/**
 * Raw-turn recall: the original conversation passages behind a memory.
 *
 * Memory entries are summaries. The real-session benchmark showed the memory arm
 * losing to full-transcript RAG mostly because extraction dropped details, and
 * the fix that recovered almost all of it was to retrieve the original history
 * alongside the memory (bench/real/joint.mjs: memory 26/33, raw 27/33,
 * memory+raw 32/33, rag 33/33). This module supplies that second channel for the
 * on-demand recall block: given a query and the sessions a recalled memory came
 * from, it reads the persisted session logs, scores the prose turns lexically,
 * and returns a few credential-scrubbed excerpts.
 *
 * No model call: the same deterministic, local-only rule as the memory scorer,
 * so a recall still costs zero tokens beyond the text it injects.
 *
 * @module dsh-memories/raw-recall
 */
import { basename, dirname } from 'node:path'
import { findSessionLogs, readSessionLog } from './backfill.js'
import type { BackfillMessage } from './backfill.js'
import { redactSecrets } from './extract.js'

/** One original turn worth showing next to a memory. */
export interface RawExcerpt {
  /** Session the passage came from. */
  readonly sessionId: string
  /** Surface seq of the message, for the evidence trail. */
  readonly seq: number
  /** Speaker. */
  readonly role: 'user' | 'assistant'
  /** Credential-scrubbed text, truncated. */
  readonly text: string
}

/** Limits for one raw-recall selection. */
export interface RawRecallLimits {
  /** Most excerpts to return. */
  readonly maxExcerpts?: number
  /** Longest one excerpt may be, in characters. */
  readonly maxChars?: number
  /** UTF-8 byte budget across all returned excerpts. */
  readonly maxBytes?: number
}

/** Token set for scoring: CJK bigrams plus Latin words of three or more. */
function tokens(text: string): Set<string> {
  const set = new Set<string>()
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/gu) ?? []
  for (const run of cjk) {
    for (let index = 0; index < run.length - 1; index += 1) set.add(run.slice(index, index + 2))
  }
  for (const word of text.toLowerCase().match(/[a-z0-9_]{3,}/gu) ?? []) set.add(word)
  return set
}

/** Whether the query and the passage share enough to be worth showing. */
function sharedTokens(query: Set<string>, passage: Set<string>): number {
  let shared = 0
  for (const token of query) if (passage.has(token)) shared += 1
  return shared
}

/**
 * Score prose messages against the query and pick the best few.
 *
 * The gate is the same shape as memory recall's: a single shared bigram is not
 * evidence (Chinese turns share 的/是 constantly), so a passage needs at least
 * two shared tokens, or one long Latin identifier such as a file name. Passages
 * are ranked by shared tokens, then by recency, then by brevity.
 *
 * @param messages - prose messages of one session.
 * @param query - the current user turn.
 * @param limits - count/character/byte caps.
 * @returns excerpts in rank order, already scrubbed and truncated.
 */
export function selectExcerpts(
  messages: readonly BackfillMessage[],
  query: string,
  limits: RawRecallLimits = {},
): RawExcerpt[] {
  const maxExcerpts = limits.maxExcerpts ?? 3
  const maxChars = limits.maxChars ?? 400
  const maxBytes = limits.maxBytes ?? 1200
  const queryTokens = tokens(query)
  if (queryTokens.size === 0) return []
  const scored: { message: BackfillMessage; score: number; index: number }[] = []
  messages.forEach((message, index) => {
    if (message.text.trim().length < 24) return
    const passageTokens = tokens(message.text)
    const shared = sharedTokens(queryTokens, passageTokens)
    if (shared < 2) return
    // A long identifier is a strong signal on its own (a path, an error code).
    const strong = [...queryTokens].some((token) => token.length >= 6 && /^[a-z0-9_]+$/u.test(token) && passageTokens.has(token))
    scored.push({ message, score: shared + (strong ? 2 : 0), index })
  })
  scored.sort((left, right) => right.score - left.score || right.index - left.index || left.message.text.length - right.message.text.length)
  const out: RawExcerpt[] = []
  let used = 0
  for (const item of scored) {
    if (out.length >= maxExcerpts) break
    const text = redactSecrets(item.message.text.trim()).replace(/\s+/gu, ' ').slice(0, maxChars)
    if (text.length < 24) continue
    const cost = Buffer.byteLength(text, 'utf8') + 16
    if (used + cost > maxBytes) continue
    used += cost
    out.push({ sessionId: '', seq: item.message.seq, role: item.message.role, text })
  }
  return out
}

/** Cache of parsed transcripts, keyed by sessions dir + session id. */
const transcriptCache = new Map<string, { at: number; messages: readonly BackfillMessage[] | undefined }>()
const CACHE_TTL_MS = 10 * 60_000
const INDEX_TTL_MS = 60_000
const indexCache = new Map<string, { at: number; files: Map<string, { file: string; modifiedAt: number }> }>()

/** Normalize a log directory name and a session id to the same form. */
function normalizeSession(id: string): string {
  return id.replace(/^session-/u, '')
}

/** The log index of one sessions directory, refreshed at most once a minute. */
async function logIndex(sessionsDir: string, now: number): Promise<Map<string, { file: string; modifiedAt: number }>> {
  const cached = indexCache.get(sessionsDir)
  if (cached !== undefined && now - cached.at < INDEX_TTL_MS) return cached.files
  const files = new Map<string, { file: string; modifiedAt: number }>()
  for (const log of await findSessionLogs(sessionsDir)) {
    const dir = normalizeSession(basename(dirname(log.file)))
    if (!files.has(dir)) files.set(dir, log)
  }
  indexCache.set(sessionsDir, { at: now, files })
  return files
}

/**
 * Read one session's prose transcript from the persisted logs.
 *
 * Failures (missing log, unreadable zstd, unknown session) return `undefined`:
 * raw recall is an optional supplement and must never break a recall.
 *
 * @param sessionsDir - `<dshHome>/sessions`.
 * @param sessionId - the session to read.
 * @param now - clock, for the cache.
 * @returns the prose messages, or `undefined`.
 */
export async function readTranscript(
  sessionsDir: string,
  sessionId: string,
  now = Date.now(),
): Promise<readonly BackfillMessage[] | undefined> {
  const key = `${sessionsDir}\0${normalizeSession(sessionId)}`
  const cached = transcriptCache.get(key)
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.messages
  try {
    const log = (await logIndex(sessionsDir, now)).get(normalizeSession(sessionId))
    if (log === undefined) {
      transcriptCache.set(key, { at: now, messages: undefined })
      return undefined
    }
    const parsed = await readSessionLog(log.file, log.modifiedAt)
    transcriptCache.set(key, { at: now, messages: parsed?.messages })
    return parsed?.messages
  } catch {
    transcriptCache.set(key, { at: now, messages: undefined })
    return undefined
  }
}

/**
 * Collect raw excerpts for a recall: the source sessions of the memory hits.
 *
 * @param sessionsDir - `<dshHome>/sessions`.
 * @param sessionIds - candidate sessions, most relevant memory first.
 * @param query - the current user turn.
 * @param limits - count/character/byte caps (byte cap applies across sessions).
 * @returns excerpts with their session id filled in.
 */
export async function collectExcerpts(
  sessionsDir: string,
  sessionIds: readonly string[],
  query: string,
  limits: RawRecallLimits & { readonly maxSessions?: number } = {},
): Promise<RawExcerpt[]> {
  const maxSessions = limits.maxSessions ?? 2
  const out: RawExcerpt[] = []
  const seen = new Set<string>()
  for (const sessionId of sessionIds) {
    if (out.length >= (limits.maxExcerpts ?? 3) || seen.size >= maxSessions) break
    if (sessionId.length === 0 || seen.has(sessionId)) continue
    seen.add(sessionId)
    const messages = await readTranscript(sessionsDir, sessionId)
    if (messages === undefined) continue
    for (const excerpt of selectExcerpts(messages, query, limits)) {
      out.push({ ...excerpt, sessionId })
    }
  }
  return out
}
