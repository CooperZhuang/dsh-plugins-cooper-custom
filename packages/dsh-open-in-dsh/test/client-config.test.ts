/**
 * Browser-half tests for the synced config.
 *
 * `alwaysNewSession` reaches the page as a live reference in
 * `apply(ctx, config)` (`SyncedConfig<OpenInDshConfig>`), not as a value in the
 * SSE `hello` frame any more. Two mistakes are easy to make and invisible in a
 * smoke test: reading the reference once at mount, so a write made while the
 * host runs is ignored until a reload, and leaving the removed `hello` channel
 * in place as a second, staler source of truth. Both are exercised here against
 * the shipped bundle.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** The stream the bundle opened, plus the listeners it registered on it. */
class FakeEventSource {
  static instances = []

  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
    FakeEventSource.instances.push(this)
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }

  /** Deliver one frame the way the network would. */
  emit(name, data) {
    for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) })
  }

  close() {
    this.closed = true
  }
}

/**
 * Load the shipped bundle and run its factory with a module table that has no
 * React: the rendered document action is not mounted by these tests.
 * @returns the plugin exports and the fake window.
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
  const exports = registration.factory(() => ({}))
  return { exports, window: fakeWindow }
}

/**
 * Mount the plugin against a fake client context that records every Workspace
 * and Session call the open path makes.
 * @param config - the synced Config the kernel would hand `apply`.
 * @returns the recorded calls and the opened request stream.
 */
function mount(config) {
  const { exports, window } = loadBundle()
  const workspaces = []
  const created = []
  const opened = []
  const uiWorkspace = {
    openWorkspace(id) {
      opened.push({ kind: 'workspace', id })
    },
    openSession(id) {
      opened.push({ kind: 'session', id })
    },
  }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject(_services, callback) {
      callback({ get: () => uiWorkspace })
    },
    contextMenus: {
      register() {
        return () => {}
      },
      notify() {},
    },
    locale: {
      register() {},
      bind() {
        return (key) => key
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: {} }) },
      async create(options) {
        created.push(options)
        return 'session-2'
      },
    },
    workspaces: {
      async create(options) {
        workspaces.push(options)
        return { workspaceId: 'workspace-1' }
      },
    },
    slots: {
      inject(_key, callback) {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register() {
        return () => {}
      },
    },
  }
  exports.apply(ctx, config)
  const source = FakeEventSource.instances.at(-1)
  assert.ok(source !== undefined, 'apply did not open the request stream')
  return { workspaceCalls: workspaces, created, opened, source, window, exports }
}

/** Run one test with the fake EventSource installed, restoring the real one. */
async function withBrowser(run) {
  const original = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  try {
    return await run()
  } finally {
    if (original === undefined) delete globalThis.EventSource
    else globalThis.EventSource = original
  }
}

/** Let one open request's promise chain settle. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Announce one folder through the stream, as the Host would.
 * @param source - the mounted EventSource.
 * @param seq - the request sequence.
 * @param path - the announced directory.
 */
async function announce(source, seq, path) {
  source.emit('request', { seq, path })
  await settle()
}

test('a false synced value reuses the Workspace, as the Host default says', async () => {
  await withBrowser(async () => {
    const mounted = mount({ alwaysNewSession: { get: () => false } })
    await announce(mounted.source, 1, '/work')

    assert.deepEqual(mounted.workspaceCalls, [{ path: '/work' }])
    assert.deepEqual(mounted.created, [])
    assert.deepEqual(mounted.opened, [{ kind: 'workspace', id: 'workspace-1' }])
  })
})

test('a true synced value lands in a fresh blank Session', async () => {
  await withBrowser(async () => {
    const mounted = mount({ alwaysNewSession: { get: () => true } })
    await announce(mounted.source, 1, '/work')

    assert.deepEqual(mounted.created, [{ workspaceId: 'workspace-1' }])
    assert.deepEqual(mounted.opened, [{ kind: 'session', id: 'session-2' }])
  })
})

test('a write made while the plugin is mounted is read by the next request', async () => {
  await withBrowser(async () => {
    let value = false
    const mounted = mount({ alwaysNewSession: { get: () => value } })

    await announce(mounted.source, 1, '/work')
    assert.deepEqual(mounted.opened, [{ kind: 'workspace', id: 'workspace-1' }])

    // The kernel commits a config write into the reference in place and does
    // not remount the plugin; the next open must see the new value.
    value = true
    await announce(mounted.source, 2, '/work')
    assert.deepEqual(mounted.opened, [
      { kind: 'workspace', id: 'workspace-1' },
      { kind: 'session', id: 'session-2' },
    ])
    assert.deepEqual(mounted.created, [{ workspaceId: 'workspace-1' }])
  })
})

test('a composition without the synced field falls back to the shipped default', async () => {
  await withBrowser(async () => {
    const mounted = mount(undefined)
    await announce(mounted.source, 1, '/work')

    // Absent means the schema default: reuse the Workspace's blank Session.
    assert.deepEqual(mounted.created, [])
    assert.deepEqual(mounted.opened, [{ kind: 'workspace', id: 'workspace-1' }])
  })
})

test('the removed hello settings channel cannot override the live reference', async () => {
  await withBrowser(async () => {
    const mounted = mount({ alwaysNewSession: { get: () => false } })
    mounted.source.emit('hello', { seq: 0, settings: { alwaysNewSession: true } })
    await announce(mounted.source, 1, '/work')

    assert.deepEqual(mounted.created, [])
    assert.deepEqual(mounted.opened, [{ kind: 'workspace', id: 'workspace-1' }])
  })
})
