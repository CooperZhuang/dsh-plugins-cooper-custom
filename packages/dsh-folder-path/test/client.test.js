/**
 * Browser-half contract tests: the shape the DSH client module system expects
 * from a client bundle, and the browser plugin's use of the Cordis context.
 *
 * The kernel executes a client bundle as a plain classic script that only
 * REGISTERS a lazy CJS factory through `window.__ModuleLoader__.load({ id,
 * factory })`; the id must be the package name and the factory must
 * materialize the plugin's exports on first import. The host half's HTTP
 * contract is covered by `host.test.js`; this file pins the browser side of
 * the same contract — without a browser, and without any dependency.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { ROUTE_PATH } from '../lib/index.js'

/** The bundle the kernel serves; `scripts/build-client.mjs` writes it. */
const BUNDLE_URL = new URL('../lib/client.js', import.meta.url)

/** The registration id the kernel expects: the package name, never the row id. */
const PACKAGE_ID = 'dsh-folder-path'

/**
 * Evaluate the client bundle against a fake page.
 *
 * @returns the registrations it submitted, the listeners it mounted, and the
 *   fake `window` the plugin installed its debugging hook on.
 */
function loadBundle() {
  const registrations = []
  const listeners = []
  const document = {
    addEventListener(type, handler, capture) {
      listeners.push({ type, handler, capture })
    },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler)
      if (index >= 0) listeners.splice(index, 1)
    },
  }
  const window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  }
  const source = readFileSync(BUNDLE_URL, 'utf8')
  // The bundle is a classic script: it runs in the page's global scope, where
  // `window` and `document` are the only page objects it touches at load time.
  new Function('window', 'document', source)(window, document)
  return { registrations, listeners, window }
}

/**
 * Build a browser Cordis context stand-in that records effects.
 *
 * @returns the context, the recorded effects, and a teardown that runs their
 *   disposers — the same lifecycle the kernel drives when it unloads a fiber.
 */
function makeContext() {
  const effects = []
  return {
    ctx: {
      effect(factory, label) {
        const disposer = factory()
        effects.push({ label, disposer })
        return disposer
      },
    },
    effects,
    dispose() {
      for (const effect of effects.splice(0).reverse()) effect.disposer()
    },
  }
}

/**
 * Materialize the browser half and mount it on a stand-in context.
 *
 * @returns the mounted state: the listeners, the recorded effects and the
 *   teardown that unmounts them.
 */
function mountPlugin() {
  const { registrations, listeners, window } = loadBundle()
  const context = makeContext()
  const exports = registrations[0].factory(() => {})
  exports.apply(context.ctx)
  return { listeners, window, context }
}

test('the bundle registers exactly one factory under the package name', () => {
  const { registrations } = loadBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, PACKAGE_ID)
  assert.equal(typeof registrations[0].factory, 'function')
})

test('the factory materializes a module whose exports carry apply()', () => {
  const { registrations } = loadBundle()
  const exports = registrations[0].factory(() => {
    throw new Error('the browser half must not require other client modules')
  })
  assert.equal(typeof exports.apply, 'function')
  assert.equal(Object.prototype.toString.call(exports), '[object Module]')
})

test('the browser plugin mounts one capture-phase paste listener', () => {
  const { listeners } = mountPlugin()
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].type, 'paste')
  // The capture phase is the whole point: the composer must not see the
  // folder paste before the plugin takes it over.
  assert.equal(listeners[0].capture, true)
})

test('the paste listener is removed when the plugin is disposed', () => {
  const { listeners, context } = mountPlugin()
  assert.equal(listeners.length, 1)
  context.dispose()
  assert.equal(listeners.length, 0)
})

test('the client half mirrors the host route path', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const declared = /ROUTE_PATH\s*=\s*'([^']+)'/.exec(source)
  assert.ok(declared !== null, 'the browser half declares its route path')
  assert.equal(declared[1], ROUTE_PATH)
})

test('the browser half installs its troubleshooting hook', () => {
  const { window } = mountPlugin()
  const hook = window.__dshFolderPath
  assert.ok(hook !== undefined, 'the hook is installed on the page window')
  assert.equal(hook.route, ROUTE_PATH)
  assert.equal(typeof hook.probe, 'function')
  assert.equal(typeof hook.insert, 'function')
  assert.equal(typeof hook.classify, 'function')
})
