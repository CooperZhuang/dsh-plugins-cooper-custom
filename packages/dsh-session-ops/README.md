# dsh-session-ops

Session operations for DeepSeek Harness (DSH): **really delete** persisted sessions and **move**
sessions between workspaces while keeping the workspace registry consistent.

One package, one host-plugin row, two halves:

| Half | What it does | Entry points |
| --- | --- | --- |
| delete | filter by workspace / archive / subagent, batch select, per-session guards; removes data from disk | HTTP `/session-admin/api/*`, model tool `session_admin`, right-pane "会话管理" tab, conversation-header trash icon, settings page "会话工具" |
| move | relocate the log, rewrite `header.cwd`, follow workspace membership; optional memory follow (off by default) | HTTP `/session-move/api/*`, model tool `session_move`, right-pane "会话归位" tab, session context menu |

The session-storage primitives live in this package under `lib/store/` (project-directory key
codec, `session[.vN].jsonl[.zstd]` frame read/write, workspace registry, `$DSH_HOME` and file
logging, HTTP plumbing) and are shared by both halves.

## Install

```bash
dsh plugin --profile <profile> add dsh-session-ops
```

Restart the host afterwards (or let DSH recompose the profile according to its hot-load rules).
The plugin row is declared in the bundled `cordis.patch.yml`; its entry id is `session-toolbox`.

## ⚠️ Destructive deletion

"Delete" means **really delete**, not archive:

- `<DSH_HOME>/sessions/<project-key>/<session-id>/` (session log)
- `<DSH_HOME>/storages/session_projcache/sessions/<session-id>.json` (projection cache)
- `<DSH_HOME>/rewind-snapshots/<session-id>/` (rewind snapshots, if present)

All three are removed from disk, and project directories left empty are cleaned up. **There is no
trash and no undo.** Back up `$DSH_HOME` yourself; the panel provides a dry run and two
confirmations, but the operator owns the outcome.

Safe defaults (configurable): `allowWorkspaceSessions=false`, `allowLiveSessions=false`,
`refuseRunning=true` — workspace sessions, live sessions and mid-turn moves are refused by default.

A move is not a delete: the session directory is relocated from the old project directory to the
new one, `header.cwd` is rewritten, and workspace membership follows. On kernel 0.2.2+
`session.lock` moves with it (same inode); if the target already holds a lease the move is refused
outright rather than leaving a split lease.

## Configuration

The plugin row has one shared `enabled` master switch; every other key is independent:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch; `false` registers no routes, tools or slots |
| `root` | `''` | session root override; empty derives it from `$DSH_HOME/sessions` |
| `adminAllowHosts` | `[]` | delete-half LAN trust list (parsed from the `Host` header) |
| `moveAllowHosts` | `[]` | move-half LAN trust list (exact socket `remoteAddress` match) |
| `headerDeleteButton` | `true` | conversation-header trash icon (icon + two confirmations) |
| `allowWorkspaceSessions` | `false` | allow deleting sessions that belong to a workspace |
| `allowLiveSessions` | `false` | allow deleting sessions still loaded in the host |
| `maxBatch` | `200` | per-call batch delete limit |
| `refuseRunning` | `true` | refuse moving a session that is mid-turn |
| `maxSessions` | `2000` | max sessions listed by the move panel |
| `memoryFollow` | `off` | project-memory follow: `off` / `copy` / `move` (`move` is irreversible) |
| `repairForkChildrenOnBoot` | `true` | re-file fork children whose membership was lost, at boot |

The two trust keys **cannot** be merged: the delete half parses the `Host` header and additionally
rejects `sec-fetch-site: cross-site` and cross-origin `Origin`, while the move half matches the
socket address exactly. Merging them would loosen one half. Both only affect LAN access; loopback is
always trusted.

The browser half registers one config card on the Plugins page: slot `plugins.bundle.config`, key =
the package name `dsh-session-ops`, carrying the seven volatile knobs (4 delete + 3 move). Saving
writes back to the profile's `cordis.patch.yml`; no restart needed.

## Compatibility

- Node.js `>=24`
- DSH `^0.2.1-rc.2 || ^0.2.2-alpha.2`

The session context menu needs the kernel's `@deepseek-ai/dsh-client-ui-context-menu` service
(0.2.2+); without it only those two menu entries are missing — tabs, tools and HTTP endpoints keep
working. Moving `session.lock` and the boot-time fork-child repair both follow the 0.2.2+
persistence implementation.

## Troubleshooting artifacts

Two file logs keep their original line formats (historical artifacts, deliberately not unified):

- `$DSH_HOME/logs/dsh-session-admin.log` — `[iso] level message`
- `$DSH_HOME/logs/dsh-session-move.log` — `iso [level] message`

Key move/repair lines: `membership repair mounted`, `membership: attached fork child …`,
`membership: attach failed …`, `membership sweep: re-attached N of M fork child(ren) …`.

## Using it as a library

`lib/store/` is independent of the plugin lifecycle and has zero `@deepseek-ai/*` dependencies, so it
can be imported on its own. Two entries are published:

```js
// package root: same surface as the former shared session-store entry
import { projectKey, readSessionHeader, hasZstd } from 'dsh-session-ops'

// or the explicit layered subpath
import { projectKey, readSessionHeader, hasZstd } from 'dsh-session-ops/store'
```

## Development

```bash
npm run build     # tsc -p tsconfig.json: src/ -> lib/ (plus lib/types/)
npm test          # build, then node --test: both halves plus lib/store
```

Host code lives in `src/` as TypeScript; `lib/*.js` and `lib/types/` are the `tsc` output committed
with the repo (so a checkout/profile install works without a build). `lib/client.js` is the one
hand-written file: an IIFE for the browser classic-script loader, not compiled by `tsc`.

## License

MIT © 2026 Cooper Zhuang
