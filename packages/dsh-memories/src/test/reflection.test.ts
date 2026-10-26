/**
 * Tests for the reflection layer.
 *
 * The rule under test is the one that separates a reflection from a plausible
 * paragraph: no evidence, no observation. Also pinned: the pass refuses thin
 * material, and it runs at most weekly.
 *
 * @module dsh-memories/test/reflection
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  REFLECTION_INTERVAL_MS,
  REFLECTION_MIN_ENTRIES,
  listReflections,
  parseReflection,
  previousInsights,
  reflectionDue,
  renderReflectionFile,
  writeReflection,
} from '../reflection.js'

const NOW = Date.parse('2026-10-24T03:00:00Z')
const known = new Set(['mem-a', 'mem-b'])

test('an observation that cannot cite the store is dropped', () => {
  const reply = JSON.stringify({
    insights: [
      { text: '他总是在同一个项目上先写测试再改实现', evidence: ['mem-a', 'mem-b'] },
      { text: '他大概喜欢深色主题', evidence: ['made-up'] },
      { text: '没有依据的泛泛之谈，看起来像结论', evidence: [] },
      { text: '短', evidence: ['mem-a'] },
    ],
  })
  const insights = parseReflection(reply, known)
  assert.equal(insights.length, 1)
  assert.equal(insights[0]?.text, '他总是在同一个项目上先写测试再改实现')
  assert.deepEqual(insights[0]?.evidence, ['mem-a', 'mem-b'])
})

test('a reply that is not JSON yields nothing rather than throwing', () => {
  assert.deepEqual(parseReflection('I think the user is nice.', known), [])
  assert.deepEqual(parseReflection('{"insights": "nope"}', known), [])
})

test('the pass refuses thin material and runs at most weekly', () => {
  assert.equal(reflectionDue(0, NOW, REFLECTION_MIN_ENTRIES - 1), false, 'too few memories to synthesize')
  assert.equal(reflectionDue(0, NOW, REFLECTION_MIN_ENTRIES), true, 'never reflected, material present')
  assert.equal(reflectionDue(NOW - 1000, NOW, 80), false, 'once a week, not once an hour')
  assert.equal(reflectionDue(NOW - REFLECTION_INTERVAL_MS, NOW, 80), true)
})

test('a reflection round-trips as a dated markdown file with its evidence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-reflection-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const insights = [{ text: '他会为一个错误重启三次，然后要求把验证做成探针', evidence: ['mem-a'] }]
  const rendered = renderReflectionFile(insights, NOW)
  assert.match(rendered, /^---\ncreated:/u)
  assert.match(rendered, /依据：mem-a/u, 'the file carries the ids, not just the claim')

  const path = await writeReflection(dir, insights, NOW)
  assert.match(path, /2026-10-24\.md$/u)
  const files = await listReflections(dir)
  assert.equal(files.length, 1)
  assert.deepEqual(previousInsights(files), ['他会为一个错误重启三次，然后要求把验证做成探针'])
})
