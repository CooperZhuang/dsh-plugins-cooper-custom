/**
 * Tests for the BM25 ranker.
 *
 * BM25 is the ordering layer; the gatekeeper in `search.ts` decides what may be
 * recalled. These pin the properties that make BM25 worth its own ranker: a
 * term that appears everywhere is worth less than a term that names the thing
 * (idf), a title hit outranks a body hit (field multiplicity), and a long
 * document does not win merely by repeating a word (length normalisation).
 *
 * @module dsh-cross-memory/test/bm25.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { BM25_B, BM25_K1, bm25Rank, createBm25Index } from '../bm25.js'
import { relevanceOf, searchMemories } from '../search.js'
import type { MemoryEntry, MemoryKind } from '../types.js'

/** Build one corpus entry. */
function entry(id: string, title: string, body: string, extra: Partial<MemoryEntry> = {}, kind: MemoryKind = 'fact'): MemoryEntry {
  return {
    id,
    scope: 'global',
    kind,
    title,
    body,
    tags: extra.tags ?? [],
    keys: extra.keys ?? [],
    createdAt: 0,
    updatedAt: 0,
    uses: 0,
    lastUsedAt: 0,
    lastSurfacedAt: 0,
    source: 'auto',
    ...extra.appliesTo === undefined ? {} : { appliesTo: extra.appliesTo },
  }
}

test('the constants are the sensitivity audit best cell, not a guess', () => {
  assert.equal(BM25_K1, 1.2)
  assert.equal(BM25_B, 0.75)
})

test('a title hit outranks an identical body hit', () => {
  const corpus = [
    entry('in-title', '插件日志查看方式', '无关正文。'),
    entry('in-body', '无关标题', '插件日志查看方式写在正文里。'),
  ]
  const ranked = bm25Rank(corpus, '插件日志')
  assert.equal(ranked[0]?.id, 'in-title', 'the title is repeated twice in the index')
  assert.ok((createBm25Index(corpus).score('插件日志').get('in-title') ?? 0)
    > (createBm25Index(corpus).score('插件日志').get('in-body') ?? 0))
})

test('a term that appears everywhere is worth less than one that names the thing', () => {
  // 「同步」 is on every entry; the file name is on one. A query naming both
  // must prefer the entry that carries the rare term.
  const corpus = Array.from({ length: 20 }, (_unused, index) =>
    entry(`common-${index}`, `同步任务 ${index}`, '同步 同步 同步。'))
  corpus.push(entry('rare', '同步任务：uk_file_invoice_sha_role', '同步。'))
  const ranked = bm25Rank(corpus, '同步 uk_file_invoice_sha_role')
  assert.equal(ranked[0]?.id, 'rare', 'the rare identifier decides the order')
  const index = createBm25Index(corpus)
  const scores = index.score('同步 uk_file_invoice_sha_role')
  assert.ok((scores.get('rare') ?? 0) > (scores.get('common-0') ?? 0))
})

test('repeating one common word saturates instead of scaling linearly', () => {
  const shortHit = entry('short', '同步说明', '同步。')
  const longRepeat = entry('long', '同步说明', '同步 '.repeat(80))
  const corpus = [shortHit, longRepeat]
  const scores = createBm25Index(corpus).score('同步')
  const once = scores.get('short') ?? 0
  const eighty = scores.get('long') ?? 0
  assert.ok(once > 0 && eighty > 0)
  // 80 repeats are worth about one hit, not eighty: the tf term saturates.
  assert.ok(eighty / once < 10, `repetition scaled too far: ${once.toFixed(2)} -> ${eighty.toFixed(2)}`)
})

test('a query with no shared term returns nothing, and an empty query is empty', () => {
  const corpus = [entry('a', '插件日志', '日志正文。')]
  assert.deepEqual(bm25Rank(corpus, '完全不相关的查询'), [])
  assert.deepEqual(bm25Rank(corpus, ''), [])
  assert.deepEqual(bm25Rank(corpus, '   '), [])
})

test('the index is cached against the exact array it was built from', () => {
  const corpus = [entry('a', '插件日志', '日志正文。')]
  assert.equal(createBm25Index(corpus), createBm25Index(corpus), 'the same array reuses the index')
  assert.notEqual(createBm25Index([...corpus]), createBm25Index(corpus), 'a copy is a different index')
})

test('CJK bigrams rank a Chinese query without a model call', () => {
  const corpus = [
    entry('logs', '插件日志查看方式', '日志写在文件里。'),
    entry('order', '插件注册顺序', '启动时注册。'),
    entry('cost', '成本计量的坑', '另一件事。'),
  ]
  const ranked = bm25Rank(corpus, '该插件是否有日志')
  assert.equal(ranked[0]?.id, 'logs')
  assert.ok(!ranked.some((value) => value.id === 'cost'), 'an unrelated entry does not surface')
})

test('the ranker changes the order, never the admitted set', () => {
  // The gatekeeper decides what may be recalled; BM25 only decides which of
  // those comes first. If a ranker ever adds or drops an entry, the recall
  // gate has silently changed meaning — so pin the set.
  const corpus = [
    entry('logs', '插件日志查看方式', '日志写在文件里。', { keys: ['logging'] }),
    entry('order', '插件注册顺序', '启动时注册。', { tags: ['插件'] }),
    entry('push', '提交后主动推送', '提交完直接推 origin。', { appliesTo: '准备推送代码之前' }),
    entry('cost', '成本计量的坑', '另一件事。'),
    entry('restart', '重启 dsh web', '用 restart 端点。'),
  ]
  const groups = [{ scope: 'global' as const, label: 'global', entries: corpus }]
  const query = '插件的日志和推送'
  const admitted = corpus.filter((value) => relevanceOf(value, query) > 0).map((value) => value.id).sort()
  const ranked = searchMemories(groups, query, { limit: 10 }).map((hit) => hit.entry.id).sort()
  assert.deepEqual(ranked, admitted, 'BM25 must not admit an entry the gatekeeper refused, or hide one it admitted')
})
