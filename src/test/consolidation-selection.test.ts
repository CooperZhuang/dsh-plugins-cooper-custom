/**
 * Tests for consolidation's input selection.
 *
 * The pass used to receive the newest N memories, which meant an old entry was
 * never looked at again — the only mechanism that could retire a stale fact
 * could not reach one. Selection now prefers what was never reviewed and then
 * what was reviewed longest ago, so nothing starves while new material and
 * material the model actually uses still go first.
 *
 * @module dsh-memories/test/consolidation-selection.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { applyVerdicts, classifyPlan, selectForConsolidation } from '../consolidate.js'
import type { MemoryEntry } from '../types.js'

/** Build one entry. */
function entry(id: string, updatedAt: number, uses = 0, scope: 'global' | 'project' = 'global'): MemoryEntry {
  return {
    id,
    scope,
    kind: 'fact',
    title: id,
    body: 'body',
    tags: [],
    keys: [],
    createdAt: 0,
    updatedAt,
    uses,
    lastUsedAt: 0,
    lastSurfacedAt: 0,
    source: 'auto',
  }
}

/** The review marks a pass records, keyed the way the runtime keys them. */
function reviewed(marks: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(marks).map(([key, value]) => [key.replace(':', '\u0000'), value]))
}

test('never-reviewed entries come first, most used first', () => {
  const selected = selectForConsolidation(
    [entry('a', 100), entry('b', 1, 5), entry('c', 50)],
    reviewed({ 'global:c': 10 }),
    2,
  )
  assert.deepEqual(selected.map((item) => item.id), ['b', 'a'])
})

test('a reviewed entry is chosen by how long it has waited, never starved', () => {
  const entries = [entry('a', 100), entry('b', 90), entry('c', 80)]
  const marks = reviewed({ 'global:a': 900, 'global:b': 500, 'global:c': 100 })
  assert.deepEqual(selectForConsolidation(entries, marks, 2).map((item) => item.id), ['c', 'b'])
  // The one that waited longest last time is first this time.
  assert.deepEqual(selectForConsolidation(entries, reviewed({ 'global:a': 900, 'global:b': 500, 'global:c': 100 }), 1).map((item) => item.id), ['c'])
})

test('fresh material keeps its place ahead of re-review', () => {
  const entries = [entry('fresh', 1), entry('old', 900)]
  const marks = reviewed({ 'global:old': 1 })
  assert.deepEqual(selectForConsolidation(entries, marks, 2).map((item) => item.id), ['fresh', 'old'])
  assert.deepEqual(selectForConsolidation(entries, marks, 1).map((item) => item.id), ['fresh'])
})

test('ties break on recency of the write and then on id, so a pass is reproducible', () => {
  const entries = [entry('b', 5), entry('a', 5), entry('c', 9)]
  assert.deepEqual(selectForConsolidation(entries, new Map(), 3).map((item) => item.id), ['c', 'a', 'b'])
  assert.deepEqual(selectForConsolidation(entries, reviewed({ 'global:a': 7, 'global:b': 7 }), 3).map((item) => item.id), ['c', 'a', 'b'])
})

test('scopes are distinct, and a limit of 0 selects nothing', () => {
  const entries = [entry('shared', 1), entry('shared', 2, 0, 'project')]
  const marks = reviewed({ 'global:shared': 1 })
  // The project copy has never been reviewed, so it goes first even though the
  // global one shares its id.
  assert.deepEqual(selectForConsolidation(entries, marks, 1).map((item) => item.scope), ['project'])
  assert.deepEqual(selectForConsolidation(entries, marks, 0), [])
})
test('a permanent memory is never rewritten or retired unattended', () => {
  const rule: MemoryEntry = { ...entry('rule', 100), source: 'tool', permanent: true, body: 'the standing rule' }
  const plan = {
    upserts: [{ id: 'rule', scope: 'global' as const, kind: 'fact' as const, title: 'rule', body: 'a shorter take', tags: [] }],
    retire: ['rule'],
    skills: [],
    notes: '',
  }
  const { safe, disputes } = classifyPlan(plan, { entries: [rule] })
  assert.equal(safe.upserts.length, 0, 'a permanent memory is not rewritten without a person')
  assert.deepEqual(safe.retire, [], 'and it is not retired either')
  assert.equal(disputes.length, 2)
  for (const dispute of disputes) assert.match(dispute.reason, /永久保留/u)
})
test('a retirement covered by its successor is applied without asking a person', () => {
  const old = { ...entry('old', 100), body: 'keep /a/b.md and the caveat', uses: 4 }
  const plan = {
    upserts: [{ id: 'new', scope: 'global' as const, kind: 'fact' as const, title: 'new', body: 'keep /a/b.md and the caveat, plus more detail', tags: [], derivedFrom: ['old'] }],
    retire: ['old'],
    skills: [],
    notes: '',
  }
  const { safe, disputes } = classifyPlan(plan, { entries: [old] })
  assert.deepEqual(safe.retire, ['old'], 'the predecessor is folded into its successor')
  assert.equal(disputes.length, 0, 'nothing is asked: the content survives')
})

test('permanence stops the automation even when the content is covered', () => {
  const old = { ...entry('old', 100), body: 'keep /a/b.md and the caveat', uses: 4, permanent: true }
  const plan = {
    upserts: [{ id: 'new', scope: 'global' as const, kind: 'fact' as const, title: 'new', body: 'keep /a/b.md and the caveat, plus more detail', tags: [], derivedFrom: ['old'] }],
    retire: ['old'],
    skills: [],
    notes: '',
  }
  const { safe, disputes } = classifyPlan(plan, { entries: [old] })
  assert.deepEqual(safe.retire, [], 'a promise is not automated away')
  assert.equal(disputes.length, 1)
  assert.equal(disputes[0]?.hard, true)
})

test('verdicts apply the accepted, drop the rejected, and keep the unheard', () => {
  const plan = { upserts: [], retire: ['a', 'b', 'c'], skills: [], notes: '' }
  const disputes = [
    { id: 'a', scope: 'global' as const, action: 'retire' as const, title: 'a', reason: 'r', before: 'x', after: '' },
    { id: 'b', scope: 'global' as const, action: 'retire' as const, title: 'b', reason: 'r', before: 'x', after: '' },
    { id: 'c', scope: 'global' as const, action: 'retire' as const, title: 'c', reason: 'r', before: 'x', after: '' },
  ]
  const safe = { upserts: [], retire: [] as string[] }
  const remaining = applyVerdicts(safe, plan, disputes, [
    { id: 'a', accept: true, confidence: 0.9, reason: 'carried over' },
    { id: 'b', accept: false, confidence: 0.8, reason: 'no replacement visible' },
    { id: 'c', accept: true, confidence: 0.3, reason: 'unsure' },
  ], 0.7)
  assert.deepEqual(safe.retire, ['a'], 'only the confident accept is applied')
  assert.deepEqual(remaining.map((row) => row.id), ['c'], 'a low-confidence verdict is not an answer')
})
