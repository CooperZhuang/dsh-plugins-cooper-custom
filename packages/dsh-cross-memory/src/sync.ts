/**
 * Git-backed transport for the memory store.
 *
 * The store is the same on every machine the user works on, so a memory written
 * here has to reach the others — and a memory written there has to arrive here.
 * This module is that path.
 *
 * Shape of the design:
 *
 * - **The store directory is the working copy.** No mirror, no second copy that
 *   can drift: the store's own \`.git\` makes entries, projects, archive, persona,
 *   sessions and staged skills ordinary tracked files, so a memory write is a file
 *   write and "what is on disk" is "what is in the repository".
 * - **Writes never wait for the network.** A store write queues a debounced local
 *   commit; fetch/rebase/push run in the background on their own timer and after
 *   that commit. A memory tool call must not fail because GitHub was slow.
 * - **Machine state stays out of git.** state.db, every index.json, pending/ and
 *   logs are per-machine caches and watermark counters; tracking them turns every
 *   sync into a fake conflict over numbers nobody wrote by hand.
 * - **A conflicting entry is a decision, not a merge conflict.** One memory is one
 *   file, so the same id on both sides is the same memory with two edits. The
 *   resolver handed to {@link MemorySyncOptions.resolveConflict} decides; without
 *   one — or when it fails — the newer \`updated\` stamp wins and the older text
 *   stays in git history.
 *
 * Everything here is best-effort: no failure in this module may fail a store
 * write, and no failure may leave the repository mid-rebase.
 *
 * @module dsh-cross-memory/sync
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { LOOPS_FILE } from './loops.js'
import type { LoopItem, LoopStore } from './loops.js'
import { parseEntry } from './storage.js'
import type { MemoryEntry } from './types.js'

const run = promisify(execFile)

/** Minimal logging seam, satisfied by the plugin's own logger. */
export interface SyncLog {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  decision(message: string, ...args: unknown[]): void
}

/** The two versions of one entry that git could not merge. */
export interface EntryConflict {
  /** Repository-relative path, e.g. \`entries/<id>.md\`. */
  readonly path: string
  /** This machine's revision. */
  readonly ours: string
  /** The incoming revision. */
  readonly theirs: string
}

/**
 * Decide what one conflicting entry should become.
 *
 * Returns the merged entry file (frontmatter and body), or \`undefined\` to fall
 * back to the newer-\`updated\` rule. Throwing is treated the same as returning
 * \`undefined\`: a model that is down must not block the store.
 */
export type ConflictResolver = (conflict: EntryConflict) => Promise<string | undefined>

/** What one sync run did. */
export interface SyncOutcome {
  /** Files committed locally by this run. */
  readonly committed: number
  /** Commits rebased in from the remote. */
  readonly pulled: number
  /** Whether this run pushed. */
  readonly pushed: boolean
  /** Entry files that required conflict resolution. */
  readonly conflicts: number
  /** Conflicts the injected resolver decided. */
  readonly resolvedByResolver: number
  /** Conflicts the newer-updated rule decided. */
  readonly resolvedByTime: number
  /** Conflicts a structural merge decided without a model, e.g. the loop ledger. */
  readonly mergedByStructure: number
  /** Path the rebase gave up on, when it gave up on one. */
  readonly stoppedBy: string | undefined
}

/** Options for {@link MemorySync}. */
export interface MemorySyncOptions {
  /** The memory store directory; it becomes the git working copy. */
  readonly memoriesDir: string
  /** Git remote to pull from and push to. Empty keeps the repository local. */
  readonly remote: string
  /** Background interval in milliseconds; 0 disables the interval timer. */
  readonly intervalMs: number
  /** Local clock times to sync at ("HH:MM"); takes precedence over `intervalMs`. */
  readonly clock?: readonly string[]
  /** Debounce before a queued write is committed, in milliseconds. */
  readonly debounceMs: number
  /** Timeout for one non-network git command. */
  readonly gitTimeoutMs: number
  /** Timeout for a fetch or push. */
  readonly networkTimeoutMs: number
  /** Logger. */
  readonly log: SyncLog
  /** Machine name recorded in commit messages. */
  readonly host: string
  /** Conflict resolver; absent means the timestamp rule decides everything. */
  readonly resolveConflict?: ConflictResolver
}

/** Files that are per-machine state, never content. */
export const STORE_GITIGNORE = [
  '# per-machine state: watermarks, caches, in-flight work',
  'state.db',
  'state.db-shm',
  'state.db-wal',
  'index.json',
  '**/index.json',
  '# a project descriptor records THIS machine\'s checkout path',
  '**/project.json',
  'pending/',
  '*.log',
  '.DS_Store',
  '',
].join('\n')

/**
 * Whether a repository-relative path is one memory this module can merge.
 *
 * One memory is one file, in the live tree or in the archive: both carry the same
 * frontmatter, so the same arbitration applies. Persona, session notes and staged
 * skills are prose with a different shape — a conflict there aborts the rebase
 * instead of being guessed at.
 */
export function isEntryPath(path: string): boolean {
  if (!path.endsWith('.md')) return false
  return /(^|\/)(entries|archive)\//u.test(path)
}

/** The updated stamp of one entry text, or 0 when it cannot be parsed. */
export function entryStamp(text: string): number {
  return parseEntry(text, 'global', 'unknown')?.updatedAt ?? parseEntry(text, 'project', 'unknown')?.updatedAt ?? 0
}

/**
 * Resolve one conflicting entry by keeping the newer revision.
 *
 * Exported because it is the documented fallback: a caller that wants the model
 * decision first reads this only when the model declined or failed.
 */
export function newerEntry(ours: string, theirs: string): { text: string; oursWon: boolean } {
  return entryStamp(theirs) > entryStamp(ours)
    ? { text: theirs, oursWon: false }
    : { text: ours, oursWon: true }
}

/** Whether one repository path is a session note: prose, but stamped with `at:`. */
export function isSessionNotePath(path: string): boolean {
  return /(^|\/)sessions\/[^/]+\.md$/u.test(path)
}

/** The `at` stamp of one session note, or 0 when it cannot be parsed. */
export function sessionNoteStamp(text: string): number {
  const match = /^at:[ \t]*(\S+)[ \t]*$/mu.exec(text)
  const stamp = match?.[1]
  if (stamp === undefined) return 0
  const parsed = Date.parse(stamp)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Whether one path is a persona file: prose the assistant maintains for the user. */
export function isPersonaPath(path: string): boolean {
  return /(^|\/)persona\/[^/]+\.md$/u.test(path)
}

/**
 * Merge two versions of a persona file as a bullet union.
 *
 * A persona file is headings plus bullet lists; both machines append their own
 * observations, so a line-level union keeps every rule either machine recorded.
 * Bullets are matched on their trimmed text (duplicates are dropped), inserted
 * after the last bullet of the same section, and a whole section that only
 * `theirs` has is appended at the end. Non-bullet lines come from `ours`.
 */
export function mergePersona(ours: string, theirs: string): string {
  const result = ours.split('\n')
  const seen = new Set<string>()
  for (const line of result) {
    if (line.startsWith('- ')) seen.add(line.trim())
  }
  // Bucket the bullets that only the other side has, by their section heading.
  const pending = new Map<string, string[]>()
  let section = ''
  for (const line of theirs.split('\n')) {
    if (line.startsWith('#')) section = line.trim()
    else if (line.startsWith('- ')) {
      const key = line.trim()
      if (seen.has(key)) continue
      seen.add(key)
      const bucket = pending.get(section) ?? []
      bucket.push(line)
      pending.set(section, bucket)
    }
  }
  if (pending.size === 0) return ours
  // Insert each bucket after the last line that belongs to its section.
  const sectionRanges: Array<{ heading: string; start: number; end: number }> = []
  let current: { heading: string; start: number; end: number } | undefined
  for (let i = 0; i < result.length; i += 1) {
    const line = result[i]
    if (line?.startsWith('#')) {
      if (current !== undefined) current.end = i - 1
      current = { heading: line.trim(), start: i, end: i }
      sectionRanges.push(current)
    } else if (current !== undefined && line !== undefined && line.trim() !== '') {
      current.end = i
    }
  }
  let offset = 0
  for (const range of sectionRanges) {
    const bucket = pending.get(range.heading)
    if (bucket === undefined) continue
    result.splice(range.end + 1 + offset, 0, ...bucket)
    offset += bucket.length
    pending.delete(range.heading)
  }
  for (const [heading, bucket] of pending) {
    if (heading !== '') result.push('', heading)
    result.push(...bucket)
  }
  return result.join('\n')
}

/**
 * Resolve one conflicting session note by keeping the later `at:` stamp.
 *
 * A session note is the extractor's prose summary of one session. The same
 * session can be summarised twice — once on each machine, or again after the
 * conversation grew — and then the two notes conflict on every later sync. The
 * `at:` frontmatter says which summary is the later reading, so the newer one
 * wins the way an entry's `updated` stamp does; the older text stays in git.
 *
 * @returns the winning text, or undefined when neither side carries a stamp.
 */
/** Whether one repository path is a per-host descriptor: `projects/<slug>/hosts/<host>.json`. */
export function isHostDescriptorPath(path: string): boolean {
  return /(^|\/)hosts\/[^/]+\.json$/u.test(path)
}

/**
 * Resolve one conflicting host descriptor by keeping the newer reading.
 *
 * A host descriptor is the machine's own note about one project checkout: where
 * it is, when it was seen last, and its git origin. Only the machine named in
 * the file writes it, but every other machine carries a copy — so a rebase
 * between two machines stops here with an older and a newer reading of the same
 * machine. `lastSeen` says which is newer; when both agree, the side that knows
 * the origin wins because a descriptor written before the origin field existed
 * lacks it.
 *
 * @returns the winning text, or undefined when neither side is a descriptor.
 */
export function newerHostDescriptor(ours: string, theirs: string): string | undefined {
  const parse = (text: string): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(text)
      return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }
  const left = parse(ours)
  const right = parse(theirs)
  if (left === undefined && right === undefined) return undefined
  if (left === undefined) return theirs
  if (right === undefined) return ours
  const seen = (row: Record<string, unknown>): number => typeof row['lastSeen'] === 'number' ? row['lastSeen'] as number : 0
  if (seen(right) !== seen(left)) return seen(right) > seen(left) ? theirs : ours
  const hasOrigin = (row: Record<string, unknown>): boolean => typeof row['origin'] === 'string'
  if (hasOrigin(right) !== hasOrigin(left)) return hasOrigin(right) ? theirs : ours
  return ours
}

export function newerSessionNote(ours: string, theirs: string): string | undefined {
  const left = sessionNoteStamp(ours)
  const right = sessionNoteStamp(theirs)
  if (left === 0 && right === 0) return undefined
  return right >= left ? theirs : ours
}

/** How final one loop state is; a user's closure must not be undone by a stale copy. */
const LOOP_STATE_RANK: Readonly<Record<string, number>> = { open: 0, expired: 1, dropped: 2, done: 3 }

/** One text as a loop ledger, or undefined when it is not one. */
function parseLedgerText(text: string): LoopStore | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { loops?: unknown }).loops)) {
      return parsed as LoopStore
    }
  } catch {
    // not JSON; the caller decides whether that is fatal
  }
  return undefined
}

/** One text with only one branch of every conflict marker block kept. */
function oneMarkerBranch(text: string, branch: 'ours' | 'theirs'): string {
  const kept: string[] = []
  let state: 'normal' | 'ours' | 'theirs' = 'normal'
  for (const line of text.split('\n')) {
    if (/^<<<<<<</u.test(line)) { state = 'ours'; continue }
    if (/^=======/u.test(line)) { if (state === 'ours') state = 'theirs'; continue }
    if (/^>>>>>>>/u.test(line)) { state = 'normal'; continue }
    if (state === 'normal' || state === branch) kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Every ledger one conflict side contributes.
 *
 * Normally that is one. A text with git conflict markers committed into it — a
 * build that aborted a rebase *after* writing the conflicted file did exactly
 * that to this store's `loops.json` — contributes one ledger per branch, so the
 * loops from both halves of the botched merge survive. Splitting on the markers
 * rather than stripping them is what keeps the result valid JSON: each branch
 * is the original file with whole field groups removed.
 */
function ledgersIn(text: string): LoopStore[] {
  const direct = parseLedgerText(text)
  if (direct !== undefined) return [direct]
  if (!/^(<<<<<<<|=======|>>>>>>>)/mu.test(text)) return []
  const ledgers: LoopStore[] = []
  for (const branch of ['ours', 'theirs'] as const) {
    const parsed = parseLedgerText(oneMarkerBranch(text, branch))
    if (parsed !== undefined) ledgers.push(parsed)
  }
  return ledgers
}

/** The copy of one loop that survives a merge: the most final state, then the most recent reminder. */
function pickLoop(ours: LoopItem, theirs: LoopItem): LoopItem {
  const rank = (loop: LoopItem): number => LOOP_STATE_RANK[loop.state] ?? 0
  if (rank(theirs) !== rank(ours)) return rank(theirs) > rank(ours) ? theirs : ours
  const reminded = (loop: LoopItem): number => loop.remindedAt ?? 0
  if (reminded(theirs) !== reminded(ours)) return reminded(theirs) > reminded(ours) ? theirs : ours
  return ours
}

/**
 * Merge two versions of the open-loop ledger.
 *
 * The ledger is one JSON file both machines append to, so it conflicts as soon
 * as either side opens a loop — and unlike an entry it is not one memory with
 * two edits but many independent rows. The merge is therefore a union by id: a
 * loop only one side knows is kept, and a loop both sides changed takes its most
 * final copy. A side whose file was committed with conflict markers contributes
 * the loops from both branches (see {@link ledgersIn}).
 *
 * @param ours - one side of the conflict, as `git show :2:` returned it.
 * @param theirs - the other side, as `git show :3:` returned it.
 * @returns the merged ledger text, or undefined when neither side is a ledger.
 */
export function mergeLoopLedgers(ours: string, theirs: string): string | undefined {
  const ledgers = [...ledgersIn(ours), ...ledgersIn(theirs)]
  if (ledgers.length === 0) return undefined
  const merged = new Map<string, LoopItem>()
  for (const ledger of ledgers) {
    for (const loop of ledger.loops) {
      const existing = merged.get(loop.id)
      merged.set(loop.id, existing === undefined ? loop : pickLoop(existing, loop))
    }
  }
  const loops = [...merged.values()].sort((a, b) => a.openedAt - b.openedAt)
  return JSON.stringify({ version: 1, loops }, null, 2) + '\n'
}

/** Parse one "HH:MM" clock entry into minutes past midnight, or undefined. */
export function parseClockTime(value: string): number | undefined {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(value.trim())
  if (match === null) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Milliseconds from `now` until the next configured clock time.
 *
 * The schedule is local time, so a machine in another timezone syncs at its own
 * 12:05 — which is the point: off-peak pricing and "when nobody is working" are
 * local facts, not UTC ones.
 *
 * @param clock - "HH:MM" entries; unparsable ones are ignored.
 * @param now - clock.
 * @returns the delay, or undefined when no entry parses.
 */
export function nextClockDelay(clock: readonly string[], now: number): number | undefined {
  const minutes = clock.map(parseClockTime).filter((value): value is number => value !== undefined)
  if (minutes.length === 0) return undefined
  const today = new Date(now)
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const elapsed = now - midnight
  let best: number | undefined
  for (const minute of minutes) {
    let at = minute * 60_000
    if (at <= elapsed + 1_000) at += 86_400_000
    if (best === undefined || at < best) best = at
  }
  return best === undefined ? undefined : best - elapsed
}

/** Run one git command and return its stdout. */
async function git(dir: string, args: readonly string[], timeout: number): Promise<string> {
  // core.quotePath=false: a non-ASCII path must come back as itself, not as a
  // C-quoted string, or the conflict resolver cannot tell it is an entry file.
  const { stdout } = await run('git', ['-c', 'core.quotePath=false', '-C', dir, ...args], {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

/** Run one git command, returning undefined instead of throwing. */
async function tryGit(dir: string, args: readonly string[], timeout: number): Promise<string | undefined> {
  try {
    return await git(dir, args, timeout)
  } catch {
    return undefined
  }
}

/** Run git and keep the failure text, for callers that must read git's wording. */
async function tryGitResult(
  dir: string,
  args: readonly string[],
  timeout: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    return { ok: true, stdout: await git(dir, args, timeout), stderr: '' }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? failure.message ?? ''),
    }
  }
}

/**
 * Whether `git rebase --continue` stopped because the replayed commit is now
 * empty (its change is already upstream). Git tells the operator to use
 * `--skip`; the plugin must do the same, otherwise the loop spins to its cap.
 */
export function isEmptyCommitFailure(text: string): boolean {
  return /previous cherry-pick is now empty|nothing to commit|no changes added to commit|no changes did you forget|no changes - did you forget/iu.test(
    text,
  )
}

/** The memory store's git transport. */
export class MemorySync {
  private readonly options: MemorySyncOptions
  private readonly dir: string
  private timer: NodeJS.Timeout | undefined
  private debounce: NodeJS.Timeout | undefined
  private pushing = false
  private inflight: Promise<SyncOutcome> | undefined
  private lastOutcome: SyncOutcome | undefined

  constructor(options: MemorySyncOptions) {
    this.options = options
    this.dir = options.memoriesDir
  }

  /** The outcome of the last completed run, when there was one. */
  get last(): SyncOutcome | undefined {
    return this.lastOutcome
  }

  /**
   * Make the store a git repository and remember the remote.
   *
   * Idempotent: an existing repository is adopted, never reinitialised, and the
   * remote is only added when it is missing. .gitignore is written only when
   * absent so a hand-edited one is not overwritten.
   */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const ignore = join(this.dir, '.gitignore')
    if (!existsSync(ignore)) await writeFile(ignore, STORE_GITIGNORE)
    if (!existsSync(join(this.dir, '.git'))) {
      await git(this.dir, ['init', '-b', 'main'], this.options.gitTimeoutMs)
      await git(this.dir, ['add', '-A'], this.options.gitTimeoutMs)
      await git(this.dir, ['commit', '--quiet', '-m', 'chore(memories): 初始记忆库快照'], this.options.gitTimeoutMs)
        .catch(() => undefined)
      this.options.log.info('dsh-cross-memory: 把记忆库初始化为 git 仓库：%s', this.dir)
    }
    if (this.options.remote.length > 0) {
      const current = await tryGit(this.dir, ['remote', 'get-url', 'origin'], this.options.gitTimeoutMs)
      if (current === undefined) {
        await git(this.dir, ['remote', 'add', 'origin', this.options.remote], this.options.gitTimeoutMs)
      } else if (current.trim() !== this.options.remote) {
        await git(this.dir, ['remote', 'set-url', 'origin', this.options.remote], this.options.gitTimeoutMs)
      }
    }
  }

  /**
   * Start the background timer.
   *
   * A clock schedule wins over an interval: two fixed local times are what the
   * owner asked for (sync right after off-peak pricing starts, when a conflict
   * merge costs least), while an interval is the fallback for anyone who wants
   * continuous convergence.
   */
  start(): void {
    this.stop()
    const clock = this.options.clock ?? []
    if (clock.length > 0) {
      this.armClock(clock)
      return
    }
    if (!(this.options.intervalMs > 0)) return
    this.timer = setInterval(() => {
      void this.run('timer').catch((error: unknown) => {
        this.options.log.warn('dsh-cross-memory: 记忆库同步失败：%o', error)
      })
    }, this.options.intervalMs)
    this.timer.unref?.()
  }

  /** Arms the next clock run; each run arms the following one. */
  private armClock(clock: readonly string[]): void {
    const delay = nextClockDelay(clock, Date.now())
    if (delay === undefined) return
    this.timer = setTimeout(() => {
      void this.run('clock')
        .catch((error: unknown) => {
          this.options.log.warn('dsh-cross-memory: 记忆库同步失败：%o', error)
        })
        .finally(() => {
          if (this.timer !== undefined) this.armClock(clock)
        })
    }, delay)
    this.timer.unref?.()
    this.options.log.info('dsh-cross-memory: 下一次记忆库同步在 %s 之后（%s）',
      Math.round(delay / 60_000) + ' 分钟', clock.join(', '))
  }

  /** Stop the background timer and any queued commit. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.debounce !== undefined) clearTimeout(this.debounce)
    this.timer = undefined
    this.debounce = undefined
  }

  /**
   * Note that the store changed.
   *
   * Deliberately synchronous and cheap: this runs inside a memory write. The
   * commit and the network happen later, on the debounce timer.
   */
  queueCommit(): void {
    if (this.debounce !== undefined) return
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      void this.run('write').catch((error: unknown) => {
        this.options.log.warn('dsh-cross-memory: 记忆库提交失败：%o', error)
      })
    }, this.options.debounceMs)
    this.debounce.unref?.()
  }

  /**
   * Commit, pull and push once.
   *
   * Concurrent calls share one run: two flushes over one directory would index
   * each other's half-written rebase.
   *
   * @param reason - who asked, for the log.
   * @returns what the run did.
   */
  async run(reason: string): Promise<SyncOutcome> {
    if (this.inflight !== undefined) return await this.inflight
    this.inflight = this.flush(reason).finally(() => { this.inflight = undefined })
    const outcome = await this.inflight
    this.lastOutcome = outcome
    return outcome
  }

  /** The body of one run; see {@link run}. */
  private async flush(reason: string): Promise<SyncOutcome> {
    const committed = await this.commit()
    let pulled = 0
    let pushed = false
    let conflicts = 0
    let resolvedByResolver = 0
    let resolvedByTime = 0
    let mergedByStructure = 0
    let stoppedBy: string | undefined
    if (this.options.remote.length > 0) {
      const pull = await this.pull()
      pulled = pull.pulled
      conflicts = pull.conflicts
      resolvedByResolver = pull.resolvedByResolver
      resolvedByTime = pull.resolvedByTime
      mergedByStructure = pull.mergedByStructure
      stoppedBy = pull.stoppedBy
      pushed = await this.push()
    }
    if (committed > 0 || pulled > 0 || conflicts > 0 || pushed || stoppedBy !== undefined) {
      this.options.log.info('dsh-cross-memory: 记忆库同步(%s)：提交 %d、拉取 %d、推送 %s、冲突 %d（AI %d / 时间 %d / 结构 %d）%s',
        reason, committed, pulled, pushed ? '是' : '否', conflicts, resolvedByResolver, resolvedByTime, mergedByStructure,
        stoppedBy === undefined ? '' : '，止于 ' + stoppedBy)
    }
    return { committed, pulled, pushed, conflicts, resolvedByResolver, resolvedByTime, mergedByStructure, stoppedBy }
  }

  /** Stage and commit everything the store changed. */
  private async commit(): Promise<number> {
    // A rebase that was killed leaves conflict markers in the worktree; `add -A`
    // would then commit them into the store — that is how loops.json once
    // reached the remote with `<<<<<<<` lines inside. Roll back first.
    if (this.rebaseInProgress()) {
      await tryGit(this.dir, ['rebase', '--abort'], this.options.gitTimeoutMs)
      this.options.log.warn('dsh-cross-memory: 记忆库停在上一次未完成的 rebase 里，已回滚后才提交')
    }
    await git(this.dir, ['add', '-A'], this.options.gitTimeoutMs).catch(() => undefined)
    const staged = await tryGit(this.dir, ['diff', '--cached', '--name-only'], this.options.gitTimeoutMs)
    const files = (staged ?? '').split('\n').filter((line) => line.length > 0)
    if (files.length === 0) return 0
    const message = 'memory(' + this.options.host + '): ' + files.length + ' 个文件 '
      + new Date().toISOString().replace('T', ' ').slice(0, 19)
    await git(this.dir, ['commit', '--quiet', '-m', message], this.options.gitTimeoutMs)
    return files.length
  }

  /** Whether a rebase was interrupted and still owns the index and worktree. */
  private rebaseInProgress(): boolean {
    return existsSync(join(this.dir, '.git', 'rebase-merge')) || existsSync(join(this.dir, '.git', 'rebase-apply'))
  }

  /** Fetch, then rebase onto the remote branch, resolving entry conflicts. */
  private async pull(): Promise<{
    pulled: number
    conflicts: number
    resolvedByResolver: number
    resolvedByTime: number
    mergedByStructure: number
    stoppedBy?: string
  }> {
    const nothing = { pulled: 0, conflicts: 0, resolvedByResolver: 0, resolvedByTime: 0, mergedByStructure: 0 }
    const fetched = await tryGit(this.dir, ['fetch', '--quiet', 'origin'], this.options.networkTimeoutMs)
    if (fetched === undefined) return nothing
    const behind = await tryGit(this.dir, ['rev-list', '--count', 'HEAD..origin/main'], this.options.gitTimeoutMs)
    if (behind === undefined || Number.parseInt(behind.trim(), 10) === 0) return nothing
    const count = Number.parseInt(behind.trim(), 10)
    const rebase = await tryGit(this.dir, ['rebase', '--quiet', 'origin/main'], this.options.networkTimeoutMs)
    if (rebase !== undefined) return { ...nothing, pulled: count }
    const resolution = await this.resolveRebase()
    return { pulled: count, ...resolution }
  }

  /**
   * Resolve whatever the rebase stopped on, then finish it.
   *
   * Entry files are resolved automatically (the resolver, then the newer
   * `updated` stamp). The loop ledger is a JSON file of independent rows rather
   * than one memory with two edits, so it gets a structural union merge. Anything
   * else aborts the rebase: a store left mid-rebase is far worse than a sync that
   * skipped a cycle.
   */
  private async resolveRebase(): Promise<{
    conflicts: number
    resolvedByResolver: number
    resolvedByTime: number
    mergedByStructure: number
    stoppedBy?: string
  }> {
    let conflicts = 0
    let resolvedByResolver = 0
    let resolvedByTime = 0
    let mergedByStructure = 0
    for (let round = 0; round < 200; round += 1) {
      const unmerged = await tryGit(this.dir, ['diff', '--name-only', '--diff-filter=U'], this.options.gitTimeoutMs)
      const paths = (unmerged ?? '').split('\n').filter((line) => line.length > 0)
      if (paths.length === 0) {
        const cont = await tryGitResult(this.dir, ['rebase', '--continue'], this.options.networkTimeoutMs)
        if (cont.ok) return { conflicts, resolvedByResolver, resolvedByTime, mergedByStructure }
        // An empty commit (its change is already upstream) makes --continue
        // refuse forever; --skip is the documented way forward. Do not gate this
        // on a clean worktree: the memory plugin writes the store concurrently,
        // so `git status` is routinely dirty during a sync and the old gate made
        // the loop spin until the round cap (observed 2026-11-11 on the host).
        if (isEmptyCommitFailure(`${cont.stdout}\n${cont.stderr}`)) {
          const skipped = await tryGit(this.dir, ['rebase', '--skip'], this.options.gitTimeoutMs)
          if (skipped !== undefined) {
            mergedByStructure += 1
            continue
          }
        }
        // Fallback for git builds with different wording: only when the tree is
        // clean is skipping safe without an explicit empty-commit signal.
        const dirty = await tryGit(this.dir, ['status', '--porcelain'], this.options.gitTimeoutMs)
        if ((dirty ?? '').trim() === '') {
          const skipped = await tryGit(this.dir, ['rebase', '--skip'], this.options.gitTimeoutMs)
          if (skipped !== undefined) {
            mergedByStructure += 1
            continue
          }
        }
        continue
      }
      for (const path of paths) {
        const ours = await tryGit(this.dir, ['show', ':' + '2:' + path], this.options.gitTimeoutMs)
        const theirs = await tryGit(this.dir, ['show', ':' + '3:' + path], this.options.gitTimeoutMs)
        if (ours === undefined && theirs === undefined) continue
        conflicts += 1
        // modify/delete: one side removed the file while the other edited it.
        // Keep the surviving text — a machine's edit must not vanish because the
        // other machine retired the row; consolidation can retire it later.
        if (ours === undefined || theirs === undefined) {
          await writeFile(join(this.dir, path), (ours ?? theirs) as string)
          mergedByStructure += 1
          await git(this.dir, ['add', path], this.options.gitTimeoutMs)
          continue
        }
        // Both sides already agree byte for byte: nothing to decide, and git only
        // stopped because the replayed commit touched a file upstream had also
        // rewritten to the same text. This is common for per-host descriptors
        // (`projects/*/hosts/<host>.json`), which every machine rewrites on open.
        if (ours === theirs) {
          await writeFile(join(this.dir, path), ours)
          mergedByStructure += 1
          await git(this.dir, ['add', path], this.options.gitTimeoutMs)
          continue
        }
        if (!isEntryPath(path)) {
          const merged = path === LOOPS_FILE ? mergeLoopLedgers(ours, theirs) : undefined
          if (merged !== undefined) {
            await writeFile(join(this.dir, path), merged)
            mergedByStructure += 1
            await git(this.dir, ['add', path], this.options.gitTimeoutMs)
            continue
          }
          const note = isSessionNotePath(path) ? newerSessionNote(ours, theirs) : undefined
          if (note !== undefined) {
            await writeFile(join(this.dir, path), note)
            resolvedByTime += 1
            await git(this.dir, ['add', path], this.options.gitTimeoutMs)
            continue
          }
          const descriptor = isHostDescriptorPath(path) ? newerHostDescriptor(ours, theirs) : undefined
          if (descriptor !== undefined) {
            await writeFile(join(this.dir, path), descriptor)
            resolvedByTime += 1
            await git(this.dir, ['add', path], this.options.gitTimeoutMs)
            continue
          }
          const persona = isPersonaPath(path) ? mergePersona(ours, theirs) : undefined
          if (persona !== undefined) {
            await writeFile(join(this.dir, path), persona)
            mergedByStructure += 1
            await git(this.dir, ['add', path], this.options.gitTimeoutMs)
            continue
          }
          await tryGit(this.dir, ['rebase', '--abort'], this.options.gitTimeoutMs)
          this.options.log.warn('dsh-cross-memory: 记忆库 rebase 遇到不可自动处理的冲突（%s），已回滚本次同步', path)
          return { conflicts, resolvedByResolver, resolvedByTime, mergedByStructure, stoppedBy: path }
        }
        let text: string | undefined
        if (this.options.resolveConflict !== undefined) {
          try {
            text = await this.options.resolveConflict({ path, ours, theirs })
          } catch (error) {
            this.options.log.warn('dsh-cross-memory: 冲突解析器失败（%s）：%o', path, error)
          }
        }
        if (text !== undefined && parseEntry(text, 'global', 'unknown') !== undefined) {
          await writeFile(join(this.dir, path), text)
          resolvedByResolver += 1
        } else {
          const decided = newerEntry(ours, theirs)
          await writeFile(join(this.dir, path), decided.text)
          resolvedByTime += 1
        }
        await git(this.dir, ['add', path], this.options.gitTimeoutMs)
      }
    }
    await tryGit(this.dir, ['rebase', '--abort'], this.options.gitTimeoutMs)
    this.options.log.warn('dsh-cross-memory: 记忆库 rebase 在 %d 轮后仍未结束，已回滚本次同步', 200)
    return { conflicts, resolvedByResolver, resolvedByTime, mergedByStructure }
  }

  /** Push the current branch, pulling once and retrying when the remote moved. */
  private async push(): Promise<boolean> {
    if (this.pushing) return false
    this.pushing = true
    try {
      const first = await tryGit(this.dir, ['push', '--quiet', 'origin', 'HEAD:main'], this.options.networkTimeoutMs)
      if (first !== undefined) return true
      await this.pull()
      const second = await tryGit(this.dir, ['push', '--quiet', 'origin', 'HEAD:main'], this.options.networkTimeoutMs)
      if (second === undefined) this.options.log.warn('dsh-cross-memory: 记忆库推送失败，下一轮再试')
      return second !== undefined
    } finally {
      this.pushing = false
    }
  }
}

/** The memory id of one entry text, for messages about a conflict. */
export function entryIdOf(text: string): string | undefined {
  const entry: MemoryEntry | undefined = parseEntry(text, 'global', 'unknown')
  return entry?.id
}
