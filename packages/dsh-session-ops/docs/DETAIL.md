# Session operations

Turns the session-to-workspace binding into an explicit tool: really delete sessions and move them
between workspaces while keeping the registry consistent.

## Two right-pane tabs
  - Delete: filter by ungrouped, temp, archived or subagent; batch select; running sessions refused by default.
  - Move: relocate the log, rewrite header cwd, follow workspace membership; optional memory follow (off).

## Other entry points
  - Session context menu: move / delete.
  - 新建工作区… in the Move tab: pick an existing directory, register it as a workspace and select it as the move target.
  - Model tools session_admin, session_move, workspace_create; host HTTP /session-admin/api, /session-move/api (including workspaceCreate).

## Session panel "session log" (kernel 0.2.2-rc.3+)

Registers one read-only section in the conversation header's Session panel: slot `conversation.session.panel.section`, id `dsh-session-ops:session`, order 350 (after environment 0 / change-requests 100 / subagents 200 / shared-tasks 250 / background-jobs 300).

  - Data plane: `/session-admin/api/health` — one `ctx.sessionPersistence.stat(sessionId)` call returns `path` / `dir` / `sizeBytes` / `compression` / `formatStatus` / `workspaceId` / `resident` / `running`; the panel shows the directory and carries an **open directory** button (`/session-admin/api/openDir`), which takes only the session id and lets the Host derive the path.
  - No list, no scan, no full log read (`readStoredLog` decompresses the whole frame chain); the section offers a manual refresh, and deeper checks are left for later.
  - A missing Session, a host without `stat`, or a throwing `stat` all come back as 200 + `{found:false, reason}`; an invalid id (empty string, path separators, …) is a structured 400.
  - A 0.2.1 host does not declare the slot: the registration stays pending without an error, and every other entry keeps working.

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
