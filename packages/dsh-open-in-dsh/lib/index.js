/**
 * `dsh-open-in-dsh` — host half.
 *
 * An Explorer context-menu verb cannot talk to the Web UI: the browser is a
 * sandbox with no reference to the folder the user right-clicked. This half is
 * the meeting point. It owns one small HTTP surface on the `dsh web` server
 * that is already running:
 *
 *   POST /dsh-open-in-dsh/api/v1/open     a launcher hands over one folder path
 *   GET  /dsh-open-in-dsh/api/v1/events   the page follows requests over SSE
 *
 * On macOS the same open route is also served on a Unix domain socket
 * (`DEFAULT_SOCKET_PATH`). Nothing outside the Electron renderer can reach the
 * Desktop shell's web server, and 2.0.19 removed the `--dsh-desktop-workspace`
 * launch argument that used to carry a folder into the app, so the Finder Quick
 * Action needs a channel of its own. The socket file is mode 0600: the same
 * "this user, this machine" boundary as loopback — see `startHandoffSocket`.
 *
 * The verb only *announces* a path. What a folder means — register-or-switch
 * Workspace, then a blank Session — is decided by the browser half, because
 * the Client already owns Workspace navigation; deciding it here would fork
 * that logic and drift from the sidebar's own behaviour.
 *
 * The push is Server-Sent Events rather than polling on purpose. Chrome
 * throttles timers in a hidden page down to once a minute, and right after a
 * right-click the DSH window is exactly that: hidden behind Explorer. An SSE
 * frame is a network event, so it still runs while the window is in the
 * background.
 *
 * Access policy: loopback peers only. These routes make the browser open an
 * arbitrary local directory as a Workspace — a code-execution surface — so a
 * LAN peer must never reach them, and a page from another origin must never be
 * able to fire them even when it can reach the port.
 *
 * @module dsh-open-in-dsh
 */
import { chmodSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name; the profile row's `id` is independent of it. */
export const name = 'open-in-dsh'

/**
 * macOS 交接套接字。**手抄**进 `scripts/macos/open-in-dsh`（`SOCKET_PATH_DEFAULT`），
 * `test/macos.test.mjs` 保证两份一致；`DSH_OPEN_SOCKET`（脚本）与 config `socketPath`
 * （宿主）都能覆盖。
 *
 * 放 `~/.dsh/run/` 而不是 `$TMPDIR`：Quick Action 由 Finder 拉起，它的 TMPDIR 与终端
 * 是不是同一个目录不值得赌。
 */
export const DEFAULT_SOCKET_PATH = join(homedir(), '.dsh', 'run', 'dsh-open-in-dsh.sock')

/**
 * 部署层配置。
 *
 * 声明它的作用是把这一行的 `config` 变成**被校验、会补默认值**的东西：bundle 自带的
 * 默认值、profile 补丁层的覆盖、`$DSH_HOME/settings.yaml` 里同名的段，都在这条路径上
 * 合并成一份，`Config.listConfigs` 也就读得到 schema——写配置的人（或 agent）不用再猜键名。
 *
 * 它**不会**凭空长出一个可编辑的配置表单：「设置 → 插件」按设计就是只读清单
 * （inspect plugins *without changing their configuration*），而侧边栏「插件」页里那块
 * 可编辑区域要由插件**自己注册一个配置页**（官方插件是配套 UI 包做的）。
 * 本插件只有下面四个开关，不值得为它单开一页——改它们直接写 YAML 或 settings.yaml。
 */
export const Config = z.object({
  /** 总开关。关掉后连路由都不注册。 */
  enabled: z.boolean().default(true),
  /**
   * 每次右键都新建一个空白会话。
   *
   * **默认 false**：复用该工作区已有的空白会话。同一个文件夹点几次就堆几个空会话
   * 是很容易发生的，而复用正是 DSH 侧边栏「新会话」自己的语义。
   */
  alwaysNewSession: z.boolean().default(false),
  /**
   * 是否接受非回环来源。**默认 false，不要轻易打开。**
   *
   * 这条路由的作用是让浏览器把任意本地目录当成工作区打开，而工作区里会跑命令，
   * 等同于一个代码执行入口，所以「能连上端口」不等于「是这台机器上的人」。
   *
   * 内核 0.2.1 起 webserver 不再接受通配地址（`0.0.0.0` / `::` 一律拒绝加载），
   * 但**可以**钉到某个具体接口地址（比如本机的局域网 IP），那仍然是网络可达的，
   * 所以这条回环检查照旧不能省。
   */
  allowNonLoopback: z.boolean().default(false),
  /** 冷启动补收的时间窗：页面没开着时，请求在这段时间内仍可被补收。 */
  backlogTtlMs: z.number().default(60000),
  /**
   * macOS 交接套接字路径；空串表示不监听。
   *
   * 桌面外壳 2.0.19 起不再接受 `--dsh-desktop-workspace`（Chromium 的选项解析会以
   * `bad option` 直接退出），也不再转发 second-instance 的 argv，所以快速操作改由本插件
   * 自己在套接字上收路径，与 Windows 那条 HTTP 路由共用同一个 handler。
   */
  socketPath: z.string().default(DEFAULT_SOCKET_PATH),
})

/** The endpoint the Explorer verb's launcher calls. Mirrored in `scripts/`. */
export const ROUTE_OPEN = '/dsh-open-in-dsh/api/v1/open'

/** The endpoint the browser half follows. Hand-mirrored in `client/index.js`. */
export const ROUTE_EVENTS = '/dsh-open-in-dsh/api/v1/events'

/**
 * Reports how many pages are following, without announcing anything.
 *
 * The launcher asks this after a request that found nobody listening: a page
 * that is merely mid-reconnect would otherwise look like "DSH is closed" and
 * send the user a browser window they did not ask for.
 */
export const ROUTE_STATUS = '/dsh-open-in-dsh/api/v1/status'

/** How long an unanswered request stays replayable for a page that was closed. */
const DEFAULT_BACKLOG_TTL_MS = 60_000

/** A right-click flood is not a queue; the newest requests are the real ones. */
const MAX_BACKLOG = 32

/** Keeps a proxied or suspended connection from being reaped as dead. */
const HEARTBEAT_MS = 20_000

/**
 * How long after the last page went away a request still counts as "a page may
 * be coming back". A page that is reconnecting (a plugin remount, a reload)
 * looks identical to "DSH is closed" for a second or two, and the launcher must
 * not answer the first by opening a window the user did not ask for.
 */
const RECENT_CLIENT_MS = 15_000

/** One folder path; anything larger is not this request. */
const MAX_REQUEST_BYTES = 16 * 1024

/**
 * Install the three routes.
 *
 * `webServer` is acquired through `ctx.inject` rather than read directly: the
 * service appears asynchronously, and a plain read inside `apply` would
 * silently see nothing and never register the routes.
 *
 * The raw row config is run through `Config` first so a partial block, a
 * `settings.yaml` override and the shipped defaults all resolve the same way —
 * `apply` then reads one already-resolved object instead of re-deciding each
 * default at the point of use.
 *
 * @param ctx - host plugin context.
 * @param rawConfig - the profile row's `config` block.
 * @returns nothing; the routes are registered once `webServer` appears.
 */
export function apply(ctx, rawConfig = {}) {
  const config = Config(rawConfig ?? {})
  if (config.enabled === false) return

  const hub = createHub({
    alwaysNewSession: config.alwaysNewSession,
    backlogTtlMs: config.backlogTtlMs,
  })
  const allowNonLoopback = config.allowNonLoopback === true

  ctx.inject(['webServer'], (host) => {
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: ROUTE_OPEN,
          handler: createOpenHandler(ctx, hub, allowNonLoopback),
        }),
      'dsh-open-in-dsh: open route',
    )
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: ROUTE_EVENTS,
          handler: createEventsHandler(ctx, hub, allowNonLoopback),
        }),
      'dsh-open-in-dsh: events route',
    )
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: ROUTE_STATUS,
          handler: createStatusHandler(hub, allowNonLoopback),
        }),
      'dsh-open-in-dsh: status route',
    )
    // macOS 的交接通道：同一个 open handler，第二个传输层。
    host.effect(
      () => startHandoffSocket(ctx, hub, allowNonLoopback, config.socketPath),
      'dsh-open-in-dsh: handoff socket',
    )
    // Streams outlive the route registration only by accident; close them when
    // the plugin unloads so a reload never leaves the old page holding a socket.
    host.effect(() => () => hub.close(), 'dsh-open-in-dsh: event streams')
  })
}

/**
 * The one piece of shared state: the request sequence and its followers.
 *
 * Kept separate from the handlers so the sequence rules — a live frame *and* a
 * replayable backlog row for the same request, an expiring replay window, and
 * a sequence that rewinds on host restart — can be tested without HTTP.
 *
 * @param options - hub options.
 * @param options.alwaysNewSession - session policy sent to the browser half.
 * @param options.backlogTtlMs - replay window in milliseconds.
 * @param options.now - clock, for tests.
 * @returns the hub.
 */
export function createHub(options = {}) {
  const ttl = Number.isFinite(Number(options.backlogTtlMs)) && Number(options.backlogTtlMs) > 0
    ? Number(options.backlogTtlMs)
    : DEFAULT_BACKLOG_TTL_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  // Defaults to the schema's shipped default (reuse a blank session), so a hub
  // built directly — as the tests do — behaves like the mounted plugin.
  const settings = { alwaysNewSession: options.alwaysNewSession === true }

  /** Live `text/event-stream` responses, each one an open DSH page. */
  const streams = new Set()
  /** Newest-last request rows, bounded and time-filtered on read. */
  const backlog = []
  /** When a page last attached or detached; 0 until the first one ever. */
  let lastSeenAt = 0
  let seq = 0

  /**
   * Record one request and hand it to every open page.
   * @param path - the canonical directory path.
   * @returns the stored row, including the sequence number to acknowledge with.
   */
  function publish(path) {
    seq += 1
    const entry = { seq, path, at: now() }
    backlog.push(entry)
    while (backlog.length > MAX_BACKLOG) backlog.shift()

    const frame = sseFrame('request', entry)
    for (const stream of streams) write(stream, frame)
    return entry
  }

  /**
   * Requests a page that just connected has not seen yet.
   * @param since - the highest sequence the caller already handled.
   * @returns the still-replayable rows newer than `since`, oldest first.
   */
  function pending(since) {
    const floor = Number.isFinite(since) ? since : 0
    const deadline = now() - ttl
    return backlog.filter((entry) => entry.seq > floor && entry.at >= deadline)
  }

  /**
   * Attach one SSE response to the hub.
   * @param response - the response to keep open.
   * @returns a disposer that detaches and stops the heartbeat.
   */
  function subscribe(response) {
    streams.add(response)
    lastSeenAt = now()
    const beat = setInterval(() => write(response, ': ping\n\n'), HEARTBEAT_MS)
    if (typeof beat.unref === 'function') beat.unref()

    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(beat)
      streams.delete(response)
      lastSeenAt = now()
    }
    response.on('close', stop)
    response.on('error', stop)
    return stop
  }

  /** @returns how many DSH pages are currently following the hub. */
  function clients() {
    return streams.size
  }

  /** Drop every follower; called when the plugin unloads. */
  function close() {
    for (const stream of streams) write(stream, '')
    streams.clear()
  }

  return {
    publish,
    pending,
    subscribe,
    clients,
    close,
    settings,
    get seq() { return seq },
    get lastSeenAt() { return lastSeenAt },
  }
}

/**
 * Whether a page is following now, or went away so recently that one is
 * probably on its way back.
 *
 * @param hub - the shared request hub.
 * @param now - clock, for tests.
 * @returns true when the launcher should wait rather than open a window.
 */
export function expectsPage(hub, now = Date.now()) {
  if (hub.clients() > 0) return true
  const seen = hub.lastSeenAt
  return seen > 0 && now - seen < RECENT_CLIENT_MS
}

/**
 * Serve the launcher's open route on a Unix domain socket.
 *
 * Why a second transport: on macOS nothing outside the Electron renderer can
 * reach the Desktop shell's web server (it rejects those requests before route
 * matching), and 2.0.19 removed the `--dsh-desktop-workspace` launch argument
 * that used to carry a folder into the app — passing it now makes Chromium's own
 * option parser exit with "bad option". A socket owned by this user, mode 0600,
 * is the one channel the Finder Quick Action shares with the running app.
 *
 * The request shape is the HTTP route's on purpose: one handler, two transports,
 * so the launcher reuses its JSON body and the page never learns which one
 * delivered the path. A request that arrives after a cold start is still
 * replayable through the hub's backlog, exactly like the port version.
 *
 * @param ctx - host plugin context, for logs.
 * @param hub - the shared request hub.
 * @param allowNonLoopback - kept for symmetry; a socket peer is always local.
 * @param socketPath - absolute socket path; empty disables the transport.
 * @returns disposer that closes the server and removes the socket file.
 */
function startHandoffSocket(ctx, hub, allowNonLoopback, socketPath) {
  const path = typeof socketPath === 'string' ? socketPath.trim() : ''
  if (path === '') return () => {}
  if (!isAbsolute(path)) {
    ctx.logger?.warn?.('dsh-open-in-dsh: socketPath is not absolute, handoff socket disabled: %s', path)
    return () => {}
  }

  const openHandler = createOpenHandler(ctx, hub, allowNonLoopback, true)
  const statusHandler = createStatusHandler(hub, allowNonLoopback, true)
  const server = createServer((request, response) => {
    let pathname = '/'
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
      sendJson(response, 400, { ok: false, reason: 'bad-request' })
      return
    }
    if (pathname === ROUTE_OPEN) {
      openHandler(request, response).catch((error) => {
        ctx.logger?.warn?.('dsh-open-in-dsh: socket open failed: %s', messageOf(error))
        if (!response.headersSent) sendJson(response, 500, { ok: false, reason: 'handler-failed' })
      })
      return
    }
    if (pathname === ROUTE_STATUS) {
      statusHandler(request, response)
      return
    }
    sendJson(response, 404, { ok: false, reason: 'not-found' })
  })

  let closed = false
  let replaced = false
  server.on('error', (error) => {
    if (closed) return
    // A crashed host leaves the file behind. A live one never lets us bind, so
    // the stale file is safe to replace exactly once.
    if (error?.code === 'EADDRINUSE' && !replaced) {
      replaced = true
      try {
        unlinkSync(path)
      } catch {}
      server.listen(path)
      return
    }
    ctx.logger?.warn?.('dsh-open-in-dsh: handoff socket failed (%s): %s', path, messageOf(error))
  })
  server.on('listening', () => {
    try {
      // The file mode is the access policy: only this user may hand paths over.
      chmodSync(path, 0o600)
    } catch (error) {
      ctx.logger?.warn?.('dsh-open-in-dsh: could not tighten socket mode: %s', messageOf(error))
    }
    ctx.logger?.info?.('dsh-open-in-dsh: handoff socket listening at %s', path)
  })

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  } catch (error) {
    ctx.logger?.warn?.('dsh-open-in-dsh: cannot create %s: %s', dirname(path), messageOf(error))
  }
  server.listen(path)

  return () => {
    closed = true
    try {
      server.close()
    } catch {}
    try {
      unlinkSync(path)
    } catch {}
  }
}

/**
 * Build the request handler that the Explorer launcher posts to.
 * @param ctx - host plugin context, for the log line.
 * @param hub - the shared request hub.
 * @param allowNonLoopback - whether a non-loopback peer may announce a path.
 * @param peerIsTrusted - true when the transport already proved a local peer (the
 *   Unix socket, whose file mode admits only this user); a socket has no
 *   `remoteAddress`, so the loopback test cannot speak for it.
 * @returns the exact-route handler.
 */
function createOpenHandler(ctx, hub, allowNonLoopback, peerIsTrusted = false) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, reason: 'method-not-allowed' }, { allow: 'POST' })
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, reason: 'cross-origin' })
      return
    }
    if (!allowNonLoopback && peerIsTrusted !== true && !isLoopback(request)) {
      // Opening a folder is opening a Workspace: shell commands run there.
      sendJson(response, 403, { ok: false, reason: 'remote-not-supported' })
      return
    }

    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, reason: 'bad-request', message: messageOf(error) })
      return
    }

    const path = directoryPath(body?.path)
    if (path === null) {
      // A wrong path is worse than no answer: the page would create a
      // Workspace pointing somewhere the user never asked for.
      sendJson(response, 200, { ok: false, reason: 'not-a-directory', path: String(body?.path ?? '') })
      return
    }

    const entry = hub.publish(path)
    ctx.logger?.info?.('dsh-open-in-dsh: %s -> seq %d (%d page(s) listening)', path, entry.seq, hub.clients())
    // `clients` and `recent` together are the cold-start signal: with nobody
    // following *and* nobody having followed recently, the launcher has no page
    // to push to and must open one itself. A merely reconnecting page (a
    // plugin remount, a reload) is not that case.
    sendJson(response, 200, {
      ok: true,
      seq: entry.seq,
      path,
      clients: hub.clients(),
      recent: expectsPage(hub),
    })
  }
}

/**
 * Build the SSE handler the browser half follows.
 * @param ctx - host plugin context, for warnings.
 * @param hub - the shared request hub.
 * @param allowNonLoopback - whether a non-loopback peer may follow.
 * @returns the exact-route handler.
 */
function createEventsHandler(ctx, hub, allowNonLoopback) {
  return (request, response) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { ok: false, reason: 'method-not-allowed' }, { allow: 'GET' })
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, reason: 'cross-origin' })
      return
    }
    if (!allowNonLoopback && !isLoopback(request)) {
      sendJson(response, 403, { ok: false, reason: 'remote-not-supported' })
      return
    }

    let since = 0
    try {
      const parsed = Number.parseInt(new URL(request.url ?? '/', 'http://localhost').searchParams.get('since') ?? '0', 10)
      if (Number.isFinite(parsed) && parsed > 0) since = parsed
    } catch {
      since = 0
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // A proxy that buffers would hold every frame until the stream ends.
      'x-accel-buffering': 'no',
    })
    response.write('retry: 2000\n\n')
    // `hello` carries the sequence and the settings the Client half cannot see
    // in its own `apply(ctx)` — including the rewind a host restart implies.
    response.write(sseFrame('hello', { seq: hub.seq, settings: hub.settings }))
    for (const entry of hub.pending(since)) response.write(sseFrame('request', entry))

    const stop = hub.subscribe(response)
    request.on('close', stop)
    ctx.logger?.debug?.('dsh-open-in-dsh: page following from seq %d', since)
  }
}

/**
 * Build the side-effect-free follower count the launcher polls.
 * @param hub - the shared request hub.
 * @param allowNonLoopback - whether a non-loopback peer may ask.
 * @param peerIsTrusted - true for the Unix socket transport (see createOpenHandler).
 * @returns the exact-route handler.
 */
function createStatusHandler(hub, allowNonLoopback, peerIsTrusted = false) {
  return (request, response) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { ok: false, reason: 'method-not-allowed' }, { allow: 'GET' })
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, reason: 'cross-origin' })
      return
    }
    if (!allowNonLoopback && peerIsTrusted !== true && !isLoopback(request)) {
      sendJson(response, 403, { ok: false, reason: 'remote-not-supported' })
      return
    }
    sendJson(response, 200, {
      ok: true,
      clients: hub.clients(),
      seq: hub.seq,
      recent: expectsPage(hub),
    })
  }
}

/** Render one SSE frame. */
function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Write a frame, tolerating a page that navigated away mid-write. */
function write(stream, text) {
  try {
    stream.write(text)
  } catch {
    // The 'close' handler detaches the stream; a failed write is not an error.
  }
}

/**
 * Canonicalize a claimed folder path.
 *
 * The verb passes `%V`, which is a drive root (`D:\`) at the top of a drive and
 * a bare `D:` only when something upstream already stripped the separator.
 *
 * @param value - the claimed path.
 * @returns the canonical absolute directory path, or `null` when it is not one.
 */
export function directoryPath(value) {
  if (typeof value !== 'string') return null
  let text = value.trim().replace(/^"|"$/g, '')
  if (text === '') return null
  if (/^[A-Za-z]:$/.test(text)) text = `${text}\\`
  if (text.length > 3) text = text.replace(/[\\/]+$/, '')
  try {
    if (!statSync(text).isDirectory()) return null
  } catch {
    return null
  }
  return resolve(text)
}

/**
 * Read a JSON request body.
 * @param request - the incoming request.
 * @returns the parsed body, or `{}` for an empty one.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : JSON.parse(text)
}

/**
 * Whether a request came from the page this host is serving.
 *
 * An absent `Origin` (curl, PowerShell, `EventSource` on a same-origin GET)
 * passes; a present one must match `Host`, which is what stops another page on
 * this machine from firing the route behind the user's back.
 *
 * @param request - the incoming request.
 * @returns true when the request may announce or follow paths.
 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/**
 * Whether a request arrived over the loopback interface.
 * @param request - the incoming request.
 * @returns true for a loopback peer, including IPv4-mapped forms.
 */
function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Write a JSON response.
 * @param response - the response to own.
 * @param status - HTTP status code.
 * @param value - JSON-serializable payload.
 * @param headers - extra headers.
 */
function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

/**
 * Human-readable message for an unknown thrown value.
 * @param error - the caught value.
 * @returns the message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
