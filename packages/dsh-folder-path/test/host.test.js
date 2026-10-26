/**
 * Host-half behaviour tests: the route's HTTP contract and its clipboard-name
 * matching. Everything here is deterministic — the PowerShell clipboard probe is
 * never reached, because every case is decided (or refused) before it runs — so
 * the suite behaves the same on any machine, with any clipboard contents.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, ROUTE_PATH, matchDirectories } from '../lib/index.js'

/**
 * Mount the host half against a fake Cordis context and capture its routes.
 * @param config - the profile row's config block.
 * @returns the registered routes.
 */
function mountRoutes(config = {}) {
  const routes = []
  const host = {
    effect(factory) {
      return factory()
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  const ctx = {
    logger: { warn() {} },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback(host)
    },
  }
  apply(ctx, config)
  return routes
}

/**
 * Build a request stand-in the handler can read.
 * @param options - method, headers, raw body and peer address.
 * @returns the fake request.
 */
function makeRequest({ method = 'POST', headers = {}, body = '', remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/**
 * Build a response stand-in that records what the handler wrote.
 * @returns the fake response.
 */
function makeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
    },
    end(text) {
      state.body = text ?? ''
    },
  }
}

/**
 * Call the registered route.
 * @param options - request options.
 * @returns status, headers and parsed body.
 */
async function call(options) {
  const route = mountRoutes().find((entry) => entry.path === ROUTE_PATH)
  assert.ok(route !== undefined, 'the clipboard route is registered')
  assert.equal(route.kind, 'exact')
  const response = makeResponse()
  await route.handler(makeRequest(options), response)
  return { status: response.state.status, headers: response.state.headers, body: JSON.parse(response.state.body) }
}

test('the route is an exact POST endpoint', async () => {
  const route = mountRoutes().find((entry) => entry.path === ROUTE_PATH)
  assert.equal(route.kind, 'exact')
  assert.equal(ROUTE_PATH, '/dsh-folder-path/api/v1/clipboard-paths')
})

test('a non-POST method is refused with an Allow header', async () => {
  const result = await call({ method: 'GET' })
  assert.equal(result.status, 405)
  assert.equal(result.headers.allow, 'POST')
  assert.equal(result.body.ok, false)
})

test('a cross-origin request is refused', async () => {
  const result = await call({ headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' } })
  assert.equal(result.status, 403)
  assert.equal(result.body.reason, 'cross-origin')
})

test('a same-origin request passes the origin gate', async () => {
  // On Windows this reaches the real probe and answers 200 either way; what
  // matters is that a same-origin request is not refused.
  const result = await call({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } })
  assert.notEqual(result.status, 403)
})

test('a non-loopback peer is refused before the clipboard is touched', async () => {
  const result = await call({ remoteAddress: '198.51.100.24', body: JSON.stringify({ names: ['x'] }) })
  assert.equal(result.status, 403)
  assert.equal(result.body.reason, 'remote-not-supported')
})

test('a non-loopback peer is served when allowNonLoopback is set', async () => {
  const route = mountRoutes({ allowNonLoopback: true }).find((entry) => entry.path === ROUTE_PATH)
  const response = makeResponse()
  await route.handler(makeRequest({ remoteAddress: '198.51.100.24', body: '{}' }), response)
  assert.notEqual(response.state.status, 403)
})

test('a malformed body is a 400', async () => {
  const result = await call({ body: '{ not json' })
  assert.equal(result.status, 400)
  assert.equal(result.body.reason, 'bad-request')
})

test('enabled: false mounts no route at all', () => {
  assert.deepEqual(mountRoutes({ enabled: false }), [])
})

test('matchDirectories returns every directory when no name is requested', () => {
  const directories = [{ name: 'a', path: 'C:\\a' }, { name: 'b', path: 'C:\\b' }]
  assert.deepEqual(matchDirectories(directories, []), directories)
})

test('matchDirectories matches basenames case-insensitively and keeps clipboard order', () => {
  const directories = [{ name: 'Reports', path: 'C:\\x\\Reports' }, { name: 'data', path: 'D:\\data' }]
  assert.deepEqual(matchDirectories(directories, ['DATA']), [{ name: 'data', path: 'D:\\data' }])
  assert.deepEqual(matchDirectories(directories, ['reports', 'data']), directories)
})

test('matchDirectories answers nothing when nothing matches', () => {
  const directories = [{ name: 'Reports', path: 'C:\\x\\Reports' }]
  assert.deepEqual(matchDirectories(directories, ['Elsewhere']), [])
})
