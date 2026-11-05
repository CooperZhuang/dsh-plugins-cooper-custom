/**
 * Runtime half of the store sync: what the plugin itself owns.
 *
 * `sync.ts` knows git and entry arbitration but nothing about this plugin: it
 * takes a resolver and a logger. This module supplies both — the model route a
 * conflict is handed to, the settings that decide whether sync runs at all — and
 * keeps that wiring out of the runtime file, which is already the largest one
 * here.
 *
 * @module dsh-memories/sync-runtime
 */
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { CONSOLIDATE_SYSTEM, classifyPlan, mergePendingPlan, parsePlan, pinExistingScopes } from './consolidate.js'
import type { ConsolidationDispute, ConsolidationPlan } from './consolidate.js'
import { formatEntry, parseEntry, slugify } from './storage.js'
import { MemorySync, parseClockTime } from './sync.js'
import type { EntryConflict, SyncLog } from './sync.js'
import { MEMORY_SOURCE_KIND } from './types.js'
import type { MemoryEntry } from './types.js'
import type { MemoriesSettings } from './config.js'

/** What the sync service needs from the plugin, all resolved lazily. */
export interface StoreSyncHost {
  /** The memory store directory. */
  readonly memoriesDir: string
  /** Tunables in force right now. */
  readonly settings: () => MemoriesSettings
  /** The LLM runtime, when one is provided. */
  readonly llm: () => LlmRuntime | undefined
  /** Plugin logger. */
  readonly log: SyncLog
}

/**
 * Owns the store's {@link MemorySync} for one plugin instance.
 *
 * Starting is idempotent because the settings watcher restarts it on every
 * commit; stopping is safe at any time.
 */
/**
 * The instruction that turns a consolidation pass into a one-entry merge.
 *
 * Same vocabulary as the consolidation pass, so the model does not have to learn
 * a second output shape: a sync conflict is one memory with two revisions.
 */
export function renderConflictPrompt(id: string, ours: string, theirs: string): string {
  return [
    CONSOLIDATE_SYSTEM,
    '',
    'SPECIAL CASE: the input below is TWO REVISIONS OF THE SAME MEMORY (id: ' + id + '), written on two machines.',
    'Return the usual plan JSON with EXACTLY ONE memory: the merged revision, keeping id ' + id + '.',
    'Do not retire it and do not add a second memory. Keep every fact from both revisions; when they contradict, keep both statements and prefer the newer revision for wording.',
    '',
    '--- REVISION A (this machine) ---',
    ours,
    '',
    '--- REVISION B (other machine) ---',
    theirs,
  ].join('\n')
}

/**
 * What a conflict merge produced: the merged file, or the questions it raised.
 *
 * The disputed branch carries the plan fragment that would apply those rows: a
 * row staged without it cannot be accepted at all, and an older version of this
 * module staged every sync dispute with an empty plan, so the panel reported an
 * apply that changed nothing.
 */
export type ConflictMerge =
  | { readonly text: string; readonly merged: true }
  | { readonly text?: undefined; readonly disputes: readonly ConsolidationDispute[]; readonly upserts?: ConsolidationPlan['upserts'] }

/**
 * Turn a model reply into the merged entry file, or into the disputes it raised.
 *
 * Pure so the arbitration is testable without an LLM: the caller hands in the
 * reply and both revisions, and this decides with the same rules the
 * consolidation pass obeys (`parsePlan` for shape, `classifyPlan` for loss).
 */
export function applyConflictPlan(reply: string, oursText: string, theirsText: string): ConflictMerge {
  const ours = parseEntry(oursText, 'global', 'unknown') ?? parseEntry(oursText, 'project', 'unknown')
  const theirs = parseEntry(theirsText, 'global', 'unknown') ?? parseEntry(theirsText, 'project', 'unknown')
  const id = ours?.id ?? theirs?.id
  if (id === undefined || ours === undefined) return { disputes: [] }
  const plan = parsePlan(reply, new Set([id]), 1)
  if (plan === undefined || plan.upserts.length !== 1) return { disputes: [] }
  // A conflict is two revisions of ONE file, and the merge is written back to
  // that same path: scope is part of the path, so the merge cannot move the
  // entry between scopes. Pinning is the same rule every consolidation pass
  // follows, and it also keeps a model that echoed the other revision's scope
  // from staging a "move" that would write a second copy instead of editing the
  // file both machines already share.
  const pinned: ConsolidationPlan = pinExistingScopes(plan, [ours]).plan
  const classified = classifyPlan(pinned, { entries: [ours] })
  // The fragment travels with the rows so accepting one is a plain write.
  if (classified.disputes.length > 0) return { disputes: classified.disputes, upserts: pinned.upserts }
  const item = classified.safe.upserts[0]
  if (item === undefined || item.id !== id) return { disputes: [] }
  const merged: MemoryEntry = {
    ...ours,
    scope: item.scope,
    kind: item.kind,
    title: item.title,
    body: item.body,
    tags: item.tags,
    keys: item.keys ?? ours.keys,
    updatedAt: Math.max(ours.updatedAt, theirs?.updatedAt ?? 0),
    ...(item.appliesTo !== undefined ? { appliesTo: item.appliesTo } : {}),
    ...(item.durability !== undefined ? { durability: item.durability } : {}),
    ...(item.asOf !== undefined ? { asOf: item.asOf } : {}),
  }
  return { text: formatEntry(merged), merged: true }
}

/** A store path that belongs to one project's entry directory. */
const PROJECT_ENTRY_PATH = /^projects\/([^/]+)\/entries\//u

/**
 * Whether a store path is a retired entry's file rather than a live one.
 *
 * Retirements are archived, not deleted, and a store sync merges an archived
 * file exactly like a live one — but applying a plan always writes into
 * `entries/`. A question staged for an archived file would therefore let
 * "accept" resurrect a memory somebody retired, so those conflicts stay on the
 * timestamp rule instead of becoming a decision.
 *
 * @param path - store-relative path of the conflicting file.
 * @returns true for `archive/<id>.md` and `projects/<slug>/archive/<id>.md`.
 */
export function isArchivedEntryPath(path: string): boolean {
  return /(^|\/)archive\//u.test(path)
}

/** Read the `root` of one project descriptor, or `undefined` when absent or unusable. */
async function readDescriptorRoot(file: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { root?: unknown }
    return typeof parsed.root === 'string' && parsed.root.length > 0 ? parsed.root : undefined
  } catch {
    // Missing or unreadable is "unknown", never a reason to invent a path: a
    // wrong root would write one project's merge into another project's store.
    return undefined
  }
}

/**
 * Resolve this machine's checkout of the project a conflicting entry lives in.
 *
 * A project entry is written back through the workspace root the store keys
 * that project by, and a sync conflict only carries store-relative paths. The
 * host descriptor is the primary source because `project.json` is rewritten by
 * whichever machine synced last, while `hosts/<host>.json` keeps THIS machine's
 * checkout and is never overwritten by another machine. The host file is named
 * after the same slug `writeHostDescriptor` uses, not the raw hostname.
 *
 * @param memoriesDir - the memory store root.
 * @param path - the conflicting entry path relative to the store.
 * @returns the checkout root to write through, or `undefined` for a global entry
 *   or when no descriptor names one.
 */
export async function projectRootOf(memoriesDir: string, path: string): Promise<string | undefined> {
  const slug = PROJECT_ENTRY_PATH.exec(path)?.[1]
  if (slug === undefined) return undefined
  const projectDir = join(memoriesDir, 'projects', slug)
  const own = await readDescriptorRoot(join(projectDir, 'hosts', `${slugify(hostname())}.json`))
  if (own !== undefined) return own
  return readDescriptorRoot(join(projectDir, 'project.json'))
}

export class StoreSyncService {
  private sync: MemorySync | undefined

  constructor(private readonly host: StoreSyncHost) {}

  /** Start (or restart) sync from the current settings. */
  start(): void {
    const settings = this.host.settings()
    this.stop()
    const sync = new MemorySync({
      memoriesDir: this.host.memoriesDir,
      remote: settings.syncRemote,
      intervalMs: settings.syncIntervalMinutes > 0 ? settings.syncIntervalMinutes * 60_000 : 0,
      clock: settings.syncClock.split(',').map((part) => part.trim()).filter((part) => parseClockTime(part) !== undefined),
      debounceMs: settings.syncDebounceSeconds * 1_000,
      gitTimeoutMs: 30_000,
      networkTimeoutMs: 60_000,
      log: this.host.log,
      host: hostname(),
      resolveConflict: (conflict) => this.resolve(conflict),
    })
    this.sync = sync
    void sync.init().then(() => {
      if (this.sync !== sync) return
      sync.start()
      this.host.log.decision('dsh-memories: 记忆库同步已启动（remote=%s，间隔 %d 分钟）',
        settings.syncRemote.length > 0 ? settings.syncRemote : '本地', settings.syncIntervalMinutes)
    }, (error: unknown) => {
      this.host.log.warn('dsh-memories: 记忆库同步初始化失败：%o', error)
    })
  }

  /** Stop the timer and any queued commit. */
  stop(): void {
    this.sync?.stop()
    this.sync = undefined
  }

  /** Note that the store changed; the commit happens on the debounce timer. */
  markChanged(): void {
    this.sync?.queueCommit()
  }

  /** Commit, pull and push once, now. */
  async runNow(): Promise<void> {
    await this.sync?.run('manual')
  }

  /**
   * Merge two revisions of one memory through the consolidation machinery.
   *
   * Every failure path returns undefined, which makes `sync.ts` fall back to the
   * newer revision. A merge the loss rules call risky is not written at all: it is
   * staged in the pending proposal, so a sync conflict is answered in the same
   * place as every other consolidation question.
   */
  private async resolve(conflict: EntryConflict): Promise<string | undefined> {
    const llm = this.host.llm()
    if (llm === undefined) return undefined
    const settings = this.host.settings()
    const provider = settings.syncConflictProvider || settings.extractProvider
    const model = settings.syncConflictModel || settings.extractModel
    if (provider.length === 0 || model.length === 0) {
      this.host.log.decision('dsh-memories: 记忆冲突没有可用模型路由（%s），按更新时间取新版', conflict.path)
      return undefined
    }
    const ours = parseEntry(conflict.ours, 'global', 'unknown') ?? parseEntry(conflict.ours, 'project', 'unknown')
    const id = ours?.id ?? parseEntry(conflict.theirs, 'global', 'unknown')?.id
    if (id === undefined) return undefined
    try {
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream({
        provider,
        model,
        messages: [createUserMessage({ content: [{ type: 'text', text: renderConflictPrompt(id, conflict.ours, conflict.theirs) }], source: { kind: MEMORY_SOURCE_KIND } })],
        system: CONSOLIDATE_SYSTEM,
        maxTokens: 2048,
        purpose: 'compaction',
        signal: AbortSignal.timeout(settings.extractTimeoutMs),
      })) assembler.push(chunk)
      const text = assembler.blocks()
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      const applied = applyConflictPlan(text, conflict.ours, conflict.theirs)
      if ('merged' in applied) return applied.text
      if (applied.disputes.length > 0) {
        // Applying a row writes the entry into the live tree, so a conflicted
        // archive file must never become a row: accepting it would bring a
        // retired memory back. The newer revision wins, as everywhere else.
        if (isArchivedEntryPath(conflict.path)) {
          this.host.log.decision('dsh-memories: 归档条目 %s 的合并会丢信息，按更新时间取新版而不进待裁决', conflict.path)
          return undefined
        }
        // A project entry is written back through its workspace root, and the
        // staged row has to carry it: staging '' made accepting it throw
        // "a project scope requires a workspace root" and roll back, so the
        // question could never be answered. A global entry needs no root, and
        // an unknown one stays '' rather than being guessed.
        const projectRoot = await projectRootOf(this.host.memoriesDir, conflict.path) ?? ''
        await mergePendingPlan(this.host.memoriesDir, {
          // The merged body travels with the rows: staging only the question
          // left "accept" with nothing to write, and the panel called that a
          // rewrite.
          plan: { upserts: applied.upserts ?? [], retire: [], skills: [], notes: '同步冲突待裁决' },
          disputes: applied.disputes,
          projectRoot,
          at: Date.now(),
          label: '记忆同步冲突（' + id + '）',
        }).catch((error: unknown) => {
          this.host.log.warn('dsh-memories: 同步冲突未能进入待裁决队列：%o', error)
        })
        this.host.log.decision('dsh-memories: 冲突 %s 的合并会丢信息，已进入待裁决；本轮取更新时间较新的版本', conflict.path)
      }
      return undefined
    } catch (error) {
      this.host.log.warn('dsh-memories: 记忆冲突的模型解析失败，按更新时间取新版：%o', error)
      return undefined
    }
  }
}
