# dsh-folder-path

A DeepSeek Harness (DSH) Web plugin: paste a **folder** you copied in Windows Explorer into the
composer with `Ctrl+V` and get its **absolute path as text**, instead of the stock "upload failed"
dead end.

- Copy one folder → `Ctrl+V` → the draft gets `D:\work\data\2026Q1`
- Copy several folders → one path per line
- Ordinary text, images and real files paste exactly as before (the plugin only takes over when the
  paste payload actually contains a directory)

## The problem it solves

The browser is a sandbox: page JavaScript never sees a local file's disk path. Pasting a folder hands
the page a `File` with `size: 0` and `type: ''` — its bytes cannot be read, so DSH's upload path must
fail — and the path itself is not in the payload at all (`File.name` is just the basename).

The clipboard, however, is process-wide: on the machine running `dsh web`, it holds exactly the file
list you just copied. So the **host half** reads the Windows clipboard file list (CF_HDROP) and hands
the real absolute paths back to the browser half.

## Install

```sh
dsh plugin --profile web add C:\CodeRepository\dsh-folder-path    # from a checkout
# dsh plugin --profile web add dsh-folder-path                    # once published
```

Then **restart `dsh web` and refresh the page** (a new bundle row is not hot-loaded).

Check it mounted: `dsh --profile web --dump-config` should show a `# == dsh-folder-path` layer.

## Use

1. Select one or more folders in Explorer and press `Ctrl+C`
2. Return to the DSH Web composer and press `Ctrl+V`
3. The paths appear in the draft; when the host cannot resolve them, a notice appears and the draft is
   left untouched

## How it works

| Half | Where | Job |
|---|---|---|
| Host `lib/index.js` | host process (`webServer`) | exact route `POST /dsh-folder-path/api/v1/clipboard-paths`: read the Windows clipboard file list, match the folder names the browser reported, answer with the real absolute paths |
| Client `lib/client.js` | browser (`__ModuleLoader__` bundle) | capture-phase `paste` interception, only when the payload contains a directory; asks the host, then inserts the text through DSH's own paste path |

Insertion does not poke the DOM: the client re-dispatches a synthetic `paste` carrying only
`text/plain`, which reaches the editor's **native text-paste command** (draft state, command menu,
undo history and existing chips all stay intact). Engines that refuse to construct a `ClipboardEvent`
with clipboard data fall back to `document.execCommand('insertText')`.

The host reads the clipboard with PowerShell (`System.Windows.Forms.Clipboard`) and emits
**base64(UTF-8 JSON)**, so paths with Chinese characters or spaces survive the redirected process's
code page. Concurrent pastes share one probe.

## Configuration

Every knob is optional and lives in the profile patch layer (`~/.dsh/profiles/web/cordis.patch.yml`,
or this package's own `cordis.patch.yml`, which `dsh plugin add` wires in):

```yaml
- insert:
    - id: folder-path
      name: dsh-folder-path
      config:
        enabled: true          # false mounts the host half inert (the client then stops taking over)
        timeoutMs: 5000        # per-probe budget
        powershell: powershell.exe   # also settable via DSH_FOLDER_PATH_POWERSHELL
        allowNonLoopback: false      # true = let a remote browser read this host's clipboard
```

## Security boundary

- **Read-only**: the route only reads the clipboard; files are never opened, copied or uploaded
- **Loopback only** by default (`remote-not-supported`), so a remote browser is never handed the
  *host machine's* paths
- **Same-origin**: a request carrying `Origin` must match `Host`, else 403
- **No guessing**: the reported folder name must match a clipboard entry; otherwise the request fails
  loudly instead of returning a plausible-looking wrong path
- **No caching**: `cache-control: no-store`

## Known limitations

- **Windows only.** Other platforms answer `unsupported-platform` and the client shows a notice.
- **Paste only, not drag-and-drop.** A drop payload carries no disk path either; this plugin does not
  guess, so dropping a folder keeps the stock behaviour.
- **Remote access cannot reach your clipboard.** Over a LAN address, port forward or jump host the
  clipboard belongs to the machine running the host. That is rejected by default;
  `allowNonLoopback: true` reads the host's clipboard instead (only sensible when the browser and the
  host are the same machine reached through a LAN IP).
- Requires Windows PowerShell 5.1 with `System.Windows.Forms`; if policy blocks it the route answers
  `clipboard-error` and the client explains.

## Development

```sh
npm run build   # client/index.js -> lib/client.js (wraps the browser half as a __ModuleLoader__ bundle)
npm test        # syntax checks + host route behaviour tests (node --test, no DSH server needed)
```

Browser-side debugging hooks (devtools console):

```js
await __dshFolderPath.probe(['folder-name'])   // ask the host directly
__dshFolderPath.insert(document.querySelector('[contenteditable]'), 'text')
```

After changing the browser half: `npm run build`, then **restart `dsh web`** and refresh
(the bundle is snapshotted when the host publishes it, so a plain refresh serves the same revision).

## Credits

The architecture follows the macOS plugin [jhuanxx44/dsh-paste-path](https://github.com/jhuanxx44/dsh-paste-path)
(copy in Finder → host reads the pasteboard → Ctrl+V inserts the path): its loopback/same-origin
checks, host-side system-clipboard reads and the "the clipboard belongs to the machine running dsh"
boundary all carry over. This plugin brings the same idea to the Windows clipboard and triggers on
the **paste event's directory payload** (Windows offers no cheap pasteboard change counter to poll).

## License

MIT
