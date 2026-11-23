/**
 * The `resolve_memory_proposal` action card: a staged consolidation proposal
 * offered in the answer, decided by a click.
 *
 * Before 0.2.9 a staged proposal could only wait for `/memories plan` +
 * `/memories apply|reject` or the settings page, and the notification pump that
 * pointed at it is unusable on macOS in this deployment (no osascript channel).
 * A card is the same question where the user already is: the model loads a
 * skill, ends its answer with an `action-card` block, and the buttons apply or
 * discard the whole waiting batch.
 *
 * The kind owns no state of its own: every action reads the real pending file
 * through {@link ProposalCardRuntime}, so a card can never apply a proposal the
 * store no longer has, and the same pending batch stays actionable from the
 * command and the settings panel.
 *
 * The Host services are described by the small structural interfaces below
 * instead of importing `@deepseek-ai/dsh-action-cards` / `dsh-skill` types. Two
 * reasons: the card mechanism is an optional capability (an older Host has no
 * `skillProvider` and this plugin must still compose), and both packages ship
 * their own `schemastery` copy, whose duplicate type identity made this
 * package's `Config` declaration non-portable.
 *
 * @module dsh-cross-memory/cards
 */
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** Value of the card's `action` field; also what the skill's block names. */
export const PROPOSAL_ACTION = 'resolve_memory_proposal'

/** Skill name that tells the model when to offer the card. */
export const PROPOSAL_SKILL = 'memory-proposal'

/** Fields the model writes into the answer block; validated on both sides. */
export interface ProposalDetails {
  /** Scope label of the waiting proposal, as the store wrote it. */
  readonly label: string
  /** Number of decisions waiting for the user. */
  readonly count: number
  /** Epoch milliseconds when the pass staged the proposal. */
  readonly stagedAt: number
}

/** Host validation for one card's `details`. */
export const PROPOSAL_DETAILS = z.object({
  label: z.string().min(1),
  count: z.number().int().positive(),
  stagedAt: z.number().int(),
}) satisfies z.ZodType<ProposalDetails>

/** The staged proposal as the card reads it; identical to the injected note's fields. */
export interface PendingProposal {
  readonly label: string
  readonly count: number
  readonly stagedAt: number
}

/**
 * What the card needs from the memory runtime.
 *
 * A seam rather than the runtime itself: the kind is testable with three tiny
 * functions, and it cannot reach the store, the model or the session directly.
 */
export interface ProposalCardRuntime {
  /** The proposal waiting right now, or `undefined` when nothing is staged. */
  pending(): Promise<PendingProposal | undefined>
  /**
   * Apply every waiting decision.
   * @param agent - live root of the card's Session, as the Host resolved it.
   * @returns the written/retired counts, or `undefined` when nothing was staged.
   */
  apply(agent: Agent): Promise<{ readonly written: number; readonly retired: number } | undefined>
  /** Discard every waiting decision, returning how many were dropped. */
  reject(): Promise<number | undefined>
}

/** One decision recorded for a card, as the Host stores it. */
export interface ProposalDecision {
  readonly cardId: string
  readonly action: string
  readonly phase: string
  readonly data?: Readonly<Record<string, unknown>>
}

/** One card as the Host hands it to `reconcile` and `act`. */
export interface ProposalRef {
  readonly cardId: string
  readonly action: string
  readonly title: string
  readonly brief: string
  readonly details: ProposalDetails
}

/** What a card action returns to the browser. */
export type ProposalResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'settled'; readonly decision: ProposalDecision }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'unconfirmed'; readonly reason: string }

/** The zod-like field validator the Host calls before every action. */
export interface ProposalDetailsSchema {
  safeParse(value: unknown): { readonly success: true; readonly data: ProposalDetails } | { readonly success: false }
}

/** One Host action kind, narrowed to the fields this plugin sets. */
export interface ProposalKind {
  readonly action: string
  readonly details: ProposalDetailsSchema
  readonly verbs: Readonly<Record<string, { readonly writes?: true; readonly global?: true }>>
  readonly openPhases?: readonly string[]
  readonly statusGuidance?: string
  readonly statusFields?: readonly string[]
  reconcile?(agent: Agent, proposal: ProposalRef): Promise<void>
  act(agent: Agent, proposal: ProposalRef, verb: string, payload: Readonly<Record<string, unknown>> | undefined): Promise<ProposalResult>
}

/** One skill catalog entry, as `ctx.skills` takes it. */
export interface ProposalSkillCandidate {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: string
  readonly provider: string
  readonly rank: number
  readonly locator: unknown
}

/** One loaded skill definition. */
export type ProposalSkillDefinition = Omit<ProposalSkillCandidate, 'rank' | 'locator'> & { readonly content: string }

/** Options a provider receives when listing or loading a skill. */
export interface ProposalSkillOptions {
  readonly signal?: AbortSignal
}

/** What a provider receives when the registry binds it. */
export interface ProposalSkillControl {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

/** One skill provider, narrowed to what this plugin implements. */
export interface ProposalSkillProvider {
  readonly name: string
  readonly list: (options: ProposalSkillOptions) => Promise<readonly ProposalSkillCandidate[]>
  readonly get: (candidate: ProposalSkillCandidate, options: ProposalSkillOptions) => Promise<ProposalSkillDefinition | undefined>
}

/** The Host action-card service, narrowed to what this kind uses. */
export interface ProposalCards {
  view(session: Session): { readonly decisions: Readonly<Record<string, ProposalDecision>> }
  register(kind: ProposalKind): () => void
  record(agent: Agent, decision: ProposalDecision): void
  /** Present only from 0.2.3-alpha.2; the composition checks it before calling. */
  skillProvider(
    candidate: ProposalSkillCandidate,
    get: ProposalSkillProvider['get'],
  ): (control: ProposalSkillControl) => ProposalSkillProvider
}

/** The Host skill registry, narrowed to provider registration. */
export interface ProposalSkills {
  registerProvider(create: (control: ProposalSkillControl) => ProposalSkillProvider): () => void
}

/**
 * Recorded phases after which the card shows its outcome and offers no action.
 * `dismissed` is recorded by the Host frame, and `failed` is this kind's
 * retryable phase.
 */
const TERMINAL_PHASES: ReadonlySet<string> = new Set(['applied', 'rejected', 'dismissed', 'superseded', 'settled-elsewhere'])

/** Guidance the status notice adds after a decision, for the model to read. */
const STATUS_GUIDANCE = 'Memory proposals: applied means the whole staged batch is now in the store with the reported written and retired counts; '
  + 'rejected means the batch was discarded and the store is unchanged; dismissed means the user set it aside, so do not offer that same proposal again; '
  + 'superseded or settled-elsewhere means another entry (/memories apply, /memories reject, the settings 待裁决 panel, or a newer pass) already decided it — '
  + 'report that state instead of offering the card again. Only the proposal that is still pending may be offered, and only once per answer.'

/**
 * A skill has to route on text alone, so the description names the trigger in
 * both languages the user works in and explicitly excludes ordinary memory work.
 */
const SKILL_CANDIDATE: ProposalSkillCandidate = {
  name: PROPOSAL_SKILL,
  description: 'Offer the staged memory-consolidation proposal as a confirmable action card when the user asks about memory changes, a pending merge, or what still needs confirmation (记忆变更 / 待确认 / 待裁决). 只有存在待确认提案时才用；不用于普通的记忆搜索、写入或问答。',
  invocation: { modelInvocable: true, userInvocable: false },
  provider: 'dsh-cross-memory',
  source: 'runtime',
  // Same value as @deepseek-ai/dsh-skill's BUNDLED_SKILL_RANK, kept as a literal
  // so this package needs no runtime dependency on the host's skill package.
  rank: 600,
  locator: null,
}

/** What the model is told when it loads the skill. */
export const PROPOSAL_SKILL_CONTENT = [
  '# 记忆变更确认卡',
  '',
  '本插件的后台合并会先把「可能丢信息」的改动放进一份待确认提案（`pending/consolidation.json`）。',
  '用户问起「记忆变更 / 待确认 / 待裁决 / 合并提案」时，用一张 `action-card` 让本人当场确认，不要只说去哪个页面。',
  '',
  '## 什么时候出卡',
  '',
  '- 只有存在待确认提案时。提案的 label、count、stagedAt 见本轮注入里的 "Pending consolidation proposal" 那一行；没有这一行就不要出卡。',
  '- 卡片只代表「当前 pending 文件里那一批」，不要自己编造或合并别的批次，也不要给出一个不同的数字。',
  '- 如果状态通知已经说这批是 applied / rejected / dismissed / superseded / settled-elsewhere，就不要再出卡；直接说明结果。',
  '',
  '## 块格式',
  '',
  '在最终回答的最后放一个 fenced code block，语言必须是字面的 `action-card`，内容是一个 JSON 对象：',
  '',
  '````',
  '```action-card',
  '{"action":"resolve_memory_proposal","title":"确认这批记忆变更","brief":"这批提案会写回若干条记忆并退役若干条，确认后才会动存储。","details":{"label":"<scope label>","count":3,"stagedAt":1750000000000}}',
  '```',
  '````',
  '',
  '- `action` 固定为 `resolve_memory_proposal`。',
  '- `title`、`brief` 用用户的语言写；brief 说清「确认后才会改动存储」。',
  '- `details.label` 照抄注入行里的提案 label。',
  '- `details.count` 是待拍板的条数，必须是正整数，照抄注入行；不要用计划里的写回/退役条数代替。',
  '- `details.stagedAt` 是提案生成时间（epoch 毫秒），照抄注入行里的 stagedAt。',
  '',
  '## 出卡之后',
  '',
  '- 块前留一句邀请：点下面的按钮确认应用或拒绝；`/memories plan|apply|reject` 和「设置 → 记忆 → 待裁决」仍然可用。',
  '- 每轮只能有一个 `action-card` 块，放在回答末尾；不要放进引用、四级缩进或另一个代码块里。',
  '- 卡片按钮会整批应用或整批丢弃，不是逐条处理。',
  '- 点了按钮之后，下一轮会收到一条 action-card 状态通知；按通知里的阶段回答，不要重复提议同一批。',
].join('\n')

/** Own entries only: browser-supplied ids such as `toString` never reach inherited object members. */
function ownDecision(cards: ProposalCards, agent: Agent, cardId: string): ProposalDecision | undefined {
  const decisions = cards.view(agent.session).decisions
  return Object.hasOwn(decisions, cardId) ? decisions[cardId] : undefined
}

/** Whether a pending proposal is the exact one this card describes. */
function matches(proposal: ProposalDetails, pending: PendingProposal): boolean {
  return pending.label === proposal.label && pending.count === proposal.count && pending.stagedAt === proposal.stagedAt
}

/** Record one decision and return it as the settled result. */
function settle(
  cards: ProposalCards,
  agent: Agent,
  cardId: string,
  phase: string,
  data?: Readonly<Record<string, unknown>>,
): ProposalResult {
  const decision: ProposalDecision = { cardId, action: PROPOSAL_ACTION, phase, ...data === undefined ? {} : { data } }
  cards.record(agent, decision)
  return { status: 'settled', decision }
}

/**
 * Register the card kind and the skill that offers it for the caller's lifetime.
 *
 * The caller must run this inside `ctx.inject(['actionCards', 'skills'], …)` and
 * hold the returned disposer in `ctx.effect`; disposing removes both, so an
 * unloaded plugin leaves no half-registered card behind.
 *
 * @param cards - the Host action-card service.
 * @param skills - the Host skill registry.
 * @param runtime - the store seam described by {@link ProposalCardRuntime}.
 * @returns disposer removing the kind and the skill provider.
 */
export function registerProposalCard(cards: ProposalCards, skills: ProposalSkills, runtime: ProposalCardRuntime): () => void {
  const disposeKind = cards.register({
    action: PROPOSAL_ACTION,
    details: PROPOSAL_DETAILS,
    // Both buttons change memory files; a read-only Session may not.
    verbs: { accept: { writes: true }, reject: { writes: true } },
    // A failed apply already rolled the store back; the card stays actionable
    // so the same click can be retried.
    openPhases: ['failed'],
    statusGuidance: STATUS_GUIDANCE,
    statusFields: ['written', 'retired'],
    // Every action, including Not now, first learns whether another entry already
    // decided this proposal or a newer pass replaced it.
    reconcile: async (agent, proposal) => {
      const previous = ownDecision(cards, agent, proposal.cardId)
      if (previous !== undefined && TERMINAL_PHASES.has(previous.phase)) return
      const pending = await runtime.pending()
      if (pending === undefined) {
        settle(cards, agent, proposal.cardId, 'settled-elsewhere')
        return
      }
      if (!matches(proposal.details, pending)) settle(cards, agent, proposal.cardId, 'superseded')
    },
    act: async (agent, proposal, verb) => {
      if (verb === 'reject') {
        const dropped = await runtime.reject()
        // Another entry discarded it between reconciliation and this click.
        if (dropped === undefined) return settle(cards, agent, proposal.cardId, 'settled-elsewhere')
        return settle(cards, agent, proposal.cardId, 'rejected')
      }
      if (verb !== 'accept') return { status: 'refused', reason: 'unknown-verb' }
      const applied = await runtime.apply(agent)
      if (applied === undefined) return settle(cards, agent, proposal.cardId, 'settled-elsewhere')
      // `applyPendingPlan` clears the proposal only after every write succeeded;
      // a still-readable proposal therefore means the store was rolled back.
      const pending = await runtime.pending()
      if (pending !== undefined) {
        return settle(cards, agent, proposal.cardId, matches(proposal.details, pending) ? 'failed' : 'superseded')
      }
      return settle(cards, agent, proposal.cardId, 'applied', { written: applied.written, retired: applied.retired })
    },
  })
  const disposeSkill = skills.registerProvider(cards.skillProvider(SKILL_CANDIDATE, async (_candidate, options) => {
    options.signal?.throwIfAborted()
    return {
      name: SKILL_CANDIDATE.name,
      description: SKILL_CANDIDATE.description,
      invocation: SKILL_CANDIDATE.invocation,
      source: SKILL_CANDIDATE.source,
      provider: SKILL_CANDIDATE.provider,
      content: PROPOSAL_SKILL_CONTENT,
    }
  }))
  return () => {
    disposeSkill()
    disposeKind()
  }
}
