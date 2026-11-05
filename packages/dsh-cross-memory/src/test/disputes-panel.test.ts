/**
 * Regression guard for the 待裁决 (disputes) panel and the Remote seam under it.
 *
 * Two bugs shipped in this panel, and neither is visible in a diff: the accept
 * button was wired to `props.onResolve`, a prop the settings section never
 * receives, so clicking it silently did nothing; and both buttons called the
 * Remote method positionally (`resolveDispute(row.id, decision)`) while the
 * browser wrapper maps ONE object's fields onto the gateway's positional
 * arguments, so the host answered `args fields do not match the descriptor`.
 *
 * The panel is hand-written `createElement` code with no DOM dependency, so it
 * is rendered here against a tiny hook runtime and its buttons are really
 * clicked; the wrapper is then exercised against a fake namespace to prove a
 * positional call now fails loudly instead of turning into a dead button.
 *
 * @module dsh-cross-memory/test/disputes-panel.test
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { REMOTE_INVOCATION_DATA } from '../remote.js'

/** One `createElement` result from the stand-in renderer. */
interface Element {
  readonly type: unknown
  readonly props: Record<string, unknown>
}

/** One run of the word diff. */
interface DiffToken {
  readonly kind: 'same' | 'del' | 'ins'
  readonly text: string
}

/** One reason split into its scope move and its remaining grounds. */
interface ParsedReason {
  readonly scope: { readonly from: string; readonly to: string } | null
  readonly reasons: string[]
}

/** The section factory and copy table the browser half defines. */
interface SectionModule {
  readonly createMemoriesSection: (react: unknown, card: unknown) => (props: Record<string, unknown>) => unknown
  readonly SECTION_COPY: Record<string, Record<string, unknown>>
  readonly diffTokens: (before: string, after: string) => DiffToken[]
  readonly splitDisputeReason: (reason: string) => ParsedReason
}

/** Every waiting decision the fake host reports. */
const DISPUTES = [{
  id: 'entry-1',
  scope: 'global',
  action: 'rewrite',
  title: 'A memory that needs a person',
  reason: 'the rewrite is shorter',
  before: 'what it says today',
  after: 'what the pass wants instead',
}]

/** The browser half, resolved from the compiled test's own location. */
const SECTION = new URL('../../.client-build/parts/section.js', import.meta.url)
const REMOTE = new URL('../../.client-build/parts/remote.js', import.meta.url)

/** Load the section factory the bundle concatenates. */
async function loadSection(): Promise<SectionModule> {
  const source = await readFile(SECTION, 'utf8')
  return new Function(`${source}\nreturn { createMemoriesSection, SECTION_COPY, diffTokens, splitDisputeReason }`)() as SectionModule
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

/** The first element carrying this class, or undefined. */
function findClass(tree: unknown, name: string): Element | undefined {
  for (const element of walk(tree)) {
    const className = element.props.className
    if (typeof className === 'string' && className.split(' ').includes(name)) return element
  }
  return undefined
}

/** Click one element's `onClick`. */
function click(element: Element): void {
  const handler = element.props.onClick
  assert.equal(typeof handler, 'function', 'the button must carry a click handler')
  ;(handler as () => void)()
}

/**
 * Render the section against a stand-in hook runtime.
 *
 * `render` re-renders until the effects it just ran have settled, which is what
 * lets the panel's own data loading — including the disputes fetch — complete
 * before anything is clicked.
 */
async function mountSection(api: Record<string, unknown>, copy: Record<string, unknown>) {
  const state: unknown[] = []
  const callbacks: unknown[] = []
  const effectSlots: (readonly unknown[] | undefined)[] = []
  let cursor = 0
  let callbackCursor = 0
  let effectCursor = 0
  let dirty = false
  let pending: (() => unknown)[] = []

  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: (initial: unknown): [unknown, (next: unknown) => void] => {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      const set = (next: unknown): void => {
        state[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(state[index]) : next
        dirty = true
      }
      return [state[index], set]
    },
    // Memoized like React's: a fresh function identity every render would make
    // the panel's `[loadDisputes]` effects re-run forever.
    useCallback: (callback: unknown): unknown => {
      const index = callbackCursor++
      callbacks[index] ??= callback
      return callbacks[index]
    },
    useEffect: (effect: () => unknown, deps?: readonly unknown[]): void => {
      const index = effectCursor++
      const previous = effectSlots[index]
      const changed = deps === undefined || previous === undefined
        || deps.length !== previous.length || deps.some((value, at) => !Object.is(value, previous[at]))
      if (!changed) return
      effectSlots[index] = deps
      pending.push(effect)
    },
  }

  const section = (await loadSection()).createMemoriesSection(react, () => null)
  const props: Record<string, unknown> = { api, copy, scope: undefined, useSnapshot: () => undefined }
  const render = async (): Promise<unknown> => {
    let tree: unknown = null
    for (let pass = 0; pass < 25; pass += 1) {
      cursor = 0
      callbackCursor = 0
      effectCursor = 0
      pending = []
      dirty = false
      tree = section(props)
      if (pending.length === 0) break
      for (const effect of pending) effect()
      await new Promise((resolve) => { setTimeout(resolve, 5) })
      if (!dirty) break
    }
    return tree
  }
  return { render }
}

/** A Remote API stub recording what the panel asks the host to do. */
function fakeApi(calls: Record<string, unknown>[], rows: readonly Record<string, unknown>[] = DISPUTES): Record<string, unknown> {
  return {
    overview: () => Promise.resolve({ storePath: '/store', globalCount: 0, projects: [], drafts: [], kinds: [] }),
    list: () => Promise.resolve({ entries: [], total: 0 }),
    disputes: () => Promise.resolve({ disputes: rows }),
    resolveDispute: (args: Record<string, unknown>) => {
      calls.push(args)
      return Promise.resolve('Applied.')
    },
    persona: () => Promise.resolve({ text: '他先确认再改代码。', locked: false }),
    savePersona: (args: Record<string, unknown>) => {
      calls.push(args)
      return Promise.resolve({ text: args.text, locked: args.locked })
    },
  }
}

test('the disputes panel accepts and rejects through the Remote API', async () => {
  const calls: Record<string, unknown>[] = []
  const module = await loadSection()
  const { render } = await mountSection(fakeApi(calls), (module.SECTION_COPY.zh ?? {}) as Record<string, unknown>)

  const memories = await render()
  click(findByText(memories, 'button', '待裁决'))
  const panel = await render()

  assert.match(textOf(panel), /A memory that needs a person/u, 'the waiting decision is rendered')

  // The section receives no `onResolve` prop at all: this is exactly the state
  // the shipped bug turned into a permanently dead button.
  click(findByText(panel, 'button', '接受'))
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  assert.deepEqual(calls, [{ id: 'entry-1', decision: 'accept' }], 'accept calls the host with the descriptor fields')

  const afterAccept = await render()
  assert.match(textOf(afterAccept), /Applied\./u, 'the outcome is shown to the reader')

  click(findByText(afterAccept, 'button', '保留原样'))
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  assert.deepEqual(calls.at(-1), { id: 'entry-1', decision: 'reject' }, 'reject goes through the same door')
})

test('the browser Remote wrapper takes one object per call and says so otherwise', async () => {
  const seen: unknown[][] = []
  const source = await readFile(REMOTE, 'utf8')
  const mount = new Function(
    `const REMOTE_INVOCATION_DATA = ${JSON.stringify(REMOTE_INVOCATION_DATA)};\n${source}\nreturn mountMemoriesRemote`,
  )() as (ctx: unknown) => Promise<Record<string, (...args: unknown[]) => Promise<unknown>>>

  const namespace: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const invocation of REMOTE_INVOCATION_DATA) {
    namespace[invocation.method] = (...args: unknown[]) => {
      seen.push(args)
      return Promise.resolve({ ok: true, value: 'done' })
    }
  }
  const ctx = {
    get: (key: string) => (key === 'remote' ? { $mount: () => Promise.resolve(() => undefined) } : namespace),
    effect: () => undefined,
  }

  const api = await mount(ctx)
  assert.equal(await api.resolveDispute?.({ id: 'entry-1', decision: 'reject' }), 'done')
  assert.deepEqual(seen.at(-1), ['entry-1', 'reject'], 'the object is spread into the descriptor order')

  // The shape the panel used to pass: two positional values reach the gateway as
  // no fields at all, so the mistake must surface here rather than at the host.
  await assert.rejects(
    async () => api.resolveDispute?.('entry-1', 'accept'),
    /takes one object keyed by its parameter names/u,
  )
})

/** Mount the disputes tab against one fixture and return the rendered panel. */
async function renderDisputes(rows: readonly Record<string, unknown>[]): Promise<unknown> {
  const module = await loadSection()
  const { render } = await mountSection(fakeApi([], rows), (module.SECTION_COPY.zh ?? {}) as Record<string, unknown>)
  click(findByText(await render(), 'button', '待裁决'))
  return render()
}

test('the word diff marks exactly the runs that changed', async () => {
  const module = await loadSection()

  // CJK is compared per character, each change run is merged, and latin words
  // and whitespace groups stay whole so a number change is one mark.
  assert.deepEqual(module.diffTokens('缓存里同步一遍', '缓存中同步一遍'), [
    { kind: 'same', text: '缓存' },
    { kind: 'del', text: '里' },
    { kind: 'ins', text: '中' },
    { kind: 'same', text: '同步一遍' },
  ])
  assert.deepEqual(module.diffTokens('记忆每天跑一次', '记忆每天运行一次'), [
    { kind: 'same', text: '记忆每天' },
    { kind: 'del', text: '跑' },
    { kind: 'ins', text: '运行' },
    { kind: 'same', text: '一次' },
  ])
  assert.deepEqual(module.diffTokens('uses 18 条', 'uses 20 条'), [
    { kind: 'same', text: 'uses ' },
    { kind: 'del', text: '18' },
    { kind: 'ins', text: '20' },
    { kind: 'same', text: ' 条' },
  ])
  // Identical bodies produce one unchanged run, never a fabricated change.
  assert.deepEqual(module.diffTokens('完全一样', '完全一样'), [{ kind: 'same', text: '完全一样' }])
})

test('a rewrite reads as one line with the change marked in place', async () => {
  const panel = await renderDisputes([{
    id: 'entry-2',
    scope: 'global',
    action: 'rewrite',
    title: '整理记忆时别把待裁决项塞进摘要',
    reason: '这条是人手写的；新版正文不到原来的一半',
    before: '整理记忆时不要把待裁决项塞进摘要',
    after: '整理记忆时别把待裁决项塞进摘要',
  }])

  const removed = findClass(panel, 'dshm-del')
  assert.ok(removed !== undefined, 'the removed words are marked')
  assert.equal(removed.type, 'del')
  assert.equal(textOf(removed), '不要')

  const added = findClass(panel, 'dshm-ins')
  assert.ok(added !== undefined, 'the added words are marked')
  assert.equal(added.type, 'ins')
  assert.equal(textOf(added), '别')

  const diff = findClass(panel, 'dshm-diff')
  assert.ok(diff !== undefined, 'the body is one diff block')
  // One reading line: the stored text with each change inline, no caption pair.
  assert.equal(textOf(diff), '整理记忆时不要别把待裁决项塞进摘要')
  assert.doesNotMatch(textOf(panel), /现在是|改成/u, 'the marks replace a caption')

  // Grounds are individual badges, not one grey paragraph.
  const reasons = findClass(panel, 'dshm-reasons')
  assert.ok(reasons !== undefined)
  assert.ok(Array.isArray(reasons.props.children))
  assert.deepEqual((reasons.props.children as unknown[]).map(textOf), ['这条是人手写的', '新版正文不到原来的一半'])
})

test('identical text with a scope move shows the comparison instead of two bodies', async () => {
  const body = '记忆库同步每天 18:10 跑一次。'
  const panel = await renderDisputes([{
    id: 'entry-3',
    scope: 'global',
    action: 'rewrite',
    title: '只换作用域',
    reason: '作用域要从 global 改成 project',
    before: body,
    after: body,
  }])

  assert.equal(findClass(panel, 'dshm-del'), undefined, 'no word was removed')
  assert.equal(findClass(panel, 'dshm-ins'), undefined, 'no word was added')

  const scope = findClass(panel, 'dshm-scope')
  assert.ok(scope !== undefined, 'the move is stated in the head')
  assert.equal(textOf(scope), '全局→项目')
  assert.equal(findClass(panel, 'dshm-reasons'), undefined, 'a scope move is not a ground')

  // The stored text stays readable, exactly once — deciding whether a memory
  // belongs where it is cannot be done without reading it, and a second copy is
  // the noise this view removes.
  const shown = textOf(panel)
  assert.equal(shown.split('记忆库同步每天').length - 1, 1, 'the body is readable once')
  assert.doesNotMatch(shown, /作用域要从/u)
})

test('a retirement strikes the body and renders no replacement', async () => {
  const panel = await renderDisputes([{
    id: 'entry-4',
    scope: 'project',
    action: 'retire',
    title: '从没被读过的条目',
    reason: '它被读到过 3 次',
    before: '这条记忆从没被读过，也没人引用它。',
    after: '',
  }])

  const retired = findClass(panel, 'dshm-retire')
  assert.ok(retired !== undefined, 'the body is marked as retired')
  assert.equal(retired.type, 'p')
  assert.match(textOf(retired), /这条记忆从没被读过/u)
  assert.equal(findClass(panel, 'dshm-ins'), undefined, 'nothing replaces a retirement')
  assert.equal(findClass(panel, 'dshm-del'), undefined)
})

test('the persona tab loads the profile and saves text plus the lock flag', async () => {
  const calls: Record<string, unknown>[] = []
  const module = await loadSection()
  const { render } = await mountSection(fakeApi(calls), module.SECTION_COPY.zh as Record<string, unknown>)

  const memories = await render()
  click(findByText(memories, 'button', '画像'))
  const panel = await render()

  const area = [...walk(panel)].find((element) => element.type === 'textarea')
  assert.equal(area?.props.value, '他先确认再改代码。', 'the stored profile is in the editor')
  ;(area?.props.onChange as ((event: { target: { value: string } }) => void))({ target: { value: '新的画像' } })
  const edited = await render()

  const lock = [...walk(edited)].find((element) => element.type === 'input' && element.props.type === 'checkbox')
  assert.equal(lock?.props.checked, false, 'the lock starts from the stored flag')
  ;(lock?.props.onChange as ((event: { target: { checked: boolean } }) => void))({ target: { checked: true } })
  const locked = await render()
  assert.equal([...walk(locked)].find((element) => element.type === 'input' && element.props.type === 'checkbox')?.props.checked, true)

  click(findByText(locked, 'button', '保存画像'))
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  assert.deepEqual(calls.at(-1), { text: '新的画像', locked: true }, 'one object with both wire fields')

  const after = await render()
  assert.match(textOf(after), /画像已保存。/u, 'the save is reported')
})
