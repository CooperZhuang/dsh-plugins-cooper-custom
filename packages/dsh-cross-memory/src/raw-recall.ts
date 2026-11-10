/**
 * Raw-turn recall: the original conversation passages behind a memory.
 *
 * Memory entries are summaries. Retrieval over the full transcript beats them on
 * detail, and the fix that recovers most of the gap is to retrieve the original
 * history alongside the memory. This module supplies that second channel for the
 * on-demand recall block: given a query and the sessions a recalled memory came
 * from, it reads the persisted session logs, scores the prose turns lexically,
 * and returns a few credential-scrubbed excerpts.
 *
 * No model call: the same deterministic, local-only rule as the memory scorer,
 * so a recall still costs zero tokens beyond the text it injects.
 *
 * @module dsh-cross-memory/raw-recall
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
 * Pick the most query-dense window of one long message.
 *
 * Real assistant turns are often 1-3k characters, and the useful detail sits in
 * the middle of a markdown report. Truncating such a message from the start (the
 * first version did) selected the right message and then cut the evidence out of
 * it: measured on 33 real-session questions, 30 of 33 evidence quotes lived in
 * messages longer than the 400-character cap, and the lexical selector covered
 * only 4/33 quotes. A sliding window centred on the matching tokens fixes that
 * without growing the budget.
 *
 * @param text - one message.
 * @param queryTokens - tokens of the current turn.
 * @param maxChars - window size.
 * @returns the best window, its score, and where it starts.
 */
function bestWindow(
  text: string,
  queryTokens: Set<string>,
  maxChars: number,
): { text: string; score: number; index: number } {
  if (text.length <= maxChars) {
    const passageTokens = tokens(text)
    const shared = sharedTokens(queryTokens, passageTokens)
    return { text, score: shared + (strongToken(queryTokens, passageTokens) ? 2 : 0), index: 0 }
  }
  const step = Math.max(40, Math.floor(maxChars / 2))
  let best: { text: string; score: number; index: number } | undefined
  const limit = text.length - maxChars
  for (let start = 0; start <= limit; start += step) {
    const window = text.slice(start, start + maxChars)
    const passageTokens = tokens(window)
    const shared = sharedTokens(queryTokens, passageTokens)
    const score = shared + (strongToken(queryTokens, passageTokens) ? 2 : 0)
    if (best === undefined || score > best.score) best = { text: window, score, index: start }
  }
  // The last window is aligned to the end, so the tail cannot be skipped by stride.
  const lastStart = Math.max(0, text.length - maxChars)
  const last = text.slice(lastStart)
  const lastScore = sharedTokens(queryTokens, tokens(last)) + (strongToken(queryTokens, tokens(last)) ? 2 : 0)
  if (best === undefined || lastScore > best.score) best = { text: last, score: lastScore, index: lastStart }
  return best
}

/** Whether the query carries a long identifier the passage also mentions. */
function strongToken(queryTokens: Set<string>, passageTokens: Set<string>): boolean {
  for (const token of queryTokens) {
    if (token.length >= 6 && /^[a-z0-9_]+$/u.test(token) && passageTokens.has(token)) return true
  }
  return false
}

/**
 * Score prose messages against the query and pick the best few.
 *
 * The gate is the same shape as memory recall's: a single shared bigram is not
 * evidence (Chinese turns share 的/是 constantly), so a passage needs at least
 * two shared tokens, or one long Latin identifier such as a file name. Each
 * message contributes its best matching window, ranked by shared tokens, then by
 * recency, then by brevity.
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
  const scored: { message: BackfillMessage; window: { text: string; score: number; index: number }; index: number }[] = []
  messages.forEach((message, index) => {
    if (message.text.trim().length < 24) return
    const window = bestWindow(message.text.trim(), queryTokens, maxChars)
    if (window.score < 2) return
    scored.push({ message, window, index })
  })
  scored.sort((left, right) => right.window.score - left.window.score || right.index - left.index || left.window.text.length - right.window.text.length)
  const out: RawExcerpt[] = []
  let used = 0
  for (const item of scored) {
    if (out.length >= maxExcerpts) break
    const text = redactSecrets(item.window.text.trim()).replace(/\s+/gu, ' ').slice(0, maxChars)
    if (text.length < 24) continue
    const cost = Buffer.byteLength(text, 'utf8') + 16
    if (used + cost > maxBytes) continue
    used += cost
    out.push({ sessionId: '', seq: item.message.seq, role: item.message.role, text })
  }
  return out
}

/**
 * Show the window of one message that contains a memory's verbatim quote.
 *
 * Every automatic memory already stores the exact source text it came from
 * (`quote`, checked as a substring when the entry was written). That makes the
 * evidence lookup a string search, not a retrieval problem: find the message
 * holding the quote, and cut a window around it. Locating a stored quote finds
 * the passage a memory already points at, which lexical window selection can
 * miss when the words in the query and the passage diverge.
 *
 * @param messages - the source session's prose.
 * @param quote - the entry's stored quote.
 * @param maxChars - window size.
 * @returns the scrubbed window, or `undefined` when the quote is no longer there.
 */
export function windowAroundQuote(
  messages: readonly BackfillMessage[],
  quote: string,
  maxChars = 600,
): RawExcerpt | undefined {
  const needle = quote.replace(/\s+/gu, '').trim()
  if (needle.length < 8) return undefined
  for (const message of messages) {
    const collapsed = message.text.replace(/\s+/gu, '')
    const at = collapsed.indexOf(needle)
    if (at < 0) continue
    const start = Math.max(0, at - Math.floor(Math.max(0, maxChars - needle.length) / 2))
    const text = redactSecrets(collapsed.slice(start, start + maxChars))
    if (text.length < 8) continue
    return { sessionId: '', seq: message.seq, role: message.role, text }
  }
  return undefined
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
 * Quote grounding is tried first for every source that carries one, because it
 * reproduces the exact sentence the memory was written from. A source whose
 * quote is gone falls back to the lexical window selector, so an old or edited
 * entry still contributes something.
 *
 * @param sessionsDir - `<dshHome>/sessions`.
 * @param sources - memory sources in recall order, each with its optional quote.
 * @param query - the current user turn.
 * @param limits - count/character/byte caps (byte cap applies across sessions).
 * @returns excerpts with their session id filled in.
 */
/**
 * Full-history RAG selection.
 *
 * `collectExcerpts` only reads the sessions a recalled memory came from, so it
 * is anchored to the extraction. This one reads EVERY persisted session on this
 * machine and picks the excerpts that lexically match the query best, which is
 * what makes the raw channel a real retrieval path rather than a footnote.
 *
 * Zero model calls: the same tokenizer and scorer as `selectExcerpts`, so the
 * cost is reading the logs (cached) and the text it injects.
 *
 * @param sessionsDir - `<dshHome>/sessions`.
 * @param query - the current user turn.
 * @param limits - same knobs as `selectExcerpts`, plus `maxSessions` to bound the
 * number of logs opened.
 * @returns the best matching excerpts across all sessions, empty when none match.
 */
export async function collectRagExcerpts(
  sessionsDir: string,
  query: string,
  limits: RawRecallLimits & { readonly maxSessions?: number; readonly excludeSessionId?: string } = {},
): Promise<RawExcerpt[]> {
  // 0 means every log: a cap that is too small silently drops the conversation
  // that holds the answer (measured: the target sat at rank 26 with a cap of 24).
  const maxSessions = limits.maxSessions === 0 ? Number.POSITIVE_INFINITY : (limits.maxSessions ?? 24)
  const excludeSessionId = limits.excludeSessionId
  const maxExcerpts = limits.maxExcerpts ?? 4
  const maxChars = limits.maxChars ?? 600
  const maxBytes = limits.maxBytes ?? 2400
  const queryTokens = tokens(query)
  if (queryTokens.size === 0) return []
  const logs = await findSessionLogs(sessionsDir).catch(() => [])
  // Newest first: the same score prefers the later conversation, which is the one
  // a follow-up is more likely to continue.
  const ordered = logs.sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, maxSessions)
  // Chunk by TURN, not by message: the question that matches a passage is the
  // one the answer sits under, and a per-message excerpt can only ever return
  // the question back. The turn is the unit a recall is about.
  const turns: { sessionId: string; chunk: TurnChunk }[] = []
  for (const log of ordered) {
    const sessionId = normalizeSession(basename(dirname(log.file)))
    // The session asking must not answer itself from its own log: the log holds
    // the very turns being recalled, which reads as a perfect match and crowds
    // out the earlier conversation the recall is for.
    if (excludeSessionId !== undefined && sessionId === normalizeSession(excludeSessionId)) continue
    const messages = await readTranscript(sessionsDir, sessionId)
    if (messages === undefined) continue
    for (const chunk of turnChunks(messages)) turns.push({ sessionId, chunk })
  }
  // Document frequency across every turn in this history, so the scorer can tell
  // a word that appears everywhere from a word that names the thing.
  const df = new Map<string, number>()
  for (const turn of turns) {
    for (const token of new Set(tokens(turn.chunk.text))) df.set(token, (df.get(token) ?? 0) + 1)
  }
  const candidates: { excerpt: RawExcerpt; score: number }[] = []
  for (const item of selectTurnExcerpts(turns.map((turn) => turn.chunk), query, df, { maxExcerpts, maxChars, maxBytes })) {
    const turn = turns.find((candidate) => candidate.chunk.seq === item.excerpt.seq)
    candidates.push({ excerpt: { ...item.excerpt, sessionId: turn?.sessionId ?? '' }, score: item.score })
  }
  // Merge across sessions by score: one conversation that happens to hold several
  // matching turns must not crowd out the conversation that holds the answer.
  candidates.sort((left, right) => right.score - left.score)
  const out: RawExcerpt[] = []
  const seen = new Set<string>()
  let used = 0
  for (const item of candidates) {
    if (out.length >= maxExcerpts) break
    const key = item.excerpt.text.slice(0, 80)
    if (seen.has(key)) continue
    const cost = Buffer.byteLength(item.excerpt.text, 'utf8') + 16
    if (used + cost > maxBytes) continue
    seen.add(key)
    used += cost
    out.push(item.excerpt)
  }
  return out
}

/** One user turn and the assistant turns that answered it. */
export interface TurnChunk {
  readonly seq: number
  readonly text: string
}

/** Group a transcript into user→assistant turns, dropping turns with no prose. */
export function turnChunks(messages: readonly BackfillMessage[]): TurnChunk[] {
  const chunks: TurnChunk[] = []
  let current: { seq: number; lines: string[] } | undefined
  for (const message of messages) {
    if (message.role === 'user') {
      if (current !== undefined && current.lines.length > 0) chunks.push({ seq: current.seq, text: current.lines.join('\n') })
      current = { seq: message.seq, lines: [message.text] }
    } else if (current !== undefined) {
      current.lines.push(message.text)
    }
  }
  if (current !== undefined && current.lines.length > 0) chunks.push({ seq: current.seq, text: current.lines.join('\n') })
  return chunks
}

/**
 * Score one turn against the query, idf-weighted.
 *
 * The plain shared-token count cannot tell 「同步」 from 「uk_file_invoice_sha_role」:
 * both add one, and the common word wins because it appears everywhere. Weighting
 * by how rare a token is across the turns in this history is what makes the
 * passage that names the thing outrank the passage that mentions the topic.
 *
 * @param text - one turn.
 * @param queryTokens - tokens of the current turn.
 * @param df - how many turns contain each token.
 * @param total - number of turns scored.
 * @param maxChars - window size.
 * @returns the best window's score.
 */
function scoreTurn(text: string, queryTokens: Set<string>, df: Map<string, number>, total: number, maxChars: number): number {
  const window = bestWindow(text, queryTokens, maxChars)
  const counts = new Map<string, number>()
  for (const token of tokens(window.text)) counts.set(token, (counts.get(token) ?? 0) + 1)
  let score = 0
  for (const token of queryTokens) {
    const tf = counts.get(token) ?? 0
    if (tf === 0) continue
    const idf = Math.log(1 + total / (df.get(token) ?? 1))
    score += (tf * (idf + 1)) / (tf + 1.5)
  }
  return score
}

/** Select the best-matching turns across a whole history, idf-weighted. */
function selectTurnExcerpts(
  turns: readonly TurnChunk[],
  query: string,
  df: Map<string, number>,
  limits: RawRecallLimits = {},
): { excerpt: RawExcerpt; score: number }[] {
  const maxExcerpts = limits.maxExcerpts ?? 3
  const maxChars = limits.maxChars ?? 400
  const queryTokens = tokens(query)
  if (queryTokens.size === 0) return []
  const scored = turns
    .filter((turn) => turn.text.trim().length >= 24)
    .map((turn) => ({ turn, score: scoreTurn(turn.text.trim(), queryTokens, df, turns.length, maxChars) }))
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxExcerpts)
  return scored.map((item) => {
    const window = bestWindow(item.turn.text.trim(), queryTokens, maxChars)
    const text = redactSecrets(window.text.trim()).replace(/\s+/gu, ' ').slice(0, maxChars)
    return { excerpt: { sessionId: '', seq: item.turn.seq, role: 'assistant' as const, text }, score: item.score }
  }).filter((item) => item.excerpt.text.length >= 24)
}

export async function collectExcerpts(
  sessionsDir: string,
  sources: readonly { readonly sessionId: string; readonly quote?: string }[],
  query: string,
  limits: RawRecallLimits & { readonly maxSessions?: number } = {},
): Promise<RawExcerpt[]> {
  const maxSessions = limits.maxSessions ?? 2
  const maxExcerpts = limits.maxExcerpts ?? 3
  const maxBytes = limits.maxBytes ?? 2400
  const maxChars = limits.maxChars ?? 600
  const out: RawExcerpt[] = []
  let used = 0
  const seenSessions = new Set<string>()
  const seenText = new Set<string>()
  const push = (excerpt: RawExcerpt | undefined, sessionId: string): boolean => {
    if (excerpt === undefined) return false
    const key = excerpt.text.slice(0, 80)
    if (seenText.has(key)) return true
    const cost = Buffer.byteLength(excerpt.text, 'utf8') + 16
    if (used + cost > maxBytes) return false
    seenText.add(key)
    used += cost
    out.push({ ...excerpt, sessionId })
    return true
  }
  for (const source of sources) {
    if (out.length >= maxExcerpts || seenSessions.size >= maxSessions) break
    if (source.sessionId.length === 0) continue
    const fresh = !seenSessions.has(source.sessionId)
    if (fresh) seenSessions.add(source.sessionId)
    const messages = await readTranscript(sessionsDir, source.sessionId)
    if (messages === undefined) continue
    // Quote grounding is tried even for a session already used: several memories
    // from one conversation each anchor a different sentence.
    if (source.quote !== undefined) {
      const grounded = windowAroundQuote(messages, source.quote, maxChars)
      if (push(grounded, source.sessionId)) continue
    }
    if (fresh) {
      for (const excerpt of selectExcerpts(messages, query, { maxExcerpts, maxChars, maxBytes })) {
        if (!push(excerpt, source.sessionId)) break
        if (out.length >= maxExcerpts) break
      }
    }
  }
  return out
}
