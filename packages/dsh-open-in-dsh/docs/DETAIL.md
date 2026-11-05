# Open with DSH

Wires "open with DSH" into the OS file manager and DSH context menus.

## Two directions
  - OS side: Windows Explorer context menu; macOS Finder quick action, QSpace service and the dsh-open handoff.
  - DSH side: file/directory context menu actions for QSpace Pro, Finder, VS Code, Warp and Terminal.

## Implementation notes
  - The host exposes an open-with route with an app allowlist; arbitrary commands are rejected.

## Notes
  - No longer requires patching app.asar.
