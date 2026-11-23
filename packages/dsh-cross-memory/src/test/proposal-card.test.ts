/**
 * Guards for the consolidation confirmation card.
 *
 * Two halves are pinned here. The Host kind is exercised against fake
 * `actionCards`/`skills` services, because a real composition would mount the
 * whole memory runtime: what matters is that accept applies the pending batch
 * and records its counts, reject clears it, and reconciliation notices a
 * proposal that was decided or replaced elsewhere. The browser body is then
 * rendered with the same hand-written hook runtime the disputes panel uses, so
 * the three buttons and the settled copy are real clicks rather than a text
 * snapshot.
 *
 * @module dsh-cross-memory/test/proposal-card.test
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PROPOSAL_ACTION, PROPOSAL_DETAILS, PROPOSAL_SKILL, PROPOSAL_SKILL_CONTENT, registerProposalCard } from '../cards.js'
import type { PendingProposal, ProposalCardRuntime, ProposalCards, ProposalDecision, ProposalKind, ProposalRef, ProposalSkillControl, ProposalSkillProvider, ProposalSkills } from '../cards.js'

/** The proposal the injected note describes. */
const DETAILS = { label: 'alpha', count: 3, stagedAt: 1_760_000_000_000 }

/** One card as the Host hands it to the kind. */
const PROPOSAL: ProposalRef = {
  cardId: 'card-1',
  action: PROPOSAL_ACTION,
  title: '确认这批记忆变更',
  brief: '确认后才会改动存储。',
  details: DETAILS,
}

/** A live root; the fake services never read it. */
const AGENT = { id: 'agent-1', session: {} } as unknown as Agent

/** Fake Host services: recorded kind, decisions, providers and disposers. */
function fakeServices(initial: Record<string, ProposalDecision> = {}) {
  const decisions: Record<string, ProposalDecision> = { ...initial }
  const kinds: ProposalKind[] = []
  const recorded: ProposalDecision[] = []
  const providers: ((control: ProposalSkillControl) => ProposalSkillProvider)[] = []
  let kindDisposed = 0
  let skillDisposed = 0
  const cards: ProposalCards = {
    view: () => ({ decisions }),
    register: (kind) => {
      kinds.push(kind)
      return () => { kindDisposed += 1 }
    },
    record: (_agent, decision) => {
      recorded.push(decision)
      decisions[decision.cardId] = decision
    },
    skillProvider: (candidate, get) => (control) => {
      // Same contract as the Host service: `enabled` is the service's to apply.
      control.signal.throwIfAborted()
      return { name: candidate.provider, list: () => Promise.resolve([candidate]), get }
    },
  }
  const skills: ProposalSkills = {
    registerProvider: (create) => {
      providers.push(create)
      return () => { skillDisposed += 1 }
    },
  }
  return {
    cards,
    skills,
    kinds,
    recorded,
    providers,
    disposers: () => ({ kindDisposed, skillDisposed }),
  }
}

/** A store seam over one mutable pending value. */
function fakeRuntime(initial: PendingProposal | undefined, applied = { written: 3, retired: 1 }) {
  const state = { pending: initial }
  const runtime: ProposalCardRuntime = {
    pending: () => Promise.resolve(state.pending),
    apply: () => {
      // Real `applyPendingPlan` reports `undefined` when nothing is staged.
      const counts = state.pending === undefined ? undefined : applied
      state.pending = undefined
      return Promise.resolve(counts)
    },
    reject: () => {
      const count = state.pending?.count
      state.pending = undefined
      return Promise.resolve(count)
    },
  }
  return { runtime, state }
}

test('the kind registers accept/reject, validates details, and publishes its skill', async () => {
  const services = fakeServices()
  const { runtime } = fakeRuntime({ ...DETAILS })
  const dispose = registerProposalCard(services.cards, services.skills, runtime)

  assert.equal(services.kinds.length, 1)
  const kind = services.kinds[0]
  assert.ok(kind !== undefined)
  assert.equal(kind.action, PROPOSAL_ACTION)
  assert.deepEqual(kind.verbs, { accept: { writes: true }, reject: { writes: true } })
  assert.deepEqual(kind.openPhases, ['failed'])
  assert.deepEqual(kind.statusFields, ['written', 'retired'])
  assert.match(kind.statusGuidance ?? '', /do not offer that same proposal again/iu)

  assert.equal(PROPOSAL_DETAILS.safeParse({ ...DETAILS, count: 0 }).success, false, 'a card with no decisions is no card')
  assert.equal(PROPOSAL_DETAILS.safeParse({ ...DETAILS, count: 1.5 }).success, false)
  assert.equal(PROPOSAL_DETAILS.safeParse({ ...DETAILS, label: '' }).success, false)
  assert.equal(PROPOSAL_DETAILS.safeParse(DETAILS).success, true)

  assert.equal(services.providers.length, 1)
  const provider = services.providers[0]?.({ signal: new AbortController().signal, invalidate: () => {} })
  assert.ok(provider !== undefined)
  assert.equal(provider.name, 'dsh-cross-memory')
  const listed = await provider.list({})
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.name, PROPOSAL_SKILL)
  const loaded = await provider.get(listed[0]!, {})
  assert.match(loaded?.content ?? '', /action-card/u)
  assert.match(loaded?.content ?? '', /resolve_memory_proposal/u)
  assert.match(loaded?.content ?? '', /只提议当前 pending 文件里那一批|当前 pending 文件里那一批/u)
  assert.match(PROPOSAL_SKILL_CONTENT, /details\.count/u)

  dispose()
  assert.deepEqual(services.disposers(), { kindDisposed: 1, skillDisposed: 1 }, 'one disposer removes both halves')
})

test('accept applies the pending batch and records written/retired', async () => {
  const services = fakeServices()
  const { runtime, state } = fakeRuntime({ ...DETAILS })
  registerProposalCard(services.cards, services.skills, runtime)
  const kind = services.kinds[0]
  assert.ok(kind !== undefined)

  const result = await kind.act(AGENT, PROPOSAL, 'accept', undefined)
  assert.equal(result.status, 'settled')
  if (result.status !== 'settled') return
  assert.equal(result.decision.phase, 'applied')
  assert.deepEqual(result.decision.data, { written: 3, retired: 1 })
  assert.deepEqual(services.recorded, [{ cardId: 'card-1', action: PROPOSAL_ACTION, phase: 'applied', data: { written: 3, retired: 1 } }])
  assert.equal(state.pending, undefined)
})

test('reject clears the pending batch and records the rejection', async () => {
  const services = fakeServices()
  const { runtime, state } = fakeRuntime({ ...DETAILS })
  registerProposalCard(services.cards, services.skills, runtime)
  const kind = services.kinds[0]
  assert.ok(kind !== undefined)

  const result = await kind.act(AGENT, PROPOSAL, 'reject', undefined)
  assert.equal(result.status, 'settled')
  if (result.status !== 'settled') return
  assert.equal(result.decision.phase, 'rejected')
  assert.equal(result.decision.data, undefined)
  assert.equal(state.pending, undefined)
})

test('a failed apply keeps the card retryable instead of claiming success', async () => {
  const services = fakeServices()
  const state = { pending: { ...DETAILS } as PendingProposal | undefined }
  const runtime: ProposalCardRuntime = {
    pending: () => Promise.resolve(state.pending),
    // `applyPendingPlan` reports the rollback by leaving the proposal in place.
    apply: () => Promise.resolve({ written: 0, retired: 0 }),
    reject: () => Promise.resolve(undefined),
  }
  registerProposalCard(services.cards, services.skills, runtime)
  const kind = services.kinds[0]
  assert.ok(kind !== undefined)

  const result = await kind.act(AGENT, PROPOSAL, 'accept', undefined)
  if (result.status !== 'settled') return assert.fail('a failed apply still settles the card')
  assert.equal(result.decision.phase, 'failed')
  assert.equal(result.decision.data, undefined, 'a rollback wrote nothing, so it reports no counts')
  assert.ok(state.pending !== undefined, 'the batch is still there for the retry')
})

test('accepting a batch that another entry already cleared settles as elsewhere', async () => {
  const services = fakeServices()
  const { runtime } = fakeRuntime(undefined)
  registerProposalCard(services.cards, services.skills, runtime)
  const kind = services.kinds[0]
  assert.ok(kind !== undefined)

  const result = await kind.act(AGENT, PROPOSAL, 'accept', undefined)
  if (result.status !== 'settled') return assert.fail('a vanished batch settles the card')
  assert.equal(result.decision.phase, 'settled-elsewhere')
})

test('reconcile records settled-elsewhere when the proposal disappeared', async () => {
  const services = fakeServices()
  const { runtime } = fakeRuntime(undefined)
  registerProposalCard(services.cards, services.skills, runtime)
  const kind = services.kinds[0]
  assert.ok(kind !== undefined)

  await kind.reconcile?.(AGENT, PROPOSAL)
  assert.deepEqual(services.recorded, [{ cardId: 'card-1', action: PROPOSAL_ACTION, phase: 'settled-elsewhere' }])
})

test('reconcile supersedes a card whose proposal was replaced, and leaves a matching one alone', async () => {
  const services = fakeServices()
  const { runtime, state } = fakeRuntime({ ...DETAILS, count: 4 })
  registerProposalCard(services.cards, services.skills, runtime)
  const kind = services.kinds[0]
  assert.ok(kind !== undefined)

  await kind.reconcile?.(AGENT, PROPOSAL)
  assert.deepEqual(services.recorded, [{ cardId: 'card-1', action: PROPOSAL_ACTION, phase: 'superseded' }])

  state.pending = { ...DETAILS }
  await kind.reconcile?.(AGENT, PROPOSAL)
  assert.equal(services.recorded.length, 1, 'the exact pending proposal is not re-recorded')
})

test('reconcile never rewrites a card that is already terminal', async () => {
  const services = fakeServices({ 'card-1': { cardId: 'card-1', action: PROPOSAL_ACTION, phase: 'applied', data: { written: 1, retired: 0 } } })
  const { runtime } = fakeRuntime(undefined)
  registerProposalCard(services.cards, services.skills, runtime)
  const kind = services.kinds[0]
  assert.ok(kind !== undefined)

  await kind.reconcile?.(AGENT, PROPOSAL)
  assert.deepEqual(services.recorded, [], 'an applied card keeps its outcome on every later action')
})

/** One `createElement` result from the stand-in renderer. */
interface Element {
  readonly type: unknown
  readonly props: Record<string, unknown>
}

/** The body factory and copy table the browser part defines. */
interface BodyModule {
  readonly createProposalCardBody: (react: unknown) => (props: Record<string, unknown>) => unknown
  readonly PROPOSAL_COPY: Record<string, Record<string, string>>
}

/** The compiled browser part, resolved from the compiled test's own location. */
const BODY = new URL('../../.client-build/parts/action-card.js', import.meta.url)

/** Load the body factory and copy table. */
async function loadBody(): Promise<BodyModule> {
  const source = await readFile(BODY, 'utf8')
  return new Function(`${source}\nreturn { createProposalCardBody, PROPOSAL_COPY }`)() as BodyModule
}

/** Every element in a rendered tree, depth first. */
function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child)
    return
  }
  if (node === null || typeof node !== 'object') return
  const element = node as Element
  if (element.props !== undefined && (typeof element.type === 'string' || typeof element.type === 'function')) yield element
  if (element.props?.children !== undefined) yield* walk(element.props.children)
}

/** The text a rendered subtree would show. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return ''
  return textOf((node as Element).props.children)
}

/** The first element with this tag whose text contains `text`. */
function findByText(tree: unknown, tag: string, text: string): Element {
  for (const element of walk(tree)) {
    if (element.type === tag && textOf(element).includes(text)) return element
  }
  throw new Error(`no <${tag}> showing ${JSON.stringify(text)}`)
}

/** Click one element's `onClick`. */
function click(element: Element): void {
  const handler = element.props.onClick
  assert.equal(typeof handler, 'function', 'the button must carry a click handler')
  ;(handler as () => void)()
}

/** Mount the body against a stand-in hook runtime and a recording `act`. */
function mountBody(module: BodyModule, props: Record<string, unknown>, act: (verb: string) => Promise<unknown>) {
  const state: unknown[] = []
  let cursor = 0
  const react = {
    createElement: (type: unknown, value: Record<string, unknown> | null, ...children: unknown[]): Element => ({
      type,
      props: { ...(value ?? {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: (initial: unknown): [unknown, (next: unknown) => void] => {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [state[index], (next: unknown) => {
        state[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(state[index]) : next
      }]
    },
  }
  const Body = module.createProposalCardBody(react)
  const copy = module.PROPOSAL_COPY.zh ?? {}
  const t = (key: string, params?: Record<string, string>): string => {
    const template = copy[key] ?? key
    return template.replace(/\{(\w+)\}/gu, (_match, name: string) => params?.[name] ?? '')
  }
  const render = (): unknown => {
    cursor = 0
    return Body({ ...props, t, act })
  }
  return { render }
}

/** The frame props for one card. */
function frameProps(decision: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    proposal: { cardId: 'card-1', action: PROPOSAL_ACTION, title: '确认这批记忆变更', brief: '确认后才会改动存储。', details: DETAILS },
    decision,
    summary: 'summary',
    fallback: 'fallback',
    act: () => Promise.resolve({ status: 'settled' }),
  }
}

test('the body shows the batch and sends accept/reject/dismiss', async () => {
  const module = await loadBody()
  const calls: string[] = []
  const act = (verb: string) => {
    calls.push(verb)
    return Promise.resolve({ status: 'settled' })
  }
  const { render } = mountBody(module, frameProps(undefined), act)

  const card = render()
  const shown = textOf(card)
  assert.match(shown, /范围：alpha/u)
  assert.match(shown, /3 条变更待确认/u)
  assert.match(shown, /提案生成于/u)

  click(findByText(card, 'button', '确认应用'))
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  assert.deepEqual(calls, ['accept'], 'the primary button sends accept')

  click(findByText(render(), 'button', '拒绝'))
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  click(findByText(render(), 'button', '稍后'))
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  assert.deepEqual(calls, ['accept', 'reject', 'dismiss'], 'reject and Not now use their own verbs')
})

test('a settled card shows its outcome and offers no buttons', async () => {
  const module = await loadBody()
  const applied = renderWith(module, { cardId: 'card-1', action: PROPOSAL_ACTION, phase: 'applied', data: { written: 3, retired: 1 } })
  const text = textOf(applied)
  assert.match(text, /已应用：3 条写回，1 条退役。/u)
  assert.equal(findByTextOptional(applied, 'button', '确认应用'), undefined, 'no action survives a decision')
  assert.equal(findByTextOptional(applied, 'button', '稍后'), undefined)

  const rejected = renderWith(module, { cardId: 'card-1', action: PROPOSAL_ACTION, phase: 'rejected' })
  assert.match(textOf(rejected), /已拒绝/u)
  assert.equal(findByTextOptional(rejected, 'button', '拒绝'), undefined)

  const elsewhere = renderWith(module, { cardId: 'card-1', action: PROPOSAL_ACTION, phase: 'settled-elsewhere' })
  assert.match(textOf(elsewhere), /已在别处处理/u)
})

test('a failed card stays retryable, and unreadable details fall back to the frame', async () => {
  const module = await loadBody()
  const failed = renderWith(module, { cardId: 'card-1', action: PROPOSAL_ACTION, phase: 'failed' })
  assert.match(textOf(failed), /应用失败，存储已回滚/u)
  assert.ok(findByTextOptional(failed, 'button', '确认应用') !== undefined, 'a rollback can be retried')

  const invalid = mountBody(module, {
    ...frameProps(undefined),
    proposal: { cardId: 'card-1', action: PROPOSAL_ACTION, title: 't', brief: 'b', details: { ...DETAILS, count: 0 } },
  }, () => Promise.resolve({ status: 'settled' })).render()
  assert.equal(invalid, 'fallback', 'a card whose details fail the schema renders the frame fallback')
})

/** Render the body with one recorded decision. */
function renderWith(module: BodyModule, decision: Record<string, unknown>): unknown {
  return mountBody(module, frameProps(decision), () => Promise.resolve({ status: 'settled' })).render()
}

/** Like {@link findByText}, but undefined instead of throwing. */
function findByTextOptional(tree: unknown, tag: string, text: string): Element | undefined {
  try {
    return findByText(tree, tag, text)
  } catch {
    return undefined
  }
}
