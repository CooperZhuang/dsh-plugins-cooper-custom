/**
 * Tests for the notice queue: the rules that keep a proactive assistant from
 * becoming a nag.
 *
 * @module dsh-cross-memory/test/notices.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ackNotice, admitNotice, dueNotices, pruneNotices, quietHoursEnd, readNotices, withNotice, writeNotices, NOTICE_TTL_MS } from '../notices.js'
import type { Notice, NoticeQueue } from '../notices.js'
import { gateNotices, parseGateReply } from '../gate.js'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const policy = { now: NOW, quietHours: '', dailyCap: 3, minSpacingHours: 6 }
const CANDIDATE = {
  kind: 'digest' as const,
  createdAt: NOW,
  dueAt: NOW,
  title: '昨天我整理了 21 条记忆',
  body: '新增 5、退役 9',
  evidence: ['digest'],
  dedupeKey: 'digest:daily',
}

test('a notice without evidence is refused', () => {
  const verdict = admitNotice({ version: 1, notices: [] }, { ...CANDIDATE, evidence: [] }, policy)
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.reason : '', /evidence/u)
})

test('the same subject is never repeated inside the spacing window', () => {
  const first = admitNotice({ version: 1, notices: [] }, CANDIDATE, policy)
  assert.equal(first.ok, true)
  if (!first.ok) return
  const queue: NoticeQueue = { version: 1, notices: [first.notice] }
  const at1h = { ...policy, now: NOW + 3_600_000 }
  const again = admitNotice(queue, { ...CANDIDATE, createdAt: NOW + 3_600_000 }, at1h)
  assert.equal(again.ok, false, 'an hour later is still too soon')

  const later = admitNotice(queue, { ...CANDIDATE, createdAt: NOW + 7 * 3_600_000 }, { ...policy, now: NOW + 7 * 3_600_000 })
  assert.equal(later.ok, true, 'after the window it may speak again')
})

test('a dismissal doubles the silence', () => {
  const first = admitNotice({ version: 1, notices: [] }, CANDIDATE, policy)
  if (!first.ok) return
  const dismissed: Notice = { ...first.notice, state: 'acked', outcome: 'dismissed', ackedAt: NOW + 1000 }
  const queue: NoticeQueue = { version: 1, notices: [dismissed] }
  const at7h = admitNotice(queue, { ...CANDIDATE, createdAt: NOW + 7 * 3_600_000 }, { ...policy, now: NOW + 7 * 3_600_000 })
  assert.equal(at7h.ok, false, 'dismissed subjects wait twice as long')
  const at13h = admitNotice(queue, { ...CANDIDATE, createdAt: NOW + 13 * 3_600_000 }, { ...policy, now: NOW + 13 * 3_600_000 })
  assert.equal(at13h.ok, true)
})

test('the daily cap is a guard rail against a runaway trigger', () => {
  const notices: Notice[] = [1, 2, 3].map((index) => ({
    ...CANDIDATE,
    id: 'n' + index,
    dedupeKey: 'other:' + index,
    state: 'delivered' as const,
  }))
  const verdict = admitNotice({ version: 1, notices }, { ...CANDIDATE, dedupeKey: 'fresh' }, policy)
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.reason : '', /guard rail/u)
})

test('quiet hours defer a notice instead of dropping it', () => {
  // Local-time constructors: quiet hours use the host clock, so an absolute UTC
  // timestamp would only test the machine's timezone (and fail on UTC CI).
  const at22 = new Date(2026, 9, 23, 22, 0, 0).getTime()
  const due = quietHoursEnd(at22, '22:00-08:00')
  assert.ok(due > at22, 'held until the window ends')
  assert.equal(quietHoursEnd(at22, ''), at22, 'no window means no delay')
  const daytime = new Date(2026, 9, 23, 10, 0, 0).getTime()
  assert.equal(quietHoursEnd(daytime, '22:00-08:00'), daytime, 'outside the window it fires now')
})

test('the queue round-trips, delivers once, and expires', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-notices-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const admitted = admitNotice({ version: 1, notices: [] }, CANDIDATE, policy)
  assert.equal(admitted.ok, true)
  if (!admitted.ok) return
  await writeNotices(dir, { version: 1, notices: [admitted.notice] })

  const loaded = await readNotices(dir)
  assert.equal(loaded.notices.length, 1)
  assert.deepEqual(dueNotices(loaded, NOW + 1000).map((notice) => notice.id), [admitted.notice.id])

  const delivered = withNotice(loaded, { ...admitted.notice, state: 'delivered', deliveredAt: NOW })
  assert.deepEqual(dueNotices(delivered, NOW + 1000), [], 'a delivered notice is not due again')

  const stale = pruneNotices({ version: 1, notices: [admitted.notice] }, NOW + NOTICE_TTL_MS + 1)
  assert.equal(stale.notices[0]?.state, 'expired', 'nothing sits in the queue forever')
})

test('the gate only authorises ids it was shown, and fails to silence', async () => {
  const candidates = [
    { id: 'loop-a', title: '还挂着：把报销单交给财务', detail: '说了 4 天' },
    { id: 'loop-b', title: '还挂着：看看部署脚本', detail: '说了 9 天' },
  ]
  const parsed = parseGateReply('{"deliver":["loop-a","loop-made-up"],"reason":"a 有硬期限"}', candidates)
  assert.equal(parsed.failed, false)
  assert.deepEqual([...parsed.deliver], ['loop-a'], 'an invented id is not permission')
  assert.equal(parsed.reason, 'a 有硬期限')

  assert.equal(parseGateReply('not json at all', candidates).failed, true, 'garbage is not permission')
  const fenced = parseGateReply('```json\n{"deliver":[],"reason":"都可以等"}\n```', candidates)
  assert.equal(fenced.deliver.size, 0)
  assert.equal(fenced.reason, '都可以等')

  const noLlm = await gateNotices({ llm: undefined, session: undefined, candidates, timeoutMs: 1000, signal: new AbortController().signal })
  assert.equal(noLlm.deliver.size, 0)
  assert.equal(noLlm.skipped, 'no-llm')
  const nothing = await gateNotices({ llm: undefined, session: undefined, candidates: [], timeoutMs: 1000, signal: new AbortController().signal })
  assert.equal(nothing.deliver.size, 0)
})
test('answering a notice records the outcome, and only once', () => {
  const first = admitNotice({ version: 1, notices: [] }, CANDIDATE, policy)
  assert.equal(first.ok, true)
  if (!first.ok) return
  const queue: NoticeQueue = { version: 1, notices: [{ ...first.notice, state: 'delivered', deliveredAt: NOW }] }

  const answered = ackNotice(queue, first.notice.id.slice(0, 12), 'dismissed', NOW + 1000)
  assert.equal(answered.notice?.id, first.notice.id, 'a unique prefix is enough to answer')
  const stored = answered.queue.notices[0]
  assert.equal(stored?.state, 'acked')
  assert.equal(stored?.outcome, 'dismissed')
  assert.equal(stored?.ackedAt, NOW + 1000)

  const again = ackNotice(answered.queue, first.notice.id, 'acted', NOW + 2000)
  assert.equal(again.notice, undefined, 'an answered notice is not answered twice')
  assert.match(again.reason ?? '', /no unacknowledged notice/u)
})

test('an ambiguous or unknown prefix is refused instead of guessing', () => {
  const one = admitNotice({ version: 1, notices: [] }, CANDIDATE, policy)
  const two = admitNotice({ version: 1, notices: [] }, { ...CANDIDATE, dedupeKey: 'other' }, policy)
  if (!one.ok || !two.ok) return
  const queue: NoticeQueue = {
    version: 1,
    notices: [
      { ...one.notice, state: 'delivered', deliveredAt: NOW },
      { ...two.notice, state: 'delivered', deliveredAt: NOW },
    ],
  }
  const ambiguous = ackNotice(queue, 'digest-', 'acted', NOW)
  assert.equal(ambiguous.notice, undefined)
  assert.match(ambiguous.reason ?? '', /be more specific/u)
  const unknown = ackNotice(queue, 'zzzz', 'acted', NOW)
  assert.equal(unknown.notice, undefined)
})
