# Session operations

Turns the session-to-workspace binding into an explicit tool: really delete sessions and move them
between workspaces while keeping the registry consistent.

## Two right-pane tabs
  - Delete: filter by ungrouped, temp, archived or subagent; batch select; running sessions refused by default.
  - Move: relocate the log, rewrite header cwd, follow workspace membership; optional memory follow (off).

## Other entry points
  - Session context menu: move / delete.
  - Model tools session_admin, session_move; host HTTP /session-admin/api, /session-move/api.

## Shared storage primitives

Sources live in `src/store/*.ts` and are built to `lib/store/*.js`:
  - `paths.ts`: project-directory key codec (`projectKey` / `encodeSegment`), session and generation file naming.
  - `frames.ts`: `session[.vN].jsonl[.zstd]` frame scanning, header read (two strictness levels), cwd rewrite.
  - `registry.ts`: workspace membership and archive sets, resident sessions, mid-turn detection, write-handle redirection.
  - `host.ts`: `$DSH_HOME`, best-effort file logging, volatile config unwrapping.
  - `http.ts`: shared JSON response / request-body plumbing and the prefixed route skeleton.

## Notes
  - A move carries session.lock (0.2.2+ write lease) and empties the source directory; it refuses when the target already holds a lease.
  - On boot a narrow fork-child membership repair runs (repairForkChildrenOnBoot, default on).
  - Deletion is permanent: no trash, no undo. Back up `$DSH_HOME` before using it.
