# Session toolbox

Turns the session-to-workspace binding into an explicit tool: really delete sessions and move them between workspaces while keeping the registry consistent.

## Two right-pane tabs
  - Delete: filter by workspace, archive or subagent; batch select; running sessions refused by default.
  - Move: relocate the log, rewrite header cwd, follow workspace membership; optional memory follow (off).

## Other entry points
  - Session context menu: move / delete.
  - Model tools session_admin, session_move; host HTTP /session-admin/api, /session-move/api.

## Notes
  - A move carries session.lock (0.2.2+ write lease) and empties the source directory; it refuses when the target already holds a lease.
  - On boot a narrow fork-child membership repair runs (repairForkChildrenOnBoot, default on).
