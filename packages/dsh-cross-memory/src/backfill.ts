/**
 * Historical-session backfill.
 *
 * Extraction only ever reads sessions that are live in this process, so every
 * conversation that ended before the plugin was installed stays unmined forever.
 * This module turns the persisted session logs under `<dshHome>/sessions` back
 * into extraction windows, without a host service and without replaying the
 * conversation: it decodes the log's zstd frames, keeps the user/assistant prose
 * the extractor wants, and cuts it into bounded windows.
 *
 * The caller owns the model call and the store write; everything here is pure
 * parsing so it can be tested against fixture logs.
 *
 * @module dsh-cross-memory/backfill
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import * as zlib from 'node:zlib'

/** The subset of `node:zlib` this module uses, typed structurally. */
interface ZstdApi {
  zstdDecompressSync?: (buffer: Buffer) => Buffer
}

/** One prose message recovered from a session log. */
export interface BackfillMessage {
  /** Surface sequence the message was logged at. */
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** One persisted session, as far as backfill needs to know it. */
export interface BackfillLog {
  readonly sessionId: string
  readonly file: string
  readonly modifiedAt: number
  /** Workspace the session was opened in, when the log recorded one. */
  readonly cwd?: string
  /** The route the session's last request used, so a backfill call can reuse it. */
  readonly route?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly messages: readonly BackfillMessage[]
  /** Highest surface sequence in the log. */
  readonly maxSeq: number
}

/** One extraction window cut from a recovered transcript. */
export interface BackfillWindow {
  readonly text: string
  readonly firstSeq: number
  readonly lastSeq: number
  readonly messages: number
  /** Message bodies behind `text`, for the extraction quote check. */
  readonly sources: readonly { readonly seq: number; readonly text: string }[]
  /**
   * Always zero: a backfill window is planned from a whole log, so the planner
   * already splits the log into contiguous windows and nothing is skipped.
   *
   * Declared because the window is handed to {@link runExtraction}, which takes
   * an {@link ExtractWindow}. The live path uses the field to detect a backlog
   * and re-window from the oldest end; the backfill path has no backlog to
   * detect.
   */
  readonly skipped: number
}

/** zstd frame magic bytes; a session log is a concatenation of frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** A session log, whatever version suffix DSH gave it (`session.jsonl.zstd`, `session.v4.jsonl.zstd`). */
const SESSION_LOG = /^session.*\.jsonl\.zstd$/u

/** Deepest directory nesting `findSessionLogs` walks. */
const MAX_LOG_DEPTH = 4

/** Whether this Node build can decompress zstd at all. */
export function zstdAvailable(): boolean {
  return typeof (zlib as unknown as ZstdApi).zstdDecompressSync === 'function'
}

/**
 * Decompress one concatenated-frame session log.
 *
 * A session log is an append-only series of independent zstd frames, so a
 * single-shot decode stops at the first frame and hides the conversation. Every
 * frame boundary is decoded and joined; a candidate offset that is not a frame
 * start simply fails to decode and is skipped.
 *
 * @param buffer - raw file bytes.
 * @returns the joined log text.
 * @throws when the Node build has no zstd support.
 */
export function decodeSessionLog(buffer: Buffer): string {
  const decompress = (zlib as unknown as ZstdApi).zstdDecompressSync
  if (decompress === undefined) throw new Error('backfill needs zstd support from Node.js 22.15 or newer')
  const offsets: number[] = []
  let index = buffer.indexOf(ZSTD_MAGIC)
  while (index >= 0) {
    offsets.push(index)
    index = buffer.indexOf(ZSTD_MAGIC, index + ZSTD_MAGIC.length)
  }
  const parts: string[] = []
  for (let frame = 0; frame < offsets.length; frame += 1) {
    const start = offsets[frame]
    if (start === undefined) continue
    const end = offsets[frame + 1] ?? buffer.length
    try {
      parts.push(decompress(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      // Not a standalone frame boundary: skip it.
    }
  }
  return parts.join('')
}

/** Join the text blocks of one message, ignoring reasoning and tool calls. */
function blockText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type !== 'text' || typeof record.text !== 'string') continue
    const text = record.text.replace(/\s+/gu, ' ').trim()
    if (text.length > 0) parts.push(text)
  }
  return parts.join(' ').trim()
}

/** A stable session id for a log whose header is missing or unreadable. */
function fallbackSessionId(file: string): string {
  const directory = basename(dirname(file))
  if (directory.startsWith('session-')) return directory
  return `session-backfill-${createHash('sha1').update(file).digest('hex').slice(0, 12)}`
}

/**
 * Parse one decoded session log.
 *
 * Only `user/message` events authored by the user and `assistant/message`
 * events are kept: tool results are bulky and rarely the durable lesson, and
 * plugin-authored user messages (a memory block, a recall delta) are skipped so
 * backfill never feeds memory its own summaries.
 *
 * @param text - decoded log text (one JSON event per line).
 * @param file - the log's path, used for a fallback session id.
 * @param modifiedAt - the file's mtime, carried through for reporting.
 * @returns the recovered session, or `undefined` when the log has no prose.
 */
export function parseSessionLog(text: string, file: string, modifiedAt: number): BackfillLog | undefined {
  const messages: BackfillMessage[] = []
  let sessionId: string | undefined
  let cwd: string | undefined
  let route: BackfillLog['route']
  let maxSeq = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof event !== 'object' || event === null) continue
    const seq = Number(event['seq'] ?? 0)
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
    const type = event['type']
    if (type === 'session') {
      if (typeof event['id'] === 'string' && event['id'].length > 0) sessionId = event['id']
      if (typeof event['cwd'] === 'string' && event['cwd'].length > 0) cwd = event['cwd']
      continue
    }
    if (type === 'request/header' && route === undefined) {
      const header = (event['data'] as { header?: { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } } | undefined)?.header
      const config = header?.config
      if (typeof config?.provider === 'string' && typeof config.model === 'string'
        && config.provider.length > 0 && config.model.length > 0) {
        route = {
          provider: config.provider,
          model: config.model,
          ...typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {},
        }
      }
      continue
    }
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const data = event['data'] as {
      content?: unknown
      source?: { kind?: unknown }
      message?: { content?: unknown }
    } | undefined
    if (type === 'user/message') {
      // A memory block or a recall delta is a user message too; only prose the
      // human wrote may be mined.
      if (data?.source?.kind !== 'user') continue
      const body = blockText(data?.content)
      if (body.length === 0) continue
      messages.push({ seq: Number.isFinite(seq) ? seq : 0, role: 'user', text: body })
      continue
    }
    const body = blockText(data?.message?.content)
    if (body.length === 0) continue
    messages.push({ seq: Number.isFinite(seq) ? seq : 0, role: 'assistant', text: body })
  }
  if (messages.length === 0) return undefined
  return {
    sessionId: sessionId ?? fallbackSessionId(file),
    file,
    modifiedAt,
    ...cwd === undefined ? {} : { cwd },
    ...route === undefined ? {} : { route },
    messages,
    maxSeq,
  }
}

/**
 * Cut a recovered transcript into bounded extraction windows.
 *
 * The message count and the character budget are separate limits on purpose:
 * a few very long turns and many short ones are both real, and either alone
 * produces a window the extractor cannot afford.
 *
 * @param messages - the recovered transcript, oldest first.
 * @param maxMessages - model-facing message cap for one window.
 * @param maxChars - character budget for one window.
 * @returns the windows, in order.
 */
export function planWindows(
  messages: readonly BackfillMessage[],
  maxMessages: number,
  maxChars: number,
): BackfillWindow[] {
  const windows: BackfillWindow[] = []
  const messageCap = Math.max(1, Math.trunc(maxMessages))
  const charCap = Math.max(200, Math.trunc(maxChars))
  let current: { seq: number; text: string; line: string }[] = []
  let cost = 0
  let firstSeq = 0
  let lastSeq = 0
  const flush = (): void => {
    if (current.length === 0) return
    windows.push({
      text: current.map((entry) => entry.line).join('\n\n'),
      firstSeq,
      lastSeq,
      messages: current.length,
      sources: current.map((entry) => ({ seq: entry.seq, text: entry.text })),
      skipped: 0,
    })
    current = []
    cost = 0
  }
  for (const message of messages) {
    const line = `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${message.text}`
    const lineCost = line.length + (current.length === 0 ? 0 : 2)
    if (current.length > 0 && (current.length >= messageCap || cost + lineCost > charCap)) flush()
    if (current.length === 0) firstSeq = message.seq
    current.push({ seq: message.seq, text: message.text, line })
    lastSeq = message.seq
    cost += lineCost
  }
  flush()
  return windows
}

/**
 * Every persisted session log under one harness home's `sessions` directory.
 *
 * @param sessionsDir - absolute `<dshHome>/sessions` path.
 * @returns log paths with their mtimes, newest first; unreadable directories are skipped.
 */
export async function findSessionLogs(sessionsDir: string): Promise<{ file: string; modifiedAt: number }[]> {
  const found: { file: string; modifiedAt: number }[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_LOG_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      // Symlinks are followed: a workspace whose logs are linked in (a test
      // scratch home, a relocated store) is still a history worth reading.
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile() || !SESSION_LOG.test(entry.name)) continue
      try {
        const info = await stat(path)
        found.push({ file: path, modifiedAt: info.mtimeMs })
      } catch {
        // A log that vanished between listing and stat is simply not there.
      }
    }
  }
  await walk(sessionsDir, 0)
  return found.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

/**
 * Read and parse one log file in one step.
 *
 * @param file - absolute log path.
 * @param modifiedAt - mtime the caller already observed.
 * @returns the parsed session, or `undefined` when the log has no prose.
 */
export async function readSessionLog(file: string, modifiedAt: number): Promise<BackfillLog | undefined> {
  const buffer = await readFile(file)
  return parseSessionLog(decodeSessionLog(buffer), file, modifiedAt)
}
