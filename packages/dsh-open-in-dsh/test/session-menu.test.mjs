/**
 * Browser-half tests for the three Session-scoped entries.
 *
 * The shipped bundle is executed the way the DSH client executes it — a classic
 * script registering a lazy factory — so these cover the artifact, not a copy
 * of the source. The slot contract is asserted from the registrations
 * themselves (name / id / order / inject), and the components are called with
 * the props those slots actually pass: `absolutePath` for the document header,
 * `sessionId` for the Conversation header.
 *
 * The Host is faked at fetch level, so what these tests can catch is the part
 * that would fail silently in the UI: a button wired to the wrong route, a
 * session entry that guesses a cwd, a failure that shows no toast.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ROUTE_APPS, ROUTE_OPEN_SESSION, ROUTE_OPEN_WITH } from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** The slot names this backport has to land on, exactly as the Host declares them. */
const DOCUMENT_SLOT = 'sidebar.right.tab.document.actions'
const HEADER_SLOT = 'conversation.session.header.actions'

/** The seed React the bundle is allowed to reach through the module table. */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
  }
}

/**
 * Load the shipped bundle and run its factory with a module table that answers
 * only 'react'.
 * @returns the module id and exports.
 */
function loadBundle() {
  let registration = null
  const fakeWindow = {
    sessionStorage: { getItem: () => null, setItem() {} },
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
    focus() {},
  }
  new Function('window', bundle)(fakeWindow)
  assert.ok(registration !== null, 'lib/client.js did not register a module')
  const exports = registration.factory((id) => {
    if (id === 'react') return fakeReact()
    return {}
  })
  return { id: registration.id, exports, window: fakeWindow }
}

/**
 * Mount the plugin against a fake client context that records every
 * contribution.
 * @param options - Session table override.
 * @returns the recorded registrations and the bound translate seat.
 */
function mount(options = {}) {
  const { id, exports, window } = loadBundle()
  const contributions = []
  const slots = []
  const notices = []
  const dictionaries = {}
  const sessions = options.sessions ?? { s1: { cwd: '/work' } }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject(_services, callback) {
      callback({ get: () => null })
    },
    contextMenus: {
      register(spec) {
        contributions.push(spec)
        return () => {}
      },
      notify(text) {
        notices.push(text)
      },
    },
    locale: {
      // The real locale service is a snapshot store as well as a dictionary
      // face; menu providers observe it so labels follow a language switch.
      getSnapshot: () => ({ language: 'zh', revision: 0 }),
      subscribe: () => () => {},
      register(ns, dicts) {
        dictionaries[ns] = dicts
      },
      bind(ns) {
        return (key) => dictionaries[ns]?.zh?.[key] ?? key
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: sessions }) },
      create: async () => 'session-2',
    },
    workspaces: { create: async () => ({ workspaceId: 'workspace-1' }) },
    slots: {
      inject(_key, callback) {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register(meta, component) {
        slots.push({ ...meta, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  return { id, exports, window, contributions, slots, notices, dictionaries, sessions }
}

/** A JSON response the bundle can consume. */
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/**
 * Run one test with a fake EventSource and a fake fetch, restoring both after.
 * @param fetchImpl - the fetch stand-in.
 * @param run - the test body.
 * @returns the body's result.
 */
async function withBrowser(fetchImpl, run) {
  const originalFetch = globalThis.fetch
  const originalEventSource = globalThis.EventSource
  globalThis.fetch = fetchImpl
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url
    }
    addEventListener() {}
    close() {}
  }
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
    if (originalEventSource === undefined) delete globalThis.EventSource
    else globalThis.EventSource = originalEventSource
  }
}

/**
 * Serve the Host's routes: availability, the path launch, the session launch.
 * @param apps - allowlisted ids the Host reports.
 * @param calls - records every POST.
 * @param overrides - optional per-route response override.
 * @returns the fetch stand-in.
 */
function hostFetch(apps, calls, overrides = {}) {
  return async (url, init) => {
    if (url === ROUTE_APPS) return overrides[ROUTE_APPS] ?? jsonResponse({ ok: true, platform: 'darwin', apps })
    if (url === ROUTE_OPEN_WITH || url === ROUTE_OPEN_SESSION) {
      calls.push({ url, init })
      return overrides[url] ?? jsonResponse({ ok: true, app: 'qspace', path: '/work' })
    }
    throw new Error('unexpected fetch ' + String(url))
  }
}

/** Find a registered context-menu contribution by target. */
function contribution(contributions, target) {
  const found = contributions.find((entry) => entry.target === target)
  assert.ok(found, 'no contribution for target ' + target)
  return found
}

/** Find a registered slot entry by slot name. */
function slotRegistration(slots, name) {
  const found = slots.find((entry) => entry.name === name)
  assert.ok(found, 'no slot registration for ' + name)
  return found
}

/** Let the click's promise chain settle. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('the three entries register on the contracts the Host declares', async () => {
  await withBrowser(hostFetch([], []), () => {
  const mounted = mount()

  // Left sidebar Session row menu: the target value is {sessionId, displayTitle}.
  const session = contribution(mounted.contributions, 'session')
  assert.equal(session.id, 'open-with.session')
  assert.equal(typeof session.resolve, 'function')
  assert.equal(typeof session.order, 'number')

  // Right-side document preview header: a list slot, so the id is required.
  const document = slotRegistration(mounted.slots, DOCUMENT_SLOT)
  assert.equal(document.id, 'open-with.qspace')
  assert.equal(typeof document.component, 'function')
  assert.equal(typeof document.order, 'number')
  assert.equal(document.locale, 'dsh-open-in-dsh')

  // Conversation header: a list slot on the session scope.
  const header = slotRegistration(mounted.slots, HEADER_SLOT)
  assert.equal(header.id, 'open-with.qspace')
  assert.equal(typeof header.component, 'function')

  // Both rendered entries take QSpace availability as an injected hook, not a
  // fetch of their own.
  for (const entry of [document, header]) {
    const injected = entry.inject()
    assert.equal(typeof injected.hooks.qspaceAvailable.getSnapshot, 'function')
    assert.equal(typeof injected.hooks.qspaceAvailable.subscribe, 'function')
  }

  // The plugin now depends on the slot service; without it apply would throw.
  assert.ok(mounted.exports.inject.includes('slots'))
  })
})

test('the document entry opens the file\'s directory, not the file', async () => {
  const calls = []
  await withBrowser(hostFetch(['qspace', 'finder'], calls), async () => {
    const mounted = mount()
    const action = slotRegistration(mounted.slots, DOCUMENT_SLOT).component
    const t = (key) => mounted.dictionaries['dsh-open-in-dsh'].zh[key] ?? key

    const element = action({ absolutePath: '/work/docs/a.md', t, useQspaceAvailable: () => true })
    assert.equal(element.type, 'button')
    assert.deepEqual(element.children, ['用 QSpace 打开所在目录'])
    assert.equal(element.props.title, '/work/docs')
    assert.equal(element.props['aria-label'], '用 QSpace 打开所在目录')

    element.props.onClick()
    await settle()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, ROUTE_OPEN_WITH)
    assert.equal(calls[0].init.method, 'POST')
    // The Host would run the file if it were sent; the folder is the target.
    assert.deepEqual(JSON.parse(calls[0].init.body), { path: '/work/docs', app: 'qspace' })
  })
})

test('the Conversation header opens the session, never a guessed path', async () => {
  const calls = []
  await withBrowser(hostFetch(['qspace'], calls), async () => {
    const mounted = mount()
    const action = slotRegistration(mounted.slots, HEADER_SLOT).component
    const t = (key) => mounted.dictionaries['dsh-open-in-dsh'].zh[key] ?? key

    const element = action({ sessionId: 's1', t, useQspaceAvailable: () => true })
    assert.equal(element.type, 'button')
    assert.deepEqual(element.children, ['QSpace 打开'])
    assert.equal(element.props.title, '用 QSpace 打开工作目录')

    element.props.onClick()
    await settle()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, ROUTE_OPEN_SESSION)
    assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 's1', app: 'qspace' })
  })
})

test('a refused launch raises the localized failure toast', async () => {
  const calls = []
  const overrides = {
    [ROUTE_OPEN_SESSION]: jsonResponse({ ok: false, reason: 'session-cwd-not-found' }, 404),
    [ROUTE_OPEN_WITH]: jsonResponse({ ok: false, reason: 'path-not-found' }, 400),
  }
  await withBrowser(hostFetch(['qspace'], calls, overrides), async () => {
    const mounted = mount()
    const t = (key) => mounted.dictionaries['dsh-open-in-dsh'].zh[key] ?? key
    const header = slotRegistration(mounted.slots, HEADER_SLOT).component({ sessionId: 's1', t, useQspaceAvailable: () => true })
    const document = slotRegistration(mounted.slots, DOCUMENT_SLOT).component({
      absolutePath: '/work/docs/a.md',
      t,
      useQspaceAvailable: () => true,
    })

    header.props.onClick()
    await settle()
    document.props.onClick()
    await settle()

    assert.equal(calls.length, 2)
    assert.deepEqual(mounted.notices, ['无法打开，请重试', '无法打开，请重试'])
  })
})

test('nothing renders when QSpace cannot be launched or the target is unknown', async () => {
  await withBrowser(hostFetch([], []), async () => {
    const mounted = mount()
    const t = (key) => mounted.dictionaries['dsh-open-in-dsh'].zh[key] ?? key
    const document = slotRegistration(mounted.slots, DOCUMENT_SLOT).component
    const header = slotRegistration(mounted.slots, HEADER_SLOT).component

    assert.equal(document({ absolutePath: '/work/a.md', t, useQspaceAvailable: () => false }), null)
    assert.equal(header({ sessionId: 's1', t, useQspaceAvailable: () => false }), null)
    // No path reported by the preview, and no session on the header scope.
    assert.equal(document({ absolutePath: undefined, t, useQspaceAvailable: () => true }), null)
    assert.equal(header({ t, useQspaceAvailable: () => true }), null)
  })
})

test('the Session row menu offers the action only when it can work', async () => {
  const calls = []
  await withBrowser(hostFetch(['qspace', 'finder'], calls), async () => {
    const mounted = mount()
    const menu = contribution(mounted.contributions, 'session')

    const actions = await menu.resolve({ sessionId: 's1', displayTitle: 'Project' }, new AbortController().signal)
    assert.deepEqual(actions.map((action) => action.id), ['qspace'])
    assert.equal(actions[0].label, '用 QSpace 打开工作目录')
    assert.equal(actions[0].failureLabel, '无法打开，请重试')
    assert.equal(actions[0].disabled, undefined)

    actions[0].run()
    await settle()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, ROUTE_OPEN_SESSION)
    assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 's1', app: 'qspace' })

    // A Session the Client knows no cwd for keeps the row, disabled with the
    // reason: a vanishing item reads as a broken menu.
    const unknown = await menu.resolve({ sessionId: 'missing', displayTitle: 'Gone' }, new AbortController().signal)
    assert.deepEqual(unknown, [{ id: 'qspace', label: '会话没有工作目录', disabled: true }])
    // No session id at all is not this menu's business.
    assert.deepEqual(await menu.resolve({ displayTitle: 'No id' }, new AbortController().signal), [])
  })
})

test('the Session row menu disappears where QSpace is not reported', async () => {
  const calls = []
  await withBrowser(hostFetch(['finder', 'terminal'], calls), async () => {
    const mounted = mount()
    const menu = contribution(mounted.contributions, 'session')
    assert.deepEqual(await menu.resolve({ sessionId: 's1', displayTitle: 'Project' }, new AbortController().signal), [])
  })
  // An aborted preparation produces nothing, even with QSpace available.
  await withBrowser(hostFetch(['qspace'], calls), async () => {
    const mounted = mount()
    const menu = contribution(mounted.contributions, 'session')
    const controller = new AbortController()
    controller.abort()
    assert.deepEqual(await menu.resolve({ sessionId: 's1', displayTitle: 'Project' }, controller.signal), [])
  })
})

test('the menu observes the Session list and the locale, so a stale disabled row heals', async () => {
  await withBrowser(hostFetch([], []), () => {
    const mounted = mount()
    const menu = contribution(mounted.contributions, 'session')
    const sources = menu.observe({ sessionId: 's1', displayTitle: 'Project' })
    assert.equal(sources.length, 2)
    for (const source of sources) assert.equal(typeof source.getSnapshot, 'function')
  })
})

test('parentDirectory handles both path spellings and the root edges', () => {
  const internals = loadBundle().exports.__internals
  assert.equal(internals.parentDirectory('/work/docs/a.md'), '/work/docs')
  assert.equal(internals.parentDirectory('/work/docs/sub/'), '/work/docs')
  assert.equal(internals.parentDirectory('/a.md'), '/')
  assert.equal(internals.parentDirectory('C:\\work\\a.md'), 'C:\\work')
  assert.equal(internals.parentDirectory('C:\\a.md'), 'C:\\')
  assert.equal(internals.parentDirectory('a.md'), null)
  assert.equal(internals.parentDirectory(''), null)
  assert.equal(internals.parentDirectory(undefined), null)
})
