/**
 * Tests for the open-loop ledger.
 *
 * The rules pinned here are the ones that keep proactivity honest: one promise is
 * ONE loop (dedupe), an undated note is never a reminder, a reminder repeats at
 * most three times, and nothing stays open forever.
 *
 * @module dsh-memories/test/loops
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { LOOP_CAP, LOOP_TTL_MS, closeLoop, describeLoops, dueLoops, mergeLoops, pruneLoops, withLoop } from '../loops.js'
import type { LoopStore } from '../loops.js'
import { parseExtraction } from '../extract.js'

const NOW = Date.parse('2026-10-24T02:00:00Z')
const empty: LoopStore = { version: 1, loops: [] }

test('the same promise said twice is one loop', () => {
  const first = mergeLoops(empty, [{ text: '把报价单发出去' }], NOW, 's1')
  const second = mergeLoops(first, [{ text: '把报价单  发出去' }], NOW + 1000, 's2')
  assert.equal(second.loops.length, 1, 'whitespace is not a new promise')
  assert.equal(second.loops[0]?.openedAt, NOW, 'the first sighting keeps its age')
})

test('a later deadline replaces the old one instead of adding a loop', () => {
  const first = mergeLoops(empty, [{ text: '周五前把报价单发出去', dueAt: NOW + 86_400_000 }], NOW)
  const moved = mergeLoops(first, [{ text: '周五前把报价单发出去', dueAt: NOW + 4 * 86_400_000 }], NOW + 1000)
  assert.equal(moved.loops.length, 1)
  assert.equal(moved.loops[0]?.dueAt, NOW + 4 * 86_400_000, 'the user moved the promise')
})

test('only a dated loop may raise a reminder, at most three times a day apart', () => {
  let store = mergeLoops(empty, [{ text: '下周再看部署脚本' }, { text: '明天把发票寄出去', dueAt: NOW - 1000 }], NOW)
  const due = dueLoops(store, NOW)
  assert.deepEqual(due.map((loop) => loop.text), ['明天把发票寄出去'], 'an undated note is not a promise')

  const id = due[0]!.id
  store = withLoop(store, id, { remindedAt: NOW, remindCount: 1 })
  assert.equal(dueLoops(store, NOW + 1000).length, 0, 'not twice in the same hour')
  assert.equal(dueLoops(store, NOW + 86_400_001).length, 1, 'a day later is allowed')

  store = withLoop(store, id, { remindedAt: NOW + 86_400_001, remindCount: 3 })
  assert.equal(dueLoops(store, NOW + 10 * 86_400_000).length, 0, 'three reminders and it stops')
})

test('an untouched loop expires, and closing accepts a unique prefix', () => {
  const store = mergeLoops(empty, [{ text: '把报销单交给财务' }], NOW)
  const later = pruneLoops(store, NOW + LOOP_TTL_MS + 1)
  assert.equal(later.loops[0]?.state, 'expired')

  const id = store.loops[0]!.id
  const closed = closeLoop(store, id.slice(0, 6))
  assert.equal(closed.closed?.id, id)
  assert.equal(closed.store.loops[0]?.state, 'done')
  assert.equal(closeLoop(store, 'zzz').reason !== undefined, true)
})

test('the ledger is capped so it cannot become a second backlog', () => {
  const many = Array.from({ length: LOOP_CAP + 5 }, (_, index) => ({ text: '第' + index + '件要做的事' }))
  const store = mergeLoops(empty, many, NOW)
  const open = store.loops.filter((loop) => loop.state === 'open')
  assert.equal(open.length, LOOP_CAP)
  assert.equal(store.loops.length, LOOP_CAP + 5, 'the rest are dropped, not deleted')
})

test('the command view puts the soonest deadline first', () => {
  const store = mergeLoops(empty, [
    { text: '没日期的笔记' },
    { text: '后天交报告', dueAt: NOW + 2 * 86_400_000 },
    { text: '今天交报告', dueAt: NOW + 1000 },
  ], NOW)
  const view = describeLoops(store, NOW)
  assert.match(view, /今天交报告[\s\S]*后天交报告/u)
})

test('extraction keeps a real deadline and drops an invented one', () => {
  const reply = JSON.stringify({
    memories: [],
    summary: 's',
    loops: [
      { text: '周五前把合同发出去', dueAt: '2026-10-30T00:00:00Z' },
      { text: '顺手清理一下桌面', dueAt: '不是日期' },
      { text: '' },
    ],
  })
  const parsed = parseExtraction(reply, 10, 'session-1')
  assert.equal(parsed.loops.length, 2)
  assert.equal(parsed.loops[0]?.dueAt, Date.parse('2026-10-30T00:00:00Z'))
  assert.equal(parsed.loops[1]?.dueAt, undefined, 'an unparseable deadline is dropped, never defaulted')
})
