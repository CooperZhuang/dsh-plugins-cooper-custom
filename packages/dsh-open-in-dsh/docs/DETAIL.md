# Open with DSH

Wires "open with DSH" into the OS file manager and DSH context menus.

## Two directions
  - OS side: Windows Explorer context menu; macOS Finder quick action, QSpace Pro service and the `dsh-open` command.
  - DSH side: file/directory context menu actions for QSpace Pro, Finder, VS Code, Warp and Terminal; the session row menu and the document preview offer "open in QSpace".

## Implementation notes
  - The host exposes six exact-match routes under `/dsh-open-in-dsh/api/v1`: `open`, `events` (SSE), `status`, `apps`, `open-with` and `open-session`. App ids are allowlisted, paths are validated by the host, and `execFile` runs without a shell.
  - Handoff uses the plugin's own Unix socket (macOS) or the loopback HTTP route (Windows).

## Notes
  - No longer requires patching app.asar.
