/**
 * Notices: the only thing in this plugin that speaks without being asked.
 *
 * Everything else waits for a turn. A notice is deliberately NOT a message in a
 * conversation — it is a durable record that something deserves the user's
 * attention NOW, addressed to whichever frontend can present it (the desktop pet
 * first, the operating system as a fallback).
 *
 * Design rules, all of them learned from how proactive assistants fail:
 *
 * 1. **Evidence or silence.** A notice carries the ids it is about. If it cannot
 *    say what it is based on, it must not exist.
 * 2. **A notice is an object, not a sentence.** It is queued, delivered, and then
 *    acknowledged or dismissed; the same object is never re-sent inside the
 *    spacing window, and a dismissal is a vote against that kind for a while.
 * 3. **Silence is recorded too**, but only by the caller's log line: this module
 *    returns why it declined to enqueue.
 *
 * @module dsh-memories/notices
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** What a notice is about. */
export type NoticeKind = 'digest' | 'backlog' | 'conflict' | 'loop' | 'reflection'

/** Lifecycle of one notice. */
export type NoticeState = 'open' | 'delivered' | 'acked' | 'expired'

/** How the user answered one notice. */
export type NoticeOutcome = 'acted' | 'dismissed' | 'snoozed'

/** One durable notice. */
export interface Notice {
  /** Stable id, derived from the dedupe key and creation time. */
  readonly id: string
  /** What it is about. */
  readonly kind: NoticeKind
  /** Unix ms. */
  readonly createdAt: number
  /** Earliest moment it may be shown. */
  readonly dueAt: number
  /** One short line, what the bubble says. */
  readonly title: string
  /** The detail a human can expand; never empty. */
  readonly body: string
  /** Ids of the memories / loops this notice is based on. Never empty. */
  readonly evidence: readonly string[]
  /** Two notices with the same key are the same subject. */
  readonly dedupeKey: string
  /** Where it is in its lifecycle. */
  readonly state: NoticeState
  /** When a frontend took it. */
  readonly deliveredAt?: number
  /** What the user did about it. */
  readonly outcome?: NoticeOutcome
  /** When the user answered. */
  readonly ackedAt?: number
}

/** The on-disk queue. */
export interface NoticeQueue {
  readonly version: 1
  /** Unix ms of the last daily digest, so the next one knows what it covers. */
  readonly lastDigestAt?: number
  /** Most recent first is not required; the queue is small and sorted on read. */
  readonly notices: readonly Notice[]
}

/** File name inside the memory store. */
export const NOTICES_FILE = 'notices.json'

/** How long an unacknowledged notice may sit before it is expired. */
export const NOTICE_TTL_MS = 7 * 86_400_000

/** Policy knobs, all injected so the module stays pure. */
export interface NoticePolicy {
  /** Unix ms. */
  readonly now: number
  /** Hours during which nothing may be delivered; `''` disables. */
  readonly quietHours: string
  /** Safety valve, not a target: the user asked for "when it matters", not a quota. */
  readonly dailyCap: number
  /** Same-subject spacing; a dismissal stretches it. */
  readonly minSpacingHours: number
}

/** Read the queue, tolerating a missing or corrupt file. */
export async function readNotices(memoriesDir: string): Promise<NoticeQueue> {
  const text = await readFile(join(memoriesDir, NOTICES_FILE), 'utf8').catch(() => undefined)
  if (text === undefined) return { version: 1, notices: [] }
  try {
    const parsed = JSON.parse(text) as Partial<NoticeQueue>
    const notices = Array.isArray(parsed.notices) ? parsed.notices.filter(isNotice) : []
    return {
      version: 1,
      ...typeof parsed.lastDigestAt === 'number' ? { lastDigestAt: parsed.lastDigestAt } : {},
      notices,
    }
  } catch {
    return { version: 1, notices: [] }
  }
}

/** Write the queue atomically. */
export async function writeNotices(memoriesDir: string, queue: NoticeQueue): Promise<string> {
  const target = join(memoriesDir, NOTICES_FILE)
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temp, `${JSON.stringify({ ...queue, version: 1 }, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return target
}

/** Whether one parsed row is a usable notice. */
function isNotice(value: unknown): value is Notice {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row['id'] === 'string'
    && typeof row['kind'] === 'string'
    && typeof row['title'] === 'string'
    && typeof row['body'] === 'string'
    && Array.isArray(row['evidence'])
    && typeof row['dedupeKey'] === 'string'
    && typeof row['state'] === 'string'
}

/**
 * Decide whether one candidate notice may enter the queue.
 *
 * Runs no model and looks at no clock beyond the injected one: every rule here is
 * explainable, which is the only way "why did it stay quiet?" can be answered
 * later.
 *
 * @param queue - the current queue.
 * @param candidate - what the trigger wants to say.
 * @param policy - caps, spacing and quiet hours.
 * @returns whether it was enqueued, and why not when it was not.
 */
export function admitNotice(
  queue: NoticeQueue,
  candidate: Omit<Notice, 'id' | 'state'>,
  policy: NoticePolicy,
): { ok: true; notice: Notice; dueAt: number } | { ok: false; reason: string } {
  if (candidate.evidence.length === 0) return { ok: false, reason: 'no evidence: a notice must cite what it is about' }

  // Same subject: never twice inside the spacing window. A dismissal doubles it.
  const spacing = policy.minSpacingHours * 3_600_000
  const previous = [...queue.notices]
    .filter((notice) => notice.dedupeKey === candidate.dedupeKey)
    .sort((left, right) => right.createdAt - left.createdAt)[0]
  if (previous !== undefined) {
    const window = previous.outcome === 'dismissed' ? spacing * 2 : spacing
    if (policy.now - previous.createdAt < window) {
      return { ok: false, reason: `same subject already handled ${Math.round((policy.now - previous.createdAt) / 3_600_000)}h ago` }
    }
  }

  // The user asked for "when it matters", not for a quota: the cap is a guard rail
  // against a runaway trigger, not an allowance to spend.
  const since = policy.now - 86_400_000
  const today = queue.notices.filter((notice) => notice.createdAt >= since && notice.state !== 'expired').length
  if (today >= policy.dailyCap) return { ok: false, reason: `daily guard rail reached (${today})` }

  // Quiet hours defer rather than drop: the notice is due when the window opens.
  const dueAt = quietHoursEnd(candidate.dueAt, policy.quietHours)
  const notice: Notice = {
    ...candidate,
    id: `${candidate.kind}-${hash(candidate.dedupeKey)}-${candidate.createdAt.toString(36)}`,
    state: 'open',
  }
  return { ok: true, notice, dueAt }
}

/**
 * Move `dueAt` to the end of the quiet window, when it falls inside one.
 *
 * Windows are written like `peakHours` (`22:00-08:00`, `Mon-Fri 09:00-12:00`) and
 * parsed by the same routine, so there is one syntax for "time of day" in this
 * plugin rather than two.
 *
 * @param dueAt - the moment the trigger wanted to fire.
 * @param quietHours - the window spec; empty disables.
 * @returns the moment it may actually fire.
 */
export function quietHoursEnd(dueAt: number, quietHours: string): number {
  const trimmed = quietHours.trim()
  if (trimmed.length === 0) return dueAt
  // Local-time minutes since midnight for each "HH:MM-HH:MM" window, any weekday.
  for (const part of trimmed.split(',')) {
    const match = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/u.exec(part)
    if (match === null) continue
    const start = Number(match[1]) * 60 + Number(match[2])
    const end = Number(match[3]) * 60 + Number(match[4])
    const at = new Date(dueAt)
    const minutes = at.getHours() * 60 + at.getMinutes()
    const inside = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
    if (!inside) continue
    const offset = ((end - minutes) + 1440) % 1440
    return dueAt + offset * 60_000
  }
  return dueAt
}

/** Notices that may be delivered now, oldest first. */
export function dueNotices(queue: NoticeQueue, now: number): Notice[] {
  return queue.notices
    .filter((notice) => notice.state === 'open' && notice.dueAt <= now)
    .sort((left, right) => right.dueAt - left.dueAt)
}

/** Replace one notice, returning a new queue. */
export function withNotice(queue: NoticeQueue, updated: Notice): NoticeQueue {
  return { ...queue, notices: queue.notices.map((notice) => (notice.id === updated.id ? updated : notice)) }
}

/** Expire notices nobody ever took, so the queue cannot grow forever. */
export function pruneNotices(queue: NoticeQueue, now: number): NoticeQueue {
  return {
    ...queue,
    notices: queue.notices.map((notice) => (
      notice.state === 'open' && now - notice.createdAt > NOTICE_TTL_MS
        ? { ...notice, state: 'expired' as const }
        : notice
    )),
  }
}

/** Stable short hash for ids. */
function hash(text: string): string {
  let value = 0
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) >>> 0
  return value.toString(36).slice(0, 8)
}
