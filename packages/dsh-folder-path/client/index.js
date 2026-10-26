/**
 * `dsh-folder-path` browser half.
 *
 * Shipped as the package's `./client` bundle: the DSH client module system
 * loads it as a `window.__ModuleLoader__.load({ id, factory })` script, calls
 * `factory(require)`, and mounts the exported plugin (`apply`) into the browser
 * Cordis tree.
 *
 * What it does — one thing, in the capture phase, before the conversation
 * plugin's Lexical paste command can turn the folder into a doomed upload:
 *
 *   * a paste is inspected for entries that are *directories*
 *     (`webkitGetAsEntry().isDirectory`; the paste payload is a `File` of size 0
 *     with no bytes to upload, which is why 上传失败 appears today);
 *   * the pasted folder names go to the host half, which reads the Windows
 *     clipboard and answers with the real full paths;
 *   * those paths are inserted into the composer as plain text by re-dispatching
 *     a synthetic text/plain paste, so the insertion goes through DSH's own
 *     composer path (command menu, draft state, undo history) instead of
 *     poking at the DOM.
 *
 * Ordinary pastes — text, images, real files — are never touched: the handler
 * returns before `preventDefault()` unless a directory is present.
 */

/** The host route; hand-mirrored from `lib/index.js` (ROUTE_PATH). */
var ROUTE_PATH = '/dsh-folder-path/api/v1/clipboard-paths'

/** Marks the synthetic events this plugin dispatches, so they are not re-read. */
var SYNTHETIC = '__dshFolderPathSynthetic'

/** The composer's editable root, as Lexical renders it. */
var EDITABLE_SELECTOR = '[contenteditable=""],[contenteditable="true"]'

/** How long a failure notice stays on screen. */
var TOAST_MS = 5000

/**
 * Split a paste payload into directories and files.
 *
 * `webkitGetAsEntry()` is the only reliable directory signal. The
 * `size === 0 && type === ''` arm is a fallback for engines without the entry
 * API; it is deliberately not applied when an entry exists, so a genuinely
 * empty file is never mistaken for a folder.
 *
 * @param dataTransfer - the event's clipboard or drag data.
 * @returns directory basenames and the non-directory files.
 */
function classifyPayload(dataTransfer) {
  var directories = []
  var files = []
  var items = dataTransfer.items ? Array.prototype.slice.call(dataTransfer.items) : []

  for (var index = 0; index < items.length; index += 1) {
    var item = items[index]
    if (item.kind !== 'file') continue

    var entry = null
    try {
      entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    } catch (error) {
      entry = null
    }

    if (entry !== null) {
      // The entry API answers both questions. Reading the file of a directory is
      // deliberately skipped: the browser hands over a zero-byte `File` whose
      // bytes cannot be read, which is the upload failure this plugin exists to
      // avoid, so there is nothing to forward for it.
      if (entry.isDirectory === true) {
        if (entry.name) directories.push(entry.name)
        continue
      }
      var entryFile = null
      try {
        entryFile = item.getAsFile()
      } catch (error) {
        entryFile = null
      }
      if (entryFile !== null) files.push(entryFile)
      continue
    }

    var file = null
    try {
      file = item.getAsFile()
    } catch (error) {
      file = null
    }
    if (file === null) continue
    if (file.size === 0 && file.type === '') {
      // No entry API (a non-Chromium engine): a zero-byte, type-less item is
      // the only directory-shaped signal left to go on.
      if (file.name) directories.push(file.name)
      continue
    }
    files.push(file)
  }

  return { directories: directories, files: files }
}

/**
 * Find the composer root a paste belongs to.
 *
 * A paste into anything that is not an editable surface is left alone: the
 * plugin swallows events it handles, and swallowing a paste it cannot insert
 * into would silently eat user data.
 *
 * @param target - the event target.
 * @returns the editable root element, or null.
 */
function editableRootOf(target) {
  var candidates = [target, document.activeElement]
  for (var index = 0; index < candidates.length; index += 1) {
    var candidate = candidates[index]
    if (candidate && typeof candidate.closest === 'function') {
      var root = candidate.closest(EDITABLE_SELECTOR)
      if (root !== null) return root
    }
  }
  return null
}

/**
 * Ask the host half for the full paths behind the pasted folder names.
 * @param names - directory basenames the browser saw.
 * @returns the resolved paths (empty when the host could not answer).
 */
async function requestPaths(names) {
  var response = await fetch(ROUTE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ names: names }),
  })
  if (!response.ok) return { paths: [], reason: 'http-' + String(response.status) }
  var payload = await response.json()
  if (payload && payload.ok === true && Array.isArray(payload.paths)) {
    return { paths: payload.paths, reason: null }
  }
  return { paths: [], reason: (payload && payload.reason) || 'unknown' }
}

/**
 * Insert plain text through DSH's own paste path.
 *
 * A synthetic `paste` carrying only `text/plain` reaches the same Lexical
 * command a real text paste does, so the draft, command menu and undo history
 * stay consistent. `execCommand` is the fallback for engines that refuse to
 * construct a `ClipboardEvent` with clipboard data.
 *
 * @param root - the composer's editable root.
 * @param text - the text to insert.
 */
function insertText(root, text) {
  root.focus({ preventScroll: true })
  try {
    var dataTransfer = new DataTransfer()
    dataTransfer.setData('text/plain', text)
    var event = new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true })
    event[SYNTHETIC] = true
    root.dispatchEvent(event)
    if (event.defaultPrevented) return
  } catch (error) {
    /* fall through to the DOM insertion below */
  }
  document.execCommand('insertText', false, text)
}

/**
 * Hand non-directory files back to the composer.
 *
 * Copying a folder and files together is legal; the files still belong to the
 * attachment flow, so they are forwarded as one synthetic file paste after the
 * paths are in.
 *
 * @param root - the composer's editable root.
 * @param files - the files taken out of the original paste.
 */
function forwardFiles(root, files) {
  if (files.length === 0) return
  try {
    var dataTransfer = new DataTransfer()
    for (var index = 0; index < files.length; index += 1) dataTransfer.items.add(files[index])
    var event = new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true })
    event[SYNTHETIC] = true
    root.dispatchEvent(event)
  } catch (error) {
    /* the paths are the point; a failed forward must not undo them */
  }
}

/**
 * Failure copy for a host answer.
 * @param reason - the host's reason code.
 * @returns the message to show.
 */
function failureText(reason) {
  if (reason === 'unsupported-platform') return '这个宿主不是 Windows，无法读取文件夹的完整路径'
  if (reason === 'remote-not-supported') return '当前页面不在运行 dsh web 的这台机器上，读不到这台机器的剪贴板'
  if (reason === 'clipboard-error') return '读取剪贴板失败，没能解析文件夹的完整路径'
  if (reason === 'no-match') return '剪贴板里的内容与粘贴的文件夹不一致，没能解析完整路径'
  return '没能解析文件夹的完整路径（宿主未响应）'
}

/**
 * Show a short-lived notice above the composer.
 * @param message - the text to show.
 */
function toast(message) {
  try {
    var element = document.createElement('div')
    element.textContent = message
    element.setAttribute('data-dsh-folder-path-toast', '')
    element.style.cssText =
      'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483000;' +
      'max-width:70vw;padding:8px 14px;border-radius:10px;background:rgba(28,28,30,0.92);color:#fff;' +
      'font-size:13px;line-height:1.45;box-shadow:0 6px 24px rgba(0,0,0,0.28);pointer-events:none;'
    document.body.appendChild(element)
    setTimeout(function () {
      element.remove()
    }, TOAST_MS)
  } catch (error) {
    /* a missing notice must never break the paste */
  }
}

/**
 * Build the browser-half plugin from the bundle's `require`.
 * @param require - the module system's synchronous require.
 * @returns the plugin's `apply`.
 */
function createPlugin(require) {
  /**
   * Resolve the pasted folders and put their paths in the composer.
   * @param root - the composer's editable root.
   * @param directories - the pasted directory basenames.
   * @param files - the non-directory files from the same paste.
   */
  async function resolveAndInsert(root, directories, files) {
    var result
    try {
      result = await requestPaths(directories)
    } catch (error) {
      result = { paths: [], reason: 'host-unreachable' }
    }
    if (result.paths.length === 0) {
      toast(failureText(result.reason))
      forwardFiles(root, files)
      return
    }
    if (!root.isConnected) {
      toast('输入框已经关闭，路径没有插入：' + result.paths.join('、'))
      return
    }
    insertText(root, result.paths.join('\n'))
    forwardFiles(root, files)
  }

  /**
   * Capture-phase paste handler: intercepts directory pastes only.
   * @param event - the paste event.
   */
  function onPaste(event) {
    if (event[SYNTHETIC] === true) return
    if (!event.clipboardData) return

    var payload = classifyPayload(event.clipboardData)
    if (payload.directories.length === 0) return

    var root = editableRootOf(event.target)
    if (root === null) return

    event.preventDefault()
    event.stopPropagation()
    void resolveAndInsert(root, payload.directories, payload.files)
  }

  /**
   * Mount the listener; the returned plugin is applied by the client runner.
   * @param ctx - browser Cordis context.
   */
  function apply(ctx) {
    document.addEventListener('paste', onPaste, true)
    ctx.effect(
      function () {
        return function () {
          document.removeEventListener('paste', onPaste, true)
        }
      },
      'dsh-folder-path: paste listener',
    )

    // Troubleshooting hook: the same resolution the paste path uses, callable
    // from the devtools console (`await __dshFolderPath.probe(['name'])`).
    window.__dshFolderPath = {
      route: ROUTE_PATH,
      probe: requestPaths,
      insert: insertText,
      classify: classifyPayload,
    }
  }

  return { apply: apply }
}
