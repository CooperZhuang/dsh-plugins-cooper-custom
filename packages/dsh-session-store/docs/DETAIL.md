# Session store library

A pure library: no host routes, no UI. It backs dsh-session-toolbox and other plugins with shared session-storage primitives.

## Provides
  - Project-directory keys (projectKey / encodeSegment).
  - session.jsonl.zstd frame scanning and header read/rewrite.
  - Workspace registry read helpers and membership operations.
  - Write-handle redirection used by session moves.

## Notes
  - Kernel-agnostic; the v4 log format is validated against real logs.
  - Mounting it alone has no visible effect.
