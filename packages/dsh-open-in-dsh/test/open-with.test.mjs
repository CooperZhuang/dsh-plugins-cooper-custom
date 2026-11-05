/**
 * Host-half tests for the right-click "open with" action.
 *
 * The point of these routes is the boundary: the browser may only name an id
 * from the Host's allowlist and a path that already exists. Everything the
 * browser sends is otherwise ignored, and the command comes from the Host's own
 * table. So these tests mock the subprocess and the filesystem and assert on
 * the exact argv that would have been spawned - and that nothing spawns at all
 * for a refused request.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  OPEN_WITH_APPS,
  ROUTE_APPS,
  ROUTE_OPEN_WITH,
  availableApps,
  createAppsHandler,
  createOpenWithHandler,
  existingPath,
  findOpenWithApp,
  openWithCommand,
} from '../lib/index.js'

const logger = { info() {}, warn() {}, debug() {} }

/**
 * Mount one exact-route handler on a real HTTP server, the way the plugin's
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
    const error = options.error === undefined ? null : options.error
    queueMicrotask(() => callback(error))
  }
  return { calls, exec }
}

/** POST one open-with request. */
async function postOpenWith(base, body, headers = {}) {
  const response = await fetch(base + ROUTE_OPEN_WITH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

test('the allowlist is the whole command surface', () => {
  assert.deepEqual(availableApps('darwin', () => true), ['qspace', 'finder', 'vscode', 'warp', 'terminal'])
  assert.deepEqual(availableApps('win32'), ['explorer'])
  // A platform the plugin does not support contributes nothing: no menu beats
  // a menu whose actions cannot launch anything.
  assert.deepEqual(availableApps('linux', () => true), [])

  // The macOS probe only offers what it can find.
  const installed = (path) => path === '/Applications/QSpace Pro.app'
  assert.deepEqual(availableApps('darwin', installed), ['qspace', 'finder', 'terminal'])

  // Ids are compared exactly: a command, an app name or a forged tail is not one.
  for (const id of ['rm', 'sh', 'open', 'QSpace Pro', 'qspace; rm -rf /', '../qspace', '']) {
    assert.equal(findOpenWithApp('darwin', id), undefined)
  }
  assert.deepEqual(OPEN_WITH_APPS.darwin.map((entry) => entry.id), ['qspace', 'finder', 'vscode', 'warp', 'terminal'])
})

test('the argv comes from the allowlist, never from the request', () => {
  assert.deepEqual(
    openWithCommand('darwin', 'qspace', { path: '/a/b', directory: true }),
    { file: 'open', args: ['-a', 'QSpace Pro', '/a/b'] },
  )
  assert.deepEqual(
    openWithCommand('darwin', 'finder', { path: '/a/f.txt', directory: false }),
    { file: 'open', args: ['-R', '/a/f.txt'] },
  )
  assert.deepEqual(
    openWithCommand('darwin', 'vscode', { path: '/a/f.txt', directory: false }),
    { file: 'open', args: ['-a', 'Visual Studio Code', '/a/f.txt'] },
  )
  // Terminal opens the folder: opening the document itself would run it.
  assert.deepEqual(
    openWithCommand('darwin', 'terminal', { path: '/a/f.txt', directory: false }),
    { file: 'open', args: ['-a', 'Terminal', '/a'] },
  )
  assert.deepEqual(
    openWithCommand('darwin', 'terminal', { path: '/a/b', directory: true }),
    { file: 'open', args: ['-a', 'Terminal', '/a/b'] },
  )
  // Windows keeps the Explorer semantics: open a directory, select a file.
  assert.deepEqual(
    openWithCommand('win32', 'explorer', { path: 'C:\\work', directory: true }),
    { file: 'explorer.exe', args: ['C:\\work'] },
  )
  assert.deepEqual(
    openWithCommand('win32', 'explorer', { path: 'C:\\work\\a.txt', directory: false }),
    { file: 'explorer.exe', args: ['/select,C:\\work\\a.txt'] },
  )
  assert.equal(openWithCommand('darwin', 'rm', { path: '/a', directory: true }), null)
})

test('existingPath canonicalizes real files and directories and refuses the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-open-with-path-'))
  const folder = join(root, 'sub')
  const file = join(root, 'file.txt')
  mkdirSync(folder)
  writeFileSync(file, 'x')

  assert.deepEqual(existingPath(folder), { path: folder, directory: true })
  assert.deepEqual(existingPath(file), { path: file, directory: false })
  assert.equal(existingPath(join(root, 'missing')), null)
  assert.equal(existingPath('relative/sub'), null)
  assert.equal(existingPath(''), null)
  assert.equal(existingPath(undefined), null)

  const stat = fakeStat({ '/tmp/d': 'directory', '/tmp/f.txt': 'file', '/tmp/fifo': 'other' })
  assert.deepEqual(existingPath('/tmp/d', stat), { path: '/tmp/d', directory: true })
  assert.equal(existingPath('/tmp/f.txt', stat).directory, false)
  // A device or socket is not a document an application opens.
  assert.equal(existingPath('/tmp/fifo', stat), null)
})

test('the apps route reports only allowlisted apps that are installed', async () => {
  const probes = new Set(['/Applications/QSpace Pro.app'])
  const mounted = await serve(createAppsHandler(false, { platform: 'darwin', exists: (path) => probes.has(path) }))
  try {
    const response = await fetch(mounted.base + ROUTE_APPS)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, platform: 'darwin', apps: ['qspace', 'finder', 'terminal'] })

    const crossed = await fetch(mounted.base + ROUTE_APPS, { headers: { origin: 'http://evil.test' } })
    assert.equal(crossed.status, 403)
  } finally {
    await mounted.close()
  }
})

test('a valid action spawns exactly the allowlisted argv', async () => {
  const exec = fakeExec()
  const mounted = await serve(createOpenWithHandler({ logger }, false, {
    platform: 'darwin',
    stat: fakeStat({ '/tmp/project': 'directory' }),
    exec: exec.exec,
  }))
  try {
    const result = await postOpenWith(mounted.base, { path: '/tmp/project', app: 'qspace' })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { ok: true, app: 'qspace', path: '/tmp/project', directory: true })
    assert.deepEqual(
      exec.calls.map((call) => ({ file: call.file, args: call.args })),
      [{ file: 'open', args: ['-a', 'QSpace Pro', '/tmp/project'] }],
    )
    // No shell: execFile's options must not ask for one.
    assert.equal(exec.calls[0].settings.shell, undefined)
  } finally {
    await mounted.close()
  }
})

test('an app id outside the allowlist is refused before anything spawns', async () => {
  const exec = fakeExec()
  const mounted = await serve(createOpenWithHandler({ logger }, false, {
    platform: 'darwin',
    stat: fakeStat({ '/tmp/project': 'directory' }),
    exec: exec.exec,
  }))
  try {
    for (const app of ['rm', 'open', 'QSpace Pro', 'qspace; rm -rf /', 'bash -c id', '']) {
      const result = await postOpenWith(mounted.base, { path: '/tmp/project', app })
      assert.equal(result.status, 400, 'expected refusal for app ' + JSON.stringify(app))
      assert.equal(result.body.reason, 'unknown-app')
      assert.equal(result.body.app, app)
    }
    assert.equal(exec.calls.length, 0, 'a refused app still spawned a process')
  } finally {
    await mounted.close()
  }
})

test('a missing or relative path is refused without spawning', async () => {
  const exec = fakeExec()
  const mounted = await serve(createOpenWithHandler({ logger }, false, {
    platform: 'darwin',
    stat: fakeStat({ '/tmp/project': 'directory' }),
    exec: exec.exec,
  }))
  try {
    const missing = await postOpenWith(mounted.base, { path: '/tmp/nope', app: 'qspace' })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.reason, 'path-not-found')

    const relative = await postOpenWith(mounted.base, { path: 'project', app: 'qspace' })
    assert.equal(relative.status, 400)
    assert.equal(relative.body.reason, 'path-not-absolute')

    const absent = await postOpenWith(mounted.base, { app: 'qspace' })
    assert.equal(absent.status, 400)
    assert.equal(absent.body.reason, 'path-not-absolute')

    assert.equal(exec.calls.length, 0)
  } finally {
    await mounted.close()
  }
})

test('a failed launch is reported, not swallowed', async () => {
  const failure = Object.assign(new Error('spawn open ENOENT'), { code: 'ENOENT' })
  const mounted = await serve(createOpenWithHandler({ logger }, false, {
    platform: 'darwin',
    stat: fakeStat({ '/tmp/project': 'directory' }),
    exec: fakeExec({ error: failure }).exec,
  }))
  try {
    const result = await postOpenWith(mounted.base, { path: '/tmp/project', app: 'warp' })
    assert.equal(result.status, 500)
    assert.equal(result.body.reason, 'launch-failed')
    assert.match(result.body.message, /ENOENT/)
  } finally {
    await mounted.close()
  }
})

test('Explorer exit code 1 still counts as a launch', async () => {
  const exit = Object.assign(new Error('explorer exited with 1'), { code: 1 })
  const mounted = await serve(createOpenWithHandler({ logger }, false, {
    platform: 'win32',
    stat: fakeStat({ '/work': 'directory' }),
    exec: fakeExec({ error: exit }).exec,
  }))
  try {
    const result = await postOpenWith(mounted.base, { path: '/work', app: 'explorer' })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
  } finally {
    await mounted.close()
  }
})

test('policy checks match the rest of the plugin routes', async () => {
  const mounted = await serve(createOpenWithHandler({ logger }, false, {
    platform: 'darwin',
    stat: fakeStat({ '/tmp/project': 'directory' }),
    exec: fakeExec().exec,
  }))
  try {
    const crossed = await postOpenWith(mounted.base, { path: '/tmp/project', app: 'qspace' }, { origin: 'http://evil.test' })
    assert.equal(crossed.status, 403)
    assert.equal(crossed.body.reason, 'cross-origin')

    const wrongMethod = await fetch(mounted.base + ROUTE_OPEN_WITH)
    assert.equal(wrongMethod.status, 405)
  } finally {
    await mounted.close()
  }
})
