# Cross-memory: implementation notes

dsh-cross-memory extracts whatever is worth keeping from a session (preferences, decisions, pitfalls, promises) into scoped memory entries, stores them in a local memory store under `global` and `project` scopes, and injects the relevant ones into later sessions within a layered budget. The model can also read and write entries through the `memory` tool. Installation, configuration keys and the command list live in [README](../README.md); this document covers the implementation layers and their limits.

## Scopes and entry files

- `global` holds facts that apply across projects, under `$DSH_HOME/memories`. `project` holds facts that apply to one workspace, under `$DSH_HOME/memories/projects/<slug>`; every session started anywhere inside that workspace shares the same directory.
- An entry id is derived from its title (`slugify(title)`): the title is the identity, so writing the same title again updates the entry instead of adding a new one.
- An entry file is Markdown: a frontmatter block plus the body. The frontmatter records `id`, `scope`, `kind`, `title`, `tags`, `keys`, `appliesTo`, `source`, `created`/`updated`, and optionally `durability: snapshot` with `asOf`, `pinned`, `permanent`, `voice: user`, `supersedes`, `derivedFrom`; extracted entries also carry `session`, `quote` and `evidenceSeq`.
- Files are the source of truth. `index.json` is a rebuildable cache and self-heals on the next read after being edited or deleted by hand.

## Injection layers

Each conversation receives the following blocks in order, each with its own budget:

1. `<persona>`: a snapshot of the user profile, bounded by `personaMaxBytes` (default 12000 bytes, `0` disables it) and truncated at a line boundary. A legacy single-file `persona.md` is still read; saving writes `persona/human.md`.
2. Memory summary: within `maxSummaryBytes` (default 4096), split into a `global` and a `project` section. Both scopes share one byte budget and `global` renders first, so it also has `globalSummaryEntries` and `globalSummaryBytes` caps of its own.
3. Delta block: memories written after the summary was injected are announced in small blocks (`injectDelta`, at most twice per conversation).
4. Title rotation: titles the summary had no room for, `rotationEntries` (default 16) per conversation, re-emitted every `rotationEveryTurns` (default 8) user turns in a long session.
5. On-demand recall: injected only when the current user turn lands enough distinct terms in an entry's title, `keys`, `tags` or `appliesTo` (or matches a whole phrase) (`recallMinTerms` default 2, `recallMinScore` default 9, at most `recallMaxPerConversation` per conversation). A term appearing in more than `evidenceMaxDf` (default 0.15) of one scope does not count as evidence.
6. Raw excerpts: with `rawRecall` on, the recall block also carries original excerpts from the source session, read from the persisted session logs on this machine only.

Every injected block says that memories are background data rather than instructions, and that an entry records what was true when it was written, not necessarily now.

## Extraction

Extraction is the first pass. It runs on the maintenance path and never touches the conversation:

- A session is mined after it has been idle for `autoExtractIdleMs` (default 300000 ms); `extractIntervalMinutes` (default 30) additionally checks every open session on a timer. `minIdleHours` (default 6) and `maxAgeDays` (default 10) decide whether a session is still eligible, and one pass mines at most `maxSessionsPerPass` (default 2) sessions.
- One extraction reads the most recent `extractWindowMessages` (default 60) messages, taking only user and assistant prose: tool results and plugin-injected context are dropped so memory never feeds on its own summaries.
- Every candidate must carry a verbatim quote that actually occurs in the window, or it is dropped. Before anything is written, credential-shaped text is redacted (`sk-…`, `ghp_…`, `AKIA…`, JWT, private-key blocks, `api_key=…`, `Bearer …`, and similar).
- Background model calls are cost- and quota-guarded: `peakHours` can defer them out of peak windows (empty by default), and `pauseOnQuotaError` (on by default) pauses them after a rate-limit or exhausted-quota error, with a cooldown that starts at `quotaCooldownMinutes` (default 30), doubles per consecutive refusal, and is capped by `quotaCooldownMaxMinutes` (default 480).

## Consolidation and pending decisions

Consolidation is the second pass. It resolves contradictions and fragments across sessions:

- Recent memories go to a restricted sub-agent that owns no tools (preset `memories-consolidator`) and must answer with strict JSON. The plugin applies that JSON itself, after taking a snapshot, so a failed plan can be rolled back. A deployment without a preset registry falls back to one plain model call that also owns no tools.
- Only reversible changes are applied unattended: merging duplicates, sharpening wording, retiring entries nothing ever read. Rewrites and retirements that could lose information wait for you: an entry a person wrote, a pinned or permanent entry, a retire of a memory that was actually read, and a rewrite that drops cited file paths or shrinks the body below half its previous length are never applied silently.
- An existing entry never changes scope; only new memories are placed as `global` or `project` by this pass.
- A pending proposal expires after `consolidateProposalMaxAgeHours` (default 72). `autoDecide` (on by default) lets an AI adjudicate first, but a verdict below `autoDecideMinConfidence` (default 0.7) still waits for you.
- When two memories contradict each other, the sub-agent reports the pair as a conflict instead of picking one silently.
- Consolidation maintains the persona profile unless `persona/human.lock` exists, and turns repeatable procedures into skill drafts (at most 2 per pass). A draft lands in `memories/skills/<name>/SKILL.md`; `/memories promote` copies it to `$DSH_HOME/skills/<name>/SKILL.md`, and re-promotion is refused when the promoted copy is newer than the draft.

## Retention and archival

- A memory that has not been read or surfaced, and is not newly written, for `maxUnusedDays` (default 90) is archived. Archiving is not deletion: `/memories restore` brings it back.
- An entry with `durability=snapshot` is also archived once it is `snapshotMaxAgeDays` (default 60) past the moment it was measured; reading a stale reading does not make it fresh.
- `maxEntriesPerScope` (default 1000) caps each scope; past it, the least recently read or surfaced entries are archived. `pinned`, `permanent` and `source=user` entries are never retired automatically, so a scope can stay slightly above its cap.
- Each scope's `archive/` keeps the newest 500 files; older archives are cleaned up.
- Evidence notes under `sessions/` keep the newest 200; older ones are removed. When a note is gone, `evidence` says so explicitly instead of inventing a summary.
- `forget` (the `memory` tool and `/memories forget`) is a physical delete, with no restore.

## Storage, logs and multi-machine sync

- Entries, evidence notes, the persona, reflections and skill drafts are ordinary files. Watermarks, job leases and usage counters live in `state.db` (Node's built-in `node:sqlite`). Without `node:sqlite`, watermarks survive only in-process, so a restart may re-mine sessions that were already processed.
- The plugin log defaults to `$DSH_HOME/logs/dsh-cross-memory.log`, rotated once at 2 MB by renaming the old file to `<path>.1`; exactly one rotated generation is kept. `npm run report` is a read-only digest of the log and `state.db`.
- The memory store is a Git working copy: writes only commit locally (bursts folded by `syncDebounceSeconds`, default 2), while fetch/rebase/push run on a background timer (`syncClock` defaults to `12:05,18:05`; empty falls back to `syncIntervalMinutes`, default 10; `0` stops the timer). No failure on the sync path may fail a memory write or leave the repository mid-rebase.
- The store's `.gitignore` keeps per-machine state out: `state.db`, `state.db-shm`, `state.db-wal`, `index.json`, `**/index.json`, `**/project.json`, `pending/`, `*.log`, `.DS_Store`.
- Conflicts: safely mergeable changes merge automatically; changes that could lose information go to the pending-decisions panel. Without a usable model route the newer `updated` stamp wins and the older text stays in Git history. A conflict on an archived entry takes the newer revision and never enters the panel.

## Browser API and settings page

- The plugin exposes a `memories` namespace to the browser through Typert, with 10 methods: `overview`, `list`, `add`, `forget`, `promoteSkill`, `discardSkill`, `persona`, `savePersona`, `disputes`, `resolveDispute`.
- The Memories settings page has four tabs: Memories, Persona, Configuration, and Needs review; the same config card also appears on the Plugins page under this package.
- A deployment without a gateway (headless, tui) has no settings page; the model tool, `/memories`, and the background maintenance passes work unchanged.

## Limits

- Recall is lexical (title, `keys`, `tags`, `appliesTo`, body) with time decay and a one-hop expansion along shared `keys`/`tags` — not vector search; the on-demand gate counts only title, `keys`, `tags` and `appliesTo`. Chinese is handled as character bigrams: a shared run of two characters counts as one strong term.
- An injected memory is what was concluded when it was written, not current truth; use `memory` action=evidence to open the source conversation when it matters.
- A `snapshot` value expires from when it was measured; do not use one in place of a reading that changes on its own.
- Extraction and consolidation are quota- and peak-hour aware; neither is guaranteed to have run at any particular moment.
