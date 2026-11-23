/**
 * Host half of `dsh-workspace-sort`.
 *
 * The ordering itself is a Client job: only the browser holds both the
 * Workspace order (`ctx.workspaces.list`) and the Session summaries whose
 * `updatedAt` is the last human prompt, and only the browser can call the
 * durable `workspaces.insertBefore`. The Host owes the browser two things and
 * nothing else:
 *
 *   * the user's pins and rule switches, persisted as plain JSON under
 *     `$DSH_HOME/workspace-sort/prefs.json` (`GET` on the state route,
 *     `POST /dsh-workspace-sort/api/prefs` to write). They are stored here
 *     rather than in `localStorage` because the desktop Web server binds an
 *     ephemeral port (`port: 0`), so the page origin — and with it every
 *     `localStorage` entry — changes on each restart;
 *   * an audit trail: the last reorder decision is kept in memory for `GET`, and
 *     every applied reorder logs one line.
 *
 * The sorting knobs are not a route: they are this package's {@link Config},
 * whose fields are all `.volatile()`. The Loader hands `apply` live `{ get() }`
 * references and gives the browser face the same values as `SyncedConfig` refs,
 * so a change made in the plugin page applies without a restart or a reload.
 * The state route still echoes the resolved knobs for `curl` diagnostics, but
 * the browser never depends on it for configuration.
 *
 * Deliberately absent: file moves, directory renames, Workspace removal,
 * session migration, process spawning. This plugin changes ordering state only.
 *
 * `enabled: false` leaves the order untouched: the browser half stops sorting.
 * Both routes stay mounted, so the pins remain readable and writable while the
 * switch is off and toggling it back on is itself a live config change.
 *
 * @module dsh-workspace-sort
 */
import z from '@deepseek-ai/schemastery'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Route paths, hand-mirrored in `src/client.js`: the two halves cannot import each other. */
export const STATE_ROUTE = '/dsh-workspace-sort/api/state'
export const PREFS_ROUTE = '/dsh-workspace-sort/api/prefs'

/**
 * Plugin config, edited live in the plugin page.
 *
 * Every field is `.volatile()` on purpose: the Loader then keeps the running
 * references stable and commits new values in place, so changing a knob neither
 * remounts this half nor reloads the page. Descriptions are the form labels.
 */
export const Config = z.object({
  /** Sort at all; false stops the browser half and leaves the Host order exactly as it is. */
  enabled: z.boolean().default(true).description('启用排序。关掉后浏览器半边停手，工作区顺序保持原样。').volatile(),
  /** Rank a container Workspace by its whole subtree instead of its own Sessions. */
  aggregate: z
    .boolean()
    .default(true)
    .description('容器目录按整个子树汇总（默认开）；关掉后只按目录自己的会话算。')
    .volatile(),
  /** Apply the order as soon as a page loads instead of waiting for the next prompt. */
  initialSort: z
    .boolean()
    .default(true)
    .description('页面加载时立即排序（默认开）；关掉后等下一次提问或手动整理。')
    .volatile(),
})

/** A reorder report or a pin set is small; anything larger is not this request. */
const MAX_BODY_BYTES = 64 * 1024

/** A browser cannot pin more Workspaces than the registry has; this is a sanity cap. */
const MAX_PINS = 500

/** Defaults mirrored in the browser bundle, used before the file exists. */
const DEFAULT_PREFS = { auto: true, runningFirst: false, pins: [] }

/**
 * The part of the profile row's `config` block this plugin reads.
 *
 * A `.volatile()` field arrives as a live `{ get() }` reference; a plain
 * boolean is also accepted, see {@link readFlag}.
 *
 * @typedef {object} VolatileFlag
 * @property {() => boolean | undefined} get - the current value.
 *
 * @typedef {object} WorkspaceSortConfig
 * @property {VolatileFlag | boolean} [enabled] Sort at all; false leaves the order untouched.
 * @property {VolatileFlag | boolean} [aggregate] Rank a container by its whole subtree (default true).
 * @property {VolatileFlag | boolean} [initialSort] Apply the order as soon as a page loads (default true).
 */

/**
 * The browser-side preferences this plugin persists.
 *
 * @typedef {object} WorkspaceSortPrefs
 * @property {boolean} auto Resolve the order automatically on the next prompt.
 * @property {boolean} runningFirst Lead the unpinned partition with running Workspaces.
 * @property {string[]} pins Workspace ids in pin order.
 */

/**
 * The Host context surface this plugin uses; DSH's Context is richer but only
 * these members are touched.
 *
 * @typedef {object} HostContext
 * @property {{ info?: Function, warn?: Function }} [logger]
 * @property {Function} inject
 */

/**
 * @param {HostContext} ctx - the plugin's Cordis context.
 * @param {WorkspaceSortConfig} [config] - the row's `config` block; volatile
 *   fields arrive as live `{ get() }` references.
 */
export function apply(ctx, config = {}) {
  if (config === null || typeof config !== 'object') config = {}
  /**
   * The knobs as they are right now. Read on every use instead of once at
   * mount: with `.volatile()` fields the Loader commits new values into the
   * same references, so a cached copy would go stale.
   */
  const resolvedConfig = () => ({
    enabled: readFlag(config.enabled, true),
    aggregate: readFlag(config.aggregate, true),
    initialSort: readFlag(config.initialSort, true),
  })

  let prefs = { ...DEFAULT_PREFS }
  let lastReport
  /** The first read must settle before any handler answers, or a GET could report defaults. */
  const ready = readStoredPrefs(ctx.logger).then((stored) => {
    prefs = stored
  })

  /**
   * Answer one request on the state route: knobs, prefs, and the last decision.
   * The knobs are echoed for diagnostics only; the browser half gets them from
   * its `SyncedConfig`.
   *
   * @param {import('node:http').IncomingMessage} request - the route request.
   * @param {import('node:http').ServerResponse} response - the route response.
   */
  const stateHandler = async (request, response) => {
    if (!isLoopback(request)) {
      sendJson(response, 403, { ok: false, reason: 'loopback-only' })
      return
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      await ready
      sendJson(response, 200, { ok: true, config: resolvedConfig(), prefs, lastReport })
      return
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, reason: 'method-not-allowed' }, { allow: ['GET', 'HEAD', 'POST'] })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, reason: 'bad-request', message: messageOf(error) })
      return
    }
    if (body === null || typeof body !== 'object') {
      sendJson(response, 400, { ok: false, reason: 'bad-request' })
      return
    }
    lastReport = body
    if (body.hello === true) {
      const options = body.options !== null && typeof body.options === 'object' ? body.options : {}
      ctx.logger?.info?.(
        'dsh-workspace-sort: client attached (enabled=%s, aggregate=%s, initialSort=%s)',
        options.enabled !== false,
        options.aggregate !== false,
        options.initialSort !== false,
      )
      sendJson(response, 200, { ok: true })
      return
    }
    const moves = Array.isArray(body.moves) ? body.moves : []
    ctx.logger?.info?.(
      'dsh-workspace-sort: reordered %d workspace(s), newest activity %s%s, %d waiting on you',
      moves.length,
      typeof body.newest === 'number' && body.newest > 0 ? new Date(body.newest).toISOString() : 'none',
      body.manual === true ? ' (manual)' : '',
      typeof body.waiting === 'number' && body.waiting > 0 ? body.waiting : 0,
    )
    sendJson(response, 200, { ok: true })
  }

  /**
   * Persist the browser's prefs. The file is written atomically: tmp then rename,
   * so a crash never leaves a half-written pin set.
   *
   * @param {import('node:http').IncomingMessage} request - the route request.
   * @param {import('node:http').ServerResponse} response - the route response.
   */
  const prefsHandler = async (request, response) => {
    if (!isLoopback(request)) {
      sendJson(response, 403, { ok: false, reason: 'loopback-only' })
      return
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, reason: 'method-not-allowed' }, { allow: ['POST'] })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, reason: 'bad-request', message: messageOf(error) })
      return
    }
    const next = sanitizePrefs(body)
    try {
      await writeStoredPrefs(next)
    } catch (error) {
      ctx.logger?.warn?.('dsh-workspace-sort: could not persist prefs: %o', error)
      sendJson(response, 500, { ok: false, reason: 'write-failed', message: messageOf(error) })
      return
    }
    prefs = next
    sendJson(response, 200, { ok: true, prefs })
  }

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const offState = host.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler: stateHandler })
      const offPrefs = host.webServer.register({ kind: 'exact', path: PREFS_ROUTE, handler: prefsHandler })
      return () => {
        offState()
        offPrefs()
      }
    }, 'dsh-workspace-sort: routes')
  })
}

/**
 * Read one config field.
 *
 * A `.volatile()` field is handed to `apply` as a live `{ get() }` reference
 * whose value may still be absent; a plain boolean is accepted too so a direct
 * `apply(ctx, {...})` (a test, or a Host that does not mark it volatile) reads
 * the same way. Anything unusable falls back to the field default.
 *
 * @param field - the config field as received.
 * @param fallback - the documented default.
 * @returns the effective boolean.
 */
function readFlag(field, fallback) {
  if (field === undefined || field === null) return fallback
  let value
  try {
    value = typeof field.get === 'function' ? field.get() : field
  } catch {
    return fallback
  }
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Where this plugin keeps its own small state file.
 *
 * @returns the absolute path of `prefs.json`.
 */
function prefsFile() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(home, 'workspace-sort', 'prefs.json')
}

/**
 * Reduce arbitrary JSON to the preference shape, dropping anything unusable.
 *
 * @param value - whatever the browser (or a damaged file) supplied.
 * @returns a valid {@link WorkspaceSortPrefs}.
 */
function sanitizePrefs(value) {
  const record = value !== null && typeof value === 'object' ? value : {}
  const pins = Array.isArray(record.pins)
    ? record.pins.filter((id) => typeof id === 'string' && id.length > 0).slice(0, MAX_PINS)
    : []
  return {
    auto: record.auto !== false,
    runningFirst: record.runningFirst === true,
    pins: [...new Set(pins)],
  }
}

/**
 * Read the stored prefs, falling back to defaults on a missing or damaged file.
 *
 * @param {HostContext['logger']} logger - the plugin logger.
 * @returns the stored {@link WorkspaceSortPrefs}.
 */
async function readStoredPrefs(logger) {
  try {
    return sanitizePrefs(JSON.parse(await readFile(prefsFile(), 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.('dsh-workspace-sort: prefs unreadable, using defaults: %o', error)
    return { ...DEFAULT_PREFS }
  }
}

/**
 * Write the prefs atomically (tmp file then rename).
 *
 * @param prefs - the value to store.
 * @returns a promise that settles once the rename is durable.
 */
async function writeStoredPrefs(prefs) {
  const file = prefsFile()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(prefs, null, 1)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * Whether the request came from this machine.
 *
 * @param {import('node:http').IncomingMessage} request - the route request.
 * @returns true for loopback peers, including IPv4-mapped IPv6.
 */
function isLoopback(request) {
  const address = request?.socket?.remoteAddress ?? ''
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

/**
 * Read and parse a bounded JSON request body.
 *
 * @param {import('node:http').IncomingMessage} request - the route request.
 * @returns {Promise<unknown>} the parsed body.
 */
async function readJsonBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} response - the route response.
 * @param {number} status - HTTP status code.
 * @param {unknown} payload - JSON-serializable body.
 * @param {Record<string, string | string[]>} [headers] - extra headers.
 */
function sendJson(response, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

/**
 * Best-effort message text for a failure payload.
 *
 * @param {unknown} error - the failure.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
