/**
 * Configuration for `dsh-cross-memory`.
 *
 * One row config, two kinds of field, deliberately separated:
 *
 * - **Deployment** (`dshHome`, `memoriesDir`, `projectRootMarkers`, `logFile`):
 *   where the store lives and how a workspace root is identified. Composition
 *   facts; changing one means remounting the row.
 * - **Tunables**: every behavioural knob, declared in {@link Config} with
 *   `.volatile()`. That marker is what makes a field live — the Loader hands it
 *   to `apply` as a reference rather than a value, the settings domain projects
 *   it into the browser, and a write from the Memories page updates the
 *   reference in place (announced as `loader/volatile-update`), so a knob takes
 *   effect without a restart or a reload. {@link MemoriesSettings} is the same
 *   field list as plain data, which is what the runtime reads.
 *
 * @module dsh-cross-memory/config
 */
import z from '@deepseek-ai/schemastery'
import { isVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { logPath, toLogLevel } from './log.js'

/**
 * Profile entry id owning this plugin, and therefore the key its tunables are
 * addressed by: the Memories page and the Plugins-page configuration card both
 * ask for this form as `ctx.configForms.get('memories')`, and a composition row
 * in `cordis.patch.yml` overrides it under the same id.
 */
export const ENTRY_ID = 'memories'

/** Default child-name markers that identify a workspace root. */
export const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const

/** Default background sync interval, in minutes; used when no clock times are set. */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 10

/** Default clock times: just after DeepSeek off-peak pricing starts (12:00 and 18:00 local). */
export const DEFAULT_SYNC_CLOCK = '12:05,18:05'

/** Default debounce before a burst of memory writes becomes one commit, in seconds. */
export const DEFAULT_SYNC_DEBOUNCE_SECONDS = 2

/**
 * Default byte budget for the injected memory summary.
 *
 * 4096 was sized when a store held a few dozen entries. On a real long-lived
 * store the summary is the ONLY projection most conversations ever see, and at
 * 4 KB it could not even list the dozen entries the per-scope cap allowed once
 * the entries were Chinese (measured on the Ornn8 six-persona benchmark: a
 * 5120-byte budget rendered 12 of 149-326 live entries, so 96% of the store was
 * invisible unless the on-demand recall happened to fire). 8192 roughly doubles
 * the rendered set at the cost of one extra cached prefix block per session.
 */
export const DEFAULT_MAX_SUMMARY_BYTES = 8192

/** Default cap on entries listed in the injected summary per scope. */
export const DEFAULT_MAX_SUMMARY_ENTRIES = 20

/**
 * Whether a conversation is told about memories written after its summary.
 *
 * The summary is a snapshot from the first step of the conversation, so a
 * memory extracted or consolidated ten turns later would otherwise stay
 * invisible until the model thought to search for it. The delta block is
 * bounded (two per conversation, 800 bytes each) and only names entries whose
 * `updated` stamp is newer than the last injection, so it costs one short
 * paragraph rather than a second summary.
 */
export const DEFAULT_INJECT_DELTA = true

/**
 * Byte budget for one delta block.
 *
 * 800 was the first guess and it is too tight to be useful: a complete entry
 * renders at 200-350 bytes once the title, kind, tags and a body preview are
 * in, so the block admitted two entries at most and often one. A late
 * conversation that changed topic then got almost nothing. 1600 fits four to
 * six, which is the size of a topic shift rather than of a single note.
 */
export const DEFAULT_DELTA_MAX_BYTES = 1600

/**
 * How many additional memories one conversation lists by title only.
 *
 * The summary can only name a dozen entries and reserves at most a third of its
 * slots for never-surfaced material; measured on a real store at baseline that
 * left 58.6% of live entries never injected or read. Sixteen titles cost about
 * 1.6 KB and are enough to make the whole store discoverable over a couple of
 * dozen sessions: each conversation rotates through the entries the summary did
 * not have room for, oldest-unseen first. The global scope takes three quarters
 * of the block, so a global library of 600 entries moves about 12 a session.
 * 0 disables the rotation block.
 */
export const DEFAULT_ROTATION_ENTRIES = 16

/**
 * User turns between rotation blocks inside one long conversation.
 *
 * Once per conversation is not enough for a session that runs for hours: the
 * store keeps growing and the model keeps needing names it has not seen yet.
 * Re-arming the block every this many USER turns keeps the cost bounded (one
 * ~1.6 KB block per span) and lets coverage accumulate within a single long
 * session. 0 keeps the old once-per-conversation behaviour.
 */
export const DEFAULT_ROTATION_EVERY_TURNS = 8

/** Byte budget for the title-only rotation block. */
export const DEFAULT_ROTATION_MAX_BYTES = 1600

/**
 * Default cap on the GLOBAL section's bullets, below {@link DEFAULT_MAX_SUMMARY_ENTRIES}.
 *
 * The two scopes share one byte budget and the global section renders first, so
 * an uncapped global scope absorbs whatever the project scope leaves over.
 * Measured on a real store: a two-memory project session spent 87% of its budget
 * on global entries, and in every session the same six were unrelated to the
 * workspace (a plugin's logger threshold, a sidebar adapter, a model catalog).
 * Four keeps the portable half visible without letting it bury the scope that is
 * actually about this conversation. Six follows the per-scope raise: the global
 * half is what every unrelated conversation can use, and four was leaving the
 * same six entries to compete for a budget that now has room.
 */
export const DEFAULT_GLOBAL_SUMMARY_ENTRIES = 6

/**
 * Default byte budget for the global section alone, inside {@link DEFAULT_MAX_SUMMARY_BYTES}.
 *
 * A count cap is not enough. Chinese entries cost roughly three bytes per
 * character, so four of them fill about 2.6 KB of a 4 KB block — measured on a
 * real store the global half still took 45–81% of every session after the count
 * cap was added. Reserving bytes is what actually leaves room for the scope that
 * is about this conversation.
 *
 * 1200 is about a third of the content budget: the block's frame (intro and
 * guidance) costs ~700 bytes of the 4096, so the two scopes divide ~3400, and a
 * third to the half that every session shares leaves two thirds to the half that
 * is actually about this workspace.
 */
export const DEFAULT_GLOBAL_SUMMARY_BYTES = 1200

/**
 * Default number of those entries reserved for memories never listed before.
 *
 * Three, because the reservation is a queue that drains: once an entry has been
 * listed it leaves the pool, and unused slots fall back to the ranking, so the
 * steady-state cost is one slot per newly written memory. It only ever costs
 * more than that while there is a backlog of never-listed memories — which is
 * exactly when showing them matters. Measured on a real store, two slots pushed
 * the correction of an already-listed memory to the *next* session and three
 * showed both in the first one. `0` restores pure ranking, which on a saturated
 * scope is a fixed point that never shows anything new.
 */
export const DEFAULT_SUMMARY_FRESH_SLOTS = 3

/**
 * Default cap on stored entries per scope before the least recently used are evicted.
 *
  * There is no cap by default (`0`). A cap is a storage decision, not a memory
  * decision: the store is files on disk, the recall path reads an inverted index
  * (`prefilterEntries`), and the summary already selects a bounded, ranked slice,
  * so a large store costs index size rather than correctness. When a cap IS set,
  * the least-attended entries are archived (never deleted) and `pinned`,
  * `permanent` and `user`-written entries are exempt.
  */
export const DEFAULT_MAX_ENTRIES_PER_SCOPE = 0

/** Default hours between periodic maintenance sweeps; `0` disables the sweep. */
export const DEFAULT_SWEEP_INTERVAL_HOURS = 12

/**
 * Default days an unused memory survives before it is archived; `0` disables archival.
 *
 * Off by default for the same reason the cap is: an entry nobody has happened to
 * read yet is not a stale entry, and archiving it removes it from recall without
 * a person having decided anything. Retrieval already ranks by decay and use, so
 * an unused memory sinks instead of being lost. Set a number to re-enable the
 * age-based sweep.
 */
export const DEFAULT_MAX_UNUSED_DAYS = 0

/**
 * Default days a `snapshot` memory survives before it is archived; `0` disables.
 *
 * A reading taken at one moment is wrong from the day after it was taken, and
 * reading it does not make it right, so it cannot be judged by the unused clock
 * that a convention is judged by. Off by default: the decay ranking already
 * pushes an old reading down, and archiving it outright is a loss nobody asked
 * for. Set a number to re-enable snapshot expiry.
 */
export const DEFAULT_SNAPSHOT_MAX_AGE_DAYS = 0

/** Default share of title/body tokens two memories must have in common to be merged. */
export const DEFAULT_DEDUPE_SIMILARITY = 0.7

/** Default recall mode: how much of a conversation pays for cross-session memory. */
export const DEFAULT_RECALL_MODE = 'on-demand'

/**
 * Default minimum relevance a recall delta must reach.
 *
 * 20 was the old value and it silently disabled Chinese recall: a Chinese
 * paraphrase that shares two bigrams with a title scores around 9-12, so nothing
 * ever cleared it. The floor is now a strictness knob, and the PRECISION lives in
 * `recallMinTerms` — the structural evidence gate, which a score threshold cannot
 * replace. 6 is deliberately below the 8 a single shared title bigram scores: a
 * one-bigram paraphrase (「北街南街」 against 「南街文具店」) is a real match that
 * the old floor refused, and the term gate plus the hub discount are what keep a
 * shared common word from recalling everything.
 */
export const DEFAULT_RECALL_MIN_SCORE = 6

/** Default cap on recall deltas injected into one conversation. */
export const DEFAULT_RECALL_MAX_PER_CONVERSATION = 8

/**
 * Default byte budget for one recall delta block.
 *
 * Sized for the several short entries a single turn can legitimately match, not
 * for one: the frame and the preamble cost roughly 250 bytes, and a one-line
 * entry costs about 90. At 800 a two-entry block would not fit, which is why
 * this is not 400 as it was when a delta could only ever hold one memory.
 */
export const DEFAULT_RECALL_MAX_BYTES = 2_400

/** Default minimum length of a user turn worth a recall decision. */
export const DEFAULT_RECALL_MIN_QUERY_CHARS = 2

/**
 * Whether a recall block may also carry original conversation excerpts.
 *
 * Off by default: this injects prose from *other* sessions, which is a privacy
 * step beyond recalling a memory summary, so it is opt-in.
 */
export const DEFAULT_RAW_RECALL = false

/** Byte budget for the raw excerpt half of one recall block. */
export const DEFAULT_RAW_RECALL_BYTES = 2_400

/** Most raw excerpts one recall block may carry. */
export const DEFAULT_RAW_RECALL_EXCERPTS = 3

export const DEFAULT_RAG_RECALL = true
export const DEFAULT_RAG_RECALL_BYTES = 2_400
export const DEFAULT_RAG_RECALL_EXCERPTS = 4
export const DEFAULT_RAG_RECALL_SESSIONS = 0
export const DEFAULT_RAG_RECALL_CHARS = 600

/**
 * Default number of distinct strong-field terms a recall needs.
 *
 * Two was the old precision gate, but a Chinese paraphrase of a stored fact
 * routinely shares exactly ONE substantive word with it: a benchmark turn asking
 * 「理零票第一步」 against a memory filed as 「整理小票先按日期分堆」 shares only
 * 票, and 「点碗粉加两个小菜」 against 「不吃香菜」 shares only 菜. Two terms made
 * those unreachable no matter how high the relevance score was. One term plus the
 * relevance floor is the gate now; the floor (8) is what keeps a shared common
 * word like 插件 or 日志 from recalling everything, and the entity path in
 * `recallFor` adds a second, stronger signal on top.
 */
export const DEFAULT_RECALL_MIN_TERMS = 1

/**
 * Every valid recall mode.
 *
 * `once` is the original behaviour (one bounded summary per conversation, every
 * later recall through the tool); `on-demand` additionally injects a small delta
 * when the current turn clearly matches a stored memory; `off` leaves only the
 * tool. The mode decides what a conversation pays for, so it is a user knob.
 */
export const RECALL_MODES = ['once', 'on-demand', 'off'] as const

/** How much cross-session memory one conversation pays for. */
export type RecallMode = (typeof RECALL_MODES)[number]

/** Narrow an unknown value to a recall mode, defaulting to `on-demand`. */
export function toRecallMode(value: unknown): RecallMode {
  return typeof value === 'string' && (RECALL_MODES as readonly string[]).includes(value)
    ? value as RecallMode
    : DEFAULT_RECALL_MODE
}

/** Default idle delay before a finished session is mined for memories. */
export const DEFAULT_AUTO_EXTRACT_IDLE_MS = 300_000

/** Default number of surface messages handed to the extractor. */
export const DEFAULT_EXTRACT_WINDOW_MESSAGES = 60

/** Default character budget for the extraction transcript. */
export const DEFAULT_EXTRACT_MAX_INPUT_CHARS = 48_000

/**
 * Default minutes between periodic extraction checks; `0` disables them.
 *
 * A settle-only pass mines a session once, after it has been quiet for the whole
 * quiet window, and reads only the newest slice of it — so a long working session
 * loses everything before that slice for good, because the watermark moves past
 * it. A periodic check mines in slices as the session runs, which is also why the
 * window above is sized for one interval rather than for a whole conversation.
 */
export const DEFAULT_EXTRACT_INTERVAL_MINUTES = 30

/**
 * Default output-token cap for one extraction call.
 *
 * Raised from 2048 to 4096 on 2026-09-23: asked for up to five memories with
 * tags, keys, `appliesTo` and a summary paragraph in Chinese, a rich reply runs
 * past 2048 tokens, and the first real `/memories mine` in the field came back
 * cut in half (`max-tokens`).
 *
 * Raised again to 8192 on 2026-09-24, because the measured cause was not reply
 * length. A background extraction call inherits the session's route, reasoning
 * level included, and a thinking model bills its reasoning against this same
 * ceiling — so the cap can be spent before the first visible token. The store's
 * own log recorded five calls that came back pinned to the cap with nothing
 * usable (`[5766 in / 4096 out]` … `[24490 in / 4096 out]`), four of them on
 * `deepseek-flash` at `reasoningEffort: high` and one on `gpt-6-astra`; raising
 * the ceiling without the `memories`-first reply order would only have moved the
 * cliff. The cap is still a ceiling rather than a spend, so replies that finish
 * early cost exactly as much as before.
 */
export const DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS = 8192

/** Default timeout for one extraction call. */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 120_000

/**
 * Default max drafts one extraction may produce.
 *
 * 8 rather than 5: on a real production session, an audit of 50 Mubea
 * Invoice-Insight conversations found 247 durable facts, and the cap of 5 was
 * the single biggest cause of missed material on long sessions (one audit
 * session held 16 facts and kept 5). Eight keeps a long session's findings
 * without letting a short one pad itself.
 */
export const DEFAULT_EXTRACT_MAX_MEMORIES = 8

/**
 * What the extractor is allowed to keep, by default.
 *
 * `work` (the default) keeps the material a working session actually needs —
 * project architecture and conventions, commands, gotchas, decisions and their
 * reasons, and pre-sales material (quotes, proposals, customer terms, effort
 * estimates, contracts, bids) — and leaves personal life alone unless the user
 * asked for it. `both` also keeps personal background, relationships, habits and
 * creative collaborations.
 *
 * Measured on this machine's own store: 90% of entries were work/toolchain and
 * project material, and a benchmark-driven push toward personal memory added
 * nothing the user's real sessions needed.
 */
export const DEFAULT_RECORD_SCOPE = 'work' as const

/** Default idle hours a session must accumulate before it is mined. */
export const DEFAULT_MIN_IDLE_HOURS = 6

/** Default age limit: sessions idle longer than this are never mined. */
export const DEFAULT_MAX_AGE_DAYS = 10

/** Default cap on sessions mined per pass. */
export const DEFAULT_MAX_SESSIONS_PER_PASS = 2

/** Default hours between consolidation passes. */
export const DEFAULT_CONSOLIDATE_COOLDOWN_HOURS = 6

/**
 * Default hours a consolidation proposal waits for a decision before a new pass
 * may replace it.
 *
 * A proposal is a question, and questions go stale: entries keep being written
 * while it waits, so an old proposal describes a store that no longer exists.
 * Inside this window a running pass leaves the pending one alone — proposing
 * again would spend a model call to overwrite a question nobody has answered —
 * and past it the fresh proposal wins. `/memories consolidate` ignores the
 * window, because a user who types the command is asking now.
 */
export const DEFAULT_CONSOLIDATE_PROPOSAL_MAX_AGE_HOURS = 72

/** Default cap on entries one consolidation pass considers. */
export const DEFAULT_CONSOLIDATE_MAX_ENTRIES = 64

/** Default timeout for one consolidation sub-agent run. */
export const DEFAULT_CONSOLIDATE_TIMEOUT_MS = 180_000

/** Default wait after a provider refuses a background pass for quota or rate. */
export const DEFAULT_QUOTA_COOLDOWN_MINUTES = 30

/** Default ceiling for that wait as consecutive refusals double it. */
export const DEFAULT_QUOTA_COOLDOWN_MAX_MINUTES = 480

/** Default verbosity of the plugin's own log file. */
export const DEFAULT_LOG_LEVEL = 'info' as const

/** Default for logging every maintenance decision rather than only pass summaries. */
export const DEFAULT_TRACE_MAINTENANCE = false

/**
 * Share of a scope above which a query term stops being recall evidence.
 *
 * Measured on the real 200-entry global scope: `dsh` sits in 44 of 200 strong
 * fields (22%), `mac` in 24 (12%), then a long tail below 11%. At 0.15 exactly
 * one term qualifies — the one the README singles out — and the effect is
 * large and one-sided: the turn "dsh 插件 配置" admits 37 memories without the
 * discount and 9 with it, "dsh 版本" 35 → 4, while "插件 内核 版本" and
 * "mac 代理 端口" are unchanged and all ten labelled retrieval probes keep their
 * gate verdict.
 */
export const DEFAULT_EVIDENCE_MAX_DF = 0.15

/**
 * Default peak-hours spec: none.
 *
 * Deliberately empty rather than pre-filled with one provider's timetable: this
 * plugin can run on any route, and silently refusing to work at certain hours
 * would be a surprising default. The description names a value that suits
 * DeepSeek.
 */
export const DEFAULT_PEAK_HOURS = ''
/**
 * This plugin's entry config: the deployment facts plus every tunable.
 *
 * The tunables are live — declared `.volatile()`, which is what the settings
 * domain projects into the Memories page and what makes the Loader hand them to
 * `apply` as references rather than values, so a committed write reaches the
 * running plugin in place. The deployment fields stay ordinary: changing a path
 * is a remount, not a knob.
 */
export const Config = z.object({
  /** Harness home; defaults to `$DSH_HOME` (or `~/.dsh`). */
  dshHome: z.string(),
  /** Directory holding every memory store; defaults to `<dshHome>/memories`. */
  memoriesDir: z.string(),
  /** Child names that mark a workspace root during the upward walk. */
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  /** Plugin log file; defaults to `<dshHome>/logs/dsh-cross-memory.log`. Empty disables file logging. */
  logFile: z.string(),
  /** Git remote the memory store syncs through; empty keeps the repository local-only. */
  syncConflictProvider: z.string().default('').description('Provider used to merge two conflicting revisions of the same memory. Empty falls back to the extraction route; when neither is configured the newer revision wins and the older one stays in git history.').volatile(),
  syncConflictModel: z.string().default('').description('Model used to merge two conflicting revisions of the same memory. Empty falls back to the extraction model.').volatile(),
  syncRemote: z.string().default('').description('Git remote the memory store pushes to and pulls from. Empty leaves the store a local repository: writes are still committed, nothing leaves the machine. Point it at one private repository shared by every machine you use, e.g. git@github.com:<you>/dsh-cross-memory-store.git.').volatile(),
  /** Local clock times to sync at, e.g. `12:05,18:05`; wins over the interval. */
  syncClock: z.string().default(DEFAULT_SYNC_CLOCK).description('Local clock times (HH:MM, comma separated) at which the store syncs. Defaults to 12:05 and 18:05 — a few minutes after DeepSeek off-peak pricing starts, when a conflict merge is cheapest. Empty falls back to syncIntervalMinutes.').volatile(),
  /** Background sync interval in minutes; 0 disables the timer. */
  syncIntervalMinutes: z.number().default(DEFAULT_SYNC_INTERVAL_MINUTES).description('How often the store fetches, rebases and pushes in the background. 0 keeps the repository but stops the timer, so only a manual sync moves it.').volatile(),
  /** Debounce before a memory write is committed locally. */
  syncDebounceSeconds: z.number().default(DEFAULT_SYNC_DEBOUNCE_SECONDS).description('How long a burst of memory writes is folded into one commit. The commit is local and cheap; the network never runs on the write path.').volatile(),
  /** Byte budget for the injected summary. `0` disables injection. */
  maxSummaryBytes: z.number().default(DEFAULT_MAX_SUMMARY_BYTES).description('Byte budget for the memory summary injected once per conversation. 0 disables injection and leaves only the memory tool.').volatile(),
  /** Max entries listed per scope in the injected summary. */
  maxSummaryEntries: z.number().default(DEFAULT_MAX_SUMMARY_ENTRIES).description('How many memories each scope lists in the injected summary.').volatile(),
  /** Max entries listed for the global scope, which every session shares. */
  globalSummaryEntries: z.number().default(DEFAULT_GLOBAL_SUMMARY_ENTRIES).description('How many memories the GLOBAL section may list, capped below maxSummaryEntries. Both scopes share one byte budget and global renders first, so without this the global half grows to fill whatever the project half leaves (measured: 87% of a small project\'s summary). 0 removes the global section entirely.').volatile(),
  /** Byte budget for the global section alone. */
  globalSummaryBytes: z.number().default(DEFAULT_GLOBAL_SUMMARY_BYTES).description('Byte budget for the GLOBAL section, inside maxSummaryBytes. A count cap is not enough because Chinese entries are ~3 bytes per character: a handful of them still fills a large share of the block. 0 removes the global section entirely.').volatile(),
  /** How many of those entries are reserved for never-listed memories. */
  summaryFreshSlots: z.number().default(DEFAULT_SUMMARY_FRESH_SLOTS).description('How many of each scope\'s summary entries are reserved for memories that have never been listed before, preferring ones written deliberately over extracted ones. 0 leaves selection to the ranking alone, which on a full scope never shows anything new.').volatile(),
  /** How the injected summary is refreshed as the conversation moves on. */
  recallMode: z.string().default(DEFAULT_RECALL_MODE).description('once injects the summary once per conversation; on-demand also injects a small delta when the current turn clearly matches a memory; off disables injection and leaves only the memory tool.').volatile(),
  /** Minimum relevance a recall delta must reach. */
  recallMinScore: z.number().default(DEFAULT_RECALL_MIN_SCORE).description('Minimum relevance a memory must reach before it is injected as a recall delta. Together with recallMinTerms this is the precision gate: with the default of one term, the score floor is what keeps a shared common word like 插件 or 日志 from recalling every memory. Raise it to demand a stronger lexical match.').volatile(),
  /** Cap on recall deltas injected into one conversation. */
  recallMaxPerConversation: z.number().default(DEFAULT_RECALL_MAX_PER_CONVERSATION).description('Maximum recall deltas injected into one conversation, counted per memory. 0 disables them.').volatile(),
  /** Byte budget for one recall delta block. */
  recallMaxBytes: z.number().default(DEFAULT_RECALL_MAX_BYTES).description('Byte budget for one on-demand recall block. 0 disables recall deltas.').volatile(),
  rawRecall: z.boolean().default(DEFAULT_RAW_RECALL).description('Also put original conversation excerpts from the memory source sessions into the on-demand recall block. Off by default: it injects prose from earlier sessions, and it is read from the persisted session logs on this machine only.').volatile(),
  rawRecallBytes: z.number().default(DEFAULT_RAW_RECALL_BYTES).description('Byte budget for the original-excerpt half of one recall block.').volatile(),
  rawRecallExcerpts: z.number().default(DEFAULT_RAW_RECALL_EXCERPTS).description('Most original conversation excerpts one recall block may carry.').volatile(),
  /**
   * Read the raw channel across the whole history, not just the sessions the
   * recalled memories came from.
   *
   * The anchored version only sees a conversation the extraction already picked
   * a memory from, so anything the extraction dropped is unreachable. This one
   * scores every persisted session's prose against the query — a real retrieval
   * path, at the cost of opening more logs.
   */
  ragRecall: z.boolean().default(DEFAULT_RAG_RECALL).description('Retrieve original conversation excerpts from ALL persisted sessions, not only the ones the recalled memories came from. Lexical, local-only, no model call. On by default: the raw channel is the main retrieval path, the memory summary is the projection.').volatile(),
  ragRecallBytes: z.number().default(DEFAULT_RAG_RECALL_BYTES).description('Byte budget for the full-history excerpt half of one recall block.').volatile(),
  ragRecallExcerpts: z.number().default(DEFAULT_RAG_RECALL_EXCERPTS).description('Most full-history excerpts one recall block may carry.').volatile(),
  ragRecallSessions: z.number().default(DEFAULT_RAG_RECALL_SESSIONS).description('How many session logs the full-history retrieval may open per recall, newest first. 0 opens all of them.').volatile(),
  ragRecallChars: z.number().default(DEFAULT_RAG_RECALL_CHARS).description('Longest one full-history excerpt may be, in characters.').volatile(),
  /** Shortest user turn worth a recall decision. */
  recallMinQueryChars: z.number().default(DEFAULT_RECALL_MIN_QUERY_CHARS).description('Shortest user turn, in characters, that may trigger a recall delta. Short acknowledgements are skipped instead of scanning the store.').volatile(),
  /** Distinct strong-field terms a recall needs before it is credited. */
  recallMinTerms: z.number().default(DEFAULT_RECALL_MIN_TERMS).description('Distinct query terms that must land in the title, keys, tags, or appliesTo before a memory may be recalled on demand. 1 (the default) admits a one-word paraphrase, which a Chinese rewrite of a stored fact routinely is, and lets the relevance floor do the precision work; 2 demands two shared words and misses single-word paraphrases; 0 disables the check entirely.').volatile(),
  /**
   * Whether memories written after the summary was injected get a small delta.
   *
   * Off leaves the once-per-conversation summary as the only automatic block;
   * the `memory` tool and the on-demand recall path still work.
   */
  injectDelta: z.boolean().default(DEFAULT_INJECT_DELTA).description('Inject a small block when memories are written after the summary was already shown (at most twice per conversation). Off keeps the summary as the only automatic block.').volatile(),
  /** Byte budget for one delta block. */
  deltaMaxBytes: z.number().default(DEFAULT_DELTA_MAX_BYTES).description('Byte budget for one late-injection delta block. One complete entry costs 200-350 bytes, so 800 admitted one or two; raise it for a longer block, lower it to spend fewer bytes per conversation. 0 disables the delta entirely.').volatile(),
  /**
   * How many extra memories one conversation lists by title only.
   *
   * The summary names at most a dozen entries, so most of a large store is never
   * seen. The rotation block spends about a kilobyte on titles the summary had
   * no room for, oldest-unseen first, so the whole store becomes discoverable
   * over a few dozen sessions. 0 disables it.
   */
  rotationEntries: z.number().default(DEFAULT_ROTATION_ENTRIES).description('List this many additional memory titles (not bodies) in each conversation, rotating through the entries the summary did not name, oldest-unseen first. 0 disables the rotation block.').volatile(),
  /**
   * User turns between rotation blocks inside one long conversation.
   *
   * A session that runs for hours outlives its first block: the store grows and
   * the model needs names it has not seen. Re-arming every this many turns keeps
   * the cost bounded (one block per span) and lets coverage accumulate within a
   * single long session. 0 keeps once-per-conversation.
   */
  rotationEveryTurns: z.number().default(DEFAULT_ROTATION_EVERY_TURNS).description('Inside one conversation, emit a fresh rotation block every this many user turns (0 keeps the old once-per-conversation behaviour).').volatile(),
  /** Max stored entries per scope; the least-recently-updated are evicted. */
  maxEntriesPerScope: z.number().default(DEFAULT_MAX_ENTRIES_PER_SCOPE).description('Stored memories per scope; past this cap the least-attended are archived (pinned, permanent and user-written entries are exempt). 0 (the default) means no cap: the store grows and retrieval ranks it.').volatile(),
  /** Days an unused memory survives before it is archived. `0` disables archival. */
  maxUnusedDays: z.number().default(DEFAULT_MAX_UNUSED_DAYS).description('Days an unused memory survives before it is archived. Archived entries are recoverable with /memories restore. 0 disables archival.').volatile(),
  /** Days a snapshot memory survives regardless of use. `0` disables. */
  snapshotMaxAgeDays: z.number().default(DEFAULT_SNAPSHOT_MAX_AGE_DAYS).description('Days a memory marked durability=snapshot survives before it is archived, counted from when it was measured rather than from when it was last read. A stale number is worse than no number, and being read does not make it right. 0 disables snapshot expiry.').volatile(),
  /** Token overlap above which a new memory supersedes an existing one. */
  dedupeSimilarity: z.number().default(DEFAULT_DEDUPE_SIMILARITY).description('Share of title and body tokens two memories must have in common before the newer one supersedes the older. 0 keeps only the exact-match rule.').volatile(),
  /** Hours between periodic maintenance sweeps. `0` disables the sweep. */
  sweepIntervalHours: z.number().default(DEFAULT_SWEEP_INTERVAL_HOURS).description('Hours between periodic maintenance sweeps, which apply retention across every known workspace. 0 disables the sweep.').volatile(),
  /** Whether the idle-time background extractor runs at all. */
  autoExtract: z.boolean().default(true).description('Mine finished sessions for durable facts after they have been idle.').volatile(),
  /** Idle milliseconds before a session is mined. */
  autoExtractIdleMs: z.number().default(DEFAULT_AUTO_EXTRACT_IDLE_MS).description('How long a session must stay idle before it is mined.').volatile(),
  /** Surface messages included in one extraction window. */
  extractWindowMessages: z.number().default(DEFAULT_EXTRACT_WINDOW_MESSAGES).description('How many recent conversation messages one extraction reads.').volatile(),
  /** Character budget for the extraction transcript. */
  extractMaxInputChars: z.number().default(DEFAULT_EXTRACT_MAX_INPUT_CHARS).description('Character budget for the transcript handed to the extractor.').volatile(),
  /** Output-token cap for one extraction call. */
  extractMaxOutputTokens: z.number().default(DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS).description('Output token cap for one extraction call.').volatile(),
  /** Timeout for one extraction call. */
  extractTimeoutMs: z.number().default(DEFAULT_EXTRACT_TIMEOUT_MS).description('Timeout for one extraction call.').volatile(),
  /** Max drafts one extraction may produce. */
    extractMaxMemories: z.number().default(DEFAULT_EXTRACT_MAX_MEMORIES).description('Maximum memories one extraction pass may store.').volatile(),
  recordScope: z.union([z.const('work'), z.const('both')]).default(DEFAULT_RECORD_SCOPE).description('What the extractor may keep. `work` (default) keeps project/tooling/pre-sales material and leaves personal life alone unless asked; `both` also keeps personal background, relationships, habits and creative work.').volatile(),
  /** Minutes between periodic extraction checks over every open session. */
  extractIntervalMinutes: z.number().default(DEFAULT_EXTRACT_INTERVAL_MINUTES).description('How often to check every open session for new material and mine it in slices. Fractions are allowed. 0 disables the periodic check, leaving mining to the settle timer and the exit flush. Peak hours and the quota gate still apply; a session with nothing new costs no model call.').volatile(),
  /** A session must have been idle this long before it is mined. */
  minIdleHours: z.number().default(DEFAULT_MIN_IDLE_HOURS).description('A session must have been idle at least this many hours before it is mined.').volatile(),
  /** Sessions older than this are never mined. */
  maxAgeDays: z.number().default(DEFAULT_MAX_AGE_DAYS).description('Sessions whose last activity is older than this are never mined.').volatile(),
  /** Sessions mined per pass; bounds one pass\'s quota cost. */
  maxSessionsPerPass: z.number().default(DEFAULT_MAX_SESSIONS_PER_PASS).description('How many sessions one extraction pass may mine, newest first.').volatile(),
  consolidate: z.boolean().default(true).description('After new memories land, merge and reconcile them through a restricted sub-agent.').volatile(),
  consolidateCooldownHours: z.number().default(DEFAULT_CONSOLIDATE_COOLDOWN_HOURS).description('Minimum hours between consolidation passes; bounds background quota use.').volatile(),
  consolidateProposalMaxAgeHours: z.number().default(DEFAULT_CONSOLIDATE_PROPOSAL_MAX_AGE_HOURS).description('Hours a staged consolidation proposal waits for /memories apply or reject before a later pass may replace it with a fresh one. Inside the window a background pass leaves the pending question alone (proposing again would spend a model call to overwrite it); /memories consolidate always proposes now. 0 keeps a proposal until it is answered.').volatile(),
  consolidateMaxEntries: z.number().default(DEFAULT_CONSOLIDATE_MAX_ENTRIES).description('How many memories one consolidation pass may consider.').volatile(),
  consolidateTimeoutMs: z.number().default(DEFAULT_CONSOLIDATE_TIMEOUT_MS).description('Timeout for one consolidation sub-agent run.').volatile(),
  /** Stop background passes while the provider is refusing for quota or rate. */
  pauseOnQuotaError: z.boolean().default(true).description('Stop background extraction and consolidation after a rate-limit or exhausted-quota error, until the cooldown elapses.').volatile(),
  /** Wait after the first such refusal; doubles per consecutive refusal. */
  quotaCooldownMinutes: z.number().default(DEFAULT_QUOTA_COOLDOWN_MINUTES).description('Minutes to wait after a rate-limit or quota refusal. Doubles per consecutive refusal.').volatile(),
  /** Ceiling for that doubling. */
  quotaCooldownMaxMinutes: z.number().default(DEFAULT_QUOTA_COOLDOWN_MAX_MINUTES).description('Upper bound for the quota cooldown.').volatile(),
  /** Explicit extraction provider route; empty reuses the session route. */
  extractProvider: z.string().default('').description("Provider route for extraction. Empty reuses the session's own logged route.").volatile(),
  /** Explicit extraction model; empty reuses the session route. */
  extractModel: z.string().default('').description("Model for extraction. Empty reuses the session's own logged route.").volatile(),
  /**
   * Whether an AI may decide the consolidation questions that used to wait for a person.
   *
   * Every merge used to stop at the human panel as soon as an entry had been read
   * once, which on a real store meant all nine proposals waited — and the panel is
   * where automation can be added safely, because the alternative to a decision is
   * not "safer", it is "nothing ever happens".
   */
  autoDecide: z.boolean().default(true).description('Let an AI adjudicate the consolidation changes that would otherwise wait for you: it is asked only whether the change loses information, and answers accept or reject with a confidence. Permanent and user-written memories still wait for you. Off sends everything to the 待裁决 panel.').volatile(),
  /** Confidence floor under which an AI verdict is treated as "no answer". */
  autoDecideMinConfidence: z.number().default(0.7).description('Below this confidence an AI adjudication is ignored and the item stays in 待裁决. 0 accepts every verdict; 1 accepts none unless certain.').volatile(),
  /** Explicit consolidation provider route; empty falls back to the extraction route. */
  consolidateProvider: z.string().default('').description('Provider route for consolidation. Empty falls back to the extraction route, then the session route.').volatile(),
  /** Explicit consolidation model; empty falls back to the extraction route. */
  consolidateModel: z.string().default('').description('Model for consolidation. Empty falls back to the extraction route, then the session route.').volatile(),
  /** Whether the `memory` tool is registered for the model. */
  enableTool: z.boolean().default(true).description('Register the model-facing memory tool.').volatile(),
  /** Whether `/memories` is registered. */
  enableCommand: z.boolean().default(true).description('Register the /memories slash command.').volatile(),
  /** How much this plugin records in its own log file. */
  logLevel: z.string().default(DEFAULT_LOG_LEVEL).description('How much dsh-cross-memory writes to its log file: off, error, warn, info, or debug. info keeps errors, warnings, and pass summaries; debug adds per-entry decisions.').volatile(),
  /** Whether maintenance decisions are logged at info, where a stock logLevel keeps them. */
  traceMaintenance: z.boolean().default(DEFAULT_TRACE_MAINTENANCE).description('Log every retention, recall, and selection decision at info instead of debug. Off keeps the file to one line per pass.').volatile(),
  /** Whether the plugin may speak without being asked. */
  noticesEnabled: z.boolean().default(true).description('Let the plugin raise a notice on its own: a daily digest of what it maintained, a backlog warning when decisions have waited too long, and open loops whose deadline passed. Delivered as an operating-system notification. Off means the plugin only ever answers.').volatile(),
  /** Windows during which nothing is delivered. */
  noticeQuietHours: z.string().default('').description('Local-time windows during which notices are held rather than delivered, for example "22:00-08:00". Empty means always allowed. Held notices fire when the window ends; they are not dropped.').volatile(),
  /** Whether the weekly reflection pass may run. */
  reflectionEnabled: z.boolean().default(true).description('Once a week, synthesize a few observations from the memory store that no single memory states — patterns across projects, habits, things the user keeps getting burned by. Every observation must cite the memories behind it or it is dropped. Written as dated markdown under memories/reflections, never injected into conversations.').volatile(),
  /** Whether a model decides if a judgement-based notice is worth an interruption. */
  noticeGate: z.boolean().default(true).description('Before raising a notice that has no rule behind it (an undated promise that has been sitting for days), ask a model whether it is worth interrupting for. The default answer is silence: a gate that cannot run, or that fails, suppresses the notice. Rule-based notices (daily digest, backlog warning, a promise whose deadline passed) are never gated.').volatile(),
  /** Byte budget for the persona block injected ahead of the memory summary. */
  personaMaxBytes: z.number().default(12000).description('Byte budget for the persona block (who the user is, in their own words) injected once per conversation ahead of the memory summary. 0 disables the block. The profile is edited in Settings → Memories → Persona; locking it there stops the consolidation pass from rewriting it. Kept separate from the summary budget because the profile is context for the whole turn, not one of the memories being listed.').volatile(),
  /** Share of a scope above which a query term stops counting as recall evidence. */
  evidenceMaxDf: z.number().default(DEFAULT_EVIDENCE_MAX_DF).description('A query term that appears in more than this share of one scope does not count towards the recall gate\'s evidence requirement. 0.15 is measured on a real 200-entry store: it catches exactly one term (dsh, 22% of entries) and cuts false admissions by three quarters without changing any of ten labelled probes. 0 disables the discount and restores the pre-2026-10-23 behaviour.').volatile(),
  /** Local-time windows whose tokens are the expensive ones. */
  peakHours: z.string().default(DEFAULT_PEAK_HOURS).description('Local-time peak windows to keep the plugin\'s model calls out of, for example "Mon-Fri 09:00-12:00, Mon-Fri 14:00-18:00" (DeepSeek charges double then, Beijing time). Background extraction and consolidation are deferred to the next off-peak moment; /memories mine and /memories consolidate ignore this. Empty disables the restriction.').volatile(),
})

/**
 * The tunables as plain data: the entry config's live half, unwrapped.
 *
 * Spelled out rather than derived from {@link Config} because a schemastery
 * schema's output type does not survive `keyof` (the library builds it through a
 * deferred conditional), and a mistyped runtime contract is worse than a
 * duplicated one. What keeps the two in step is a test, not the type system: see
 * `test/settings-card.test.ts`, which holds this list, the entry schema's live
 * fields, and the card's field list against each other.
 */
export interface MemoriesSettings {
  /** Summary injection: budget, per-scope caps, and the recall delta. */
  maxSummaryBytes: number
  maxSummaryEntries: number
  globalSummaryEntries: number
  globalSummaryBytes: number
  summaryFreshSlots: number
  recallMode: string
  recallMinScore: number
  recallMaxPerConversation: number
  recallMaxBytes: number
  rawRecall: boolean
  rawRecallBytes: number
  rawRecallExcerpts: number
  ragRecall: boolean
  ragRecallBytes: number
  ragRecallExcerpts: number
  ragRecallSessions: number
  ragRecallChars: number
  recallMinQueryChars: number
  recallMinTerms: number
  /** Whether memories written after the summary are announced as a delta. */
  injectDelta: boolean
  /** Byte budget for one delta block (0 disables the delta). */
  deltaMaxBytes: number
  /** How many extra memories one conversation lists by title only (0 disables). */
  rotationEntries: number
  /** User turns between rotation blocks inside one long conversation (0 = once). */
  rotationEveryTurns: number
  /** Retention: what the store keeps, and for how long. */
  maxEntriesPerScope: number
  maxUnusedDays: number
  snapshotMaxAgeDays: number
  dedupeSimilarity: number
  sweepIntervalHours: number
  /** Background extraction: when it runs and how much it reads. */
  autoExtract: boolean
  autoExtractIdleMs: number
  extractWindowMessages: number
  extractMaxInputChars: number
  extractMaxOutputTokens: number
  extractTimeoutMs: number
  extractMaxMemories: number
  /** What the extractor may keep: `work` (default) or `both`. */
  recordScope: 'work' | 'both'
  extractIntervalMinutes: number
  minIdleHours: number
  maxAgeDays: number
  maxSessionsPerPass: number
  /** Git remote the store syncs through; empty keeps it local-only. */
  syncRemote: string
  /** Provider for AI conflict resolution; empty falls back to the extraction route. */
  syncConflictProvider: string
  /** Model for AI conflict resolution; empty falls back to the extraction route. */
  syncConflictModel: string
  /** Local clock times to sync at, comma separated `HH:MM`; wins over the interval. */
  syncClock: string
  /** Background sync interval in minutes; 0 disables the timer. */
  syncIntervalMinutes: number
  /** Debounce before a memory write becomes one commit, in seconds. */
  syncDebounceSeconds: number
  /** Consolidation: the restricted sub-agent pass that merges new memories. */
  consolidate: boolean
  consolidateCooldownHours: number
  consolidateProposalMaxAgeHours: number
  consolidateMaxEntries: number
  consolidateTimeoutMs: number
  pauseOnQuotaError: boolean
  quotaCooldownMinutes: number
  quotaCooldownMaxMinutes: number
  /** Whether an AI may adjudicate what would otherwise wait for a person. */
  autoDecide: boolean
  /** Confidence floor under which an AI verdict counts as no answer. */
  autoDecideMinConfidence: number
  /** Byte budget for the injected persona block. */
  personaMaxBytes: number
  /** Whether a model gates judgement-based notices. */
  noticeGate: boolean
  /** Whether the weekly reflection pass may run. */
  reflectionEnabled: boolean
  /** Whether the plugin may speak without being asked. */
  noticesEnabled: boolean

  /** Local-time windows during which notices are held. */
  noticeQuietHours: string
  /** Model routes for the plugin's own calls; empty reuses the session's route. */
  extractProvider: string
  extractModel: string
  consolidateProvider: string
  consolidateModel: string
  /** Registrations the model sees. */
  enableTool: boolean
  enableCommand: boolean
  /** This plugin's own log file and how much it records. */
  logLevel: string
  traceMaintenance: boolean
  evidenceMaxDf: number
  peakHours: string
}

/**
 * Every tunable with its shipped value.
 *
 * The runtime never reads this object for behaviour — the Loader resolves the
 * schema defaults — but it is the same set as plain data: the key list the
 * runtime and the card are both checked against, with the values a harness (or
 * any deployment that configures nothing) starts from.
 */
export const MEMORIES_SETTINGS_DEFAULTS: MemoriesSettings = {
  maxSummaryBytes: DEFAULT_MAX_SUMMARY_BYTES,
  maxSummaryEntries: DEFAULT_MAX_SUMMARY_ENTRIES,
  globalSummaryEntries: DEFAULT_GLOBAL_SUMMARY_ENTRIES,
  globalSummaryBytes: DEFAULT_GLOBAL_SUMMARY_BYTES,
  summaryFreshSlots: DEFAULT_SUMMARY_FRESH_SLOTS,
  recallMode: DEFAULT_RECALL_MODE,
  recallMinScore: DEFAULT_RECALL_MIN_SCORE,
  recallMaxPerConversation: DEFAULT_RECALL_MAX_PER_CONVERSATION,
  recallMaxBytes: DEFAULT_RECALL_MAX_BYTES,
  rawRecall: DEFAULT_RAW_RECALL,
  rawRecallBytes: DEFAULT_RAW_RECALL_BYTES,
  rawRecallExcerpts: DEFAULT_RAW_RECALL_EXCERPTS,
  ragRecall: DEFAULT_RAG_RECALL,
  ragRecallBytes: DEFAULT_RAG_RECALL_BYTES,
  ragRecallExcerpts: DEFAULT_RAG_RECALL_EXCERPTS,
  ragRecallSessions: DEFAULT_RAG_RECALL_SESSIONS,
  ragRecallChars: DEFAULT_RAG_RECALL_CHARS,
  recallMinQueryChars: DEFAULT_RECALL_MIN_QUERY_CHARS,
  recallMinTerms: DEFAULT_RECALL_MIN_TERMS,
  injectDelta: DEFAULT_INJECT_DELTA,
  deltaMaxBytes: DEFAULT_DELTA_MAX_BYTES,
  rotationEntries: DEFAULT_ROTATION_ENTRIES,
  rotationEveryTurns: DEFAULT_ROTATION_EVERY_TURNS,
  maxEntriesPerScope: DEFAULT_MAX_ENTRIES_PER_SCOPE,
  maxUnusedDays: DEFAULT_MAX_UNUSED_DAYS,
  snapshotMaxAgeDays: DEFAULT_SNAPSHOT_MAX_AGE_DAYS,
  dedupeSimilarity: DEFAULT_DEDUPE_SIMILARITY,
  sweepIntervalHours: DEFAULT_SWEEP_INTERVAL_HOURS,
  autoExtract: true,
  autoExtractIdleMs: DEFAULT_AUTO_EXTRACT_IDLE_MS,
  extractWindowMessages: DEFAULT_EXTRACT_WINDOW_MESSAGES,
  extractMaxInputChars: DEFAULT_EXTRACT_MAX_INPUT_CHARS,
  extractMaxOutputTokens: DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS,
  extractTimeoutMs: DEFAULT_EXTRACT_TIMEOUT_MS,
  extractMaxMemories: DEFAULT_EXTRACT_MAX_MEMORIES,
  recordScope: DEFAULT_RECORD_SCOPE,
  extractIntervalMinutes: DEFAULT_EXTRACT_INTERVAL_MINUTES,
  minIdleHours: DEFAULT_MIN_IDLE_HOURS,
  maxAgeDays: DEFAULT_MAX_AGE_DAYS,
  maxSessionsPerPass: DEFAULT_MAX_SESSIONS_PER_PASS,
  syncRemote: '',
  syncConflictProvider: '',
  syncConflictModel: '',
  syncClock: DEFAULT_SYNC_CLOCK,
  syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
  syncDebounceSeconds: DEFAULT_SYNC_DEBOUNCE_SECONDS,
  consolidate: true,
  consolidateCooldownHours: DEFAULT_CONSOLIDATE_COOLDOWN_HOURS,
  consolidateProposalMaxAgeHours: DEFAULT_CONSOLIDATE_PROPOSAL_MAX_AGE_HOURS,
  consolidateMaxEntries: DEFAULT_CONSOLIDATE_MAX_ENTRIES,
  consolidateTimeoutMs: DEFAULT_CONSOLIDATE_TIMEOUT_MS,
  autoDecide: true,
  autoDecideMinConfidence: 0.7,
  personaMaxBytes: 12000,
  noticeGate: true,
  reflectionEnabled: true,
  noticesEnabled: true,
  noticeQuietHours: '',
  pauseOnQuotaError: true,
  quotaCooldownMinutes: DEFAULT_QUOTA_COOLDOWN_MINUTES,
  quotaCooldownMaxMinutes: DEFAULT_QUOTA_COOLDOWN_MAX_MINUTES,
  extractProvider: '',
  extractModel: '',
  consolidateProvider: '',
  consolidateModel: '',
  enableTool: true,
  enableCommand: true,
  logLevel: DEFAULT_LOG_LEVEL,
  traceMaintenance: DEFAULT_TRACE_MAINTENANCE,
  evidenceMaxDf: DEFAULT_EVIDENCE_MAX_DF,
  peakHours: DEFAULT_PEAK_HOURS,
}

/**
 * The raw, possibly partial entry configuration the loader hands `apply`.
 *
 * The tunables are spelled flat on the row, and how they arrive depends on who
 * composed it: a row the Loader mounted against {@link Config} carries them as
 * live references, while a hand-written one (a composition without the schema, a
 * test harness) carries plain values. Both are accepted here, and
 * {@link plainRow} is what reads them out.
 */
export interface MemoriesConfig extends Partial<RowTunables> {
  dshHome?: string
  memoriesDir?: string
  projectRootMarkers?: string[]
  /**
   * Directories that are a workspace even though they are not a repository.
   *
   * Keyed by absolute path prefix, valued by the scope root to file under. The
   * harness home is excluded from scoping on purpose (it is where a session is
   * *started*, not what it works on), but plugin and kernel work really does
   * happen there — and 28% of the global scope turned out to be exactly that:
   * DSH-development notes following the user into every unrelated project. Naming
   * a directory here gives it a scope of its own without weakening the catch-all
   * rule for the home directory itself.
   */
  projectRootOverrides?: Record<string, string>
  /** Plugin log file; defaults to `<dshHome>/logs/dsh-cross-memory.log`. Empty disables file logging. */
  logFile?: string
}

/** One tunable as a row carries it: the value itself, or the reference to it. */
type RowField<T> = T | Volatile<T>

/** Every tunable, keyed as the row spells it. */
type RowTunables = { [K in keyof MemoriesSettings]: RowField<MemoriesSettings[K]> }

/** Fully resolved deployment configuration. */
export interface ResolvedConfig {
  readonly dshHome: string
  readonly memoriesDir: string
  readonly projectRootMarkers: readonly string[]
  /** Absolute prefixes that own a scope regardless of markers, longest first. */
  readonly projectRootOverrides: readonly (readonly [string, string])[]
  /**
   * Log file for the plugin's own lines; empty disables file logging.
   *
   * A deployment fact rather than a tunable: it is a path. The knob that matters
   * day to day is `logLevel`.
   */
  readonly logFile: string
  /** The tunables this row resolves to, as read when the plugin was mounted. */
  readonly tunables: MemoriesSettings
}

/** Clamp one tunable into a usable range. */
function positive(value: number | undefined, fallback: number, min = 1): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return value < min ? min : Math.trunc(value)
}

/** Like {@link positive}, but `0` is a meaningful value (the behaviour is off/unlimited). */
function nonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return value < 0 ? 0 : Math.trunc(value)
}

/** Clamp one ratio into `[0, 1]`, where `0` disables the behaviour it gates. */
function clampUnit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  if (value <= 0) return 0
  return value >= 1 ? 1 : value
}

/**
 * Clamp one tunable that accepts fractions, such as a wait in hours.
 *
 * `positive` truncates, which would turn `minIdleHours: 0.5` — half an hour —
 * into `0`, silently disabling the gate it configures.
 */
function decimal(value: number | undefined, fallback: number, min = 0): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return value < min ? min : value
}

/** Coerce one possibly-absent tunable set into a complete, clamped section. */
export function normalizeSettings(input: Partial<MemoriesSettings> | undefined): MemoriesSettings {
  const value = input ?? {}
  const provider = value.extractProvider?.trim() ?? ''
  const model = value.extractModel?.trim() ?? ''
  const route = provider.length > 0 && model.length > 0
    ? { extractProvider: provider, extractModel: model }
    : { extractProvider: '', extractModel: '' }
  const consolidateProvider = value.consolidateProvider?.trim() ?? ''
  const consolidateModel = value.consolidateModel?.trim() ?? ''
  // A lone half is not a route: the pair resolves together or not at all, and an
  // empty consolidation route falls back to the extraction one at call time.
  const consolidateRoute = consolidateProvider.length > 0 && consolidateModel.length > 0
    ? { consolidateProvider, consolidateModel }
    : { consolidateProvider: '', consolidateModel: '' }
  return {
    maxSummaryBytes: positive(value.maxSummaryBytes, DEFAULT_MAX_SUMMARY_BYTES, 0),
    maxSummaryEntries: positive(value.maxSummaryEntries, DEFAULT_MAX_SUMMARY_ENTRIES),
    globalSummaryEntries: positive(value.globalSummaryEntries, DEFAULT_GLOBAL_SUMMARY_ENTRIES, 0),
    globalSummaryBytes: positive(value.globalSummaryBytes, DEFAULT_GLOBAL_SUMMARY_BYTES, 0),
    summaryFreshSlots: positive(value.summaryFreshSlots, DEFAULT_SUMMARY_FRESH_SLOTS, 0),
    recallMode: toRecallMode(value.recallMode),
    recallMinScore: positive(value.recallMinScore, DEFAULT_RECALL_MIN_SCORE, 0),
    recallMaxPerConversation: positive(value.recallMaxPerConversation, DEFAULT_RECALL_MAX_PER_CONVERSATION, 0),
    recallMaxBytes: positive(value.recallMaxBytes, DEFAULT_RECALL_MAX_BYTES, 0),
    rawRecall: value.rawRecall ?? DEFAULT_RAW_RECALL,
    rawRecallBytes: positive(value.rawRecallBytes, DEFAULT_RAW_RECALL_BYTES, 0),
    rawRecallExcerpts: positive(value.rawRecallExcerpts, DEFAULT_RAW_RECALL_EXCERPTS, 0),
    ragRecall: value.ragRecall ?? DEFAULT_RAG_RECALL,
    ragRecallBytes: positive(value.ragRecallBytes, DEFAULT_RAG_RECALL_BYTES, 0),
    ragRecallExcerpts: positive(value.ragRecallExcerpts, DEFAULT_RAG_RECALL_EXCERPTS, 0),
    ragRecallSessions: nonNegative(value.ragRecallSessions, DEFAULT_RAG_RECALL_SESSIONS),
    ragRecallChars: positive(value.ragRecallChars, DEFAULT_RAG_RECALL_CHARS, 0),
    recallMinQueryChars: positive(value.recallMinQueryChars, DEFAULT_RECALL_MIN_QUERY_CHARS, 0),
    recallMinTerms: positive(value.recallMinTerms, DEFAULT_RECALL_MIN_TERMS, 0),
    injectDelta: value.injectDelta ?? DEFAULT_INJECT_DELTA,
    deltaMaxBytes: positive(value.deltaMaxBytes, DEFAULT_DELTA_MAX_BYTES, 0),
    rotationEntries: positive(value.rotationEntries, DEFAULT_ROTATION_ENTRIES, 0),
    rotationEveryTurns: positive(value.rotationEveryTurns, DEFAULT_ROTATION_EVERY_TURNS, 0),
    maxEntriesPerScope: positive(value.maxEntriesPerScope, DEFAULT_MAX_ENTRIES_PER_SCOPE, 0),
    maxUnusedDays: positive(value.maxUnusedDays, DEFAULT_MAX_UNUSED_DAYS, 0),
    snapshotMaxAgeDays: positive(value.snapshotMaxAgeDays, DEFAULT_SNAPSHOT_MAX_AGE_DAYS, 0),
    dedupeSimilarity: clampUnit(value.dedupeSimilarity, DEFAULT_DEDUPE_SIMILARITY),
    sweepIntervalHours: decimal(value.sweepIntervalHours, DEFAULT_SWEEP_INTERVAL_HOURS),
    autoExtract: value.autoExtract ?? true,
    autoExtractIdleMs: positive(value.autoExtractIdleMs, DEFAULT_AUTO_EXTRACT_IDLE_MS, 1000),
    extractWindowMessages: positive(value.extractWindowMessages, DEFAULT_EXTRACT_WINDOW_MESSAGES),
    extractMaxInputChars: positive(value.extractMaxInputChars, DEFAULT_EXTRACT_MAX_INPUT_CHARS),
    extractMaxOutputTokens: positive(value.extractMaxOutputTokens, DEFAULT_EXTRACT_MAX_OUTPUT_TOKENS),
    extractTimeoutMs: positive(value.extractTimeoutMs, DEFAULT_EXTRACT_TIMEOUT_MS),
    extractMaxMemories: positive(value.extractMaxMemories, DEFAULT_EXTRACT_MAX_MEMORIES),
    recordScope: value.recordScope ?? DEFAULT_RECORD_SCOPE,
    extractIntervalMinutes: decimal(value.extractIntervalMinutes, DEFAULT_EXTRACT_INTERVAL_MINUTES),
    minIdleHours: decimal(value.minIdleHours, DEFAULT_MIN_IDLE_HOURS),
    maxAgeDays: positive(value.maxAgeDays, DEFAULT_MAX_AGE_DAYS, 0),
    maxSessionsPerPass: positive(value.maxSessionsPerPass, DEFAULT_MAX_SESSIONS_PER_PASS),
    syncRemote: value.syncRemote?.trim() ?? '',
    syncConflictProvider: value.syncConflictProvider?.trim() ?? '',
    syncConflictModel: value.syncConflictModel?.trim() ?? '',
    syncClock: value.syncClock?.trim() ?? DEFAULT_SYNC_CLOCK,
    syncIntervalMinutes: positive(value.syncIntervalMinutes, DEFAULT_SYNC_INTERVAL_MINUTES, 0),
    syncDebounceSeconds: positive(value.syncDebounceSeconds, DEFAULT_SYNC_DEBOUNCE_SECONDS, 0),
    consolidate: value.consolidate ?? true,
    consolidateCooldownHours: decimal(value.consolidateCooldownHours, DEFAULT_CONSOLIDATE_COOLDOWN_HOURS),
    consolidateProposalMaxAgeHours: decimal(value.consolidateProposalMaxAgeHours, DEFAULT_CONSOLIDATE_PROPOSAL_MAX_AGE_HOURS, 0),
    consolidateMaxEntries: positive(value.consolidateMaxEntries, DEFAULT_CONSOLIDATE_MAX_ENTRIES),
    consolidateTimeoutMs: positive(value.consolidateTimeoutMs, DEFAULT_CONSOLIDATE_TIMEOUT_MS),
    autoDecide: value.autoDecide ?? true,
    autoDecideMinConfidence: clampUnit(value.autoDecideMinConfidence, 0.7),
    personaMaxBytes: positive(value.personaMaxBytes, 12000, 0),
    noticeGate: value.noticeGate ?? true,
    reflectionEnabled: value.reflectionEnabled ?? true,
    noticesEnabled: value.noticesEnabled ?? true,
    noticeQuietHours: value.noticeQuietHours ?? '',
    pauseOnQuotaError: value.pauseOnQuotaError ?? true,
    quotaCooldownMinutes: positive(value.quotaCooldownMinutes, DEFAULT_QUOTA_COOLDOWN_MINUTES, 0),
    quotaCooldownMaxMinutes: positive(value.quotaCooldownMaxMinutes, DEFAULT_QUOTA_COOLDOWN_MAX_MINUTES, 0),
    ...route,
    ...consolidateRoute,
    enableTool: value.enableTool ?? true,
    enableCommand: value.enableCommand ?? true,
    logLevel: toLogLevel(value.logLevel, DEFAULT_LOG_LEVEL),
    traceMaintenance: value.traceMaintenance ?? false,
    evidenceMaxDf: clampUnit(value.evidenceMaxDf, DEFAULT_EVIDENCE_MAX_DF),
    peakHours: (value.peakHours ?? '').replace(/\s+/gu, ' ').trim(),
  }
}

/**
 * The route one consolidation pass runs on.
 *
 * Codex keeps `memories.extract_model` and `memories.consolidation_model`
 * separate; here an unset consolidation route falls back to the extraction one
 * and then to the session's own logged route, so an existing configuration that
 * only names `extractProvider`/`extractModel` keeps behaving as before.
 *
 * @param settings - the tunables in force.
 * @returns the provider/model pair, or `{}` to reuse the session route.
 */
export function consolidationRouteOf(settings: MemoriesSettings): { provider?: string; model?: string } {
  if (settings.consolidateProvider.length > 0 && settings.consolidateModel.length > 0) {
    return { provider: settings.consolidateProvider, model: settings.consolidateModel }
  }
  if (settings.extractProvider.length > 0 && settings.extractModel.length > 0) {
    return { provider: settings.extractProvider, model: settings.extractModel }
  }
  return {}
}
/**
 * One entry config with its live references read out.
 *
 * A row the Loader mounted arrives with every tunable as a `Volatile` reference
 * that a committed settings write updates in place; a plain row (a test harness,
 * a hand-written composition) arrives with the values themselves. Both pass
 * through here unchanged in shape, so every reader downstream sees plain data
 * and the same code serves the two cases.
 *
 * @param config - the row as `apply` received it.
 * @returns the same row with references replaced by their current values.
 */
export function plainRow(config: MemoriesConfig): MemoriesConfig {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]),
  ) as MemoriesConfig
}

/** The tunables a plain row carries, in one place, keyed by tunable name. */
function flatTunables(row: MemoriesConfig): Partial<MemoriesSettings> {
  const source = row as Record<string, unknown>
  const tunables: Partial<MemoriesSettings> = {}
  for (const key of Object.keys(MEMORIES_SETTINGS_DEFAULTS) as (keyof MemoriesSettings)[]) {
    const value = source[key]
    if (value !== undefined) (tunables as Record<string, unknown>)[key] = value
  }
  return tunables
}

/**
 * The tunables an entry config holds right now.
 *
 * A read rather than a value on purpose: a committed settings write lands in the
 * row's references without re-mounting the plugin, so the runtime asks again
 * instead of holding a snapshot.
 *
 * @param config - the row as `apply` received it.
 * @returns the normalized tunables in force.
 */
export function readTunables(config: MemoriesConfig): MemoriesSettings {
  return normalizeSettings(flatTunables(plainRow(config)))
}

/**
 * Resolve the deployment facts and the tunables of one entry config.
 *
 * @param config - the entry configuration the Loader hands `apply`.
 * @returns normalized paths, workspace markers, and tunables.
 */
/** Expand a leading `~` and leave everything else to `resolve`. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

export function resolveConfig(config: MemoriesConfig = {}): ResolvedConfig {
  const row = plainRow(config)
  const dshHome = resolveDshHome(row.dshHome)
  const memoriesDir = row.memoriesDir !== undefined && row.memoriesDir.trim().length > 0
    ? row.memoriesDir
    : `${dshHome}/memories`
  const markers = (row.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS])
    .filter((marker) => marker.trim().length > 0)
  const overrides = Object.entries(row.projectRootOverrides ?? {})
    .filter(([prefix, root]) => prefix.trim().length > 0 && typeof root === 'string' && root.trim().length > 0)
    .map(([prefix, root]) => [resolve(expandHome(prefix.trim())), resolve(expandHome(root.trim()))] as const)
    // Longest prefix first, so a nested workspace beats the tree it lives in.
    .sort((left, right) => right[0].length - left[0].length)
  return {
    dshHome,
    memoriesDir,
    projectRootMarkers: markers.length > 0 ? markers : [...DEFAULT_PROJECT_ROOT_MARKERS],
    projectRootOverrides: overrides,
    // Only `undefined` falls back to the default location, so an explicit empty
    // string disables file logging.
    logFile: row.logFile?.trim() ?? logPath(dshHome),
    tunables: normalizeSettings(flatTunables(row)),
  }
}
