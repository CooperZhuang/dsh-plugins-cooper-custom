/**
 * 「本会话日志」section 的 Host 数据面：`/session-admin/api/health`。
 *
 * 这条路由只做一次 `sessionPersistence.stat(sessionId)`，**不解压事件日志**、也不
 * 全量枚举；这里用临时目录里的真实会话日志 + 一个记录调用的假持久化后端，验证：
 *   - 返回的 `path` / `sizeBytes` 就是后端 `stat` 报的落盘工件（不是扫描结果）；
 *   - `resident` / `running` 来自假 `sessions` / `agents`；
 *   - 会话不存在、宿主没有 `stat`、`stat` 抛错都收敛成结构化结果（200 + `found:false`）；
 *   - 非法 id（含路径分隔符）被挡成 400 的结构化错误。
 *
 * 挂载方式与 `admin-wiring.test.ts` 相同：把 `apply` 挂进沙箱，`DSH_HOME` 指向临时目录，
 * 所以文件日志也不会写到真实的 `~/.dsh`。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import { apply } from '../lib/index.js'

/** 会话日志第一行（头部）。 */
function headerLine(id, cwd) {
  return JSON.stringify({ version: 3, id, createdAt: Date.now(), cwd, isSeeded: false })
}

/**
 * 在沙箱里写一条真实形状的会话日志（两个 zstd 帧：第 0 帧只有头部）。
 * @param home - 沙箱 DSH 主目录。
 * @param id - 会话 id。
 * @returns 日志绝对路径。
 */
function writeSession(home, id) {
  const dir = join(home, 'sessions', '--proj--', id)
  mkdirSync(dir, { recursive: true })
  const headerFrame = zlib.zstdCompressSync(Buffer.from(`${headerLine(id, '/tmp/work')}\n`, 'utf8'))
  const eventFrame = zlib.zstdCompressSync(Buffer.from('{"type":"turn/start"}\n', 'utf8'))
  const logPath = join(dir, 'session.v3.jsonl.zstd')
  writeFileSync(logPath, Buffer.concat([headerFrame, eventFrame]))
  return logPath
}

/**
 * 一个记录调用的假持久化后端。
 *
 * `stat` 默认对 `session-health` 返回**真实文件**的 stat；`list` / `open` 被调用会记录
 * 下来——health 路由若偷偷走了全量枚举或整读日志，测试会立刻看见。
 * @param options - `logPath` / `stat`（覆盖 stat 行为）/ `compression` / `omitStat`。
 * @returns 假后端。
 */
function fakePersistence(options = {}) {
  const { logPath, stat, compression = 'zstd', omitStat = false } = options
  const calls = { stat: [], list: 0, open: 0 }
  const backend = {
    calls,
    root: '/tmp/sessions',
    compression,
    list: async () => {
      calls.list += 1
      return []
    },
    open: async () => {
      calls.open += 1
      throw new Error('the health route must not open the log')
    },
  }
  if (omitStat !== true) {
    backend.stat = async (id) => {
      calls.stat.push(id)
      if (typeof stat === 'function') return stat(id)
      if (id !== 'session-health') return undefined
      const info = statSync(logPath)
      return {
        header: { id, cwd: '/tmp/work' },
        revision: 'rev-1',
        sizeBytes: info.size,
        formatStatus: 'current',
        location: { kind: 'jsonl', path: logPath },
      }
    }
  }
  return backend
}

/** 只含一条工作区（成员为 `members`）的假登记表。 */
function fakeRegistry(members = []) {
  return {
    list: () => [
      {
        id: 'ws-health',
        title: '健康检查',
        path: '/tmp/work',
        sessionIds: members,
        record: { sessionIds: members },
        attachSession: async () => {},
        detachSession: async () => {},
      },
    ],
    archivedSessionIds: [],
    unarchiveSession: async () => {},
    unpinSession: async () => {},
  }
}

/**
 * 把插件挂到一个真实 `node:http` 服务器上。
 * @param options - `persistence` / `sessions`（驻留会话对象数组）/ `agents`（id → agent）。
 * @returns 基址、注册到的路由与关闭函数。
 */
async function mount(options = {}) {
  const { persistence, sessions = [], agents = {}, registry = fakeRegistry() } = options
  const routes = []
  const tools = []
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    effect: (fn) => fn(),
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    get: (name) => {
      if (name === 'sessions') return { list: () => sessions }
      if (name === 'agents') return { get: (id) => agents[id] }
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    workspaceRegistry: registry,
    sessionPersistence: persistence,
  }

  // 启动期的 fork 补记账会调 persistence.list()，这里关掉，让统计只反映 health 本身。
  apply(ctx, { repairForkChildrenOnBoot: false })

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const route = routes.find((entry) => pathname.startsWith(entry.path))
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    routes,
    tools,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 调一次 `health`。 */
async function callHealth(base, payload) {
  const response = await fetch(`${base}/session-admin/api/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

/** 在沙箱 `$DSH_HOME` 里跑一轮。 */
async function inSandbox(run) {
  const home = mkdtempSync(join(tmpdir(), 'session-health-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await run({ home })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('health：返回与 stat 一致的 path / sizeBytes，并带上压缩格式、归属与驻留状态', async () => {
  await inSandbox(async ({ home }) => {
    const logPath = writeSession(home, 'session-health')
    const persistence = fakePersistence({ logPath })
    const mounted = await mount({
      persistence,
      sessions: [{ id: 'session-health' }],
      agents: { 'session-health': { status: 'running' } },
      registry: fakeRegistry(['session-health']),
    })

    try {
      const { status, body } = await callHealth(mounted.base, { sessionId: 'session-health' })
      assert.equal(status, 200)
      assert.equal(body.ok, true)
      const value = body.value
      assert.equal(value.id, 'session-health')
      assert.equal(value.found, true)
      // 路径与字节数就是后端 stat 报的落盘工件（这里再拿文件系统独立核对一次）。
      assert.equal(value.path, logPath)
      assert.equal(value.sizeBytes, statSync(logPath).size)
      assert.equal(value.compression, 'zstd')
      assert.equal(value.formatStatus, 'current')
      assert.equal(value.workspaceId, 'ws-health')
      assert.equal(value.resident, true)
      assert.equal(value.running, true)
      assert.equal(value.reason, undefined)
      // 只 stat 这一次会话：不 list、不 open（也就没有整读日志）。
      assert.deepEqual(persistence.calls.stat, ['session-health'])
      assert.equal(persistence.calls.list, 0)
      assert.equal(persistence.calls.open, 0)
    } finally {
      await mounted.close()
    }
  })
})

/**
 * 内核真身形状的假后端：`stat` 是**原型方法**，方法体依赖 `this`。
 *
 * 0.2.4 的 health 路由写成 `const stat = persistence.stat` 再 `stat(id)`，`this` 变成
 * `undefined`；内核 JSONL 后端的 `stat` 第一句是 `this.ensureRootEncoding()`，于是抛
 * `Cannot read properties of undefined (reading 'ensureRootEncoding')`，面板整块显示
 * 「读取失败」。用同一形状把「必须绑在接收者上调用」这条契约锁住。
 */
class KernelShapedPersistence {
  #rootEncodingCheck

  constructor(logPath) {
    this.logPath = logPath
  }

  /** 内核同名方法：确保每轮 stat 都先走一遍根编码检查。 */
  ensureRootEncoding() {
    this.#rootEncodingCheck ??= Promise.resolve()
    return this.#rootEncodingCheck
  }

  async stat(id) {
    await this.ensureRootEncoding()
    return {
      header: { id },
      sizeBytes: 1,
      formatStatus: 'current',
      location: { kind: 'jsonl', path: this.logPath },
    }
  }
}

test('health：stat 必须绑在接收者上调用（内核 stat 依赖 this，摘出来就抛 TypeError）', async () => {
  await inSandbox(async ({ home }) => {
    const logPath = writeSession(home, 'session-health')
    const mounted = await mount({
      persistence: new KernelShapedPersistence(logPath),
      registry: fakeRegistry(['session-health']),
    })
    try {
      const { status, body } = await callHealth(mounted.base, { sessionId: 'session-health' })
      assert.equal(status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.value.found, true)
      assert.equal(body.value.reason, undefined)
      assert.equal(body.value.path, logPath)
      assert.equal(body.value.sizeBytes, 1)
    } finally {
      await mounted.close()
    }
  })
})

test('health：会话不存在时返回 200 + found:false + reason:not-found（不是裸异常）', async () => {
  await inSandbox(async ({ home }) => {
    const logPath = writeSession(home, 'session-health')
    const mounted = await mount({
      persistence: fakePersistence({ logPath }),
      // 一条驻留/运行中的**别的**会话：未知 id 不该被它带出错误的 resident/running。
      sessions: [{ id: 'session-other' }],
      agents: { 'session-other': { status: 'running' } },
    })
    try {
      const { status, body } = await callHealth(mounted.base, { sessionId: 'session-missing' })
      assert.equal(status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.value.id, 'session-missing')
      assert.equal(body.value.found, false)
      assert.equal(body.value.reason, 'not-found')
      assert.equal(body.value.path, null)
      assert.equal(body.value.sizeBytes, null)
      assert.equal(body.value.workspaceId, null)
      assert.equal(body.value.resident, false)
      assert.equal(body.value.running, false)
    } finally {
      await mounted.close()
    }
  })
})

test('health：宿主没有 stat 时降级为 persistence-unavailable，其余入口不受影响', async () => {
  await inSandbox(async ({ home }) => {
    const logPath = writeSession(home, 'session-health')
    const mounted = await mount({ persistence: fakePersistence({ logPath, omitStat: true }) })
    try {
      const { status, body } = await callHealth(mounted.base, { sessionId: 'session-health' })
      assert.equal(status, 200)
      assert.equal(body.value.found, false)
      assert.equal(body.value.reason, 'persistence-unavailable')
      // 同一套路由的其它方法照旧在（降级只影响这一条只读探针）。
      const config = await fetch(`${mounted.base}/session-admin/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(config.status, 200)
    } finally {
      await mounted.close()
    }
  })
})

test('health：后端 stat 抛错时返回结构化 read-failed，不把异常透给浏览器', async () => {
  await inSandbox(async ({ home }) => {
    const logPath = writeSession(home, 'session-health')
    const persistence = fakePersistence({
      logPath,
      stat: async () => {
        throw new Error('disk went away')
      },
    })
    const mounted = await mount({ persistence })
    try {
      const { status, body } = await callHealth(mounted.base, { sessionId: 'session-health' })
      assert.equal(status, 200)
      assert.equal(body.value.found, false)
      assert.equal(body.value.reason, 'read-failed')
      assert.match(body.value.message, /disk went away/)
    } finally {
      await mounted.close()
    }
  })
})

test('health：非法 id（空串 / 路径分隔符 / 非字符串）一律 400 结构化错误', async () => {
  await inSandbox(async ({ home }) => {
    const logPath = writeSession(home, 'session-health')
    const mounted = await mount({ persistence: fakePersistence({ logPath }) })
    try {
      for (const sessionId of ['', '../escape', 'a/b', 'a\\b', '..', 42, undefined]) {
        const { status, body } = await callHealth(mounted.base, { sessionId })
        assert.equal(status, 400, `sessionId=${JSON.stringify(sessionId)} 应当被拒绝`)
        assert.equal(body.ok, false)
        assert.equal(body.error.code, 'bad-request')
        assert.match(body.error.message, /sessionId/)
      }
    } finally {
      await mounted.close()
    }
  })
})
