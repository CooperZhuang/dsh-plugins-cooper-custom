/**
 * Browser-half contract tests for "waiting on you" ordering.
 *
 * The bundle served to the kernel is `lib/client.js` (built from
 * `src/client.js` + the pure rules in `src/sort.js`). These tests evaluate it
 * against a fake page and a fake Cordis context, then drive the two stores the
 * engine follows: Session summaries and `ctx.uiSession.pendingInteractions`.
 *
 * The fake `fetch` always answers 503 on purpose: the point of this change is
 * that a Host half that cannot be reached only costs persisted pins, never the
 * sorting itself. Every passing test therefore also proves the old
 * "request failed → enabled:false" downgrade is gone.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** The built bundle the kernel serves. */
const BUNDLE_URL = new URL('../lib/client.js', import.meta.url)

/** The registration id the kernel expects: the package name, never the row id. */
const PACKAGE_ID = '@cooper-zhuang/dsh-workspace-sort'

/** `SETTLE_MS` in `src/client.js` plus slack; every engine change is debounced through it. */
const SETTLE_WAIT_MS = 520

/** The page objects the bundle touches at load time. */
function makeDocument() {
  const head = {
    appendChild(node) {
      node.isConnected = true
    },
  }
  return {
    head,
    getElementById: () => null,
    createElement: () => ({
      id: '',
      textContent: '',
      isConnected: false,
      remove() {
        this.isConnected = false
      },
    }),
  }
}

/**
 * Evaluate the bundle and return its one registration.
 *
 * @returns the `{id, factory}` registration.
 */
function loadBundle() {
  const registrations = []
  const window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  }
  new Function('window', 'document', readFileSync(BUNDLE_URL, 'utf8'))(window, makeDocument())
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, PACKAGE_ID)
  return registrations[0]
}

/**
 * Materialize the plugin exports; the components are never rendered here.
 *
 * @returns the plugin's `{inject, apply}`.
 */
function loadPlugin() {
  const react = { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {} }
  return loadBundle().factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected client module: ${id}`)
  })
}

/**
 * A minimal external store: `getSnapshot` / `subscribe` / `set`.
 *
 * @param initial - starting snapshot.
 * @returns the store.
 */
function store(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * A Host-synced config field whose value can be pushed like the kernel does.
 *
 * @param value - initial value.
 * @returns the ref plus a `push` helper for the test.
 */
function configRef(value) {
  let current = value
  const listeners = new Set()
  return {
    get: () => current,
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    push(next) {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** One Workspace row, one member Session named after it. */
const workspace = (id) => ({ workspaceId: id, path: `/${id}`, sessionIds: [id] })

/** Session summaries keyed by id; `running` is off unless asked for. */
const summaries = (entries) => Object.fromEntries(entries.map(([id, updatedAt]) => [id, { updatedAt, running: false }]))

/** Build the pending-interaction map the kernel publishes. */
const pending = (sessionId, kind) => new Map([[sessionId, { key: `${sessionId}-${kind}`, kind, sessionId }]])

/**
 * Mount the browser half on a stand-in context.
 *
 * @param options - `items`, `byId`, `enabled`, `initialSort`.
 * @returns the recorded durable writes and the stores the tests drive.
 */
function mount({ items, byId, enabled = true, initialSort = false }) {
  const calls = []
  const workspaceStore = store({ items })
  const sessionStore = store({ byId })
  const pendingStore = store(new Map())
  const effects = []

  const insertBefore = async (id, before) => {
    calls.push({ id, before })
    const next = workspaceStore.getSnapshot().items.map((row) => ({ ...row }))
    const from = next.findIndex((row) => row.workspaceId === id)
    assert.notEqual(from, -1, `insertBefore names an unknown Workspace: ${id}`)
    const [row] = next.splice(from, 1)
    const at = before === undefined ? next.length : next.findIndex((entry) => entry.workspaceId === before)
    assert.notEqual(at, -1, `insertBefore names an unknown anchor: ${before}`)
    next.splice(at, 0, row)
    workspaceStore.set({ items: next })
  }

  const ctx = {
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return disposer
    },
    locale: { bind: () => (key) => key, register: () => () => {}, subscribe: () => () => {} },
    workspaces: { list: workspaceStore, insertBefore },
    sessions: { list: sessionStore },
    uiSession: { pendingInteractions: pendingStore },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register: () => () => {},
    },
  }
  const config = { enabled: configRef(enabled), aggregate: configRef(true), initialSort: configRef(initialSort) }
  loadPlugin().apply(ctx, config)

  return {
    calls,
    workspaceStore,
    sessionStore,
    pendingStore,
    config,
    dispose() {
      for (const disposer of effects.splice(0).reverse()) if (typeof disposer === 'function') disposer()
    },
  }
}

/** Let the engine's SETTLE_MS debounce fire and its pass settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))

// The Host half is unreachable on purpose (see the file comment); keep its
// warning out of the test output. Diagnostics still go to `console.warn` in a
// real page.
console.warn = () => {}

test('a waiting Session lifts its Workspace and writes one insertBefore', async () => {
  const mounted = mount({ items: [workspace('b'), workspace('a')], byId: summaries([['a', 100], ['b', 300]]) })
  try {
    mounted.pendingStore.set(pending('a', 'approval'))
    await settle()
    assert.deepEqual(mounted.calls, [{ id: 'a', before: 'b' }])
    assert.deepEqual(
      mounted.workspaceStore.getSnapshot().items.map((row) => row.workspaceId),
      ['a', 'b'],
    )
  } finally {
    mounted.dispose()
  }
})

test('a pending kind outside the visible whitelist writes nothing', async () => {
  const mounted = mount({ items: [workspace('b'), workspace('a')], byId: summaries([['a', 100], ['b', 300]]) })
  try {
    mounted.pendingStore.set(pending('a', 'other'))
    await settle()
    assert.deepEqual(mounted.calls, [])
  } finally {
    mounted.dispose()
  }
})

test('a waiting Session lifts a Workspace even when no activity stamp exists', async () => {
  // The old pass() bailed out on `newest === 0`; a pending request must survive
  // that guard, because the waiting Session may never have been prompted.
  const mounted = mount({ items: [workspace('b'), workspace('a')], byId: summaries([['a', 0], ['b', 0]]) })
  try {
    mounted.pendingStore.set(pending('a', 'question'))
    await settle()
    assert.deepEqual(mounted.calls, [{ id: 'a', before: 'b' }])
  } finally {
    mounted.dispose()
  }
})

test('a live config change to enabled:false stops the engine without a reload', async () => {
  const mounted = mount({ items: [workspace('b'), workspace('a')], byId: summaries([['a', 100], ['b', 300]]) })
  try {
    mounted.config.enabled.push(false)
    mounted.pendingStore.set(pending('a', 'approval'))
    await settle()
    assert.deepEqual(mounted.calls, [])
  } finally {
    mounted.dispose()
  }
})

test('re-enabling the live config re-runs a pass', async () => {
  const mounted = mount({
    items: [workspace('b'), workspace('a')],
    byId: summaries([['a', 100], ['b', 300]]),
    enabled: false,
  })
  try {
    mounted.pendingStore.set(pending('a', 'plan-review'))
    await settle()
    assert.deepEqual(mounted.calls, [], 'disabled at mount: nothing is written')
    mounted.config.enabled.push(true)
    await settle()
    assert.deepEqual(mounted.calls, [{ id: 'a', before: 'b' }])
  } finally {
    mounted.dispose()
  }
})
