/**
 * Host half of `dsh-workspace-sort`.
 *
 * The sidebar order itself is a Client-side job: only the browser holds both
 * the Workspace order (`ctx.workspaces.list`) and the Session summaries whose
 * `updatedAt` is the last human prompt, and only the browser can call the
 * durable `workspaces.insertBefore`. What the Host still owes the browser half
 * is configuration and an audit trail, so this file is deliberately small:
 *
 *   * `GET  /dsh-workspace-sort/api/state` — the resolved knobs, so the browser
 *     half never hard-codes a default that the profile cannot change;
 *   * `POST /dsh-workspace-sort/api/state` — the last reorder decision, kept in
 *     memory and echoed back by `GET`, so a reload or `curl` can answer "why did
 *     my workspace list move?";
 *   * one log line per applied reorder, because a durable order write that only
 *     exists in a page's memory is not auditable.
 *
 * `enabled: false` mounts this half inert: no route is registered, so the
 * browser half stays silent rather than inventing its own defaults.
 *
 * @module dsh-workspace-sort
 */

/** Route path, hand-mirrored in `src/client.js`: the two halves cannot import each other. */
export const STATE_ROUTE = '/dsh-workspace-sort/api/state'

/** A reorder report is a handful of ids; anything larger is not this request. */
const MAX_REPORT_BYTES = 64 * 1024

/**
 * The part of the profile row's `config` block this plugin reads.
 *
 * @typedef {object} WorkspaceSortConfig
 * @property {boolean} [enabled] Mount the plugin at all (false leaves the order untouched).
 * @property {boolean} [aggregate] Rank a container by its whole subtree (default true).
 * @property {boolean} [initialSort] Apply the activity order as soon as a page loads (default true).
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
 * @param {WorkspaceSortConfig} [config] - the profile row's `config` block.
 */
export function apply(ctx, config = {}) {
  if (config === null || typeof config !== 'object') config = {}
  if (config.enabled === false) return
  const resolved = {
    enabled: true,
    aggregate: config.aggregate !== false,
    initialSort: config.initialSort !== false,
  }

  let lastReport

  const handler = async (request, response) => {
    if (!isLoopback(request)) {
      sendJson(response, 403, { ok: false, reason: 'loopback-only' })
      return
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      sendJson(response, 200, { ok: true, config: resolved, lastReport })
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
        'dsh-workspace-sort: client attached (aggregate=%s, initialSort=%s)',
        options.aggregate !== false,
        options.initialSort !== false,
      )
      sendJson(response, 200, { ok: true, config: resolved })
      return
    }
    const moves = Array.isArray(body.moves) ? body.moves : []
    ctx.logger?.info?.(
      'dsh-workspace-sort: reordered %d workspace(s), newest activity %s',
      moves.length,
      typeof body.newest === 'number' && body.newest > 0 ? new Date(body.newest).toISOString() : 'none',
    )
    sendJson(response, 200, { ok: true, config: resolved })
  }

  ctx.inject(['webServer'], (host) => {
    host.effect(
      () => host.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler }),
      'dsh-workspace-sort: state route',
    )
  })
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
    if (bytes > MAX_REPORT_BYTES) throw new Error('report too large')
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
