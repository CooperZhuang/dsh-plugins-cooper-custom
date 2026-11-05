# Paste folder path

Pasting a folder into the composer normally tries to upload it and fails. This plugin reads the folder path from the system clipboard and inserts it instead.

## Behavior
  - Windows and macOS only; other platforms report unsupported-platform.
  - The client half intercepts paste; the host half reads the system clipboard (CF_HDROP on Windows, NSPasteboard on macOS).

## Notes
  - Falls back to default behavior when the clipboard is unavailable.
