# dsh-session-toolbox

The **session toolbox** for DeepSeek Harness (DSH): the former `dsh-session-admin`
(deletion) and `dsh-session-move` (relocation) plugins, merged into one package with
one host-plane plugin row and one browser half.

| Half | Was | Still provides |
| --- | --- | --- |
| delete | `dsh-session-admin` | `/session-admin/api/*`, model tool `session_admin`, right-pane "会话管理" tab, conversation-header trash icon, settings section |
| move | `dsh-session-move` | `/session-move/api/*`, model tool `session_move`, right-pane "会话归位" tab |

Both halves are **copied verbatim** (`lib/admin.js` ← `dsh-session-admin/lib/index.js`,
`lib/move.js` ← `dsh-session-move/lib/index.js`, plus `lib/engine.js` / `lib/memory.js` /
`lib/sessionlog.js` byte-for-byte). Only three things moved: the plugin entry metadata and
the config schema now live in `lib/index.js`, the two `API_PREFIX` constants became
`ADMIN_API_PREFIX` / `MOVE_API_PREFIX`, and the two `allowHosts` keys were split (different
trust-fence semantics — see below).

Session-storage knowledge (path naming, frame reading/writing, workspace registry, host and
HTTP plumbing) comes from the shared **`dsh-session-store`** package; nothing is duplicated here.

## Config keys: old → new

| old (`dsh-session-admin` row) | old (`dsh-session-move` row) | new (`session-toolbox` row) |
| --- | --- | --- |
| `enabled` | `enabled` | `enabled` (one master switch for both halves) |
| `allowHosts` | — | `adminAllowHosts` |
| — | `allowHosts` | `moveAllowHosts` |
| — | `root` | `root` |
| `headerDeleteButton` | — | `headerDeleteButton` |
| `allowWorkspaceSessions` | — | `allowWorkspaceSessions` |
| `allowLiveSessions` | — | `allowLiveSessions` |
| `maxBatch` | — | `maxBatch` |
| — | `refuseRunning` | `refuseRunning` |
| — | `maxSessions` | `maxSessions` |
| — | `memoryFollow` | `memoryFollow` |

The two `allowHosts` keys **must** stay separate: the delete half parses the `Host` header
and additionally rejects `sec-fetch-site: cross-site` and cross-origin `Origin`, while the
move half matches the socket's `remoteAddress` exactly. One shared key would loosen one of
them. A leftover `allowHosts` in an old profile is **silently ignored** (schemastery tolerates
unknown keys) — LAN access then falls back to loopback-only, which is stricter, never looser.

Only `enabled` is a semantic merge: two switches became one, so a profile with one half
enabled and the other disabled can only be expressed as "both on" or "both off".

## Browser half

One loader id (`dsh-session-toolbox`), one plugin object, two block scopes holding the two
original halves (not a single line had to be renamed). Every externally visible id is kept:

- tab kinds `dsh-session-admin:manager` / `dsh-session-move:panel`
  (`…-via-better-sidebar` when dsh-better-sidebar is present);
- header trash icon `dsh-session-admin:delete-current` (an icon plus two confirmations; the
  switch is `headerDeleteButton`, default on);
- settings section id changed from `session-admin` to `session-toolbox` (it stays: that page
  is the cleanup panel, not a config menu).

The **two config cards became one**, and since 2026-09-25 it lives on the Plugins page:
slot `plugins.bundle.config`, key = the package name `dsh-session-toolbox`, rendered on this
bundle's own page between its description and its rows. It carries all seven volatile knobs
(4 delete, 3 move). The `plugins.row.config` registration (key
`dsh-session-toolbox#session-toolbox`) was removed with it, so the same form exists once.

### Session context menu (kernel 0.2.2+)

`dsh.client.inject` declares `@deepseek-ai/dsh-client-ui-context-menu`. Each half registers
one `target: 'session'` contribution, so a session row's right-click / Shift+F10 menu gets:

- **Move session to workspace…** — resolve only decides whether a move is possible (running,
  no cwd, Host config refusal) and writes the reason into the label; `run` re-reads Host state
  and then opens the existing "Session move" pane with that session preselected;
- **Delete session…** — the same flow as the header trash icon (dry run → two confirmations →
  delete), re-probed inside `run`; the disabled reason sits in the label and it renders in the
  same footer group as the built-in Archive action.

Icons are registered in the keyed `contextMenu.icon` slot (keys
`session-toolbox.move-session` / `session-toolbox.delete-session`). `contextMenus` is an
**optional** injection: without the service (shell 0.2.1 and older) only these two entries are
missing.

## Safety defaults (unchanged)

`headerDeleteButton=true`, `allowWorkspaceSessions=false`, `allowLiveSessions=false`,
`maxBatch=200`, `refuseRunning=true`, `maxSessions=2000`, `memoryFollow=off`,
`adminAllowHosts=[]`, `moveAllowHosts=[]`. Guards, confirmations and the "mid-turn" check
are the original implementations.

## Fork child membership repair

Incident (2026-10-31): dsh-easyrewrite's "edit & resend" forks a new session and archives
the original. Two children (`session-267986cf`, `session-4cf88d34`) ended up `ungrouped`
(`workspaceTitle: null` in `session_admin`) even though the first fork's parent was a
member of the `.dsh` workspace. The client only recorded them as list placeholders, so
after a restart they vanished from the sidebar — "where did that conversation go?".
The Host's `session/fork` does call `forkWorkspace(source.header)` +
`workspace.attachSession(childId)` and replies `session/workspace-attach-failed` on
failure, yet neither fork reported an error and both stayed ungrouped (the losing step was
not identified inside the Host, so this does not bet on "it will not happen again").

### What the Host actually did (2026-10-31 review)

Source read of three kernels (0.2.1-rc.3, 0.2.1-rc.5, 0.2.2-alpha.2): `session/fork` is
the same in all three (`dsh-workspace` is byte-identical).

1. The one "succeeds but records nothing" branch is `forkWorkspace(source.header)`
   returning `undefined`: when `workspaces.find(w => w.sessionIds.includes(source.id))`
   misses and the source is not a subagent, the function returns `undefined`, the whole
   `attachSession` block is skipped, and the RPC still resolves. So **an ungrouped parent
   always yields an ungrouped child with no error** — that is the second fork (its source
   was the first child).
2. The first fork's parent *was* a `.dsh` member and the fork resolved through the success
   path (easyrewrite's failure branch logged 0 lines), so `attachSession` did run and did
   write (every failure path there rejects; nothing swallows).
3. Yet the archive written at the same moment was lost too: at 22:28 the child's unarchive
   reported `restored:false` and the parent had to be archived again. A new attach plus
   the archive set live in the same `storages/workspace.json`; only a *second Host process
   rewriting the whole file from a stale in-memory snapshot* can erase both. Evidence: two
   non-beta Host processes (pids 15206 / 15449 at 22:10:16 / 22:10:40) mounted the same
   plugins on the same `~/.dsh` (`logs/dsh-rtk-slim.log`) while the beta Host was live;
   the JSON storage backend replaces whole unit files with no cross-process lock
   (`dsh-storage-json`: single writer per unit, last write wins), and `session.lock`
   only covers session logs.

So this is not fixable by patching `session/fork`: the accounting is erased *after* attach
by a concurrent writer. The Host must fix it (cross-process locking / merged writes, or
stop sharing `$DSH_HOME` between apps); at plugin level the only product fix is to notice
and repair.

**Fix**: `mountForkMembershipRepair()` now runs two passes with the same rules:

1. **Creation**: re-file on `session/created` (covers "the Host never attached");
2. **Boot**: `sweepForkChildrenOnBoot()` lists `sessionPersistence.list()` and re-files
   fork children whose parent is accounted but the child is not (covers "the write was
   overwritten"). Toggle: `repairForkChildrenOnBoot` (default `true`).

- only ordinary fork children: `parentSession` present, `origin !== 'subagent'`,
  `delegationDepth` not > 0;
- the parent must already belong to a workspace; the child joins that same workspace,
  never a guess;
- the child's `header.cwd` must realpath to the workspace path;
- idempotent, de-duplicated, attach failures are logged only.

The boot pass is **fork children only, never a full scan**: of 343 stored sessions, 155 are
subagent children and several are deliberately ungrouped migrations; a full attach would
rewrite the user's sidebar.
Log lines (`dsh-session-move.log`): `membership repair mounted`,
`membership: attached fork child …`, `membership: attach failed …`,
`membership sweep: re-attached N of M fork child(ren) …`.

## Moving a session with `session.lock` (kernel 0.2.2+)

Since 0.2.2, `dsh-session-persistence-jsonl` writes `session.lock` into every session
directory: a POSIX flock held for the whole life of the write handle and never removed
(stable inode identifies the owner; a second writer is rejected in
`SessionWriteLease.acquire`). A move relocates the session directory from the old project
directory to the new one, so the lease file must move with it: after the log rename,
`applyPlan` renames `session.lock` into the target directory. The inode is preserved, so
the flock already held by this process follows to the new path and still blocks a second
writer; the now-empty source directory is removed. If the target directory already has a
`session.lock`, `planMove` refuses outright instead of creating a half-lease split across
two directories.

## Troubleshooting artifacts

Two log files with their original line formats are kept as they were:

- `$DSH_HOME/logs/dsh-session-admin.log` — `[iso] level message`
- `$DSH_HOME/logs/dsh-session-move.log` — `iso [level] message`

## Usage

```bash
npm test   # node --test: all ported cases from both repos, plus merge-time assertions
```

Module resolution follows the two source repos: `node_modules/dsh-session-store` and
`node_modules/@deepseek-ai/schemastery` are junctions, and `package.json` declares `link:`
dependencies the way the profile expects.
