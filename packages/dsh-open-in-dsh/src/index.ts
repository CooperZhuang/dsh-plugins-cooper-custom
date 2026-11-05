/**
 * `dsh-open-in-dsh` — host half.
 *
 * An Explorer context-menu verb cannot talk to the Web UI: the browser is a
 * sandbox with no reference to the folder the user right-clicked. This half is
 * the meeting point. It owns one small HTTP surface on the `dsh web` server
 * that is already running:
 *
 *   POST /dsh-open-in-dsh/api/v1/open        a launcher hands over one folder path
 *   GET  /dsh-open-in-dsh/api/v1/events      the page follows requests over SSE
 *   POST /dsh-open-in-dsh/api/v1/open-with   a right-click action opens a file or directory in a whitelisted app
 *   POST /dsh-open-in-dsh/api/v1/open-session a Session-scoped entry opens that Session's cwd (resolved from its header)
 *   GET  /dsh-open-in-dsh/api/v1/apps        which whitelisted apps this platform can actually launch
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
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { dshHome, encodeSegment, readSessionHeader } from 'dsh-session-ops/store'

// ---------------------------------------------------------------------------
// Type boundary
//
// The Cordis/Host services this plugin talks to are not published as types, so
// the boundary is described with the smallest interfaces that name what is
// actually read or called. Node's own HTTP/fs types are used directly.
// ---------------------------------------------------------------------------

/** A thrown value from a failed spawn: an `Error` that may carry an errno code. */
interface ExecFailure extends Error {
  code?: string | number
}

/** The exact `execFile` option set this plugin passes; no shell, ever. */
interface ExecOptions {
  timeout: number
  windowsHide: boolean
}

/** One `execFile` call: file, argv, options, done. */
type ExecFn = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
  callback: (error: ExecFailure | null) => void,
) => unknown

/** The only two facts this plugin asks about an existing path. */
export interface StatProbe {
  isDirectory(): boolean
  isFile(): boolean
}

/** A stat probe; `statSync` and the tests' fakes both fit. */
export type StatFn = (path: string) => StatProbe

/** A file-existence probe. */
export type ExistsFn = (path: string) => boolean

/** A directory read yielding entries; the Session lookup probes project keys. */
export type ReadDirFn = (
  path: string,
  options: { withFileTypes: true },
) => Array<{ name: string; isDirectory(): boolean }>

/** What an SSE follower must offer the hub; a `ServerResponse` does. */
export interface EventStream {
  write(text: string): unknown
  on(event: string, listener: () => void): unknown
}

/** One incoming HTTP request handler, as `webServer.register` takes it. */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

/** The exact-route row this plugin registers. */
export interface ExactRoute {
  kind: 'exact'
  path: string
  handler: RouteHandler
}

/** The `webServer` service slice the plugin uses. */
export interface WebServerService {
  register(route: ExactRoute): unknown
}

/** The host context handed to an `inject` callback; only `effect` and `webServer` are read. */
export interface InjectedHost {
  effect(callback: () => unknown, label?: string): unknown
  webServer: WebServerService
}

/** Host logger surface: only the three levels the plugin writes. */
export interface HostLogger {
  info?(...args: unknown[]): unknown
  warn?(...args: unknown[]): unknown
  debug?(...args: unknown[]): unknown
}

/** The slice of the Cordis plugin context this plugin reads. */
export interface HostContext {
  logger?: HostLogger
  get?(key: string): unknown
  inject(services: readonly string[], callback: (host: InjectedHost) => void): unknown
}

/** What `createLiveCwdReader` reads: just `ctx.get`. */
export interface LiveContext {
  get?(key: string): unknown
}

/** One announced request: sequence, canonical path, arrival time. */
export interface RequestEntry {
  readonly seq: number
  readonly path: string
  readonly at: number
}

/** The settings the page receives in the `hello` frame. */
export interface HubSettings {
  readonly alwaysNewSession: boolean
}

/** Options for {@link createHub}. */
export interface HubOptions {
  alwaysNewSession?: boolean
  backlogTtlMs?: number
  now?: () => number
}

/** The shared request hub: one sequence, its followers and its replay window. */
export interface Hub {
  publish(path: string): RequestEntry
  pending(since?: number): RequestEntry[]
  subscribe(response: EventStream): () => void
  clients(): number
  close(): void
  readonly settings: HubSettings
  readonly seq: number
  readonly lastSeenAt: number
}

/** One allowlist row: a launchable app on one platform. */
export interface OpenWithAppEntry {
  readonly id: string
  /** macOS app display name handed to `open -a`. */
  readonly app?: string
  /** macOS bundle name probed under the two Applications folders. */
  readonly bundle?: string
  /** True for apps that exist on every install (Finder, Terminal, Explorer). */
  readonly always?: boolean
}

/** The allowlist, per platform. A platform that is not listed has no entries. */
export interface OpenWithApps {
  readonly darwin: readonly OpenWithAppEntry[]
  readonly win32: readonly OpenWithAppEntry[]
}

/** A canonical path plus whether it is a directory. */
export interface LaunchTarget {
  readonly path: string
  readonly directory: boolean
}

/** One allowlisted argv to spawn. */
export interface LaunchCommand {
  readonly file: string
  readonly args: readonly string[]
}

/** Overrides for {@link createOpenWithHandler}, for tests. */
export interface OpenWithDeps {
  platform?: string
  stat?: StatFn
  exec?: ExecFn
}

/** Overrides for {@link createAppsHandler}, for tests. */
export interface AppsDeps {
  platform?: string
  exists?: ExistsFn
}

/** A Session id -> cwd reader. */
export type LiveCwdReader = (sessionId: string) => string | undefined

/** Overrides for {@link createOpenSessionHandler}, for tests. */
export interface OpenSessionDeps extends OpenWithDeps {
  resolveCwd?: LiveCwdReader
}

/** Overrides for {@link findSessionCwdOnDisk}, for tests. */
export interface DiskLookupDeps {
  home?: string
  sessionsRoot?: string
  readdir?: ReadDirFn
  readSessionHeader?: (dir: string) => unknown
}

/** `{live}` plus the stored-header overrides, for {@link resolveSessionCwd}. */
export interface ResolveSessionCwdDeps extends DiskLookupDeps {
  live?: LiveCwdReader
}

/** A stored session header is only ever asked for its `cwd`. */
interface HeaderLike {
  cwd?: unknown
}

/** The `workspaceRegistry` service: a header cache behind the sidebar. */
interface WorkspaceRegistryLike {
  headers?: { get?(sessionId: string): unknown }
}

/** The resident `sessions` service: entity lookup plus a row list. */
interface SessionsServiceLike {
  get?(sessionId: string): unknown
  list?(): unknown
}

/** Cordis plugin name; the profile row's `id` is independent of it. */
export const name = 'open-in-dsh'

/**
 * macOS 交接套接字。**手抄**进 `scripts/macos/open-in-dsh`（`SOCKET_PATH_DEFAULT`），
 * `test/macos.test.ts` 保证两份一致；`DSH_OPEN_SOCKET`（脚本）与 config `socketPath`
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

/** The config after the schema has applied its shipped defaults. */
export interface OpenInDshConfig {
  enabled: boolean
  alwaysNewSession: boolean
  allowNonLoopback: boolean
  backlogTtlMs: number
  socketPath: string
}

/** The endpoint the Explorer verb's launcher calls. Mirrored in `scripts/`. */
export const ROUTE_OPEN = '/dsh-open-in-dsh/api/v1/open'

/** The endpoint the browser half follows. Hand-mirrored in `client/index.ts`. */
export const ROUTE_EVENTS = '/dsh-open-in-dsh/api/v1/events'

/**
 * Reports how many pages are following, without announcing anything.
 *
 * The launcher asks this after a request that found nobody listening: a page
 * that is merely mid-reconnect would otherwise look like "DSH is closed" and
 * send the user a browser window they did not ask for.
 */
export const ROUTE_STATUS = '/dsh-open-in-dsh/api/v1/status'

/**
 * The right-click menu's "open with <app>" action posts `{ path, app }` here.
 *
 * `app` is an id from `OPEN_WITH_APPS`, never a command, a binary path or an
 * app name: the Host owns the whole argv, so the browser can only ask for one
 * of the allowlisted launches.
 */
export const ROUTE_OPEN_WITH = '/dsh-open-in-dsh/api/v1/open-with'

/**
 * The menu asks this before it shows anything, so an app that is not installed
 * on this machine never becomes an action that fails on click.
 */
export const ROUTE_APPS = '/dsh-open-in-dsh/api/v1/apps'

/**
 * The Session-scoped entry (the sidebar row menu) knows a session id, never a
 * directory: the browser half has the Session projection, not the stored
 * header. This route is where the Host turns "session X" into "directory D"
 * and launches D.
 *
 * The browser still only names an allowlisted app id plus a session id; the
 * path never crosses the wire, so a forged request cannot open an arbitrary
 * directory through this route.
 */
export const ROUTE_OPEN_SESSION = '/dsh-open-in-dsh/api/v1/open-session'

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
 * The open-with allowlist: the only commands this plugin will ever spawn.
 *
 * A menu action sends an id from this table; the Host resolves that id to a
 * fixed argv here. Nothing the browser sends is ever spliced into a command,
 * so a forged pair can at worst name one of these launches with a path the
 * Host itself validated.
 *
 * - darwin: Finder reveals with 'open -R'; every other app launches with
 *   'open -a <name> <path>'. Terminal-like apps land on a file's directory,
 *   because 'open -a Terminal <file>' would make Terminal run that file.
 * - win32: Explorer opens a directory and selects a file.
 */
export const OPEN_WITH_APPS: OpenWithApps = Object.freeze({
  darwin: Object.freeze([
    Object.freeze({ id: 'qspace', app: 'QSpace Pro', bundle: 'QSpace Pro.app' }),
    Object.freeze({ id: 'finder', always: true }),
    Object.freeze({ id: 'vscode', app: 'Visual Studio Code', bundle: 'Visual Studio Code.app' }),
    Object.freeze({ id: 'warp', app: 'Warp', bundle: 'Warp.app' }),
    Object.freeze({ id: 'terminal', app: 'Terminal', always: true }),
  ]),
  win32: Object.freeze([Object.freeze({ id: 'explorer', always: true })]),
})

/** Where a macOS app bundle is probed for; the per-user folder comes second. */
const DARWIN_APP_DIRS: readonly string[] = Object.freeze(['/Applications', join(homedir(), 'Applications')])

/** One path longer than this did not come from a right-click. */
const MAX_PATH_LENGTH = 4096

/** A Session id is one store-key segment; longer than this is not one. */
const MAX_SESSION_ID_LENGTH = 256

/** How long one launch may take before it is reported as failed. */
const LAUNCH_TIMEOUT_MS = 10_000

/**
 * The allowlist rows for one platform.
 * @param platform - process.platform spelling.
 * @returns the rows for that platform, or an empty list when it has none.
 */
function appsForPlatform(platform: string): readonly OpenWithAppEntry[] {
  if (platform === 'darwin') return OPEN_WITH_APPS.darwin
  if (platform === 'win32') return OPEN_WITH_APPS.win32
  return []
}

/**
 * The allowlist entry for one id on one platform.
 * @param platform - process.platform spelling.
 * @param id - the id a menu action sent.
 * @returns the entry, or undefined when the id is not allowlisted here.
 */
export function findOpenWithApp(platform: string, id: string): OpenWithAppEntry | undefined {
  return appsForPlatform(platform).find((entry) => entry.id === id)
}

/**
 * Ids of the allowlisted apps this platform can actually launch.
 *
 * macOS bundles are probed by path in the two Applications folders; the
 * system apps (Finder, Terminal) are always there. Windows contributes
 * Explorer. An unknown platform contributes nothing, so the menu simply does
 * not appear instead of offering launches that cannot work.
 *
 * @param platform - process.platform spelling.
 * @param exists - file probe, for tests.
 * @param appDirs - bundle search folders, for tests.
 * @returns allowlisted ids, in registry order.
 */
export function availableApps(
  platform: string = process.platform,
  exists: ExistsFn = existsSync,
  appDirs: readonly string[] = DARWIN_APP_DIRS,
): string[] {
  return appsForPlatform(platform)
    .filter((entry) => {
      if (entry.always === true) return true
      const bundle = entry.bundle
      return bundle !== undefined && appDirs.some((dir) => exists(join(dir, bundle)))
    })
    .map((entry) => entry.id)
}

/**
 * The exact argv for one allowlisted launch.
 * @param platform - process.platform spelling.
 * @param appId - an allowlisted id.
 * @param target - canonical path plus the directory flag.
 * @returns the command to spawn, or null when the id is not allowlisted here.
 */
export function openWithCommand(
  platform: string,
  appId: string,
  target: LaunchTarget,
): LaunchCommand | null {
  const entry = findOpenWithApp(platform, appId)
  if (entry === undefined) return null
  if (platform === 'darwin') {
    if (entry.id === 'finder') return { file: 'open', args: ['-R', target.path] }
    const terminal = entry.id === 'terminal' || entry.id === 'warp'
    const path = terminal && target.directory === false ? dirname(target.path) : target.path
    if (entry.app === undefined) return null
    return { file: 'open', args: ['-a', entry.app, path] }
  }
  if (platform === 'win32') {
    return { file: 'explorer.exe', args: [target.directory ? target.path : '/select,' + target.path] }
  }
  return null
}

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
export function apply(ctx: HostContext, rawConfig: Partial<OpenInDshConfig> = {}): void {
  const config: OpenInDshConfig = Config(rawConfig ?? {})
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
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: ROUTE_APPS,
          handler: createAppsHandler(allowNonLoopback),
        }),
      'dsh-open-in-dsh: apps route',
    )
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: ROUTE_OPEN_WITH,
          handler: createOpenWithHandler(ctx, allowNonLoopback),
        }),
      'dsh-open-in-dsh: open-with route',
    )
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: ROUTE_OPEN_SESSION,
          handler: createOpenSessionHandler(ctx, allowNonLoopback, {
            resolveCwd: (sessionId) =>
              resolveSessionCwd(sessionId, { live: createLiveCwdReader(ctx) }),
          }),
        }),
      'dsh-open-in-dsh: open-session route',
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
export function createHub(options: HubOptions = {}): Hub {
  const ttl = Number.isFinite(Number(options.backlogTtlMs)) && Number(options.backlogTtlMs) > 0
    ? Number(options.backlogTtlMs)
    : DEFAULT_BACKLOG_TTL_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  // Defaults to the schema's shipped default (reuse a blank session), so a hub
  // built directly — as the tests do — behaves like the mounted plugin.
  const settings: HubSettings = { alwaysNewSession: options.alwaysNewSession === true }

  /** Live `text/event-stream` responses, each one an open DSH page. */
  const streams = new Set<EventStream>()
  /** Newest-last request rows, bounded and time-filtered on read. */
  const backlog: RequestEntry[] = []
  /** When a page last attached or detached; 0 until the first one ever. */
  let lastSeenAt = 0
  let seq = 0

  /**
   * Record one request and hand it to every open page.
   * @param path - the canonical directory path.
   * @returns the stored row, including the sequence number to acknowledge with.
   */
  function publish(path: string): RequestEntry {
    seq += 1
    const entry: RequestEntry = { seq, path, at: now() }
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
  function pending(since = 0): RequestEntry[] {
    const floor = Number.isFinite(since) ? since : 0
    const deadline = now() - ttl
    return backlog.filter((entry) => entry.seq > floor && entry.at >= deadline)
  }

  /**
   * Attach one SSE response to the hub.
   * @param response - the response to keep open.
   * @returns a disposer that detaches and stops the heartbeat.
   */
  function subscribe(response: EventStream): () => void {
    streams.add(response)
    lastSeenAt = now()
    const beat = setInterval(() => write(response, ': ping\n\n'), HEARTBEAT_MS)
    if (typeof beat.unref === 'function') beat.unref()

    let stopped = false
    const stop = (): void => {
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
  function clients(): number {
    return streams.size
  }

  /** Drop every follower; called when the plugin unloads. */
  function close(): void {
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
export function expectsPage(hub: Hub, now: number = Date.now()): boolean {
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
function startHandoffSocket(
  ctx: HostContext,
  hub: Hub,
  allowNonLoopback: boolean,
  socketPath: string | undefined,
): () => void {
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
      openHandler(request, response).catch((error: unknown) => {
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
  server.on('error', (error: NodeJS.ErrnoException) => {
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
function createOpenHandler(
  ctx: HostContext,
  hub: Hub,
  allowNonLoopback: boolean,
  peerIsTrusted = false,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
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

    let body: Record<string, unknown>
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
function createEventsHandler(ctx: HostContext, hub: Hub, allowNonLoopback: boolean): RouteHandler {
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
function createStatusHandler(hub: Hub, allowNonLoopback: boolean, peerIsTrusted = false): RouteHandler {
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

/**
 * Build the menu's availability route.
 *
 * The answer is probed once per plugin life and then cached: an app installed
 * while the host runs shows up after a restart, the same rule the kernel's own
 * open-in-app feature uses.
 *
 * @param allowNonLoopback - whether a non-loopback peer may ask.
 * @param deps - platform/exists overrides, for tests.
 * @returns the exact-route handler.
 */
export function createAppsHandler(allowNonLoopback = false, deps: AppsDeps = {}): RouteHandler {
  const platform = deps.platform ?? process.platform
  const exists: ExistsFn = deps.exists ?? existsSync
  let cached: string[] | null = null
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
    cached ??= availableApps(platform, exists)
    sendJson(response, 200, { ok: true, platform, apps: cached })
  }
}

/**
 * Build the right-click action: validate a whitelisted app and an existing
 * path, then spawn the one argv the allowlist names.
 *
 * The app id is checked against the allowlist before the path is touched, so
 * a forged id is refused even by a caller that never had a valid path.
 *
 * @param ctx - host plugin context, for logs.
 * @param allowNonLoopback - whether a non-loopback peer may launch.
 * @param deps - platform/stat/exec overrides, for tests.
 * @returns the exact-route handler.
 */
export function createOpenWithHandler(
  ctx: HostContext,
  allowNonLoopback = false,
  deps: OpenWithDeps = {},
): RouteHandler {
  const platform = deps.platform ?? process.platform
  const stat: StatFn = deps.stat ?? statSync
  const exec: ExecFn = deps.exec ?? execFile
  return async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, reason: 'method-not-allowed' }, { allow: 'POST' })
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

    let body: Record<string, unknown>
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, reason: 'bad-request', message: messageOf(error) })
      return
    }

    const claimedApp = body?.app
    const app = typeof claimedApp === 'string' ? claimedApp.trim() : ''
    if (findOpenWithApp(platform, app) === undefined) {
      // The whole security story: no id, no command. A caller cannot smuggle
      // a binary path or an app name in here.
      sendJson(response, 400, { ok: false, reason: 'unknown-app', app, platform })
      return
    }

    const claimedValue = body?.path
    const claimed = typeof claimedValue === 'string' ? claimedValue.trim().replace(/^"|"$/g, '') : ''
    if (claimed === '' || !isAbsolute(claimed)) {
      sendJson(response, 400, { ok: false, reason: 'path-not-absolute', path: String(body?.path ?? '') })
      return
    }
    // Existing, canonical, regular file or directory. A path that cannot be
    // opened far enough to prove it exists is refused before any spawn.
    const target = existingPath(claimed, stat)
    if (target === null) {
      sendJson(response, 400, { ok: false, reason: 'path-not-found', path: claimed })
      return
    }

    const command = openWithCommand(platform, app, target)
    if (command === null) {
      sendJson(response, 400, { ok: false, reason: 'unknown-app', app, platform })
      return
    }
    try {
      await runCommand(command, exec)
    } catch (error) {
      ctx.logger?.warn?.('dsh-open-in-dsh: open-with %s failed on %s: %s', app, target.path, messageOf(error))
      sendJson(response, 500, { ok: false, reason: 'launch-failed', app, path: target.path, message: messageOf(error) })
      return
    }
    ctx.logger?.info?.('dsh-open-in-dsh: opened %s with %s', target.path, app)
    sendJson(response, 200, { ok: true, app, path: target.path, directory: target.directory })
  }
}

/**
 * Read a Session's cwd from the Host's in-memory projections, when one is live.
 *
 * Two in-memory sources, both authoritative while the Host runs:
 *   - `workspaceRegistry.headers` — the header cache behind the sidebar's
 *     Workspace membership;
 *   - the resident Session object — the same header tools and the UI parse a
 *     cwd from.
 *
 * Everything here is best-effort: a missing service, a service that throws, or
 * a composition without either simply falls through to the stored header
 * ({@link resolveSessionCwd}), which is the disk truth anyway.
 *
 * @param ctx - host plugin context.
 * @returns a reader: session id -> cwd, or undefined when nothing is cached.
 */
export function createLiveCwdReader(ctx: LiveContext): LiveCwdReader {
  const serviceOf = (key: string): unknown => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(key) : undefined
    } catch {
      return undefined
    }
  }
  const clean = (value: unknown): string | undefined =>
    (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  return (sessionId) => {
    try {
      const registry = serviceOf('workspaceRegistry') as WorkspaceRegistryLike | undefined
      const cached = registry?.headers?.get?.(sessionId)
      const cwd = clean((cached as HeaderLike | undefined)?.cwd)
      if (cwd !== undefined) return cwd
    } catch {}
    try {
      const sessions = serviceOf('sessions') as SessionsServiceLike | undefined
      const entity = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
      const fromEntity = clean((entity as { header?: HeaderLike } | undefined)?.header?.cwd)
      if (fromEntity !== undefined) return fromEntity
      const rows = typeof sessions?.list === 'function' ? sessions.list() : []
      const row = Array.isArray(rows)
        ? rows.find((entry) => isRecord(entry) && entry.id === sessionId)
        : undefined
      return clean(isRecord(row) ? row.cwd : undefined)
    } catch {
      return undefined
    }
  }
}

/**
 * Read a Session's cwd out of the session store on disk.
 *
 * The store is keyed by project directory, so an id alone does not name a
 * path: every project key is probed for `<root>/<projectKey>/<encodeSegment(id)>`
 * and the first header carrying a cwd wins. `encodeSegment` and
 * `readSessionHeader` come from `dsh-session-ops/store`, the same header/frame
 * reader `dsh-session-ops` uses, so a storage-format change cannot make
 * the two plugins disagree.
 *
 * @param sessionId - the Session id the browser sent.
 * @param deps - root/readdir/reader overrides, for tests.
 * @returns the stored cwd, or undefined when no header carries one.
 */
export function findSessionCwdOnDisk(
  sessionId: string,
  deps: DiskLookupDeps = {},
): string | undefined {
  const root = deps.sessionsRoot ?? join(deps.home ?? dshHome(), 'sessions')
  const readdir: ReadDirFn = deps.readdir ?? readdirSync
  const readHeader = deps.readSessionHeader ?? readSessionHeader
  let segment: string
  try {
    segment = encodeSegment(sessionId)
  } catch {
    return undefined
  }
  let projects: Array<{ name: string; isDirectory(): boolean }>
  try {
    projects = readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (project?.isDirectory?.() !== true) continue
    let header: unknown
    try {
      header = readHeader(join(root, project.name, segment))
    } catch {
      continue
    }
    const record = isRecord(header) ? header : undefined
    const cwd = typeof record?.cwd === 'string' ? record.cwd.trim() : ''
    if (cwd !== '') return cwd
  }
  return undefined
}

/**
 * Resolve one Session id to its project directory: live projections first,
 * stored header second.
 * @param sessionId - the Session id.
 * @param deps - `{live}` plus {@link findSessionCwdOnDisk}'s overrides.
 * @returns the cwd, or undefined when this Host cannot name one.
 */
export function resolveSessionCwd(
  sessionId: string,
  deps: ResolveSessionCwdDeps = {},
): string | undefined {
  if (typeof deps.live === 'function') {
    let live: string | undefined
    try {
      live = deps.live(sessionId)
    } catch {
      live = undefined
    }
    if (typeof live === 'string' && live.trim() !== '') return live.trim()
  }
  return findSessionCwdOnDisk(sessionId, deps)
}

/**
 * Build the Session-scoped launch route: resolve a session id to its cwd, then
 * spawn the same allowlisted argv the open-with route uses.
 *
 * The request names an app id and a session id only. The directory never
 * crosses the wire, so a forged request cannot turn this route into "open any
 * path" — the worst it can do is open a directory the Host itself resolved.
 *
 * @param ctx - host plugin context, for logs.
 * @param allowNonLoopback - whether a non-loopback peer may launch.
 * @param deps - platform/stat/exec/resolver overrides, for tests.
 * @returns the exact-route handler.
 */
export function createOpenSessionHandler(
  ctx: HostContext,
  allowNonLoopback = false,
  deps: OpenSessionDeps = {},
): RouteHandler {
  const platform = deps.platform ?? process.platform
  const stat: StatFn = deps.stat ?? statSync
  const exec: ExecFn = deps.exec ?? execFile
  const resolveCwd: LiveCwdReader =
    typeof deps.resolveCwd === 'function' ? deps.resolveCwd : (sessionId) => resolveSessionCwd(sessionId)
  return async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, reason: 'method-not-allowed' }, { allow: 'POST' })
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

    let body: Record<string, unknown>
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, reason: 'bad-request', message: messageOf(error) })
      return
    }

    const claimedApp = body?.app
    const app = typeof claimedApp === 'string' ? claimedApp.trim() : ''
    if (findOpenWithApp(platform, app) === undefined) {
      sendJson(response, 400, { ok: false, reason: 'unknown-app', app, platform })
      return
    }

    const claimedSession = body?.sessionId
    const claimed = typeof claimedSession === 'string' ? claimedSession.trim() : ''
    if (claimed === '') {
      sendJson(response, 400, { ok: false, reason: 'missing-session-id' })
      return
    }
    // A session id is a single path segment; these bounds keep a forged one
    // from turning the store probe into a directory walk.
    if (claimed.length > MAX_SESSION_ID_LENGTH || claimed.includes(String.fromCharCode(0)) || claimed.includes('/') || claimed.includes('\\')) {
      sendJson(response, 400, { ok: false, reason: 'invalid-session-id' })
      return
    }

    let cwd: string | undefined
    try {
      cwd = resolveCwd(claimed)
    } catch (error) {
      ctx.logger?.warn?.('dsh-open-in-dsh: session cwd lookup failed for %s: %s', claimed, messageOf(error))
      sendJson(response, 500, { ok: false, reason: 'session-lookup-failed', message: messageOf(error) })
      return
    }
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      sendJson(response, 404, { ok: false, reason: 'session-cwd-not-found', sessionId: claimed })
      return
    }

    const target = existingPath(cwd, stat)
    // A stored header can outlive its directory (a folder renamed behind DSH's
    // back). That is still "this Session's cwd cannot be opened", not a bad
    // request: the caller sent a perfectly valid session id.
    if (target === null || target.directory !== true) {
      sendJson(response, 404, { ok: false, reason: 'session-cwd-not-found', sessionId: claimed, cwd: cwd.trim() })
      return
    }

    const command = openWithCommand(platform, app, { path: target.path, directory: true })
    if (command === null) {
      sendJson(response, 400, { ok: false, reason: 'unknown-app', app, platform })
      return
    }
    try {
      await runCommand(command, exec)
    } catch (error) {
      ctx.logger?.warn?.(
        'dsh-open-in-dsh: open-session %s failed on %s: %s',
        app,
        target.path,
        messageOf(error),
      )
      sendJson(response, 500, {
        ok: false,
        reason: 'launch-failed',
        app,
        sessionId: claimed,
        path: target.path,
        message: messageOf(error),
      })
      return
    }
    ctx.logger?.info?.('dsh-open-in-dsh: opened session %s cwd %s with %s', claimed, target.path, app)
    sendJson(response, 200, { ok: true, app, sessionId: claimed, path: target.path, directory: true })
  }
}

/**
 * Spawn one allowlisted command. execFile takes an argv array, so no shell
 * ever parses the path or the app name.
 *
 * @param command - the exact command.
 * @param exec - execFile, for tests.
 * @returns completion; rejects with the spawn error.
 */
function runCommand(command: LaunchCommand, exec: ExecFn = execFile): Promise<void> {
  return new Promise((settle, fail) => {
    exec(command.file, command.args, { timeout: LAUNCH_TIMEOUT_MS, windowsHide: true }, (error) => {
      if (error === null) {
        settle()
        return
      }
      // Explorer returns 1 even when it opened the folder; only a missing or
      // unexecutable binary means the launch did not happen.
      if (command.file === 'explorer.exe' && error.code !== 'ENOENT' && error.code !== 'EACCES') {
        settle()
        return
      }
      fail(error)
    })
  })
}

/** Render one SSE frame. */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Write a frame, tolerating a page that navigated away mid-write. */
function write(stream: EventStream, text: string): void {
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
export function directoryPath(value: unknown): string | null {
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
 * Canonicalize a claimed file or directory path.
 *
 * The path is not trusted because the browser sent it: it must be absolute,
 * short enough to be a path, and resolve to a regular file or directory.
 *
 * @param value - the claimed path.
 * @param stat - stat probe, for tests.
 * @returns canonical path plus the directory flag, or null when it is not one.
 */
export function existingPath(value: unknown, stat: StatFn = statSync): LaunchTarget | null {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/^"|"$/g, '')
  if (text === '' || text.length > MAX_PATH_LENGTH || text.includes(String.fromCharCode(0))) return null
  if (!isAbsolute(text)) return null
  try {
    const info = stat(text)
    if (info.isDirectory()) return { path: resolve(text), directory: true }
    if (info.isFile()) return { path: resolve(text), directory: false }
  } catch {}
  return null
}

/**
 * Read a JSON request body.
 * @param request - the incoming request.
 * @returns the parsed body, or `{}` for an empty one.
 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
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
function sameOrigin(request: IncomingMessage): boolean {
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
function isLoopback(request: IncomingMessage): boolean {
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
function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string | number> = {},
): void {
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
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Narrow an unknown value to a plain object, so a projected or stored record
 * can be probed for one field without trusting its shape.
 * @param value - the value to inspect.
 * @returns true when the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
