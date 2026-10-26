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
 * @module dsh-memories/sync
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
}

/** Options for {@link MemorySync}. */
export interface MemorySyncOptions {
  /** The memory store directory; it becomes the git working copy. */
  readonly memoriesDir: string
  /** Git remote to pull from and push to. Empty keeps the repository local. */
  readonly remote: string
  /** Background interval in milliseconds; 0 disables the timer. */
  readonly intervalMs: number
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

/** Run one git command and return its stdout. */
async function git(dir: string, args: readonly string[], timeout: number): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, ...args], {
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
      this.options.log.info('dsh-memories: 把记忆库初始化为 git 仓库：%s', this.dir)
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

  /** Start the background timer, if an interval is configured. */
  start(): void {
    this.stop()
    if (!(this.options.intervalMs > 0)) return
    this.timer = setInterval(() => {
      void this.run('timer').catch((error: unknown) => {
        this.options.log.warn('dsh-memories: 记忆库同步失败：%o', error)
      })
    }, this.options.intervalMs)
    this.timer.unref?.()
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
        this.options.log.warn('dsh-memories: 记忆库提交失败：%o', error)
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
    if (this.options.remote.length > 0) {
      const pull = await this.pull()
      pulled = pull.pulled
      conflicts = pull.conflicts
      resolvedByResolver = pull.resolvedByResolver
      resolvedByTime = pull.resolvedByTime
      pushed = await this.push()
    }
    if (committed > 0 || pulled > 0 || conflicts > 0 || pushed) {
      this.options.log.info('dsh-memories: 记忆库同步(%s)：提交 %d、拉取 %d、推送 %s、冲突 %d（AI %d / 时间 %d）',
        reason, committed, pulled, pushed ? '是' : '否', conflicts, resolvedByResolver, resolvedByTime)
    }
    return { committed, pulled, pushed, conflicts, resolvedByResolver, resolvedByTime }
  }

  /** Stage and commit everything the store changed. */
  private async commit(): Promise<number> {
    await git(this.dir, ['add', '-A'], this.options.gitTimeoutMs).catch(() => undefined)
    const staged = await tryGit(this.dir, ['diff', '--cached', '--name-only'], this.options.gitTimeoutMs)
    const files = (staged ?? '').split('\n').filter((line) => line.length > 0)
    if (files.length === 0) return 0
    const message = 'memory(' + this.options.host + '): ' + files.length + ' 个文件 '
      + new Date().toISOString().replace('T', ' ').slice(0, 19)
    await git(this.dir, ['commit', '--quiet', '-m', message], this.options.gitTimeoutMs)
    return files.length
  }

  /** Fetch, then rebase onto the remote branch, resolving entry conflicts. */
  private async pull(): Promise<{ pulled: number; conflicts: number; resolvedByResolver: number; resolvedByTime: number }> {
    const fetched = await tryGit(this.dir, ['fetch', '--quiet', 'origin'], this.options.networkTimeoutMs)
    if (fetched === undefined) return { pulled: 0, conflicts: 0, resolvedByResolver: 0, resolvedByTime: 0 }
    const behind = await tryGit(this.dir, ['rev-list', '--count', 'HEAD..origin/main'], this.options.gitTimeoutMs)
    if (behind === undefined || Number.parseInt(behind.trim(), 10) === 0) {
      return { pulled: 0, conflicts: 0, resolvedByResolver: 0, resolvedByTime: 0 }
    }
    const count = Number.parseInt(behind.trim(), 10)
    const rebase = await tryGit(this.dir, ['rebase', '--quiet', 'origin/main'], this.options.networkTimeoutMs)
    if (rebase !== undefined) return { pulled: count, conflicts: 0, resolvedByResolver: 0, resolvedByTime: 0 }
    const resolution = await this.resolveRebase()
    return { pulled: count, conflicts: resolution.conflicts, resolvedByResolver: resolution.resolvedByResolver, resolvedByTime: resolution.resolvedByTime }
  }

  /**
   * Resolve whatever the rebase stopped on, then finish it.
   *
   * Only entry files are resolved automatically. Anything else aborts the rebase:
   * a store left mid-rebase is far worse than a sync that skipped a cycle.
   */
  private async resolveRebase(): Promise<{ conflicts: number; resolvedByResolver: number; resolvedByTime: number }> {
    let conflicts = 0
    let resolvedByResolver = 0
    let resolvedByTime = 0
    for (let round = 0; round < 20; round += 1) {
      const unmerged = await tryGit(this.dir, ['diff', '--name-only', '--diff-filter=U'], this.options.gitTimeoutMs)
      const paths = (unmerged ?? '').split('\n').filter((line) => line.length > 0)
      if (paths.length === 0) {
        const cont = await tryGit(this.dir, ['rebase', '--continue'], this.options.networkTimeoutMs)
        if (cont !== undefined) return { conflicts, resolvedByResolver, resolvedByTime }
        continue
      }
      for (const path of paths) {
        if (!isEntryPath(path)) {
          await tryGit(this.dir, ['rebase', '--abort'], this.options.gitTimeoutMs)
          this.options.log.warn('dsh-memories: 记忆库 rebase 遇到不可自动处理的冲突（%s），已回滚本次同步', path)
          return { conflicts, resolvedByResolver, resolvedByTime }
        }
        conflicts += 1
        const ours = await tryGit(this.dir, ['show', ':' + '2:' + path], this.options.gitTimeoutMs)
        const theirs = await tryGit(this.dir, ['show', ':' + '3:' + path], this.options.gitTimeoutMs)
        if (ours === undefined || theirs === undefined) continue
        let text: string | undefined
        if (this.options.resolveConflict !== undefined) {
          try {
            text = await this.options.resolveConflict({ path, ours, theirs })
          } catch (error) {
            this.options.log.warn('dsh-memories: 冲突解析器失败（%s）：%o', path, error)
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
    return { conflicts, resolvedByResolver, resolvedByTime }
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
      if (second === undefined) this.options.log.warn('dsh-memories: 记忆库推送失败，下一轮再试')
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
