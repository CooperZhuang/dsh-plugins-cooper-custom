# Paste folder path

Pasting a folder into the composer normally tries to upload it and fails. This plugin reads the folder path from the system clipboard and inserts it instead.

## Behavior
  - Windows only; other platforms report unsupported-platform.
  - The client half intercepts paste; the host half reads the system clipboard.

## Notes
  - Falls back to default behavior when the clipboard is unavailable.
