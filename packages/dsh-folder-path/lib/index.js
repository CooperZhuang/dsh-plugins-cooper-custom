/**
 * `dsh-folder-path` — host half.
 *
 * A folder copied in the desktop file manager cannot travel through the
 * browser: the paste event carries a `File` with no readable bytes, so
 * `dsh-client-file-upload` fails and the composer shows 上传失败. The browser
 * also never sees the folder's location — `File.name` is the basename and the
 * path is not part of the paste payload at all.
 *
 * This half answers the one question the browser cannot: *which paths did the
 * user just copy?* The clipboard is process-wide on the machine running the
 * GUI, and at paste time it holds exactly the payload being pasted, so reading
 * the platform clipboard's file list recovers the real full paths:
 *
 *   * Windows — the CF_HDROP file-drop list, through PowerShell's
 *     `System.Windows.Forms.Clipboard`;
 *   * macOS — the NSPasteboard file URLs (plus the legacy
 *     `NSFilenamesPboardType` list), through `osascript -l JavaScript`.
 *
 * Scope is deliberately narrow:
 *
 *   * one exact POST route, no agent-visible surface, no model content;
 *   * the route only *reads* the clipboard and matches directory basenames the
 *     browser claimed to be pasting — a mismatched clipboard yields no answer
 *     instead of a wrong path;
 *   * other hosts answer `unsupported-platform` and the browser half
 *     degrades to a notice.
 *
 * @module dsh-folder-path
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

/** Cordis plugin name; the profile row's `id` is independent of it. */
export const name = 'folder-path'

/**
 * The single endpoint the browser half calls. Hand-mirrored in
 * `client/index.js`: the two halves ship as one package but cannot import each
 * other (the browser bundle is a hand-written classic script).
 */
export const ROUTE_PATH = '/dsh-folder-path/api/v1/clipboard-paths'

/** Clipboard probes are interactive: a wedged child process must not hold a paste. */
const DEFAULT_TIMEOUT_MS = 5000

/** A paste names a handful of folders; anything larger is not this request. */
const MAX_REQUEST_BYTES = 64 * 1024

/** Hosts whose clipboard can answer this route. */
const DESKTOP_PLATFORMS = new Set(['win32', 'darwin'])

/**
 * Windows PowerShell probe. Emits base64(UTF-8 JSON) on stdout so a Chinese path
 * can never be mangled by the console code page of a redirected Windows
 * PowerShell process, which is what plain `ConvertTo-Json` output would hit.
 *
 * `-InputObject` keeps a single-element result a JSON array (`items` is always
 * a list), and `[char]92`/`[char]47` avoid backslash quoting hazards.
 */
const WINDOWS_PROBE_SCRIPT = [
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
 * macOS JXA probe. Emits a JSON array of absolute paths on stdout.
 *
 * Two sources are merged because Finder and other apps do not agree on one:
 *
 *   * `readObjectsForClassesOptions` returns every pasteboard item that carries
 *     a `public.file-url` (the modern shape, one item per copied file);
 *   * `NSFilenamesPboardType` is Finder's legacy path list, which still carries
 *     a multi-selection that the modern representation may reduce to one item.
 *
 * Non-file URLs (a copied web link) are dropped, and duplicates keep first
 * position, so the answer is the clipboard's own order. Directory versus file
 * is decided by the host process, not here: AppleScript can stat, but a child
 * process that reports the path list is the smaller surface.
 */
const DARWIN_PROBE_SCRIPT = [
  "ObjC.import('AppKit')",
  'var pasteboard = $.NSPasteboard.generalPasteboard',
  'var paths = []',
  'function remember(value) {',
  "  if (typeof value !== 'string' || value.length === 0) return",
  '  if (paths.indexOf(value) >= 0) return',
  '  paths.push(value)',
  '}',
  'var urls = pasteboard.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), $.NSDictionary.dictionary)',
  'if (urls && urls.count > 0) {',
  '  for (var index = 0; index < urls.count; index += 1) {',
  '    var url = urls.objectAtIndex(index)',
  '    if (url.isFileURL === true) remember(ObjC.unwrap(url.path))',
  '  }',
  '}',
  'try {',
  "  var legacy = pasteboard.propertyListForType('NSFilenamesPboardType')",
  '  if (legacy && legacy.count > 0) {',
  '    for (var other = 0; other < legacy.count; other += 1) remember(ObjC.unwrap(legacy.objectAtIndex(other)))',
  '  }',
  '} catch (error) {',
  '  /* a pasteboard without the legacy flavour simply has nothing to add */',
  '}',
  'JSON.stringify(paths)',
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
 * @param config.timeoutMs - clipboard probe budget in milliseconds.
 * @param config.powershell - PowerShell executable used for the Windows probe.
 * @param config.osascript - `osascript` executable used for the macOS probe.
 * @param config.allowNonLoopback - allow a browser on another machine to read this host's clipboard.
 * @returns nothing; the route is registered once `webServer` appears.
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) return
  const probe = {
    timeoutMs: Number(config?.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS,
    powershell:
      firstString(config?.powershell) || firstString(process.env.DSH_FOLDER_PATH_POWERSHELL) || 'powershell.exe',
    osascript:
      firstString(config?.osascript) || firstString(process.env.DSH_FOLDER_PATH_OSASCRIPT) || '/usr/bin/osascript',
  }
  const allowNonLoopback = config?.allowNonLoopback === true

  ctx.inject(['webServer'], (host) => {
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: createHandler(ctx, probe, allowNonLoopback),
        }),
      'dsh-folder-path: clipboard route',
    )
  })
}

/**
 * Build the request handler.
 * @param ctx - host plugin context, for warnings.
 * @param probe - the probe's budget and executable overrides.
 * @param allowNonLoopback - whether a non-loopback peer may read the clipboard.
 * @returns the exact-route handler.
 */
function createHandler(ctx, probe, allowNonLoopback) {
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

    if (!DESKTOP_PLATFORMS.has(process.platform)) {
      sendJson(response, 200, { ok: false, reason: 'unsupported-platform', platform: process.platform, paths: [] })
      return
    }

    let entries
    try {
      entries = await readClipboardEntries(probe)
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

/**
 * Parse the macOS probe's stdout into absolute paths.
 * @param stdout - the probe's stdout.
 * @returns the paths it reported, in clipboard order.
 * @remarks Exported for the host test suite; the probe is its only runtime caller.
 */
export function parseProbePaths(stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') return []
  let value
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error('clipboard probe returned unreadable output', { cause })
  }
  if (!Array.isArray(value)) throw new Error('clipboard probe returned an unexpected shape')
  return value.filter((entry) => typeof entry === 'string' && entry.length > 0)
}

/** The probe in flight, if any: several pastes must not fork a child process each. */
let inflight = null
let inflightKey = null

/**
 * Read the platform clipboard's file list.
 * @param probe - the probe's budget and executable overrides.
 * @returns the clipboard items, each `{ path, name, isDirectory }`.
 */
function readClipboardEntries(probe) {
  const executable = process.platform === 'darwin' ? probe.osascript : probe.powershell
  const key = `${process.platform}\u0000${executable}\u0000${String(probe.timeoutMs)}`
  if (inflight !== null && inflightKey === key) return inflight

  const run = process.platform === 'darwin' ? probeMacClipboard(probe) : probeWindowsClipboard(probe)
  const pending = run.finally(() => {
    if (inflight === pending) {
      inflight = null
      inflightKey = null
    }
  })
  inflight = pending
  inflightKey = key
  return pending
}

/**
 * Run one probe executable and return its stdout.
 * @param executable - the executable to spawn.
 * @param args - its arguments.
 * @param timeoutMs - how long it may take.
 * @returns its stdout.
 */
function runProbe(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`clipboard probe failed: ${firstLine(stderr) || messageOf(error)}`, { cause: error }))
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/**
 * Read the Windows clipboard file-drop list.
 * @param probe - the probe's budget and executable overrides.
 * @returns the clipboard items, each `{ path, name, isDirectory }`.
 */
async function probeWindowsClipboard(probe) {
  const stdout = await runProbe(
    probe.powershell,
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROBE_SCRIPT],
    probe.timeoutMs,
  )
  let payload
  try {
    payload = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'))
  } catch (cause) {
    throw new Error('clipboard probe returned unreadable output', { cause })
  }
  return Array.isArray(payload?.items) ? payload.items : []
}

/**
 * Read the macOS clipboard's file URLs and describe them on disk.
 *
 * Directory versus file is decided here with `stat`: the probe reports paths,
 * and a path that no longer exists is simply not a directory.
 *
 * @param probe - the probe's budget and executable overrides.
 * @returns the clipboard items, each `{ path, name, isDirectory }`.
 */
async function probeMacClipboard(probe) {
  const stdout = await runProbe(probe.osascript, ['-l', 'JavaScript', '-e', DARWIN_PROBE_SCRIPT], probe.timeoutMs)
  const paths = parseProbePaths(stdout)
  const entries = []
  for (const path of paths) {
    let isDirectory = false
    try {
      isDirectory = (await stat(path)).isDirectory()
    } catch {
      isDirectory = false
    }
    entries.push({ path, name: basename(path), isDirectory })
  }
  return entries
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
