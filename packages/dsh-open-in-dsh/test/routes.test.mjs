/**
 * Route-level integration test for the host half.
 *
 * The unit tests cover the sequence bookkeeping; this covers the part they
 * cannot: that `apply` actually registers all three routes, and that the
 * handlers answer real HTTP requests with the shapes the launcher and the page
 * depend on.
 *
 * It exists because a running `dsh web` keeps the JavaScript module it already
 * imported — editing `lib/index.js` and reloading the patch layer re-runs
 * `apply` from that cached module. So a change to the host half can only be
 * verified before a restart by mounting it somewhere else, which is what this
 * does: a real `node:http` server, the real handlers, real requests.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, Config, ROUTE_EVENTS, ROUTE_OPEN, ROUTE_STATUS } from '../lib/index.js'

/**
 * Mount the plugin the way the Host does, and serve its routes for real.
 * @param config - the profile row's config block.
 * @returns the listening base URL and a disposer.
 */
async function mount(config = {}) {
  const routes = []
  const ctx = {
    logger: { info() {}, debug() {}, warn() {} },
    // `apply` acquires `webServer` through `ctx.inject`; hand it the effect
    // registration and route table it expects, and keep the disposers so the
    // test can exercise teardown.
    inject(_services, callback) {
      callback({
        effect(fn) {
          const disposer = fn()
          if (typeof disposer === 'function') routes.disposers.push(disposer)
        },
        webServer: {
          register(route) {
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        },
      })
    },
  }
  routes.disposers = []

  apply(ctx, config)

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const route = routes.find((entry) => entry.path === pathname)
    if (route === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    route.handler(request, response)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    routes,
    async close() {
      for (const dispose of routes.disposers) dispose()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * POST one folder path.
 * @param base - the mounted base URL.
 * @param body - the JSON body.
 * @param headers - extra request headers.
 * @returns the status and parsed body.
 */
async function postOpen(base, body, headers = {}) {
  const response = await fetch(`${base}${ROUTE_OPEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

test('apply registers the open, events and status routes', async () => {
  const mounted = await mount()
  try {
    const paths = mounted.routes.map((route) => route.path).sort()
    assert.deepEqual(paths, [ROUTE_EVENTS, ROUTE_OPEN, ROUTE_STATUS].sort())
    for (const route of mounted.routes) assert.equal(route.kind, 'exact')
  } finally {
    await mounted.close()
  }
})

test('a real folder is accepted and reported with the launcher signal', async () => {
  const mounted = await mount()
  try {
    const folder = mkdtempSync(join(tmpdir(), 'dsh-open-in-route-'))
    const result = await postOpen(mounted.base, { path: folder })

    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.path, folder)
    assert.equal(result.body.seq, 1)
    // No page has ever followed, so this is a real cold start: the launcher
    // must open a window rather than wait for a page that is not coming.
    assert.equal(result.body.clients, 0)
    assert.equal(result.body.recent, false)
  } finally {
    await mounted.close()
  }
})

test('a file or a missing path is refused without publishing a request', async () => {
  const mounted = await mount()
  try {
    const folder = mkdtempSync(join(tmpdir(), 'dsh-open-in-route-'))
    const missing = join(folder, 'nope')

    const absent = await postOpen(mounted.base, { path: missing })
    assert.equal(absent.body.reason, 'not-a-directory')

    // A refusal must not consume a sequence number: the page keys its
    // de-duplication on it, and a hole would be harmless but a phantom request
    // would open a folder nobody named.
    const real = await postOpen(mounted.base, { path: folder })
    assert.equal(real.body.seq, 1)
  } finally {
    await mounted.close()
  }
})

test('a cross-origin caller is refused even from loopback', async () => {
  const mounted = await mount()
  try {
    const result = await postOpen(mounted.base, { path: tmpdir() }, { origin: 'http://evil.test' })
    assert.equal(result.status, 403)
    assert.equal(result.body.reason, 'cross-origin')
  } finally {
    await mounted.close()
  }
})

test('status reports the follower count without announcing anything', async () => {
  const mounted = await mount()
  try {
    const response = await fetch(`${mounted.base}${ROUTE_STATUS}`)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body, { ok: true, clients: 0, seq: 0, recent: false })
  } finally {
    await mounted.close()
  }
})

test('the event stream greets a new page and replays what it missed', async () => {
  const mounted = await mount()
  try {
    const folder = mkdtempSync(join(tmpdir(), 'dsh-open-in-route-'))
    await postOpen(mounted.base, { path: folder })

    // `since=0` is a page that has handled nothing: it must be handed the
    // request that arrived while it was not open.
    const controller = new AbortController()
    const response = await fetch(`${mounted.base}${ROUTE_EVENTS}?since=0`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('event: request')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }

    assert.match(text, /event: hello\ndata: \{"seq":1,"settings":\{"alwaysNewSession":false\}\}/)
    assert.match(text, /event: request\ndata: \{"seq":1,/)
    assert.match(text, new RegExp(`"path":"${folder.replace(/\\/g, '\\\\\\\\')}"`))

    controller.abort()
  } finally {
    await mounted.close()
  }
})

test('alwaysNewSession is reported to the page from the config', async () => {
  const mounted = await mount({ alwaysNewSession: false })
  try {
    const controller = new AbortController()
    const response = await fetch(`${mounted.base}${ROUTE_EVENTS}?since=0`, { signal: controller.signal })
    const { value } = await response.body.getReader().read()
    assert.match(new TextDecoder().decode(value), /"settings":\{"alwaysNewSession":false\}/)
    controller.abort()
  } finally {
    await mounted.close()
  }
})

test('a disabled plugin registers nothing', async () => {
  const mounted = await mount({ enabled: false })
  try {
    assert.equal(mounted.routes.length, 0)
  } finally {
    await mounted.close()
  }
})

test('the Config schema supplies the shipped defaults for a partial row', () => {
  // This schema is what puts a card in 设置 → 插件; without it the switches exist
  // but are only reachable by hand-editing YAML.
  const defaults = Config({})
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.alwaysNewSession, false)
  assert.equal(defaults.allowNonLoopback, false)
  assert.equal(defaults.backlogTtlMs, 60_000)

  // Toggling one switch must not silently reset the others.
  const partial = Config({ alwaysNewSession: true })
  assert.equal(partial.alwaysNewSession, true)
  assert.equal(partial.allowNonLoopback, false)
  assert.equal(partial.backlogTtlMs, 60_000)
})
