/**
 * `dsh-folder-path` — host half.
 *
 * A folder copied in Windows Explorer cannot travel through the browser: the
 * paste event carries a `File` with `size: 0` whose bytes are unreadable, so
 * `dsh-client-file-upload` fails and the composer shows 上传失败. The browser
 * also never sees the folder's location — `File.name` is the basename and the
 * path is not part of the paste payload at all.
 *
 * This half answers the one question the browser cannot: *which paths did the
 * user just copy?* The clipboard is process-wide on the machine running the
 * GUI, and at paste time it holds exactly the payload being pasted, so reading
 * the Windows clipboard file-drop list (CF_HDROP) recovers the real full paths.
 *
 * Scope is deliberately narrow:
 *
 *   * one exact POST route, no agent-visible surface, no model content;
 *   * the route only *reads* the clipboard and matches directory basenames the
 *     browser claimed to be pasting — a mismatched clipboard yields no answer
 *     instead of a wrong path;
 *   * non-Windows hosts answer `unsupported-platform` and the browser half
 *     degrades to a notice.
 *
 * @module dsh-folder-path
 */
import { execFile } from 'node:child_process'

/** Cordis plugin name; the profile row's `id` is independent of it. */
export const name = 'folder-path'

/**
 * The single endpoint the browser half calls. Hand-mirrored in
 * `client/index.js`: the two halves ship as one package but cannot import each
 * other (the browser bundle is a hand-written classic script).
 */
export const ROUTE_PATH = '/dsh-folder-path/api/v1/clipboard-paths'

/** Clipboard probes are interactive: a wedged PowerShell must not hold a paste. */
const DEFAULT_TIMEOUT_MS = 5000

/** A paste names a handful of folders; anything larger is not this request. */
const MAX_REQUEST_BYTES = 64 * 1024

/**
 * PowerShell probe. Emits base64(UTF-8 JSON) on stdout so a Chinese path can
 * never be mangled by the console code page of a redirected Windows PowerShell
 * process, which is what plain `ConvertTo-Json` output would hit.
 *
 * `-InputObject` keeps a single-element result a JSON array (`items` is always
 * a list), and `[char]92`/`[char]47` avoid backslash quoting hazards.
 */
const PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  '$items = @()',
  'foreach ($raw in [System.Windows.Forms.Clipboard]::GetFileDropList()) {',
  '  $full = [string]$raw',
  '  if ([string]::IsNullOrWhiteSpace($full)) { continue }',
  '  $trimmed = $full.TrimEnd([char]92, [char]47)',
  '  $name = if ($trimmed.Length -gt 0) { [System.IO.Path]::GetFileName($trimmed) } else { $full }',
  '  $items += [pscustomobject]@{',
  '    path = $full',
  '    name = $name',
  '    isDirectory = [System.IO.Directory]::Exists($full)',
  '  }',
  '}',
  '$payload = [pscustomobject]@{ ok = $true; items = @($items) }',
  '$json = ConvertTo-Json -InputObject $payload -Compress -Depth 4',
  '[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))',
].join('\n')

/**
 * Install the clipboard route.
 *
 * `webServer` is acquired through `ctx.inject` rather than read directly: the
 * service appears asynchronously, and a plain read inside `apply` would silently
 * see nothing and never register the route.
 *
 * @param ctx - host plugin context.
 * @param config - the profile row's `config` block.
 * @param config.enabled - set `false` to mount the host half inert.
 * @param config.timeoutMs - PowerShell probe budget in milliseconds.
 * @param config.powershell - PowerShell executable used for the probe.
 * @param config.allowNonLoopback - allow a browser on another machine to read this host's clipboard.
 * @returns nothing; the route is registered once `webServer` appears.
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) return
  const timeoutMs = Number(config?.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS
  const powershell =
    firstString(config?.powershell) || firstString(process.env.DSH_FOLDER_PATH_POWERSHELL) || 'powershell.exe'
  const allowNonLoopback = config?.allowNonLoopback === true

  ctx.inject(['webServer'], (host) => {
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: createHandler(ctx, timeoutMs, powershell, allowNonLoopback),
        }),
      'dsh-folder-path: clipboard route',
    )
  })
}

/**
 * Build the request handler.
 * @param ctx - host plugin context, for warnings.
 * @param timeoutMs - PowerShell probe budget.
 * @param powershell - PowerShell executable used for the probe.
 * @param allowNonLoopback - whether a non-loopback peer may read the clipboard.
 * @returns the exact-route handler.
 */
function createHandler(ctx, timeoutMs, powershell, allowNonLoopback) {
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
      // The clipboard belongs to the machine running the host; a browser on
      // another machine would be handed this machine's paths instead of its own.
      sendJson(response, 403, { ok: false, reason: 'remote-not-supported', paths: [] })
      return
    }

    let names
    try {
      const body = await readJsonBody(request)
      names = Array.isArray(body?.names)
        ? body.names.filter((entry) => typeof entry === 'string' && entry.length > 0)
        : []
    } catch (error) {
      sendJson(response, 400, { ok: false, reason: 'bad-request', message: messageOf(error) })
      return
    }

    if (process.platform !== 'win32') {
      sendJson(response, 200, { ok: false, reason: 'unsupported-platform', paths: [] })
      return
    }

    let entries
    try {
      entries = await readClipboardEntries(timeoutMs, powershell)
    } catch (error) {
      ctx.logger?.warn?.('dsh-folder-path: clipboard probe failed: %o', error)
      sendJson(response, 200, { ok: false, reason: 'clipboard-error', message: messageOf(error), paths: [] })
      return
    }

    const directories = entries.filter((entry) => entry.isDirectory === true)
    const matches = matchDirectories(directories, names)
    if (names.length > 0 && matches.length === 0) {
      // The browser pasted something the clipboard no longer describes (or the
      // name it reports differs from the on-disk name). Answering "no match" is
      // the point: a plausible-looking wrong path would be worse than none.
      sendJson(response, 200, {
        ok: false,
        reason: 'no-match',
        paths: [],
        clipboard: { directories: directories.length, total: entries.length },
      })
      return
    }

    sendJson(response, 200, { ok: true, paths: matches.map((entry) => entry.path), entries: matches })
  }
}

/**
 * Filter clipboard directories down to the ones the browser is pasting.
 *
 * An empty `names` list means the caller wants every copied directory; a
 * non-empty list is matched by basename, case-insensitively, because that is
 * all the browser can see of the path.
 *
 * @param directories - directory entries from the clipboard.
 * @param names - basenames the browser reported.
 * @returns the matching entries, in clipboard order.
 * @remarks Exported for the host test suite; the route is its only runtime caller.
 */
export function matchDirectories(directories, names) {
  if (names.length === 0) return directories
  const wanted = new Set(names.map((entry) => entry.toLowerCase()))
  return directories.filter((entry) => wanted.has(entry.name.toLowerCase()))
}

/** The probe in flight, if any: several pastes must not fork PowerShell each. */
let inflight = null
let inflightKey = null

/**
 * Read the Windows clipboard file-drop list.
 * @param timeoutMs - how long PowerShell may take.
 * @param powershell - PowerShell executable used for the probe.
 * @returns the parsed probe payload's `items` array.
 */
function readClipboardEntries(timeoutMs, powershell) {
  const key = `${powershell}\u0000${String(timeoutMs)}`
  if (inflight !== null && inflightKey === key) return inflight

  const probe = probeClipboard(timeoutMs, powershell).finally(() => {
    if (inflight === probe) {
      inflight = null
      inflightKey = null
    }
  })
  inflight = probe
  inflightKey = key
  return probe
}

/**
 * Run the PowerShell probe once.
 * @param timeoutMs - how long PowerShell may take.
 * @param powershell - PowerShell executable used for the probe.
 * @returns the clipboard items, each `{ path, name, isDirectory }`.
 */
function probeClipboard(timeoutMs, powershell) {
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', PROBE_SCRIPT],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`clipboard probe failed: ${firstLine(stderr) || messageOf(error)}`, { cause: error }))
          return
        }
        try {
          const payload = JSON.parse(Buffer.from(String(stdout).trim(), 'base64').toString('utf8'))
          resolve(Array.isArray(payload?.items) ? payload.items : [])
        } catch (cause) {
          reject(new Error('clipboard probe returned unreadable output', { cause }))
        }
      },
    )
  })
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
 * Browsers send `Origin` on cross-origin POSTs *and* same-origin ones, so an
 * absent header (curl, tests) passes and a present one must match `Host`.
 *
 * @param request - the incoming request.
 * @returns true when the request may read the clipboard.
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
 * First non-empty string of a value, for optional config knobs.
 * @param value - the configured value.
 * @returns the trimmed string, or an empty string.
 */
function firstString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
}

/**
 * First non-empty line of a stream, for a compact error message.
 * @param text - raw stderr text.
 * @returns the first non-empty line, trimmed.
 */
function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  return line ?? ''
}

/**
 * Human-readable message for an unknown thrown value.
 * @param error - the caught value.
 * @returns the message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
