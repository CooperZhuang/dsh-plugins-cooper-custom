/**
 * Browser-half tests for the context-menu contributions.
 *
 * The shipped bundle is executed the way the DSH client executes it - a classic
 * script that registers a lazy factory on window.__ModuleLoader__ - so these
 * tests cover the real artifact, not a copy of the source. The Host is faked at
 * fetch level: availability answers and launches go through the same two routes
 * the bundle calls.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ROUTE_APPS, ROUTE_OPEN_WITH } from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/**
 * Load the shipped bundle and run its factory.
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
  // A parameter named 'window' supplies the browser global; nothing global is
  // touched, and the factory closes over the same object.
  new Function('window', bundle)(fakeWindow)
  assert.ok(registration !== null, 'lib/client.js did not register a module')
  return { id: registration.id, exports: registration.factory(() => ({})) }
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
 * Serve the Host's two routes: availability, then the launch.
 * @param apps - allowlisted ids the Host reports.
 * @param launches - records every open-with POST.
 * @param launchResponse - optional response override for the launch.
 * @returns the fetch stand-in.
 */
function hostFetch(apps, launches, launchResponse) {
  return async (url, init) => {
    if (url === ROUTE_APPS) return jsonResponse({ ok: true, platform: 'darwin', apps })
    if (url === ROUTE_OPEN_WITH) {
      launches.push({ url, init })
      return launchResponse === undefined ? jsonResponse({ ok: true, app: 'qspace', path: '/work/a.md' }) : launchResponse
    }
    throw new Error('unexpected fetch ' + String(url))
  }
}

/**
 * Mount the plugin against a fake client context.
 * @param options - Session table override.
 * @returns the registered contributions, dictionaries, exports and window.
 */
function mount(options = {}) {
  const { id, exports } = loadBundle()
  const contributions = []
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
      notify() {},
    },
    locale: {
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
  }
  exports.apply(ctx)
  return { id, exports, contributions, dictionaries, sessions }
}

/**
 * Mount inside the fake browser environment; the plugin opens its SSE stream
 * during apply, so EventSource must exist before that call.
 * @param options - mount options.
 * @param fetchImpl - fetch stand-in.
 * @param run - body receiving the mounted context.
 */
async function withMounted(options, fetchImpl, run) {
  return withBrowser(fetchImpl, async () => run(mount(options)))
}

/** Find one registered contribution by target family. */
function contribution(contributions, target) {
  const found = contributions.find((entry) => entry.target === target)
  assert.ok(found, 'no contribution for target ' + target)
  return found
}

test('the bundle loads and exports a plugin that injects the menu services', () => {
  const { id, exports } = loadBundle()
  assert.equal(id, 'dsh-open-in-dsh')
  assert.equal(typeof exports.apply, 'function')
  for (const service of ['workspaces', 'sessions', 'contextMenus', 'locale']) {
    assert.ok(exports.inject.includes(service), 'plugin does not inject ' + service)
  }
  assert.ok(exports.__internals, 'no test surface exported')
})

test('apply contributes one menu per target family and registers the labels', async () => {
  await withMounted({}, hostFetch([], []), (mounted) => {
    assert.deepEqual(
      mounted.contributions.map((entry) => entry.target + ':' + entry.id).sort(),
      ['directory:open-with.directory', 'file:open-with.file'],
    )
    for (const entry of mounted.contributions) assert.equal(entry.order, 200)

    const dictionaries = mounted.dictionaries['dsh-open-in-dsh']
    assert.equal(dictionaries.zh['menu.qspace'], '用 QSpace Pro 打开')
    assert.equal(dictionaries.zh['menu.finder'], '在 Finder 中显示')
    assert.equal(dictionaries.zh['menu.vscode'], '用 VS Code 打开')
    assert.equal(dictionaries.zh['menu.warp'], '用 Warp 打开')
    assert.equal(dictionaries.zh['menu.terminal'], '在终端中打开')
    assert.equal(dictionaries.zh['menu.explorer'], '在资源管理器中显示')
    assert.equal(dictionaries.zh['menu.failed'], '无法打开，请重试')
    assert.equal(dictionaries.en['menu.qspace'], 'Open in QSpace Pro')
  })
})

test('a file target resolves the macOS apps the Host reported, and runs one', async () => {
  const launches = []
  await withMounted({}, hostFetch(['qspace', 'finder', 'vscode', 'warp', 'terminal'], launches), async (mounted) => {
    const file = contribution(mounted.contributions, 'file')
    const actions = await file.resolve({ sessionId: 's1', path: 'docs/a.md' }, new AbortController().signal)
    assert.deepEqual(actions.map((action) => action.id), [
      'open-with.qspace',
      'open-with.finder',
      'open-with.vscode',
      'open-with.warp',
      'open-with.terminal',
    ])
    assert.deepEqual(actions.map((action) => action.label), [
      '用 QSpace Pro 打开',
      '在 Finder 中显示',
      '用 VS Code 打开',
      '用 Warp 打开',
      '在终端中打开',
    ])
    assert.equal(actions[0].failureLabel, '无法打开，请重试')

    await actions[0].run()
    assert.equal(launches.length, 1)
    assert.equal(launches[0].url, ROUTE_OPEN_WITH)
    assert.equal(launches[0].init.method, 'POST')
    // The relative target became an absolute path the Host can validate.
    assert.deepEqual(JSON.parse(launches[0].init.body), { path: '/work/docs/a.md', app: 'qspace' })
  })
})

test('a directory target uses the same catalog and an absolute path passes through', async () => {
  const launches = []
  await withMounted({}, hostFetch(['qspace', 'finder', 'terminal'], launches), async (mounted) => {
    const directory = contribution(mounted.contributions, 'directory')
    const actions = await directory.resolve({ sessionId: 's1', path: '/abs/docs' }, new AbortController().signal)
    assert.deepEqual(actions.map((action) => action.id), ['open-with.qspace', 'open-with.finder', 'open-with.terminal'])
    await actions[1].run()
    assert.deepEqual(JSON.parse(launches[0].init.body), { path: '/abs/docs', app: 'finder' })
  })
})

test('Windows reports Explorer, and only reported apps become actions', async () => {
  const fetchImpl = async (url) => {
    if (url === ROUTE_APPS) return jsonResponse({ ok: true, platform: 'win32', apps: ['explorer', 'rm', 'qspace'] })
    throw new Error('unexpected fetch ' + String(url))
  }
  await withMounted({}, fetchImpl, async (mounted) => {
    const file = contribution(mounted.contributions, 'file')
    const actions = await file.resolve({ sessionId: 's1', path: 'docs/a.md' }, new AbortController().signal)
    // Unknown ids are dropped; order follows the plugin's own catalog.
    assert.deepEqual(actions.map((action) => action.id), ['open-with.qspace', 'open-with.explorer'])
    assert.deepEqual(actions.map((action) => action.label), ['用 QSpace Pro 打开', '在资源管理器中显示'])
  })
})

test('nothing is offered when the path cannot be resolved or the Host has no apps', async () => {
  let fetches = 0
  const fetchImpl = async (url) => {
    fetches += 1
    if (url === ROUTE_APPS) return jsonResponse({ ok: true, platform: 'darwin', apps: [] })
    throw new Error('unexpected fetch ' + String(url))
  }
  await withMounted({ sessions: { s1: { cwd: '' } } }, fetchImpl, async (mounted) => {
    const directory = contribution(mounted.contributions, 'directory')
    const unresolved = await directory.resolve({ sessionId: 's1', path: 'docs' }, new AbortController().signal)
    assert.deepEqual(unresolved, [])
    // No cwd was needed for that answer, so the availability route was never asked.
    assert.equal(fetches, 0)

    const empty = await directory.resolve({ sessionId: 's1', path: '/abs/docs' }, new AbortController().signal)
    assert.deepEqual(empty, [])
    assert.equal(fetches, 1)
  })
})

test('a lost availability request is retried on the next opening', async () => {
  let attempts = 0
  const fetchImpl = async (url) => {
    if (url !== ROUTE_APPS) throw new Error('unexpected fetch ' + String(url))
    attempts += 1
    if (attempts === 1) throw new Error('host is not up yet')
    return jsonResponse({ ok: true, platform: 'darwin', apps: ['qspace', 'finder'] })
  }
  await withMounted({}, fetchImpl, async (mounted) => {
    const file = contribution(mounted.contributions, 'file')
    assert.deepEqual(await file.resolve({ sessionId: 's1', path: 'a.md' }, new AbortController().signal), [])
    const actions = await file.resolve({ sessionId: 's1', path: 'a.md' }, new AbortController().signal)
    assert.deepEqual(actions.map((action) => action.id), ['open-with.qspace', 'open-with.finder'])
    assert.equal(attempts, 2)
  })
})

test('a refused launch rejects so the menu can show the failure toast', async () => {
  await withMounted({}, hostFetch(['qspace'], [], jsonResponse({ ok: false, reason: 'path-not-found' }, 400)), async (mounted) => {
    const file = contribution(mounted.contributions, 'file')
    const actions = await file.resolve({ sessionId: 's1', path: 'a.md' }, new AbortController().signal)
    assert.equal(actions.length, 1)
    await assert.rejects(actions[0].run(), /path-not-found/)
  })
})

test('an aborted menu preparation produces no actions', async () => {
  await withMounted({}, hostFetch(['qspace'], []), async (mounted) => {
    const file = contribution(mounted.contributions, 'file')
    const controller = new AbortController()
    controller.abort()
    assert.deepEqual(await file.resolve({ sessionId: 's1', path: 'a.md' }, controller.signal), [])
  })
})

test('path helpers accept the spellings the Host accepts', () => {
  const internals = loadBundle().exports.__internals
  assert.equal(internals.isAbsolutePath('/a/b'), true)
  assert.equal(internals.isAbsolutePath('C:\\a\\b'), true)
  assert.equal(internals.isAbsolutePath('\\\\server\\share'), true)
  assert.equal(internals.isAbsolutePath('a/b'), false)

  assert.equal(internals.resolveWorkspacePath('/work', 'docs/a.md'), '/work/docs/a.md')
  assert.equal(internals.resolveWorkspacePath('/work/', './docs/a.md'), '/work/docs/a.md')
  assert.equal(internals.resolveWorkspacePath('C:\\work', 'docs\\a.md'), 'C:\\work\\docs\\a.md')
  assert.equal(internals.resolveWorkspacePath('/abs/x', '/abs/x'), '/abs/x')
  assert.equal(internals.resolveWorkspacePath(undefined, 'docs'), null)

  assert.deepEqual(internals.appIdsFrom({ apps: ['rm', 'warp', 'qspace'] }), ['qspace', 'warp'])
  assert.deepEqual(internals.appIdsFrom(null), [])
})
