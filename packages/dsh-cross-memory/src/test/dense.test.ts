/**
 * Tests for the optional dense channel.
 *
 * The ranker is only exercised on the parts that need no service: fusion order
 * and the degrade-to-lexical guarantee. The embedding call itself is covered by
 * the bench (`run-bench.mts`, dense arm), which runs against a real ollama.
 *
 * @module dsh-cross-memory/test/dense.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { cosine, denseScores, rrf } from '../dense.js'
import type { MemoryEntry } from '../types.js'

function entry(id: string, title: string, body: string): MemoryEntry {
  return {
    id, scope: 'global', kind: 'fact', title, body,
    tags: [], keys: [], createdAt: 0, updatedAt: 0, uses: 0,
    lastUsedAt: 0, lastSurfacedAt: 0, source: 'auto',
  }
}

test('fusion sums reciprocal ranks and keeps the better-placed entry first', () => {
  const fused = rrf([['a', 'b', 'c'], ['a', 'b']])
  // `a` leads both lists; `b` follows it in both; `c` appears once.
  assert.ok((fused.get('a') ?? 0) > (fused.get('b') ?? 0), 'a outranks b on total rank')
  assert.ok((fused.get('b') ?? 0) > (fused.get('c') ?? 0), 'c has only one appearance')
  assert.deepEqual([...fused.keys()], ['a', 'b', 'c'])
})

test('fusion ignores empty lists and returns nothing for no lists', () => {
  assert.deepEqual([...rrf([[], ['a']]).keys()], ['a'])
  assert.equal(rrf([]).size, 0)
})

test('cosine is 1 for identical unit vectors and 0 for orthogonal ones', () => {
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])) - 1) < 1e-6)
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))) < 1e-6)
})

test('an unavailable embedding service degrades to an empty result, never a throw', async () => {
  const entries = [entry('a', '插件日志', '日志正文。')]
  const scores = await denseScores(entries, '插件日志', {
    url: 'http://127.0.0.1:1',
    model: 'test-model',
    cacheDir: '/tmp/dsh-cross-memory-dense-test',
  })
  assert.equal(scores.size, 0, 'the lexical caller falls back on an empty map')
})

test('an empty query or an empty store scores nothing without calling out', async () => {
  const entries = [entry('a', '插件日志', '日志正文。')]
  const options = { url: 'http://127.0.0.1:1', model: 'test-model', cacheDir: '/tmp/dsh-cross-memory-dense-test' }
  assert.equal((await denseScores(entries, '', options)).size, 0)
  assert.equal((await denseScores([], '插件日志', options)).size, 0)
})
