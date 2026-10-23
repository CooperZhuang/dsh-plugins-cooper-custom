/**
 * Tests for the notice queue: the rules that keep a proactive assistant from
 * becoming a nag.
 *
 * @module dsh-memories/test/notices.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { admitNotice, dueNotices, pruneNotices, quietHoursEnd, readNotices, withNotice, writeNotices, NOTICE_TTL_MS } from '../notices.js'
import type { Notice, NoticeQueue } from '../notices.js'
import { say } from '../pet.js'

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
  const at22 = Date.parse('2026-10-23T14:00:00Z') // 22:00 in UTC+8
  const due = quietHoursEnd(at22, '22:00-08:00')
  assert.ok(due > at22, 'held until the window ends')
  assert.equal(quietHoursEnd(at22, ''), at22, 'no window means no delay')
  const daytime = Date.parse('2026-10-23T02:00:00Z') // 10:00 in UTC+8
  assert.equal(quietHoursEnd(daytime, '22:00-08:00'), daytime, 'outside the window it fires now')
})

test('the queue round-trips, delivers once, and expires', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-notices-'))
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

test('the pet channel reports failure instead of throwing', async () => {
  const target = { origin: 'http://127.0.0.1:43120', petId: 'main', routeId: '7340' }
  const ok = await say(target, { text: 'hi', duration: 1 }, (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch)
  assert.equal(ok.ok, true)
  const refused = await say(target, { text: 'hi', duration: 1 }, (async () => new Response('{"ok":false,"reason":"occupied"}', { status: 200 })) as unknown as typeof fetch)
  assert.equal(refused.ok, false)
  assert.match(refused.reason ?? '', /occupied/u)
  const broken = await say(target, { text: 'hi', duration: 1 }, (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
  assert.equal(broken.ok, false)
  assert.match(broken.reason ?? '', /ECONNREFUSED/u)
})