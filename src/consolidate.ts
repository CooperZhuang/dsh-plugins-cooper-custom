/**
 * Stage 2: consolidation of staged memories into the live store.
 *
 * Stage 1 (the idle extractor) writes what each session learned into the store
 * one session at a time. That is fast and cheap but it cannot resolve anything
 * ACROSS sessions: two sessions can state contradictory facts, five sessions can
 * each record a fragment of one procedure, and nothing ever decides which of
 * them is the current truth.
 *
 * Consolidation is the second pass. It hands the recent memories to a
 * restricted sub-agent whose only job is to return a merged set — replacing,
 * merging, or retiring entries — as strict JSON. The plugin then applies that
 * JSON itself, so the child never touches the store and the write path stays in
 * one place with a snapshot to roll back to.
 *
 * @module dsh-memories/consolidate
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { toMemoryKind } from './types.js'
import { MEMORY_SOURCE_KIND } from './types.js'
import type { MemoryEntry, MemoryDraft, MemoryKind, MemoryScope } from './types.js'

/** System instruction for the consolidation sub-agent. */
export const CONSOLIDATE_SYSTEM = [
  'You maintain the long-term memory of a coding assistant. You are given the CURRENT memories and must return a better set.',
  '',
  'You may:',
  '- MERGE several memories that describe the same thing into one clear memory.',
  '- REPLACE a memory that is now wrong or superseded, keeping its id.',
  '- RETIRE a memory that is stale, trivial, duplicated, or no longer true.',
  '- ADD a memory only when the input clearly states a durable fact that no current memory captures.',
  '',
  'Rules:',
  '- Preserve every id you keep. A returned memory with an existing id REPLACES that memory; a new id ADDS one.',
  '- Prefer fewer, sharper memories. Never invent facts that are not in the input.',
  '- Keep scope honest: a fact that is only true in one workspace stays "project"; a durable user preference or general tooling fact is "global". A fact that names a specific employer, product, customer, repository path, drive letter or internal host is NEVER global.',
  '- Keep the kind honest: "preference" for how the user wants work done, "failure" for something that went wrong, "procedure" for an ordered recipe, "knowledge" for a non-obvious technique, "fact" for background.',
  '- When you MERGE memories into one, list every id you folded in under "derivedFrom" (the ids you are retiring because their content now lives in the merged memory). A plain rewrite of one memory, or a brand-new memory, gets an empty list. This is the only record of what a merge replaced: the sources are archived, and without the list a future reader cannot check the merged claim against what it replaced.',
  '- Do not record secrets, credentials, transient task state, or restatements of code.',
  '- Write every title, body and appliesTo in Simplified Chinese, keeping paths, commands, identifiers and product names exactly as they are. A memory the model wrote in Chinese must not come back in English.',
  '- The injected summary shows only the title and roughly the first 100 characters of the body (the budget forces short previews), so lead with the trigger and the decision; put the detail after. This matters most when merging: the merged body must open with the one thing a future session needs.',
  '- Always provide "appliesTo": a short phrase in the user\'s words saying when the memory matters ("准备推送代码之前"). When you rewrite a memory that already has one, carry it over unless the rewrite makes it wrong.',
  '- Never record a number that moves on its own (test counts, file or row counts, "ahead by N commits", a version that will be bumped). Record the command that produces the number instead, or mark the value 截至 <date>. When a number IS the point of the memory, set "durability":"snapshot" with "asOf" as the date it was measured, and carry both over when you rewrite such a memory.',
  '- Never change a memory\'s "durability" or "asOf" by omission: a memory that already is a snapshot stays one unless the fact has become durable.',
  '- A problem that is already fixed is recorded as fixed ("已修 in <commit>"); never leave it reading as an open problem.',
  '- Write each body as 1-4 self-contained sentences. Titles are short and imperative.',
  '',
  'When two or more memories together describe a repeatable procedure that would be worth running again, also return it as a skill: a short kebab-case name, a one-line description, and the ordered steps. Skills are drafts a human promotes; return at most 2.',
  '',
  'Reply with JSON only, no prose and no code fence:',
  '{"memories":[{"id":string|null,"scope":"global"|"project","kind":string,"title":string,"body":string,"tags":string[],"keys":string[],"appliesTo":string,"derivedFrom":string[]}],"retire":[string],"skills":[{"name":string,"description":string,"steps":string[]}],"notes":string}',
  'Use null for the id of a new memory. "retire" lists ids to delete. "notes" is one short sentence about what you changed.',
].join('\n')

/** JSON output contract for one consolidation call. */
export const CONSOLIDATE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['memories'],
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'title', 'body', 'appliesTo'],
        properties: {
          // A nullable field must be spelled with `oneOf`: the harness schema
          // subset rejects `type: ["string", "null"]`, and a rejected schema
          // fails the whole child run at start.
          id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          scope: { type: 'string', enum: ['global', 'project'] },
          kind: { type: 'string', enum: ['fact', 'preference', 'knowledge', 'failure', 'procedure'] },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          appliesTo: { type: 'string' },
          durability: { type: 'string', enum: ['durable', 'snapshot'] },
          asOf: { type: 'string' },
          derivedFrom: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    retire: { type: 'array', items: { type: 'string' } },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'steps'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    notes: { type: 'string' },
  },
} as const

/** One skill draft proposed by a consolidation pass. */
export interface SkillDraft {
  /** Kebab-case skill name. */
  readonly name: string
  /** One-line description. */
  readonly description: string
  /** Ordered steps. */
  readonly steps: readonly string[]
}

/** One consolidation proposal, already validated against the input. */
export interface ConsolidationPlan {
  /** Memories to add or replace, keyed by the id they replace (or `undefined` to add). */
  readonly upserts: readonly { id: string | null; scope: MemoryScope; kind: MemoryKind; title: string; body: string; tags: readonly string[]; keys?: readonly string[]; appliesTo?: string; durability?: 'durable' | 'snapshot'; asOf?: number; derivedFrom?: readonly string[] }[]
  /** Ids to delete. */
  readonly retire: readonly string[]
  /** Skill drafts extracted from the memory set. */
  readonly skills: readonly SkillDraft[]
  /** The sub-agent's one-line account of what it changed. */
  readonly notes: string
}

/** Render the input document handed to the consolidation agent. */
export function renderConsolidationInput(entries: readonly MemoryEntry[], projectLabel: string): string {
  const sections = new Map<MemoryScope, MemoryEntry[]>()
  for (const entry of entries) {
    const list = sections.get(entry.scope)
    if (list === undefined) sections.set(entry.scope, [entry])
    else list.push(entry)
  }
  const blocks: string[] = [`Workspace scope label: ${projectLabel}`, `Current memories: ${entries.length}`, '']
  for (const scope of ['global', 'project'] as const) {
    const list = sections.get(scope)
    if (list === undefined || list.length === 0) continue
    blocks.push(`## ${scope}`)
    for (const entry of list) {
      blocks.push(`- id: ${entry.id}`)
      blocks.push(`  title: ${entry.title}`)
      blocks.push(`  tags: ${entry.tags.join(', ') || '(none)'}`)
      blocks.push(`  keys: ${entry.keys.join(', ') || '(none)'}`)
      blocks.push(`  body: ${entry.body.replace(/\n+/gu, ' ')}`)
    }
    blocks.push('')
  }
  return blocks.join('\n')
}

/** Parse and validate the agent's JSON reply into a plan. */
export function parsePlan(text: string, knownIds: ReadonlySet<string>, maxUpserts: number): ConsolidationPlan | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const rawMemories = Array.isArray(record['memories']) ? record['memories'] : []
  const upserts: ConsolidationPlan['upserts'][number][] = []
  const seen = new Set<string>()
  for (const item of rawMemories) {
    if (upserts.length >= maxUpserts) break
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const scope = entry['scope']
    const title = entry['title']
    const body = entry['body']
    if (scope !== 'global' && scope !== 'project') continue
    if (typeof title !== 'string' || typeof body !== 'string') continue
    const cleanTitle = title.replace(/\s+/gu, ' ').trim().slice(0, 120)
    const cleanBody = body.trim().slice(0, 2000)
    if (cleanTitle.length === 0 || cleanBody.length === 0) continue
    // A "replace" id the store does not know is treated as a new memory: the
    // agent inventing an id must not create a dangling reference.
    const rawId = entry['id']
    const id = typeof rawId === 'string' && knownIds.has(rawId) ? rawId : null
    if (id !== null && seen.has(id)) continue
    if (id !== null) seen.add(id)
    const tags = Array.isArray(entry['tags']) ? entry['tags'].filter((tag): tag is string => typeof tag === 'string') : []
    const keys = Array.isArray(entry['keys']) ? entry['keys'].filter((key): key is string => typeof key === 'string') : []
    const appliesTo = typeof entry['appliesTo'] === 'string' ? entry['appliesTo'].replace(/\s+/gu, ' ').trim().slice(0, 160) : ''
    // A plan that omits durability must not silently turn a snapshot durable:
    // the upsert preserves the stored value, so only an explicit field is passed.
    const snapshot = entry['durability'] === 'snapshot'
    const parsedAsOf = typeof entry['asOf'] === 'string' ? Date.parse(entry['asOf']) : Number.NaN
    // Only ids the store has, never the entry itself: a merge trail that points
    // at a memory nobody can open is worse than no trail, because it reads as
    // evidence. The same discipline the `id` field already follows.
    const rawDerived = Array.isArray(entry['derivedFrom']) ? entry['derivedFrom'] : []
    const derivedFrom = [...new Set(rawDerived.filter((value): value is string => typeof value === 'string' && knownIds.has(value) && value !== id))]
    upserts.push({
      id,
      scope,
      kind: toMemoryKind(entry['kind']),
      title: cleanTitle,
      body: cleanBody,
      tags,
      keys,
      ...appliesTo.length > 0 ? { appliesTo } : {},
      ...snapshot ? { durability: 'snapshot' as const, ...Number.isFinite(parsedAsOf) ? { asOf: parsedAsOf } : {} } : {},
      ...derivedFrom.length > 0 ? { derivedFrom } : {},
    })
  }
  const rawRetire = Array.isArray(record['retire']) ? record['retire'] : []
  const retired = new Set<string>()
  for (const value of rawRetire) {
    if (typeof value !== 'string') continue
    // Only ids the store actually has, and never one this plan rewrites.
    if (!knownIds.has(value) || seen.has(value)) continue
    retired.add(value)
  }
  const skills = parseSkills(record['skills'])
  if (upserts.length === 0 && retired.size === 0 && skills.length === 0) return undefined
  return {
    upserts,
    retire: [...retired],
    skills,
    notes: typeof record['notes'] === 'string' ? record['notes'].slice(0, 300) : '',
  }
}

/**
 * Parse the skill drafts of one reply.
 *
 * A name is forced into the kebab-case grammar DSH's skill loader accepts, and
 * a draft without a usable name, description, or any step is dropped: a skill
 * that cannot be loaded is worse than no skill.
 * @param value - the raw `skills` field.
 * @returns the validated drafts, at most two.
 */
function parseSkills(value: unknown): SkillDraft[] {
  if (!Array.isArray(value)) return []
  const drafts: SkillDraft[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (drafts.length >= MAX_SKILL_DRAFTS) break
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const rawName = typeof record['name'] === 'string' ? record['name'] : ''
    const name = rawName.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64)
    const description = typeof record['description'] === 'string' ? record['description'].replace(/\s+/gu, ' ').trim().slice(0, 300) : ''
    const steps = Array.isArray(record['steps'])
      ? record['steps'].filter((step): step is string => typeof step === 'string').map((step) => step.trim()).filter((step) => step.length > 0).slice(0, 20)
      : []
    if (name.length === 0 || description.length === 0 || steps.length === 0) continue
    if (seen.has(name)) continue
    seen.add(name)
    drafts.push({ name, description, steps })
  }
  return drafts
}

/** Everything one consolidation run needs. */
export interface ConsolidateRequest {
  /** The agent whose subagent seam is used; also the lineage parent. */
  readonly parent: Agent
  /** Provider the child should use, defaulting to the parent's own route. */
  readonly provider?: string
  readonly model?: string
  /**
   * Agent Preset the child runs under.
   *
   * Required by the 0.2.1-rc.2 seam: a child that names no preset inherits the
   * parent's composition, and the parent's tools are exactly what this pass
   * exists to withhold. The preset this plugin registers carries no tool rows
   * at all, so the child can only answer.
   */
  readonly agentPreset?: string
  /** Subagent provider name; `spawn` unless a deployment names another. */
  readonly subagentProvider?: string
  /** Entries to consider, newest first. */
  readonly entries: readonly MemoryEntry[]
  /** Model-facing project label. */
  readonly projectLabel: string
  /** Cap on returned memories. */
  readonly maxUpserts: number
  /** Tool names to deny the child; must be names the registry actually has. */
  readonly denyTools: readonly string[]
  /** Deadline for the child run. */
  readonly timeoutMs: number
  /** Output token cap for the direct (no-subagent) path. */
  readonly maxOutputTokens?: number
  /** Route the direct (no-subagent) path runs on. */
  readonly route?: { provider: string; model: string; reasoningEffort?: string }
  readonly signal: AbortSignal
}

/**
 * The subagent seam this module consumes, kept structural for testability.
 *
 * Two kernel shapes live here, because the seam changed under this plugin:
 *
 * - `startActivation` is the 0.2.1-rc.2 shape. The provider is named, the
 *   request is nested under it, and the child's tool set comes from an Agent
 *   Preset named in the request — `toolFilter` and `persona` are gone from the
 *   start request (the model-facing subagent tool rejects both outright).
 * - `start` is the pre-0.2.1 shape: a name-addressed call whose request carries
 *   `toolFilter` and `persona`.
 *
 * The new shape is preferred, and it is only used when a preset is available:
 * without one the child inherits the parent's composition, so a "restricted"
 * child would quietly get the parent's tools back.
 */
export interface ActivationSpec {
  provider: string
  /**
   * The child's label.
   *
   * The kernel writes this field into the child's continuable descriptor
   * UNCONDITIONALLY (`label: input.label`) and then validates the whole
   * descriptor with `snapshotJsonValue`, which rejects `undefined`. Omitting
   * it therefore does not mean "no label" — it means "this descriptor cannot be
   * serialized", and the pass dies with `subagent descriptor is not losslessly
   * JSON-serializable`. Every consolidation attempt failed that way from
   * 2026-10-20 until this field was declared here.
   */
  label: string
  /**
   * Cancellation for the whole activation.
   *
   * Top-level, NOT inside `request`: the kernel reads `spec.signal` directly
   * (`spec.signal.throwIfAborted()`, and `prepareContinuable({ signal })`), so a
   * spec that carries the signal only in its request throws
   * `Cannot read properties of undefined (reading 'throwIfAborted')` — after the
   * child has already been reserved, which is why it reads as a crash rather than
   * a refusal.
   *
   * The kernel's continuable path reads exactly these top-level fields —
   * `provider`, `label`, `signal`, `childId`, `delivery`, `request` — and these
   * on the request: `prompt`, `parent`, `maxDepth`, `outputSchema`,
   * `agentOptions`, `agentPreset`, `cwd`. Anything omitted here fails at the
   * kernel boundary, not at this module's type boundary.
   */
  signal: AbortSignal
  request: {
    prompt: { type: 'text'; text: string }[]
    parent: Agent
    /** Kept for the request contract even though the kernel reads the top-level one. */
    signal: AbortSignal
    agentOptions?: { provider?: string; model?: string }
    outputSchema?: unknown
    maxDepth?: number
    agentPreset?: string
  }
}

export interface SubagentSeam {
  startActivation?: (spec: ActivationSpec) => Promise<{ result: Promise<{ output: readonly unknown[]; structured?: unknown; stopReason?: { kind: string } }> }>
  start?: (name: string, request: {
    prompt: { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    agentOptions?: { provider?: string; model?: string }
    outputSchema?: unknown
    maxDepth?: number
    toolFilter?: { deny?: readonly string[]; allow?: readonly string[] }
    persona?: string
  }) => Promise<{ result: Promise<{ output: readonly unknown[]; structured?: unknown; stopReason?: { kind: string } }> }>
}

/** Cap on skill drafts one pass may propose. */
const MAX_SKILL_DRAFTS = 2

/**
 * The Agent Preset the consolidation child runs under.
 *
 * Since 0.2.1-rc.2 the kernel takes a child's tool set from the preset it
 * names: a request's own `toolFilter` and `persona` are gone, and a child that
 * names no preset inherits the parent's composition — which would hand the
 * consolidation pass the parent's tools, the one thing this pass must never
 * have. This preset carries no tool rows at all, so the child can only answer.
 */
export const CONSOLIDATE_PRESET_ID = 'memories-consolidator'

/**
 * Label every consolidation child runs under.
 *
 * A plain constant, never derived from anything that can be `undefined`: see
 * {@link ActivationSpec.label} for what a missing label does to the child's
 * descriptor.
 */
export const CONSOLIDATE_LABEL = '记忆合并'

/** Output token cap for the direct (no-subagent) consolidation path. */
export const DEFAULT_CONSOLIDATE_MAX_OUTPUT_TOKENS = 8192

/**
 * Tools the consolidation child must not have: it reads and proposes, nothing else.
 *
 * The list is deliberately cross-platform (it names both `bash` and `pwsh`,
 * both `str_replace_editor` and `edit`), so any single deployment has only a
 * subset. {@link denyToolsFor} narrows it before use.
 */
export const CONSOLIDATE_DENY_TOOLS = [
  'write', 'edit', 'str_replace_editor', 'pwsh', 'bash', 'terminal',
  'web_search', 'web_fetch', 'subagent', 'subagent_fork', 'workflow', 'ralph',
  'job_kill', 'interrupt_agent', 'memory', 'todo_write', 'create_goal', 'update_goal',
] as const

/**
 * Narrow the deny list to tools this deployment actually has.
 *
 * `tools.restrict()` fails loud on an unknown name — a feature, since a typo in
 * a filter must not silently leave a capability enabled. But a cross-platform
 * deny list names tools that do not exist here, and that loud failure would
 * sink every consolidation pass. Pass the registry's own names and this returns
 * the intersection.
 * @param available - every tool name the registry knows.
 * @returns the deny list, filtered to known names.
 */
export function denyToolsFor(available: ReadonlySet<string>): string[] {
  return CONSOLIDATE_DENY_TOOLS.filter((tool) => available.has(tool))
}

/**
 * Run one consolidation through a restricted sub-agent.
 * @param seam - the `ctx.subagents` service.
 * @param request - entries, route, caps, and cancellation.
 * @returns the validated plan, or `undefined` when the child produced none.
 */
export async function runConsolidation(seam: SubagentSeam, request: ConsolidateRequest): Promise<ConsolidationPlan | undefined> {
  if (request.entries.length === 0) return undefined
  const known = new Set(request.entries.map((entry) => entry.id))
  const input = renderConsolidationInput(request.entries, request.projectLabel)
  const timeout = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
  const prompt = [{ type: 'text' as const, text: `${CONSOLIDATE_SYSTEM}\n\n---\n\n${input}` }]
  const reply = await runChild(seam, prompt, request, timeout)
  if (reply === undefined) return undefined
  return parsePlan(reply, known, request.maxUpserts)
}

/**
 * Build the spec the 0.2.1-rc.2 seam takes.
 *
 * Extracted so a test can inspect it without a kernel: the one bug this shape
 * can carry — a missing `label` — is invisible from the seam's type unless the
 * type declares the field, and the failure it causes happens inside the
 * kernel's descriptor validator, three calls away from here. See
 * {@link ActivationSpec.label}.
 *
 * @param request - route, preset and lineage parent.
 * @param prompt - the child's single user message.
 * @param timeout - the child's deadline.
 * @returns the spec, with every optional field absent rather than `undefined`.
 */
export function buildActivationSpec(
  request: ConsolidateRequest,
  prompt: { type: 'text'; text: string }[],
  timeout: AbortSignal,
): ActivationSpec {
  const agentOptions = request.provider !== undefined && request.model !== undefined
    ? { provider: request.provider, model: request.model }
    : undefined
  return {
    provider: request.subagentProvider ?? 'spawn',
    // Never optional, never derived: a missing label fails the kernel's
    // descriptor validator BEFORE the child starts, and the symptom is a
    // silently dead consolidation pass rather than a start error.
    label: CONSOLIDATE_LABEL,
    // Same class of mistake as the label, one field later: the kernel reads
    // `spec.signal` and never `spec.request.signal`, so it has to be here too.
    signal: timeout,
    request: {
      prompt,
      parent: request.parent,
      signal: timeout,
      ...agentOptions !== undefined ? { agentOptions } : {},
      outputSchema: CONSOLIDATE_JSON_SCHEMA,
      // The child may not delegate further: it returns a plan, nothing else.
      //
      // `maxDepth` is the cap on the CHILD's depth, and DSH counts depth from
      // 1 (a top-level agent is 0, its child is 1). So 1 admits this child and
      // rejects any grandchild — 0 would reject the child itself, which is how
      // this line was wrong the first time.
      maxDepth: 1,
      ...request.agentPreset !== undefined ? { agentPreset: request.agentPreset } : {},
    },
  }
}

/**
 * Ask the seam for one restricted child and return its answer as text.
 *
 * The 0.2.1-rc.2 seam is preferred, but only with a preset: a child that names
 * no preset inherits the parent's composition, and the parent's tools are what
 * this pass must withhold. The pre-0.2.1 seam is used when it is all there is.
 *
 * @param seam - the subagent service.
 * @param prompt - the child's single user message.
 * @param request - route, caps, and the preset name.
 * @param timeout - the child's deadline.
 * @returns the child's text, or `undefined` when the seam cannot run it.
 */
async function runChild(
  seam: SubagentSeam,
  prompt: { type: 'text'; text: string }[],
  request: ConsolidateRequest,
  timeout: AbortSignal,
): Promise<string | undefined> {
  const agentOptions = request.provider !== undefined && request.model !== undefined
    ? { provider: request.provider, model: request.model }
    : undefined
  if (typeof seam.startActivation === 'function' && request.agentPreset !== undefined) {
    const run = await seam.startActivation(buildActivationSpec(request, prompt, timeout))
    return textOf(await run.result)
  }
  if (typeof seam.start === 'function') {
    const run = await seam.start('spawn', {
      prompt,
      parent: request.parent,
      signal: timeout,
      ...agentOptions !== undefined ? { agentOptions } : {},
      outputSchema: CONSOLIDATE_JSON_SCHEMA,
      maxDepth: 1,
      // The child may not write anything and may not reach the network: its
      // only output is the JSON plan it returns.
      toolFilter: { deny: request.denyTools },
    })
    return textOf(await run.result)
  }
  return undefined
}

/**
 * Read one child's answer as text.
 *
 * A child that answered through the structured-output tool carries the plan in
 * `structured`; a child that answered in prose carries it in the text blocks.
 * @param result - the child's finished run.
 * @returns the text the plan is parsed from.
 */
function textOf(result: { output: readonly unknown[]; structured?: unknown }): string {
  if (typeof result.structured === 'object' && result.structured !== null) return JSON.stringify(result.structured)
  return result.output
    .map((block) => (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/**
 * Run one consolidation without a subagent: a plain model call that owns no
 * tools at all.
 *
 * This is the fallback for a deployment whose subagent seam cannot express a
 * restricted child (no Agent Preset service, or a seam that predates the
 * preset contract). It is not a weaker guarantee: the model is handed no tool
 * list whatsoever, so it cannot write, shell out, or delegate — the same
 * property the old deny list bought, reached by a different route.
 *
 * @param llm - the LLM runtime.
 * @param request - entries, route, caps, and cancellation.
 * @returns the validated plan, or `undefined` when the model produced none.
 */
export async function runConsolidationDirect(llm: LlmRuntime, request: ConsolidateRequest): Promise<ConsolidationPlan | undefined> {
  if (request.entries.length === 0) return undefined
  const route = request.route
  if (route === undefined) return undefined
  const known = new Set(request.entries.map((entry) => entry.id))
  const input = renderConsolidationInput(request.entries, request.projectLabel)
  const messages = [createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: MEMORY_SOURCE_KIND },
  })]
  const timeout = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages,
    system: CONSOLIDATE_SYSTEM,
    maxTokens: request.maxOutputTokens ?? DEFAULT_CONSOLIDATE_MAX_OUTPUT_TOKENS,
    purpose: 'compaction',
    sessionId: request.parent.session.id,
    signal: timeout,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const text = assembler.blocks()
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  if (text.trim().length === 0) return undefined
  return parsePlan(text, known, request.maxUpserts)
}

/**
 * Choose which memories one consolidation pass reviews.
 *
 * The pass used to receive the newest N entries, which meant an old memory was
 * never looked at again: the first page never changed, so a stale fact deep in
 * the store was unreachable by the only mechanism that could retire it.
 * Selection prefers what was never reviewed, then what was reviewed longest
 * ago, so every memory is eventually reached while new material — and material
 * the model actually uses — still goes first.
 *
 * @param entries - every candidate entry.
 * @param reviewedAt - `scope\u0000id` → last review time, or 0 when never.
 * @param max - how many entries the pass may consider.
 * @returns the selection to hand the sub-agent.
 */
export function selectForConsolidation(
  entries: readonly MemoryEntry[],
  reviewedAt: ReadonlyMap<string, number>,
  max: number,
): readonly MemoryEntry[] {
  if (max <= 0) return []
  const key = (entry: MemoryEntry): string => `${entry.scope}\u0000${entry.id}`
  const selected: MemoryEntry[] = []
  const taken = new Set<string>()
  const fresh = entries.filter((entry) => (reviewedAt.get(key(entry)) ?? 0) === 0)
  fresh.sort((left, right) => right.uses - left.uses || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  for (const entry of fresh) {
    if (selected.length >= max) return selected
    selected.push(entry)
    taken.add(key(entry))
  }
  const rest = entries.filter((entry) => !taken.has(key(entry)))
  rest.sort((left, right) =>
    (reviewedAt.get(key(left)) ?? 0) - (reviewedAt.get(key(right)) ?? 0)
    || right.updatedAt - left.updatedAt
    || left.id.localeCompare(right.id))
  for (const entry of rest) {
    if (selected.length >= max) break
    selected.push(entry)
  }
  return selected
}

/** A snapshot of the store taken before applying a plan, used to roll back. */
export interface ConsolidationSnapshot {
  /** Entries as they were before the plan ran. */
  readonly entries: readonly MemoryEntry[]
}

/**
 * One consolidation decision that a person should make rather than the pass.
 *
 * The pass runs unattended, so the question is not "is this a good edit" but
 * "can this edit be undone or noticed if it is wrong". Archiving an entry nobody
 * ever read, folding a duplicate, sharpening a body while keeping its anchors:
 * all reversible or visible. Deleting the memory a session actually used,
 * rewriting what a person typed, silently moving a fact between scopes, or
 * dropping the paths a body cited — those need a human, because the loss is
 * invisible and the pass has no model of what it did not understand.
 */
export interface ConsolidationDispute {
  /** Entry id the decision is about. */
  readonly id: string
  /** Scope the entry lives in. */
  readonly scope: MemoryScope
  /** What would happen to it. */
  readonly action: 'rewrite' | 'retire'
  /** Title before the change, for the reader. */
  readonly title: string
  /** One short sentence saying why this one is being asked about. */
  readonly reason: string
  /** What the entry says today. */
  readonly before: string
  /** What the pass wants it to say; empty for a retirement. */
  readonly after: string
}

/** Paths a body cites, as anchors that must survive a rewrite. */
const CITATION = /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*\.[A-Za-z0-9]{1,6}\b/gu

/** How many cited paths a body carries. */
function citationCount(body: string): number {
  return new Set([...body.matchAll(CITATION)].map((match) => match[0])).size
}

/**
 * Split a plan into what may be applied unattended and what should be asked about.
 *
 * The rules are deliberately about *loss*, not taste: the pass is allowed to
 * sharpen wording, merge duplicates and retire memories nothing ever read. It is
 * not allowed to quietly destroy a fact a session used, rewrite something a
 * person wrote, change where a memory lives, or drop the concrete anchors
 * (file paths) that made a body checkable.
 *
 * @param plan - the plan the pass returned.
 * @param snapshot - the entries as they were before it ran.
 * @returns the safe remainder and the decisions to ask about.
 */
export function classifyPlan(
  plan: ConsolidationPlan,
  snapshot: ConsolidationSnapshot,
): { safe: ConsolidationPlan; disputes: readonly ConsolidationDispute[] } {
  // Indexed by id alone: a plan that MOVES an entry between scopes names the new
  // scope, so a scope+id lookup would miss the entry it is describing and treat a
  // move as a brand-new memory — the one case where the old copy is the thing
  // being changed.
  const byId = new Map<string, MemoryEntry[]>()
  for (const entry of snapshot.entries) {
    const list = byId.get(entry.id)
    if (list === undefined) byId.set(entry.id, [entry])
    else list.push(entry)
  }
  const previousOf = (id: string, scope: MemoryScope): MemoryEntry | undefined => {
    const candidates = byId.get(id) ?? []
    return candidates.find((entry) => entry.scope === scope) ?? candidates[0]
  }
  const disputes: ConsolidationDispute[] = []
  const safeUpserts: ConsolidationPlan['upserts'][number][] = []
  for (const item of plan.upserts) {
    const previous = item.id === null ? undefined : previousOf(item.id, item.scope)
    if (previous === undefined) {
      // A brand-new memory destroys nothing: it can be un-written.
      safeUpserts.push(item)
      continue
    }
    const reasons: string[] = []
    if (previous.source === 'user') reasons.push('这条是人手写的')
    if (previous.pinned === true) reasons.push('这条是置顶的')
    if (previous.permanent === true) reasons.push('这条标记为永久保留')
    if (previous.scope !== item.scope) reasons.push(`作用域要从 ${previous.scope} 改成 ${item.scope}`)
    const lostCitations = citationCount(previous.body) - citationCount(item.body)
    if (lostCitations > 0) reasons.push(`新版少了 ${lostCitations} 处文件路径引用`)
    // A body that shrinks by half is not a rewrite, it is a summary — and what
    // was dropped is exactly what the pass judged to be noise.
    if (item.body.length * 2 < previous.body.length) reasons.push('新版正文不到原来的一半')
    if (reasons.length === 0) {
      safeUpserts.push(item)
      continue
    }
    disputes.push({
      id: previous.id,
      scope: previous.scope,
      action: 'rewrite',
      title: previous.title,
      reason: reasons.join('；'),
      before: previous.body,
      after: item.body,
    })
  }
  const safeRetire: string[] = []
  for (const id of plan.retire) {
    const previous = snapshot.entries.find((entry) => entry.id === id)
    if (previous === undefined) continue
    const reasons: string[] = []
    if (previous.source === 'user') reasons.push('这条是人手写的')
    if (previous.pinned === true) reasons.push('这条是置顶的')
    if (previous.permanent === true) reasons.push('这条标记为永久保留')
    if (previous.uses > 0) reasons.push(`它被读到过 ${previous.uses} 次`)
    if (reasons.length === 0) {
      safeRetire.push(id)
      continue
    }
    disputes.push({
      id: previous.id,
      scope: previous.scope,
      action: 'retire',
      title: previous.title,
      reason: reasons.join('；'),
      before: previous.body,
      after: '',
    })
  }
  return {
    safe: { upserts: safeUpserts, retire: safeRetire, skills: plan.skills, notes: plan.notes },
    disputes,
  }
}

/** Apply one plan against a store-like target. */
export interface ConsolidationTarget {
  /** Write one entry, keeping `keepId` when given. */
  upsert(draft: MemoryDraft, projectRoot: string | undefined, source: MemoryEntry['source'], keepId?: string): Promise<{ entry: MemoryEntry; action: 'created' | 'updated' }>
  /** Move one entry out of the live store; returns whether it was there. */
  archive(scope: MemoryScope, projectRoot: string | undefined, id: string): Promise<boolean>
  /** Put an archived entry back, used to roll back a failed plan. */
  restore(scope: MemoryScope, projectRoot: string | undefined, id: string): Promise<boolean>
}

/** The outcome of applying a plan. */
export interface ConsolidationResult {
  readonly written: number
  readonly retired: number
  readonly notes: string
}

/** A plan waiting for a human, as stored between passes. */
export interface PendingPlan {
  /** The disputed part of the plan, so accepting one is a matter of applying it. */
  readonly plan: ConsolidationPlan
  /** One row per decision being asked about, for the reader. */
  readonly disputes: readonly ConsolidationDispute[]
  /** Workspace root the plan was prepared for, or `''` for a global-only pass. */
  readonly projectRoot: string
  /** When the pass produced it. */
  readonly at: number
  /** Scope label shown to the reader. */
  readonly label: string
}

/** Where a pending proposal lives, one per store. */
export function pendingPlanPath(memoriesDir: string): string {
  return join(memoriesDir, 'pending', 'consolidation.json')
}

/**
 * Stage a plan instead of applying it.
 *
 * A background pass rewrites memories with no model of what it is destroying: on
 * a real store one such pass erased the trigger phrase from 32 memories, demoted
 * 8 hand-written rules to "extracted guess", and turned Chinese titles back into
 * English — all silently, and all found only in a later audit. A proposal has the
 * same power and none of the risk: nothing changes until a person says so.
 *
 * @param memoriesDir - the store root.
 * @param pending - the plan and where it came from.
 */
export async function writePendingPlan(memoriesDir: string, pending: PendingPlan): Promise<void> {
  const target = pendingPlanPath(memoriesDir)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(pending, undefined, 2)}\n`, 'utf8')
}

/**
 * Read the pending proposal, if any.
 *
 * @param memoriesDir - the store root.
 * @returns the proposal, or `undefined` when there is none or it is unreadable.
 */
export async function readPendingPlan(memoriesDir: string): Promise<PendingPlan | undefined> {
  try {
    const text = await readFile(pendingPlanPath(memoriesDir), 'utf8')
    const parsed = JSON.parse(text) as PendingPlan
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.plan !== 'object' || parsed.plan === null) return undefined
    if (!Array.isArray(parsed.plan.upserts) || !Array.isArray(parsed.plan.retire)) return undefined
    // A file written before disputes existed carries no rows to show; it is
    // treated as empty rather than as an unreadable file, so an upgrade cannot
    // strand a question nobody can see.
    return { ...parsed, disputes: Array.isArray(parsed.disputes) ? parsed.disputes : [] }
  } catch {
    return undefined
  }
}

/**
 * Merge newly disputed decisions into the ones already waiting.
 *
 * A later pass must not silently replace a question: the reader may be part-way
 * through deciding, and the same id can legitimately be disputed twice (the pass
 * proposes something else about it). Newest wins for an id, older rows stay.
 *
 * @param memoriesDir - the store root.
 * @param pending - the rows and the plan fragment that would apply them.
 * @returns how many rows are waiting after the merge.
 */
export async function mergePendingPlan(memoriesDir: string, pending: PendingPlan): Promise<number> {
  const existing = await readPendingPlan(memoriesDir)
  if (existing === undefined) {
    await writePendingPlan(memoriesDir, pending)
    return pending.disputes.length
  }
  const byId = new Map(existing.disputes.map((row) => [`${row.action}\u0000${row.id}`, row]))
  for (const row of pending.disputes) byId.set(`${row.action}\u0000${row.id}`, row)
  const disputes = [...byId.values()]
  // The plan fragment follows the rows: keep the upsert/retire for every id that
  // is still waiting, so applying a row later needs no second model call.
  const ids = new Set(disputes.map((row) => row.id))
  const plan: ConsolidationPlan = {
    upserts: [...existing.plan.upserts, ...pending.plan.upserts].filter((item) => item.id !== null && ids.has(item.id)),
    retire: [...new Set([...existing.plan.retire, ...pending.plan.retire])].filter((id) => ids.has(id)),
    skills: [],
    notes: pending.plan.notes,
  }
  await writePendingPlan(memoriesDir, { plan, disputes, projectRoot: pending.projectRoot, at: pending.at, label: pending.label })
  return disputes.length
}

/**
 * Whether a staged proposal is still worth leaving alone.
 *
 * A proposal is a question, and questions go stale: entries keep arriving while
 * it waits, so an old proposal describes a store that no longer exists. Inside
 * the window a background pass does not spend a model call to overwrite a
 * question nobody has answered; past it, the fresh proposal wins.
 *
 * @param pending - the staged proposal.
 * @param maxAgeHours - the window; `0` means "wait for an answer".
 * @param now - clock.
 * @returns true when a running pass should leave it in place.
 */
export function proposalIsFresh(pending: PendingPlan, maxAgeHours: number, now: number): boolean {
  if (maxAgeHours <= 0) return true
  return now - pending.at < maxAgeHours * 3_600_000
}

/**
 * Drop the pending proposal.
 *
 * @param memoriesDir - the store root.
 * @returns whether one was there.
 */
export async function clearPendingPlan(memoriesDir: string): Promise<boolean> {
  try {
    await rm(pendingPlanPath(memoriesDir), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Apply a plan, restoring the snapshot when a write fails.
 *
 * The child proposes; this function is the only writer. Applying is all-or-
 * nothing: a failure mid-plan puts the entries it already touched back the way
 * they were, so a half-consolidated store is never left behind.
 *
 * @param plan - the validated plan.
 * @param target - the store to write to.
 * @param projectRoot - workspace root for project entries.
 * @param snapshot - entries as they were before the plan.
 * @returns how many entries were written and retired.
 */
export async function applyPlan(
  plan: ConsolidationPlan,
  target: ConsolidationTarget,
  projectRoot: string | undefined,
  snapshot: ConsolidationSnapshot,
): Promise<ConsolidationResult> {
  const before = new Map(snapshot.entries.map((entry) => [`${entry.scope}\u0000${entry.id}`, entry]))
  const touched: { scope: MemoryScope; id: string }[] = []
  /** Retirements already archived, so a failed plan can put them back. */
  const archived: { scope: MemoryScope; id: string }[] = []
  try {
    for (const item of plan.upserts) {
      // A rewrite keeps the provenance of what it rewrites. Stamping every
      // consolidation result `auto` demotes memories a person wrote: `auto` is
      // the extractor's guess, `tool`/`user` is somebody's statement, and the
      // distinction carries a ranking bonus and an exemption from retention.
      // Measured on a real store, one consolidation run demoted the user's own
      // "never break the prompt cache" rule to `auto`, which is what a guess is.
      const previous = item.id === null ? undefined : before.get(`${item.scope}\u0000${item.id}`)
      const draft: MemoryDraft = {
        scope: item.scope,
        title: item.title,
        body: item.body,
        tags: item.tags,
        keys: item.keys ?? [],
        ...item.appliesTo === undefined ? {} : { appliesTo: item.appliesTo },
        ...item.derivedFrom === undefined ? {} : { derivedFrom: item.derivedFrom },
      }
      const result = await target.upsert(
        draft,
        item.scope === 'project' ? projectRoot : undefined,
        previous?.source ?? 'auto',
        item.id ?? undefined,
      )
      touched.push({ scope: result.entry.scope, id: result.entry.id })
    }
    for (const id of plan.retire) {
      if (await target.archive('global', projectRoot, id)) archived.push({ scope: 'global', id })
      if (await target.archive('project', projectRoot, id)) archived.push({ scope: 'project', id })
    }
    return { written: plan.upserts.length, retired: plan.retire.length, notes: plan.notes }
  } catch (error) {
    // Restore every entry the plan may have changed, then rethrow so the caller
    // can log it and retry with backoff.
    for (const item of touched) {
      const original = before.get(`${item.scope}\u0000${item.id}`)
      if (original === undefined) continue
      await target.upsert(
        { scope: original.scope, title: original.title, body: original.body, tags: original.tags, keys: [...original.keys] },
        original.scope === 'project' ? projectRoot : undefined,
        original.source,
        original.id,
      )
    }
    // A retirement is an archival, not a deletion, so it can be put back
    // exactly; without this the store would lose entries to a plan that failed
    // for an unrelated reason later in the same run.
    for (const item of archived) {
      await target.restore(item.scope, projectRoot, item.id).catch(() => undefined)
    }
    throw error
  }
}
