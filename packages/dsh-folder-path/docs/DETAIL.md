# Paste folder path

Pasting a folder into the composer normally tries to upload it and fails. This plugin reads the folder path from the system clipboard and inserts it as text instead.

## Behavior
  - Windows and macOS only; other platforms answer `unsupported-platform`.
  - The client half intercepts paste in the capture phase and only takes over when the payload contains a directory.
  - The host half reads the system clipboard (CF_HDROP on Windows, NSPasteboard on macOS) and matches the folder names the browser reported before answering with the paths.

## Notes
  - Loopback only by default; a non-loopback peer gets `remote-not-supported`. A request carrying `Origin` must match `Host`, else 403.
  - Other platforms answer `unsupported-platform`, a failed clipboard read answers `clipboard-error`, and unmatched names answer `no-match`. In each case the client shows a notice and inserts no path.
  - Responses carry `cache-control: no-store`; the route only reads the clipboard and never opens, copies or uploads files.
