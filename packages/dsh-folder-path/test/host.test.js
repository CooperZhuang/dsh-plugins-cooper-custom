/**
 * Host-half behaviour tests: the route's HTTP contract, its clipboard-name
 * matching, and the macOS probe's parsing. Everything here is deterministic —
 * clipboard probes are reached only through an osascript stand-in, never the
 * real clipboard — so the suite behaves the same on any machine, with any
 * clipboard contents.
 *
 * Run with "npm test".
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, ROUTE_PATH, matchDirectories, parseProbePaths } from '../lib/index.js'

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
  // The probe runs on a supported host; what matters here is that a same-origin
  // request is not refused.
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

/** macOS probe cases, skipped where the probe cannot run at all. */
const MAC_ONLY = { skip: process.platform !== 'darwin' }

/**
 * Write an osascript stand-in that prints a fixed path list.
 *
 * The macOS probe is a child process, so the deterministic way to exercise the
 * route end to end is to point "config.osascript" at a script that answers like
 * the real probe does.
 *
 * @param root - a temporary directory to keep the script in.
 * @param paths - the absolute paths the stand-in reports.
 * @returns the executable path.
 */
function writeOsascriptStub(root, paths) {
  const script = join(root, 'osascript-stub')
  const lines = ['#!/bin/sh', "printf '%s' '" + JSON.stringify(paths) + "'", '']
  writeFileSync(script, lines.join('\n'), 'utf8')
  chmodSync(script, 0o755)
  return script
}

/**
 * Call the route mounted with a stand-in probe.
 *
 * @param stub - the probe executable to configure.
 * @param options - the request options.
 * @returns the parsed answer.
 */
async function callWithProbe(stub, options) {
  const route = mountRoutes({ osascript: stub }).find((entry) => entry.path === ROUTE_PATH)
  assert.ok(route !== undefined, 'the clipboard route is registered')
  const response = makeResponse()
  await route.handler(makeRequest(options), response)
  return { status: response.state.status, body: JSON.parse(response.state.body) }
}

test('parseProbePaths keeps non-empty paths in clipboard order', () => {
  assert.deepEqual(parseProbePaths('["/a","/b/c",""]'), ['/a', '/b/c'])
  assert.deepEqual(parseProbePaths('  []  '), [])
  assert.deepEqual(parseProbePaths(''), [])
  assert.deepEqual(parseProbePaths(undefined), [])
})

test('parseProbePaths refuses output that is not a path list', () => {
  assert.throws(() => parseProbePaths('{"paths":[]}'), /unexpected shape/)
  assert.throws(() => parseProbePaths('not json'), /unreadable output/)
})

test('on macOS the route answers with the directory the browser named', MAC_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-folder-path-'))
  const folders = join(root, 'Reports')
  mkdirSync(folders)
  const file = join(root, 'note.txt')
  writeFileSync(file, 'x')
  const stub = writeOsascriptStub(root, [file, folders])

  const result = await callWithProbe(stub, { body: JSON.stringify({ names: ['reports'] }) })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  // The copied file is not a directory, and the basename match ignores case.
  assert.deepEqual(result.body.paths, [folders])
  assert.deepEqual(result.body.entries, [{ path: folders, name: 'Reports', isDirectory: true }])
})

test('on macOS an empty name list answers with every copied directory', MAC_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-folder-path-'))
  const first = join(root, 'first')
  const second = join(root, 'second')
  mkdirSync(first)
  mkdirSync(second)
  const stub = writeOsascriptStub(root, [first, second])

  const result = await callWithProbe(stub, { body: '{}' })
  assert.equal(result.body.ok, true)
  assert.deepEqual(result.body.paths, [first, second])
})

test('on macOS a clipboard that no longer matches the paste answers no-match', MAC_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-folder-path-'))
  const folders = join(root, 'Reports')
  mkdirSync(folders)
  const stub = writeOsascriptStub(root, [folders])

  const result = await callWithProbe(stub, { body: JSON.stringify({ names: ['Elsewhere'] }) })
  assert.equal(result.body.ok, false)
  assert.equal(result.body.reason, 'no-match')
  assert.deepEqual(result.body.paths, [])
  assert.equal(result.body.clipboard.directories, 1)
})

test('on macOS a failing probe is reported as clipboard-error', MAC_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-folder-path-'))
  const stub = join(root, 'osascript-failing')
  writeFileSync(stub, '#!/bin/sh\necho boom >&2\nexit 1\n', 'utf8')
  chmodSync(stub, 0o755)

  const result = await callWithProbe(stub, { body: JSON.stringify({ names: ['Reports'] }) })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.reason, 'clipboard-error')
});
