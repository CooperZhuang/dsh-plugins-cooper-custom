/**
 * Reflections: the layer that notices what no single memory says.
 *
 * Every other layer in this plugin records or retrieves a fact. This one is the
 * Generative Agents "reflection" step: periodically synthesize a small number of
 * higher-level observations from what has accumulated, so the store can say
 * something it never wrote down — a pattern across projects, a preference that
 * only shows up over weeks, a habit the user has not named.
 *
 * Three constraints keep it from becoming a prose generator:
 *
 * - **Every insight cites the memories it came from.** An insight whose evidence
 *   the store cannot show is a guess wearing a conclusion's clothes; it is dropped
 *   in parsing, not merely flagged.
 * - **Reflections are their own files**, never injected into every conversation.
 *   They are for a person to read and for the profile to be refined FROM, which is
 *   a different status from "background truth".
 * - **It refuses to run on thin material.** Below {@link REFLECTION_MIN_ENTRIES}
 *   recent memories there is nothing to synthesize, and a weekly pass would
 *   produce the same generic sentences forever.
 *
 * @module dsh-memories/reflection
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { resolveLlmRoute } from './extract.js'
import { MEMORY_SOURCE_KIND } from './types.js'
import type { MemoryEntry } from './types.js'

/** Directory inside the memory store. */
export const REFLECTION_DIR = 'reflections'

/** How often the pass may run. */
export const REFLECTION_INTERVAL_MS = 7 * 86_400_000

/** Recent entries required before a reflection is worth attempting. */
export const REFLECTION_MIN_ENTRIES = 20

/** How many entries one pass reads. */
export const REFLECTION_MAX_ENTRIES = 80

/** One synthesized observation, with the memories behind it. */
export interface ReflectionInsight {
  /** One or two sentences, in the user's language. */
  readonly text: string
  /** Ids the insight is derived from; never empty. */
  readonly evidence: readonly string[]
}

/** The instruction. Its job is to refuse restatement. */
export const REFLECTION_SYSTEM = [
  'You review a person\'s long-term memory store and write a few observations about them that NO SINGLE memory states.',
  '',
  'A reflection is not a summary. Restating what the memories already say is worthless — the reader can read them. What is valuable is the pattern:',
  '- a preference that shows up across unrelated projects;',
  '- a habit in how they work (what they check first, what they postpone, what they always fix by hand);',
  '- a tension between two things they care about;',
  '- something they repeatedly get burned by.',
  '',
  'Rules:',
  '- 2-5 observations. Fewer, sharper ones beat more, vaguer ones.',
  '- Every observation MUST list the ids of the memories it is based on, in "evidence". If you cannot name them, do not write the observation.',
  '- Never repeat a previous observation verbatim; if it still holds, leave it out unless you are sharpening it.',
  '- Write in Simplified Chinese, in the third person, about the user. No advice, no flattery, no instructions.',
  '',
  'Reply with JSON only: {"insights":[{"text":"...","evidence":["id1","id2"]}]}',
].join('\n')

/** Output contract. */
export const REFLECTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['insights'],
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'evidence'],
        properties: {
          text: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const

/**
 * Whether a pass is due.
 *
 * @param lastAt - when the last reflection was written (0 when never).
 * @param now - clock.
 * @param entries - how many recent memories exist.
 * @returns whether to run.
 */
export function reflectionDue(lastAt: number, now: number, entries: number): boolean {
  if (entries < REFLECTION_MIN_ENTRIES) return false
  return lastAt <= 0 || now - lastAt >= REFLECTION_INTERVAL_MS
}

/** Render the input document, listing only what the model may cite. */
export function renderReflectionInput(entries: readonly MemoryEntry[], persona?: string, previous?: readonly string[]): string {
  const blocks: string[] = []
  if (persona !== undefined && persona.trim().length > 0) {
    blocks.push('## Who the user is (already known — do not restate)', persona.trim(), '')
  }
  if (previous !== undefined && previous.length > 0) {
    blocks.push('## Previous observations (do not repeat)', ...previous.map((text) => `- ${text}`), '')
  }
  blocks.push('## Memories')
  for (const entry of entries.slice(0, REFLECTION_MAX_ENTRIES)) {
    blocks.push(`- id: ${entry.id}`)
    blocks.push(`  kind: ${entry.kind}${entry.voice === 'user' ? ' (the user\'s own words)' : ''}`)
    blocks.push(`  title: ${entry.title}`)
    blocks.push(`  body: ${entry.body.replace(/\n+/gu, ' ')}`)
  }
  return blocks.join('\n')
}

/**
 * Parse a reflection reply, dropping any insight whose evidence the store cannot show.
 *
 * @param text - the raw reply.
 * @param knownIds - ids present in the material the model was shown.
 * @returns the validated insights, possibly none.
 */
export function parseReflection(text: string, knownIds: ReadonlySet<string>): ReflectionInsight[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return []
  }
  const row = parsed as { insights?: unknown }
  if (!Array.isArray(row.insights)) return []
  const insights: ReflectionInsight[] = []
  const seen = new Set<string>()
  for (const item of row.insights) {
    if (insights.length >= 5) break
    if (typeof item !== 'object' || item === null) continue
    const entry = item as { text?: unknown; evidence?: unknown }
    const body = typeof entry.text === 'string' ? entry.text.replace(/\s+/gu, ' ').trim().slice(0, 400) : ''
    const evidence = Array.isArray(entry.evidence)
      ? [...new Set(entry.evidence.filter((id): id is string => typeof id === 'string' && knownIds.has(id)))]
      : []
    if (body.length < 10 || evidence.length === 0) continue
    const key = body.slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    insights.push({ text: body, evidence })
  }
  return insights
}

/** Everything one reflection call needs. */
export interface ReflectionRequest {
  readonly llm: LlmRuntime | undefined
  readonly session: Session | undefined
  readonly entries: readonly MemoryEntry[]
  readonly persona?: string
  readonly previous?: readonly string[]
  readonly provider?: string
  readonly model?: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/** What one pass produced. */
export interface ReflectionOutcome {
  readonly insights: readonly ReflectionInsight[]
  readonly reason: string
  readonly skipped?: 'no-llm' | 'no-route' | 'empty' | 'failed'
}

/**
 * Run one reflection call.
 *
 * @param request - material, route, budget.
 * @returns the validated insights, or why there are none.
 */
export async function runReflection(request: ReflectionRequest): Promise<ReflectionOutcome> {
  if (request.entries.length < REFLECTION_MIN_ENTRIES) return { insights: [], reason: `only ${request.entries.length} recent memories`, skipped: 'empty' }
  if (request.llm === undefined) return { insights: [], reason: 'no llm runtime', skipped: 'no-llm' }
  if (request.session === undefined) return { insights: [], reason: 'no session to route through', skipped: 'no-route' }
  const route = resolveLlmRoute(request.session, request.provider, request.model, {})
  if (route === undefined) return { insights: [], reason: 'no route configured', skipped: 'no-route' }

  const input = renderReflectionInput(request.entries, request.persona, request.previous)
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: MEMORY_SOURCE_KIND } })],
    system: REFLECTION_SYSTEM,
    maxTokens: 1_200,
    purpose: 'compaction',
    sessionId: request.session.id,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]),
  }
  let text = ''
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of request.llm.stream(options)) assembler.push(chunk)
    text = assembler.blocks()
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  } catch (error) {
    return { insights: [], reason: `reflection call failed: ${error instanceof Error ? error.message : String(error)}`, skipped: 'failed' }
  }
  const known = new Set(request.entries.map((entry) => entry.id))
  const insights = parseReflection(text, known)
  return { insights, reason: insights.length === 0 ? 'the reply had no observation that could cite its evidence' : `${insights.length} observation(s)` }
}

/** Render one reflection as the markdown written to disk. */
export function renderReflectionFile(insights: readonly ReflectionInsight[], now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 10)
  const lines = [
    '---',
    `created: ${new Date(now).toISOString()}`,
    `insights: ${insights.length}`,
    '---',
    '',
    `# 反思 ${stamp}`,
    '',
    ...insights.flatMap((insight) => [
      `- ${insight.text}`,
      `  依据：${insight.evidence.join(', ')}`,
    ]),
    '',
  ]
  return lines.join('\n')
}

/**
 * Write one reflection file, one per day at most.
 *
 * @param memoriesDir - the store root.
 * @param insights - validated observations.
 * @param now - clock.
 * @returns the absolute path written.
 */
export async function writeReflection(memoriesDir: string, insights: readonly ReflectionInsight[], now: number): Promise<string> {
  const dir = join(memoriesDir, REFLECTION_DIR)
  await mkdir(dir, { recursive: true })
  const stamp = new Date(now).toISOString().slice(0, 10)
  const target = join(dir, `${stamp}.md`)
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temp, renderReflectionFile(insights, now), 'utf8')
  await rename(temp, target)
  return target
}

/** List the reflection files, newest first. */
export async function listReflections(memoriesDir: string): Promise<{ name: string; body: string }[]> {
  const dir = join(memoriesDir, REFLECTION_DIR)
  const names = await readdir(dir).catch(() => [] as string[])
  const files = names.filter((name) => name.endsWith('.md')).sort().reverse()
  const out: { name: string; body: string }[] = []
  for (const name of files) {
    const body = await readFile(join(dir, name), 'utf8').catch(() => '')
    if (body.length > 0) out.push({ name, body })
  }
  return out
}

/** The one-line observations already written, for the "do not repeat" list. */
export function previousInsights(files: readonly { body: string }[]): string[] {
  return files
    .flatMap((file) => file.body.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim()))
    .slice(0, 40)
}
