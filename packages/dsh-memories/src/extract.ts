/**
 * Idle-time memory extraction.
 *
 * After a session has been quiet for a while, the extractor replays a bounded
 * tail of its transcript through one auxiliary model call and turns the result
 * into memory drafts. It never touches the conversation: extraction runs on the
 * maintenance path, writes only to the memory store, and is fully optional
 * (`autoExtract: false` disables it).
 *
 * @module dsh-memories/extract
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { MEMORY_SOURCE_KIND, toMemoryKind } from './types.js'
import type { MemoryDraft, MemoryScope } from './types.js'

/** Model-facing transcript line budget for one extraction window. */
export interface ExtractWindow {
  /** Rendered transcript, oldest first. */
  readonly text: string
  /** Highest surface seq included, or `undefined` when nothing was new. */
  readonly lastSeq: number | undefined
  /** Number of messages included. */
  readonly messages: number
  /**
   * The messages behind {@link ExtractWindow.text}, with their surface seq.
   *
   * The extractor answers with a verbatim quote, and this is what the quote is
   * checked against: a candidate whose quote is not a substring of one of these
   * messages is dropped before it reaches the store. `text` is not enough
   * because it carries the `USER:`/`ASSISTANT:` prefixes and the quote comes from
   * the message body.
   */
  readonly sources: readonly { readonly seq: number; readonly text: string }[]
}

/**
 * The system instruction for the extraction call.
 *
 * The reply's key order is load-bearing, not cosmetic. `maxOutputTokens` is a
 * ceiling on the *whole* completion, reasoning included, and the reply's only
 * recoverable part is the sequence of COMPLETE memory objects: when the ceiling
 * bites mid-reply, `repairTruncatedJson` can close the array after the last
 * finished object, but it can never resurrect one that was not written yet.
 * With `summary` first, a model that spends the budget on the summary paragraph
 * loses every memory at once — measured on this store, 2026-09-23/24, five
 * extraction calls came back capped with nothing usable (`[5766 in / 4096 out]`
 * … `[24490 in / 4096 out]`, `raise extractMaxOutputTokens`), four of them on
 * `deepseek-flash` at `reasoningEffort: high` and one on `gpt-6-astra`, where
 * the thinking tokens alone can consume the cap. Memories first makes the same
 * truncation keep everything that finished.
 */
export const EXTRACT_SYSTEM = [
  'You maintain long-term memory for a coding assistant.',
  'Read the supplied conversation transcript and extract only durable, reusable facts that would help in a FUTURE session.',
  '',
  'Record: stable user preferences and working style; project architecture and conventions; build/test/deploy commands; environment and tooling facts; non-obvious gotchas; decisions and their reasons.',
  'Do NOT record: transient task state, one-off debugging output, secrets, API keys, tokens, credentials, personal data, restatements of the code the assistant just wrote, or anything already stated in the transcript as a question rather than a fact.',
  '',
  'Write every title and body in Simplified Chinese. Keep paths, commands, identifiers, product names and error strings exactly as they are.',
  'The injected summary shows only the title and roughly the first 100 characters of the body (the budget forces short previews), so lead with the trigger and the decision; put the detail after.',
  'Never record a number that moves on its own (test counts, file or row counts, "ahead by N commits", a version that will be bumped). Record the command that produces the number instead, or mark the value 截至 <date>.',
  'When a number IS the point of the memory (a measured pass rate, a corpus size, the current state of a system), set "durability":"snapshot" and give "asOf" as the date it was measured; it is then shown with that date and retired once it is old. Everything else is "durable" and needs neither field.',
  'A problem that is already fixed is recorded as fixed ("已修 in <commit>"); never leave it reading as an open problem.',
  '',
  'Choose the scope of each memory:',
  '- "global": true across the developer\'s machines and projects — how they like to work, general preferences, tooling, machine and path facts, network and proxy setup, how to move work between machines.',
  '- "project": true only for this workspace (its architecture, commands, conventions, gotchas).',
  'Choose by breadth, not by wording: naming a machine, drive letter, repository path, host, employer or customer is NOT by itself evidence of project scope. A durable fact about the developer\'s own environment is global even when it names such a thing, because global memories are what every unrelated project reads. A fact becomes "project" only when it would be wrong or meaningless outside this one workspace.',
  '',
  'Each memory has a short imperative title (max 80 characters), a 1-3 sentence body, up to 5 lowercase keyword tags, and 1-5 search keys: the aliases and keyphrases a future session would actually type (for example "monorepo" for a pnpm-workspace fact).',
  'Search keys are how a memory is found at all, so spend them on the words a person would use who has NOT read the memory: the other name for the same thing, the command, the file, the error text, the product\'s own term. Include the English technical term when the memory is written in Chinese and vice versa — a turn that mixes them ("这个排序改动会不会动到 system prompt") shares no characters with "前缀缓存", and the keys are the only place that gap can be closed. Retrieval is lexical: it matches characters, not meaning.',
  'Give each memory a kind, because the kinds are recalled differently:',
  '- "preference": how the user wants work done, or a correction they issued.',
  '- "failure": something that went wrong and how to avoid repeating it.',
  '- "procedure": an ordered recipe for a recurring task.',
  '- "knowledge": a non-obvious technique worth reusing.',
  '- "fact": durable background that is none of the above.',
  'Always provide "appliesTo": a short phrase in the user\'s words saying when this memory matters ("准备推送代码之前"). It is the field that lets a paraphrased turn find the memory, and it is required.',
  'Every memory must also carry "quote": one continuous passage copied VERBATIM from a single message in the transcript above (8-200 characters), keeping its punctuation and wording exactly, and without the "USER:"/"ASSISTANT:" line prefix. Choose the sentence that carries the claim — the user stating it, or the assistant\'s conclusion you are recording — not a greeting, a question or your own summary. Never paraphrase the quote, combine two messages, or invent one. The quote is checked as an exact substring of the transcript before the memory is written, and a memory whose quote does not appear there is discarded, so a paraphrased quote loses the memory.',
  '',
  'Mark whose words a memory preserves with "voice":',
  '- "user" when the user themselves stated it: how they want work done, a correction they issued, a habit, an opinion, a rule they set ("以后都…", "不要…", "我喜欢…").',
  '- Record the SUBSTANCE faithfully but in the form that will be found and understood later: rewrite for clarity when their sentence was context-bound, and keep their exact phrasing only where the wording itself carries the rule (a threshold, a condition, a turn of phrase they will repeat). The voice field records whose claim it is, not a transcript.',
  '- omit the field (the default) when the memory is your own conclusion, an observation about the code, or a fact you looked up.',
  'Never attribute your own conclusion to the user. A profile of this person is rebuilt from the "user" entries, so a misattributed guess becomes a false belief about them.',
  '',
  'Also return "loops": things the USER said they would do or asked to be reminded of, and that are still not done ("我明天发出去", "下周再看", "周五前给你"). These are not memories — they are obligations with a deadline and a lifecycle, and the only thing that can justify speaking up without being asked.',
  '- One short sentence each, in the user\'s framing, naming the object ("把报价单发出去", not "邮件相关").',
  '- "dueAt" only when a deadline was actually said, as ISO date or date-time. Never invent one: a loop without a deadline is a note, and nagging somebody about a note turns help into supervision.',
  '- Skip what the session shows as already done, and skip the assistant\'s own to-dos. An empty array is the normal result.',
  'Prefer few high-value memories over many trivial ones. Return at most the requested number.',
  'Reply with JSON only, no prose and no code fence: {"memories":[{"scope":"global"|"project","kind":string,"title":string,"body":string,"tags":string[],"appliesTo":string,"quote":string}],"summary":string}',
  'Write the "memories" array first and the "summary" paragraph last: the reply is capped, and a summary written first can spend the whole budget before the first memory is complete.',
  'Write "summary" as one paragraph (2-4 sentences) saying what this session was about — the task, the decisions, and anything that would help someone judge the memories above later. It is stored as the evidence behind them.',
  'When nothing is worth remembering, reply exactly {"memories":[],"summary":""}.'
].join('\n')

/**
 * JSON output contract for one extraction call.
 *
 * `memories` is declared (and required) before `summary` on purpose: property
 * declaration order guides generation, and the array is the part a truncated
 * reply can still salvage. See {@link EXTRACT_SYSTEM}.
 */
export const EXTRACT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['memories', 'summary'],
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'title', 'body', 'appliesTo', 'quote'],
        properties: {
          scope: { type: 'string', enum: ['global', 'project'] },
          kind: { type: 'string', enum: ['fact', 'preference', 'knowledge', 'failure', 'procedure'] },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          keys: { type: 'array', items: { type: 'string' } },
          appliesTo: { type: 'string' },
          quote: { type: 'string' },
          voice: { type: 'string', enum: ['user', 'assistant'] },
          durability: { type: 'string', enum: ['durable', 'snapshot'] },
          asOf: { type: 'string' },
        },
      },
    },
    loops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          dueAt: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
} as const

/**
 * Parse the open-loop list of one reply.
 *
 * Deliberately strict about deadlines: an unparseable `dueAt` is dropped rather
 * than defaulted to "now", because a fake deadline is a reminder the user never
 * asked for. The text is the only required field.
 *
 * @param value - the raw `loops` field.
 * @returns at most ten loops, duplicates removed.
 */
function parseLoops(value: unknown): { text: string; dueAt?: number }[] {
  if (!Array.isArray(value)) return []
  const loops: { text: string; dueAt?: number }[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (loops.length >= 10) break
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const text = typeof record['text'] === 'string' ? record['text'].replace(/\s+/gu, ' ').trim().slice(0, 200) : ''
    if (text.length < 4 || seen.has(text)) continue
    seen.add(text)
    const parsed = typeof record['dueAt'] === 'string' ? Date.parse(record['dueAt']) : Number.NaN
    loops.push(Number.isFinite(parsed) ? { text, dueAt: parsed } : { text })
  }
  return loops
}

/** Patterns that look like credentials and must never enter the memory store. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/gu,
  /\bglpat-[A-Za-z0-9_-]{16,}/gu,
  /\b(?:sk|pk|xox[baprs])-[A-Za-z0-9_-]{16,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\b\s*[:=]\s*["']?[^\s"',;]{8,}["']?/giu,
  /\bBearer\s+[\w.-]{20,}/gu,
]

/**
 * Redact credential-shaped text. Deliberately conservative and applied before
 * anything is written, because a memory store outlives the session it came from.
 * @param text - candidate memory text.
 * @returns the text with credential-shaped spans replaced.
 */
export function redactSecrets(text: string): string {
  let redacted = text
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[redacted]')
  return redacted
}

/** Extract the text of one content block list. */
function blockText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Collect the conversation tail a session has produced since `afterSeq`.
 *
 * Only user and assistant prose is taken: tool results are dropped because
 * they are bulky and rarely the durable lesson, and plugin-injected context is
 * dropped so memory never feeds on its own summaries.
 *
 * @param session - session to read.
 * @param afterSeq - last surface seq already mined (exclusive).
 * @param maxMessages - message cap.
 * @param maxChars - transcript character cap; the newest messages win.
 * @returns the rendered window and the highest included seq.
 */
export function collectWindow(
  session: Session,
  afterSeq: number,
  maxMessages: number,
  maxChars: number,
): ExtractWindow {
  const floor = SessionSeq(Math.max(0, Math.trunc(afterSeq)))
  const lines: { seq: number; role: 'user' | 'assistant'; text: string }[] = []
  for (const seq of session.surface.nodes) {
    if (seq <= floor) continue
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (event.type === 'user/message' && event.data.source.kind !== 'user') continue
    const message = deriveEventMessage(event)
    if (message === null) continue
    const text = blockText(message.content)
    if (text.length === 0) continue
    lines.push({ seq, role: message.role === 'user' ? 'user' : 'assistant', text })
  }
  const selected = lines.slice(-maxMessages)
  const kept: { seq: number; role: 'user' | 'assistant'; text: string }[] = []
  let used = 0
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const line = selected[index]
    if (line === undefined) continue
    const cost = `${line.role === 'user' ? 'USER' : 'ASSISTANT'}: ${line.text}`.length + 1
    if (used + cost > maxChars && kept.length > 0) break
    used += cost
    kept.unshift(line)
  }
  const lastSeq = selected.at(-1)?.seq
  return {
    text: kept.map((line) => `${line.role === 'user' ? 'USER' : 'ASSISTANT'}: ${line.text}`).join('\n\n'),
    lastSeq,
    messages: kept.length,
    sources: kept.map((line) => ({ seq: line.seq, text: line.text })),
  }
}

/**
 * Resolve the provider/model route for a model call.
 *
 * The session's own route is inherited deliberately — a background call should
 * not silently run on a model nobody chose — but the reasoning level comes with
 * it, and that level is what the output cap has to pay for: a thinking model
 * bills its reasoning against `maxOutputTokens` before the first visible token.
 * Carrying the level out with the route is what lets the caller's log line name
 * the reason a capped call produced nothing, instead of only naming the knob.
 *
 * @param session - the session whose logged route is the fallback.
 * @param provider - an explicit provider, if the caller names one.
 * @param model - an explicit model, if the caller names one.
 * @param fallback - the route to use when the session has none.
 * @returns the route, or `undefined` when no route can be resolved.
 */
export function resolveLlmRoute(
  session: Session,
  provider: string | undefined,
  model: string | undefined,
  fallback: { provider?: string; model?: string },
): ExtractionRoute | undefined {
  if (provider !== undefined && model !== undefined) return { provider, model }
  const header = session.requestHeader()
  if (header !== undefined) {
    const config = header.config as { provider: string; model: string; reasoningEffort?: string }
    return config.reasoningEffort === undefined
      ? { provider: config.provider, model: config.model }
      : { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
  }
  if (fallback.provider !== undefined && fallback.model !== undefined) {
    return { provider: fallback.provider, model: fallback.model }
  }
  return undefined
}

/**
 * Parse the model's JSON reply into the session summary and its drafts,
 * tolerating a code fence.
 *
 * Every usable draft in the reply is validated even once the cap is reached, so
 * the caller can report how many were dropped. A pass that always lands exactly
 * on the cap looks identical to a pass that found exactly that many facts, and
 * the difference is the only signal that `extractMaxMemories` is the knob
 * limiting what the plugin remembers.
 *
 * @param text - the model's reply.
 * @param maxMemories - how many drafts to keep.
 * @param sessionId - session the drafts came from, recorded as provenance.
 * @returns the drafts, the evidence summary, and how many were over the cap.
 */
export function parseExtraction(text: string, maxMemories: number, sessionId: string): { drafts: MemoryDraft[]; loops: { text: string; dueAt?: number }[]; summary: string; dropped: number } {
  const result = { drafts: [] as MemoryDraft[], loops: [] as { text: string; dueAt?: number }[], summary: '', dropped: 0 }
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return result
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return result
  }
  if (typeof parsed !== 'object' || parsed === null || !('memories' in parsed)) return result
  const envelope = parsed as { memories: unknown; loops?: unknown; summary?: unknown }
  if (typeof envelope.summary === 'string') {
    result.summary = redactSecrets(envelope.summary.replace(/\s+/gu, ' ').trim()).slice(0, 1_200)
  }
  const raw = envelope.memories
  if (!Array.isArray(raw)) return result
  const usable: MemoryDraft[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const scope = record['scope']
    const title = record['title']
    const body = record['body']
    if (scope !== 'global' && scope !== 'project') continue
    if (typeof title !== 'string' || typeof body !== 'string') continue
    const cleanTitle = redactSecrets(title.replace(/\s+/gu, ' ').trim()).slice(0, 120)
    const cleanBody = redactSecrets(body.trim()).slice(0, 2000)
    if (cleanTitle.length === 0 || cleanBody.length === 0) continue
    if (cleanTitle === '[redacted]' || cleanBody === '[redacted]') continue
    const tags = Array.isArray(record['tags'])
      ? record['tags'].filter((tag): tag is string => typeof tag === 'string')
      : []
    const keys = Array.isArray(record['keys']) ? record['keys'].filter((key): key is string => typeof key === 'string') : []
    const appliesTo = typeof record['appliesTo'] === 'string'
      ? redactSecrets(record['appliesTo'].replace(/\s+/gu, ' ').trim()).slice(0, 160)
      : ''
    // A snapshot without a date cannot be judged later, so it gets one: the
    // extractor's own claim if it parsed, otherwise the moment of extraction.
    const snapshot = record['durability'] === 'snapshot'
    const parsedAsOf = typeof record['asOf'] === 'string' ? Date.parse(record['asOf']) : Number.NaN
    // The evidence excerpt. Kept as close to the reply as verification allows:
    // only whitespace is normalized (a long transcript line may be re-wrapped),
    // never punctuation or wording — those are what the substring check proves.
    const quote = typeof record['quote'] === 'string'
      ? redactSecrets(record['quote'].replace(/\s+/gu, ' ').trim()).slice(0, 300)
      : ''
    // "assistant" is the default and is stored as absent, so every entry written
    // before this field existed keeps its meaning.
    const voice = record['voice'] === 'user' ? 'user' as const : undefined
    usable.push({
      scope: scope as MemoryScope,
      kind: toMemoryKind(record['kind']),
      title: cleanTitle,
      body: cleanBody,
      tags,
      keys,
      ...voice === undefined ? {} : { voice },
      ...appliesTo.length > 0 ? { appliesTo } : {},
      ...quote.length > 0 && quote !== '[redacted]' ? { quote } : {},
      ...snapshot ? { durability: 'snapshot' as const, asOf: Number.isFinite(parsedAsOf) ? parsedAsOf : Date.now() } : {},
      sourceSession: sessionId,
    })
  }
  result.drafts = usable.slice(0, Math.max(0, maxMemories))
  result.dropped = usable.length - result.drafts.length
  result.loops = parseLoops(envelope.loops)
  return result
}

/**
 * Shortest quote that can count as evidence.
 *
 * Four characters was too few in practice: a phrase like "这个" or "pnpm" occurs
 * in most messages, so it would "verify" a claim it does not support. Eight
 * characters is about the shortest span that can carry a claim in Chinese and
 * still be unique enough to be worth checking.
 */
const MIN_QUOTE_CHARS = 8

/** Collapse whitespace so a re-wrapped quote still matches its source line. */
function squash(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** What {@link bindEvidence} made of one reply. */
export interface EvidenceBinding {
  /** Drafts that carry a quote found verbatim in the window's messages. */
  readonly drafts: readonly MemoryDraft[]
  /** Drafts dropped because the quote was missing, too short, or not in the transcript. */
  readonly unsupported: number
}

/**
 * Check every draft's quote against the transcript it claims to come from.
 *
 * This is the mechanical half of the evidence contract: the extractor is asked
 * to copy a verbatim passage, and nothing else in the pipeline can tell a copied
 * passage from a plausible one. A draft without a usable quote is dropped rather
 * than stored unverified — the whole point of the field is that a memory the
 * transcript does not support must not enter the store silently. The message the
 * quote matched supplies an `evidenceSeq`, so `memory action=evidence` can point
 * at the exact turn.
 *
 * @param drafts - drafts parsed from the reply.
 * @param sources - messages in the window the reply was shown.
 * @returns the verified drafts and how many were rejected.
 */
export function bindEvidence(
  drafts: readonly MemoryDraft[],
  sources: readonly { readonly seq: number; readonly text: string }[],
): EvidenceBinding {
  const verified: MemoryDraft[] = []
  let unsupported = 0
  for (const draft of drafts) {
    const quote = draft.quote === undefined ? '' : squash(draft.quote)
    if (quote.length < MIN_QUOTE_CHARS) {
      unsupported += 1
      continue
    }
    const source = sources.find((candidate) => squash(candidate.text).includes(quote))
    if (source === undefined) {
      unsupported += 1
      continue
    }
    verified.push({ ...draft, evidenceSeq: source.seq })
  }
  return { drafts: verified, unsupported }
}

/** Everything one extraction call needs. */
export interface ExtractionRequest {
  /** Session being mined. */
  readonly session: Session
  /** Transcript window. */
  readonly window: ExtractWindow
  /** Model-facing label of the project scope, for the prompt. */
  readonly projectLabel: string
  /**
   * Titles already stored in the scopes this pass may write to.
   *
   * The extractor is otherwise blind to what is already known, so it re-derives
   * the same lesson from overlapping windows and stores it under a new title.
   * Measured on a real store, one session's handwriting-extraction lesson was
   * stored twice — once in Chinese, once in English — because each pass phrased
   * the title differently and ids come from titles.
   */
  readonly knownTitles?: readonly string[]
  /** Explicit route override. */
  readonly provider?: string
  readonly model?: string
  /** Route used when the session has logged no request header yet. */
  readonly fallbackRoute?: { readonly provider?: string; readonly model?: string }
  /** Caps and deadline. */
  readonly maxOutputTokens: number
  readonly maxMemories: number
  readonly timeoutMs: number
  /** Cancellation. */
  readonly signal: AbortSignal
}

/** Token cost of one extraction call, as the provider reported it. */
export interface ExtractionUsage {
  /** Prompt tokens the call was billed for. */
  readonly inputTokens: number
  /** Completion tokens the call produced. */
  readonly outputTokens: number
}

/**
 * The provider/model an extraction call actually ran on.
 *
 * `reasoningEffort` is present only when the inherited session route declared
 * one, and it is the field that explains a capped call: a thinking model spends
 * the output ceiling on reasoning before it writes any JSON.
 */
export interface ExtractionRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Outcome of one extraction call. */
export type ExtractionOutcome =
  | {
    readonly kind: 'memories'
    readonly drafts: readonly MemoryDraft[]
    /** Promises the user made that are still open. */
    readonly loops: readonly { text: string; dueAt?: number }[]
    /** What the session was about, stored as the evidence behind the drafts. */
    readonly summary: string
    /** Usable drafts the reply offered beyond `maxMemories`, reported to the caller. */
    readonly dropped: number
    /**
     * Drafts rejected because their evidence quote did not appear verbatim in
     * the window. Reported so a rising count is visible instead of reading as
     * an unusually quiet extractor.
     */
    readonly unsupported: number
    readonly route: ExtractionRoute
    /**
     * Whether the reply was cut short by the output cap and salvaged.
     *
     * A caller must be able to tell "the extractor found three facts" from "the
     * extractor found three facts and was cut off before it finished", because
     * only the second one means `extractMaxOutputTokens` is the binding knob.
     */
    readonly truncated?: boolean
    /**
     * What the call cost, when the adapter reported it.
     *
     * Carried out of here because background extraction runs outside any
     * session, so this is the only place the spend can be observed at all: the
     * cost dashboards read session logs, and this call writes none.
     */
    readonly usage?: ExtractionUsage
  }
  | {
    readonly kind: 'none'
    /**
     * Why the call produced no memory.
     *
     * `max-tokens` and `incomplete` are capped/failed finishes rather than an
     * empty answer: they are reported, never thrown, and `max-tokens` is the
     * one that tells a reader which configuration knob to raise.
     */
    readonly reason: 'empty-window' | 'no-route' | 'empty-reply' | 'unsupported-evidence' | 'max-tokens' | 'incomplete'
    /**
     * The route the call ran on, when one was resolved.
     *
     * Absent for `empty-window` and `no-route`, which fail before a route
     * exists. Present otherwise so the caller can name the model — and its
     * reasoning level — in the line that reports the cap.
     */
    readonly route?: ExtractionRoute
    readonly usage?: ExtractionUsage
  }

/**
 * Run one extraction call and return the drafts it produced.
 *
 * Failures are the caller's to contain: this function throws only on transport
 * or protocol errors, and never mutates the session.
 *
 * @param llm - the LLM runtime.
 * @param request - session, window, route, and budget.
 * @returns the parsed drafts, or a reason there are none.
 */
export async function runExtraction(llm: LlmRuntime, request: ExtractionRequest): Promise<ExtractionOutcome> {
  if (request.window.text.trim().length === 0) return { kind: 'none', reason: 'empty-window' }
  const route = resolveLlmRoute(request.session, request.provider, request.model, request.fallbackRoute ?? {})
  if (route === undefined) return { kind: 'none', reason: 'no-route' }
  const known = request.knownTitles ?? []
  const framed = [
    `Workspace scope label: ${request.projectLabel}`,
    `Extract at most ${request.maxMemories} memories from this transcript.`,
    ...known.length === 0 ? [] : [
      '',
      'Memories already stored in the scopes this pass writes to:',
      ...known.map((title) => `- ${title}`),
      'If the transcript adds to (or corrects) one of those, reuse its EXACT title so that entry is updated instead of duplicated. Only invent a new title for a genuinely new fact.',
    ],
    '',
    request.window.text,
  ].join('\n')
  const messages = [createUserMessage({
    content: [{ type: 'text', text: framed }],
    source: { kind: MEMORY_SOURCE_KIND },
  })]
  const timeout = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages,
    system: EXTRACT_SYSTEM,
    maxTokens: request.maxOutputTokens,
    purpose: 'compaction',
    sessionId: request.session.id,
    signal: timeout,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish.kind
  const text = assembler.blocks()
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  // The adapter emits usage before the terminal finish chunk; when a provider
  // reports none, the call still happened and simply cannot be priced here.
  const reported = assembler.usage
  const usage: ExtractionUsage | undefined = reported === undefined
    ? undefined
    : { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens }
  if (finish !== 'stop') {
    // A reply the output cap cut short is not a failure of the pass. Throwing
    // here turned an ordinary "raise `extractMaxOutputTokens`" into an exception
    // that reached the user's own command line (`/memories mine` reports the
    // handler error verbatim) and made a background pass look broken — measured
    // 2026-09-23, the first `/memories mine` in the field died this way.
    //
    // The extractor is asked for one object whose `memories` array comes first,
    // so a truncated reply is normally an unterminated array of COMPLETE
    // objects: keep what parsed, and only when nothing did does the caller hear
    // about the cap.
    const complete = parseExtraction(text, request.maxMemories, request.session.id)
    const salvaged = complete.drafts.length > 0
      ? complete
      : parseExtraction(repairTruncatedJson(text), request.maxMemories, request.session.id)
    // Evidence is checked before "was anything kept": a salvaged object whose
    // quote is not in the transcript is exactly the case the check exists for.
    const bound = bindEvidence(salvaged.drafts, request.window.sources)
    if (bound.drafts.length > 0) {
      return {
        kind: 'memories',
        drafts: bound.drafts,
        loops: salvaged.loops,
        summary: salvaged.summary,
        dropped: salvaged.dropped,
        unsupported: bound.unsupported,
        route,
        truncated: true,
        ...usage === undefined ? {} : { usage },
      }
    }
    if (bound.unsupported > 0) {
      return { kind: 'none', reason: 'unsupported-evidence', route, ...usage === undefined ? {} : { usage } }
    }
    return { kind: 'none', reason: finish === 'max-tokens' ? 'max-tokens' : 'incomplete', route, ...usage === undefined ? {} : { usage } }
  }
  const parsed = parseExtraction(text, request.maxMemories, request.session.id)
  if (parsed.drafts.length === 0) return { kind: 'none', reason: 'empty-reply', route, ...usage === undefined ? {} : { usage } }
  const bound = bindEvidence(parsed.drafts, request.window.sources)
  if (bound.drafts.length === 0) {
    return { kind: 'none', reason: 'unsupported-evidence', route, ...usage === undefined ? {} : { usage } }
  }
  return { kind: 'memories', drafts: bound.drafts, loops: parsed.loops, summary: parsed.summary, dropped: parsed.dropped, unsupported: bound.unsupported, route, ...usage === undefined ? {} : { usage } }
}

/**
 * Close a JSON reply the output cap cut in half.
 *
 * The reply is one object whose `memories` array is written first, so a
 * truncated reply is an unterminated array whose earlier elements are complete.
 * Candidate cut points are tried from the end backwards — the first one that
 * parses wins — which keeps every memory that was fully written. A reply cut
 * inside a string, or before the first object, yields `''` so the caller can
 * report the cap instead of pretending it salvaged something.
 *
 * @param text - the truncated reply.
 * @returns parseable JSON, or an empty string when no cut point parses.
 */
export function repairTruncatedJson(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '')
  let cursor = trimmed.lastIndexOf('}')
  let attempts = 0
  while (cursor > 0 && attempts < 64) {
    const candidate = `${trimmed.slice(0, cursor + 1)}]}`
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      cursor = trimmed.lastIndexOf('}', cursor - 1)
      attempts += 1
    }
  }
  return ''
}
