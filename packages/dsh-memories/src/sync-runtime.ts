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
import { hostname } from 'node:os'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { parseEntry } from './storage.js'
import { MemorySync } from './sync.js'
import type { EntryConflict, SyncLog } from './sync.js'
import { MEMORY_SOURCE_KIND } from './types.js'
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

/** System prompt for one conflict merge. */
const MERGE_SYSTEM = 'You merge two revisions of one stored memory. Reply with the entry file only.'

/**
 * Owns the store's {@link MemorySync} for one plugin instance.
 *
 * Starting is idempotent because the settings watcher restarts it on every
 * commit; stopping is safe at any time.
 */
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
   * Merge two revisions of one memory with a model.
   *
   * Every failure path returns undefined, which makes `sync.ts` fall back to the
   * newer revision. A conflict is rare; a store that cannot sync because a model
   * was busy would be worse than one that syncs on the timestamp rule.
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
    const id = parseEntry(conflict.ours, 'global', 'unknown')?.id ?? 'unchanged'
    const prompt = [
      'Two machines edited the same memory entry. Merge them into ONE entry file.',
      'Keep every fact from both sides; prefer the more specific wording when they disagree.',
      'Output ONLY the complete entry file: YAML frontmatter (id, scope, kind, title, tags, keys, appliesTo, created, updated) then a blank line and the body.',
      'The id must stay ' + id + '. Take the newer of the two updated timestamps.',
      '',
      '--- THIS MACHINE ---',
      conflict.ours,
      '',
      '--- OTHER MACHINE ---',
      conflict.theirs,
    ].join('\n')
    try {
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream({
        provider,
        model,
        messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: MEMORY_SOURCE_KIND } })],
        system: MERGE_SYSTEM,
        maxTokens: 2048,
        purpose: 'compaction',
        signal: AbortSignal.timeout(settings.extractTimeoutMs),
      })) assembler.push(chunk)
      const text = assembler.blocks()
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      const fenced = /```(?:markdown|md)?\n([\s\S]*?)```/u.exec(text)
      const candidate = (fenced?.[1] ?? text).trim()
      if (parseEntry(candidate, 'global', 'unknown') === undefined) return undefined
      return candidate + '\n'
    } catch (error) {
      this.host.log.warn('dsh-memories: 记忆冲突的模型解析失败，按更新时间取新版：%o', error)
      return undefined
    }
  }
}
