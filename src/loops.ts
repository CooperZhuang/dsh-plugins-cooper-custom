/**
 * Open loops: the things the user said they would do and has not done yet.
 *
 * This is the only input a proactive assistant can act on that is not a clock or
 * a queue: "Friday" is a real deadline because somebody said it, not because a
 * timestamp says so. Meta's MemoProAgent calls the same object an *open loop* and
 * makes the point this module is built around — a reminder is only justified when
 * there is a loop to close, otherwise a relevant memory is just noise.
 *
 * The lifecycle is deliberately narrow: a loop is opened by an extraction, closed
 * by the user, or dies. Nothing here decides *whether* to speak; that is the
 * notice gate's job. This module only keeps an honest ledger.
 *
 * @module dsh-memories/loops
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Where one loop is in its life. */
export type LoopState = 'open' | 'done' | 'dropped' | 'expired'

/** One thing said but not done. */
export interface LoopItem {
  /** Stable id derived from the text. */
  readonly id: string
  /** What was said they would do; short and in their words. */
  readonly text: string
  /** When it was captured. */
  readonly openedAt: number
  /** The moment it was promised for, when one was said. */
  readonly dueAt?: number
  /** Current state. */
  readonly state: LoopState
  /** Session it came from. */
  readonly sourceSession?: string
  /** Last time it was raised as a notice. */
  readonly remindedAt?: number
  /** How many times it has been raised. */
  readonly remindCount?: number
}

/** The on-disk ledger. */
export interface LoopStore {
  readonly version: 1
  readonly loops: readonly LoopItem[]
}

/** File name inside the memory store. */
export const LOOPS_FILE = 'loops.json'

/** How long an untouched loop may stay open before it expires. */
export const LOOP_TTL_MS = 21 * 86_400_000

/** How many open loops are kept; the oldest are dropped past this. */
export const LOOP_CAP = 50

/** Reminders per loop, and the spacing between them. */
export const LOOP_MAX_REMINDERS = 3
export const LOOP_REMIND_INTERVAL_MS = 24 * 3_600_000

/** Read the ledger, tolerating a missing or corrupt file. */
export async function readLoops(memoriesDir: string): Promise<LoopStore> {
  const text = await readFile(join(memoriesDir, LOOPS_FILE), 'utf8').catch(() => undefined)
  if (text === undefined) return { version: 1, loops: [] }
  try {
    const parsed = JSON.parse(text) as Partial<LoopStore>
    return { version: 1, loops: Array.isArray(parsed.loops) ? parsed.loops.filter(isLoop) : [] }
  } catch {
    return { version: 1, loops: [] }
  }
}

/** Write the ledger atomically. */
export async function writeLoops(memoriesDir: string, store: LoopStore): Promise<string> {
  const target = join(memoriesDir, LOOPS_FILE)
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temp, `${JSON.stringify({ ...store, version: 1 }, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return target
}

/** Whether one parsed row is usable. */
function isLoop(value: unknown): value is LoopItem {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row['id'] === 'string'
    && typeof row['text'] === 'string'
    && typeof row['state'] === 'string'
    && typeof row['openedAt'] === 'number'
}

/**
 * Fold newly extracted promises into the ledger.
 *
 * Duplicates are the normal case, not the exception: a promise repeated across
 * three sessions must be ONE loop, or the user gets reminded three times about
 * the same thing. Matching is on normalized text and containment, which is crude
 * but predictable — the failure mode of a cleverer match is silently merging two
 * different promises.
 *
 * @param store - the current ledger.
 * @param candidates - what an extraction just found.
 * @param now - clock.
 * @param sessionId - where they came from.
 * @returns the new ledger.
 */
export function mergeLoops(
  store: LoopStore,
  candidates: readonly { text: string; dueAt?: number }[],
  now: number,
  sessionId?: string,
): LoopStore {
  const loops = [...store.loops]
  for (const candidate of candidates) {
    const text = candidate.text.replace(/\s+/gu, ' ').trim().slice(0, 200)
    if (text.length === 0) continue
    const key = normalize(text)
    if (key.length < 4) continue
    const existing = loops.find((loop) => loop.state === 'open' && overlaps(normalize(loop.text), key))
    if (existing !== undefined) {
      // A later deadline wins: the user moved the promise, they did not make two.
      if (candidate.dueAt !== undefined && (existing.dueAt === undefined || candidate.dueAt > existing.dueAt)) {
        const index = loops.indexOf(existing)
        loops[index] = { ...existing, dueAt: candidate.dueAt }
      }
      continue
    }
    loops.push({
      id: `loop-${hash(key)}`,
      text,
      openedAt: now,
      ...candidate.dueAt === undefined ? {} : { dueAt: candidate.dueAt },
      state: 'open',
      ...sessionId === undefined ? {} : { sourceSession: sessionId },
    })
  }
  // Cap: an open-loop list that grows without bound becomes a second backlog.
  const open = loops.filter((loop) => loop.state === 'open')
  if (open.length > LOOP_CAP) {
    const stale = open.sort((left, right) => left.openedAt - right.openedAt).slice(0, open.length - LOOP_CAP)
    for (const loop of stale) {
      const index = loops.indexOf(loop)
      loops[index] = { ...loop, state: 'dropped' }
    }
  }
  return { version: 1, loops }
}

/** Expire loops nobody closed and nobody mentioned in weeks. */
export function pruneLoops(store: LoopStore, now: number): LoopStore {
  return {
    version: 1,
    loops: store.loops.map((loop) => (
      loop.state === 'open' && now - loop.openedAt > LOOP_TTL_MS ? { ...loop, state: 'expired' as const } : loop
    )),
  }
}

/**
 * Loops that may be raised right now.
 *
 * Only loops with a stated deadline qualify. A loop without one is a note, not a
 * promise, and nagging somebody about a note they never dated is how a helpful
 * assistant turns into a supervisor.
 *
 * @param store - the ledger.
 * @param now - clock.
 * @returns loops to raise, oldest deadline first.
 */
export function dueLoops(store: LoopStore, now: number): LoopItem[] {
  return store.loops
    .filter((loop) => loop.state === 'open'
      && loop.dueAt !== undefined
      && loop.dueAt <= now
      && (loop.remindCount ?? 0) < LOOP_MAX_REMINDERS
      && (loop.remindedAt === undefined || now - loop.remindedAt >= LOOP_REMIND_INTERVAL_MS))
    .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0))
}

/** Record that one loop was raised, or close it. */
export function withLoop(store: LoopStore, id: string, update: Partial<LoopItem>): LoopStore {
  return { version: 1, loops: store.loops.map((loop) => (loop.id === id ? { ...loop, ...update } : loop)) }
}

/** Close one loop by the id the user typed, accepting a unique prefix. */
export function closeLoop(store: LoopStore, idOrPrefix: string): { store: LoopStore; closed?: LoopItem; reason?: string } {
  const needle = idOrPrefix.trim()
  if (needle.length === 0) return { store, reason: 'an id is required' }
  const matches = store.loops.filter((loop) => loop.id.startsWith(needle) && loop.state === 'open')
  if (matches.length === 0) return { store, reason: 'no open loop matches ' + needle }
  if (matches.length > 1) return { store, reason: `${matches.length} open loops match ${needle}; be more specific` }
  const closed = matches[0]!
  return { store: withLoop(store, closed.id, { state: 'done' }), closed }
}

/** The text a command shows: open loops, soonest deadline first. */
export function describeLoops(store: LoopStore, now: number): string {
  const open = store.loops.filter((loop) => loop.state === 'open')
  if (open.length === 0) return 'No open loops.'
  return open
    .sort((left, right) => (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER))
    .map((loop) => {
      const due = loop.dueAt === undefined ? 'no date' : loop.dueAt < now ? 'overdue' : new Date(loop.dueAt).toISOString().slice(0, 10)
      return `${loop.id}  ${due.padEnd(10)}  ${loop.text.slice(0, 70)}`
    })
    .join('\n')
}

/** Strip punctuation and case so two spellings of one promise compare equal. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** Whether one normalized promise contains the other. */
function overlaps(left: string, right: string): boolean {
  if (left === right) return true
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  return shorter.length >= 8 && longer.includes(shorter)
}

/** Stable short hash for ids. */
function hash(text: string): string {
  let value = 0
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) >>> 0
  return value.toString(36).slice(0, 8)
}
