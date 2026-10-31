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

**Fix**: `mountForkMembershipRepair()` re-files the child on `session/created`
(`lib/move.js`):

- only ordinary fork children: `parentSession` present, `origin !== 'subagent'`,
  `delegationDepth` not > 0;
- the parent must already belong to a workspace; the child joins that same workspace,
  never a guess;
- the child's `header.cwd` must realpath to the workspace path;
- idempotent, de-duplicated, attach failures are logged only.

**No** startup sweep: of 343 stored sessions, 155 are subagent children and several are
deliberately ungrouped migrations; a full attach would rewrite the user's sidebar.
Log lines (`dsh-session-move.log`): `membership repair mounted`,
`membership: attached fork child …`, `membership: attach failed …`.

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
