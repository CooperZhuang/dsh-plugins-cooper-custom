/**
 * Host-half tests for the Session-scoped launch route.
 *
 * Two things can be wrong here and both are expensive: resolving a session id
 * to the *wrong* directory (the user opens one project and lands in another),
 * and accepting a directory the request itself named (the route would stop
 * being "open this Session" and become "open any path"). So the resolver is
 * tested against the real store layout, and the handler against a mocked
 * subprocess that records exactly what would have been spawned.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import { encodeSegment, hasZstd } from 'dsh-session-store'

import {
  ROUTE_OPEN_SESSION,
  createLiveCwdReader,
  createOpenSessionHandler,
  findSessionCwdOnDisk,
  resolveSessionCwd,
} from '../lib/index.js'

const logger = { info() {}, warn() {}, debug() {} }

/**
 * Mount one exact-route handler on a real HTTP server, as the plugin's
 * webServer row would.
 * @param handler - the route handler.
 * @returns the base URL and a disposer.
 */
async function serve(handler) {
  const server = createServer((request, response) => handler(request, response))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: 'http://127.0.0.1:' + port,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * A stat probe answering from a fixed path-to-kind table.
 * @param table - absolute path to 'file' or 'directory'.
 * @returns the stat function.
 */
function fakeStat(table) {
  return (path) => {
    const kind = table[path]
    if (kind === undefined) {
      const error = new Error('ENOENT: no such file or directory, stat ' + path)
      error.code = 'ENOENT'
      throw error
    }
    return { isDirectory: () => kind === 'directory', isFile: () => kind === 'file' }
  }
}

/**
 * An execFile stand-in that records the argv and answers on the next microtask.
 * @param options - optional failure: { error }.
 * @returns the recorded calls and the exec function.
 */
function fakeExec(options = {}) {
  const calls = []
  const exec = (file, args, settings, callback) => {
    calls.push({ file, args, settings })
    queueMicrotask(() => callback(options.error === undefined ? null : options.error))
  }
  return { calls, exec }
}

/** POST one open-session request. */
async function postOpenSession(base, body, headers = {}) {
  const response = await fetch(base + ROUTE_OPEN_SESSION, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

/**
 * Write a Session into a throwaway store the way the Host lays it out:
 * `<root>/<projectKey>/<encodeSegment(id)>/session[.vN].jsonl[.zstd]`.
 * @param root - the store root.
 * @param projectKey - a project directory key.
 * @param sessionId - the Session id.
 * @param header - the header object to store.
 * @param compressed - write a real zstd frame instead of a plain line.
 * @returns the session directory.
 */
function writeSession(root, projectKey, sessionId, header, compressed = false) {
  const dir = join(root, projectKey, encodeSegment(sessionId))
  mkdirSync(dir, { recursive: true })
  const line = JSON.stringify(header) + '\n'
  if (compressed) {
    writeFileSync(join(dir, 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(line, 'utf8')))
    try {
      chmodSync(join(dir, 'session.jsonl.zstd'), 0o644)
    } catch {}
  } else {
    writeFileSync(join(dir, 'session.jsonl'), line)
  }
  return dir
}

test('a stored header is found by id alone, across project keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-open-session-store-'))
  writeSession(root, '--other--', 'session-other', { type: 'session', cwd: '/elsewhere' })
  const wanted = writeSession(root, '--wanted--', 'session-abc', { type: 'session', cwd: '/work/project' })

  assert.equal(findSessionCwdOnDisk('session-abc', { sessionsRoot: root }), '/work/project')
  // The id is the lookup key, not a prefix or a substring.
  assert.equal(findSessionCwdOnDisk('session-ab', { sessionsRoot: root }), undefined)
  assert.equal(findSessionCwdOnDisk('nope', { sessionsRoot: root }), undefined)
  // A missing store root is "unknown", not a throw.
  assert.equal(findSessionCwdOnDisk('session-abc', { sessionsRoot: join(root, 'missing') }), undefined)
  assert.ok(wanted.length > 0)
})

test('a zstd-framed header is readable through the shared session-store reader', (t) => {
  if (!hasZstd) {
    t.skip('this node build lacks zlib zstd support')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-open-session-zstd-'))
  writeSession(root, '--work--', 'session-z', { type: 'session', cwd: '/work/zstd' }, true)
  assert.equal(findSessionCwdOnDisk('session-z', { sessionsRoot: root }), '/work/zstd')
})

test('the live projection wins over the stored header, and the store is the fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-open-session-live-'))
  writeSession(root, '--work--', 'session-1', { type: 'session', cwd: '/from-disk' })

  assert.equal(
    resolveSessionCwd('session-1', { live: () => '/from-memory', sessionsRoot: root }),
    '/from-memory',
  )
  // A live reader that answers nothing (or throws) must not hide the disk.
  assert.equal(resolveSessionCwd('session-1', { live: () => undefined, sessionsRoot: root }), '/from-disk')
  assert.equal(
    resolveSessionCwd('session-1', {
      live: () => {
        throw new Error('service is not up yet')
      },
      sessionsRoot: root,
    }),
    '/from-disk',
  )
})

test('the live reader reads both Host projections and tolerates missing services', () => {
  const registry = { headers: new Map([['session-cached', { cwd: '/registry' }]]) }
  const resident = { header: { cwd: '/resident' } }
  const ctx = {
    get(key) {
      if (key === 'workspaceRegistry') return registry
      if (key === 'sessions') {
        return { get: (id) => (id === 'session-resident' ? resident : undefined), list: () => [] }
      }
      return undefined
    },
  }
  const live = createLiveCwdReader(ctx)
  assert.equal(live('session-cached'), '/registry')
  assert.equal(live('session-resident'), '/resident')
  assert.equal(live('session-unknown'), undefined)

  // No get(), or a get() that throws: unknown, never a crash.
  assert.equal(createLiveCwdReader({})('session-cached'), undefined)
  assert.equal(
    createLiveCwdReader({
      get() {
        throw new Error('not ready')
      },
    })('session-cached'),
    undefined,
  )
})

test('a resolved Session cwd is spawned as the allowlisted directory launch', async () => {
  const exec = fakeExec()
  const mounted = await serve(
    createOpenSessionHandler({ logger }, false, {
      platform: 'darwin',
      stat: fakeStat({ '/work/project': 'directory' }),
      exec: exec.exec,
      resolveCwd: () => '/work/project',
    }),
  )
  try {
    const result = await postOpenSession(mounted.base, { sessionId: 'session-1', app: 'qspace' })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, {
      ok: true,
      app: 'qspace',
      sessionId: 'session-1',
      path: '/work/project',
      directory: true,
    })
    assert.deepEqual(
      exec.calls.map((call) => ({ file: call.file, args: call.args })),
      [{ file: 'open', args: ['-a', 'QSpace Pro', '/work/project'] }],
    )
    assert.equal(exec.calls[0].settings.shell, undefined)
  } finally {
    await mounted.close()
  }
})

test('an app id outside the allowlist is refused before any lookup', async () => {
  const exec = fakeExec()
  let lookups = 0
  const mounted = await serve(
    createOpenSessionHandler({ logger }, false, {
      platform: 'darwin',
      stat: fakeStat({ '/work/project': 'directory' }),
      exec: exec.exec,
      resolveCwd: () => {
        lookups += 1
        return '/work/project'
      },
    }),
  )
  try {
    for (const app of ['rm', 'open', 'QSpace Pro', 'qspace; rm -rf /', '']) {
      const result = await postOpenSession(mounted.base, { sessionId: 'session-1', app })
      assert.equal(result.status, 400, 'expected refusal for app ' + JSON.stringify(app))
      assert.equal(result.body.reason, 'unknown-app')
    }
    assert.equal(exec.calls.length, 0, 'a refused app still spawned a process')
    assert.equal(lookups, 0, 'a refused app still probed the session store')
  } finally {
    await mounted.close()
  }
})

test('a missing or unusable session id is refused', async () => {
  const exec = fakeExec()
  const mounted = await serve(
    createOpenSessionHandler({ logger }, false, {
      platform: 'darwin',
      stat: fakeStat({ '/work/project': 'directory' }),
      exec: exec.exec,
      resolveCwd: () => '/work/project',
    }),
  )
  try {
    for (const body of [{ app: 'qspace' }, { sessionId: '', app: 'qspace' }, { sessionId: '   ', app: 'qspace' }, { sessionId: 42, app: 'qspace' }]) {
      const result = await postOpenSession(mounted.base, body)
      assert.equal(result.status, 400, 'expected refusal for ' + JSON.stringify(body))
      assert.equal(result.body.reason, 'missing-session-id')
    }
    for (const sessionId of ['../escape', 'a/b', 'a\\b', 'x'.repeat(257)]) {
      const result = await postOpenSession(mounted.base, { sessionId, app: 'qspace' })
      assert.equal(result.status, 400, 'expected refusal for ' + JSON.stringify(sessionId))
      assert.equal(result.body.reason, 'invalid-session-id')
    }
    assert.equal(exec.calls.length, 0)
  } finally {
    await mounted.close()
  }
})

test('an unresolvable cwd is a named 404, not a generic failure', async () => {
  const exec = fakeExec()
  const mounted = await serve(
    createOpenSessionHandler({ logger }, false, {
      platform: 'darwin',
      stat: fakeStat({ '/work/project': 'directory' }),
      exec: exec.exec,
      resolveCwd: () => undefined,
    }),
  )
  try {
    const result = await postOpenSession(mounted.base, { sessionId: 'session-1', app: 'qspace' })
    assert.equal(result.status, 404)
    assert.equal(result.body.reason, 'session-cwd-not-found')
    assert.equal(result.body.sessionId, 'session-1')
    assert.equal(exec.calls.length, 0)
  } finally {
    await mounted.close()
  }
})

test('a stored cwd that is no longer a directory is refused, with the path reported', async () => {
  const exec = fakeExec()
  const mounted = await serve(
    createOpenSessionHandler({ logger }, false, {
      platform: 'darwin',
      // A renamed folder, and a cwd that points at a file: both unopenable.
      stat: fakeStat({ '/work/file.txt': 'file' }),
      exec: exec.exec,
      resolveCwd: (sessionId) => (sessionId === 'session-gone' ? '/work/renamed-away' : '/work/file.txt'),
    }),
  )
  try {
    for (const sessionId of ['session-gone', 'session-file']) {
      const result = await postOpenSession(mounted.base, { sessionId, app: 'qspace' })
      assert.equal(result.status, 404, 'expected 404 for ' + sessionId)
      assert.equal(result.body.reason, 'session-cwd-not-found')
      assert.equal(result.body.cwd, sessionId === 'session-gone' ? '/work/renamed-away' : '/work/file.txt')
    }
    assert.equal(exec.calls.length, 0)
  } finally {
    await mounted.close()
  }
})

test('a failed launch is reported, not swallowed', async () => {
  const failure = Object.assign(new Error('spawn open ENOENT'), { code: 'ENOENT' })
  const mounted = await serve(
    createOpenSessionHandler({ logger }, false, {
      platform: 'darwin',
      stat: fakeStat({ '/work/project': 'directory' }),
      exec: fakeExec({ error: failure }).exec,
      resolveCwd: () => '/work/project',
    }),
  )
  try {
    const result = await postOpenSession(mounted.base, { sessionId: 'session-1', app: 'qspace' })
    assert.equal(result.status, 500)
    assert.equal(result.body.reason, 'launch-failed')
    assert.equal(result.body.sessionId, 'session-1')
    assert.match(result.body.message, /ENOENT/)
  } finally {
    await mounted.close()
  }
})

test('a resolver that throws is reported as a failure, not as a 404', async () => {
  const mounted = await serve(
    createOpenSessionHandler({ logger }, false, {
      platform: 'darwin',
      stat: fakeStat({}),
      exec: fakeExec().exec,
      resolveCwd: () => {
        throw new Error('store unreadable')
      },
    }),
  )
  try {
    const result = await postOpenSession(mounted.base, { sessionId: 'session-1', app: 'qspace' })
    assert.equal(result.status, 500)
    assert.equal(result.body.reason, 'session-lookup-failed')
    assert.match(result.body.message, /store unreadable/)
  } finally {
    await mounted.close()
  }
})

test('policy checks match the rest of the plugin routes', async () => {
  const mounted = await serve(
    createOpenSessionHandler({ logger }, false, {
      platform: 'darwin',
      stat: fakeStat({ '/work/project': 'directory' }),
      exec: fakeExec().exec,
      resolveCwd: () => '/work/project',
    }),
  )
  try {
    const crossed = await postOpenSession(
      mounted.base,
      { sessionId: 'session-1', app: 'qspace' },
      { origin: 'http://evil.test' },
    )
    assert.equal(crossed.status, 403)
    assert.equal(crossed.body.reason, 'cross-origin')

    const wrongMethod = await fetch(mounted.base + ROUTE_OPEN_SESSION)
    assert.equal(wrongMethod.status, 405)
  } finally {
    await mounted.close()
  }
})
