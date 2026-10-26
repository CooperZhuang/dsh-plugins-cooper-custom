/**
 * `dsh-session-toolbox` **删除半边**的接线测试（原 `dsh-session-admin/test/wiring.test.mjs`）：
 * 走插件真实的 HTTP 路由删一个会话，必须在动文件之前先把登记表里对它的引用摘掉。
 *
 * 与源仓库相比只多了两处：`mount` 顺便收集注册到的工具（合并后有两个），文件末尾
 * 补一条"两条路由 + 两个工具"的并集断言。
 *
 * `core.test.mjs` 验的是 `remove()` 配一个注入回调时的行为；它验不到接线本身——
 * `apply` 是否真的把登记表适配器交给了 `remove`、适配器是否用了契约里的方法、
 * 以及是否发生在目录消失之前。
 *
 * 而这段接线只在活的宿主里跑，活宿主又抱着它已经 import 过的模块不放（改
 * `lib/index.js` 后热重载只会重跑缓存模块），所以不重启就没法对着运行中的进程验。
 * 这里换个办法：把 `apply` 挂进沙箱。
 *
 * 注意 `apply` 建 admin 时**没有**传 `home`，也就是说它会用真实的 `~/.dsh`——
 * 但 `dshHome()` 认 `DSH_HOME`，所以下面把它指向临时目录，所有写入都落在沙箱里。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import { apply } from '../lib/index.js'

/** 会话日志第一行（头部）。 */
function headerLine(id, cwd, extra = {}) {
  return JSON.stringify({ version: 3, id, createdAt: Date.now(), cwd, isSeeded: false, ...extra })
}

/**
 * 在沙箱里写一个会话的持久化数据（与 `core.test.mjs` 同形）。
 * @param home - 沙箱 DSH 主目录。
 * @param project - `sessions/` 下的项目目录键。
 * @param id - 会话 id。
 * @param options - `cwd` / `title`。
 */
function writeSession(home, project, id, options = {}) {
  const dir = join(home, 'sessions', project, id)
  mkdirSync(dir, { recursive: true })
  // 真实日志是多个 zstd 帧拼接，第 0 帧恰好只有头部行；夹具必须照这个形状写。
  const headerFrame = zlib.zstdCompressSync(Buffer.from(`${headerLine(id, options.cwd ?? 'C:\\work')}\n`, 'utf8'))
  const eventFrame = zlib.zstdCompressSync(Buffer.from('{"type":"turn/start"}\n', 'utf8'))
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([headerFrame, eventFrame]))

  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, `${id}.json`),
    JSON.stringify({
      version: 7,
      record: { identity: { cwd: options.cwd ?? 'C:\\work', createdAt: Date.now() }, rows: { title: { val: options.title ?? null } } },
    }),
  )
}

/**
 * 一个记录调用的假登记表，实现 `ctx.workspaceRegistry` 契约里用到的部分。
 *
 * `detachSession` 会顺手记下**这一刻会话目录还在不在**——本次改动的全部要点就是
 * 「摘登记表早于删文件」，这条断言比调用次数更能说明问题。
 *
 * @param sessionDirOf - 由会话 id 得到其日志目录。
 * @param members - 该工作区当前的成员 id。
 * @returns 记录用的登记表。
 */
function fakeRegistry(sessionDirOf, members) {
  const calls = []
  const membership = new Set(members)
  const workspace = {
    id: 'ws-sandbox',
    path: 'C:\\sandbox',
    title: 'sandbox',
    get sessionIds() {
      return [...membership]
    },
    async detachSession(sessionId) {
      calls.push({ method: 'detachSession', sessionId, logPresent: existsSync(sessionDirOf(sessionId)) })
      membership.delete(sessionId)
    },
  }
  return {
    calls,
    membership,
    list: () => [workspace],
    async unarchiveSession(sessionId) {
      calls.push({ method: 'unarchiveSession', sessionId })
    },
    async unpinSession(sessionId) {
      calls.push({ method: 'unpinSession', sessionId })
    },
  }
}

/**
 * 把插件挂到一个真实 `node:http` 服务器上。
 * @param registry - 假登记表。
 * @param config - 插件配置。
 * @returns 基址、注册到的路由与关闭函数。
 */
async function mount(registry, config = {}) {
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
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    get: (name) => (name === 'sessions' ? { list: () => [] } : undefined),
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
  }

  apply(ctx, config)

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
    /** 触发一次 Host 事件（测 volatile 更新用）。 */
    emit: (event) => {
      for (const handler of listeners.get(event) ?? []) handler()
    },
  }
}

/**
 * 调一次插件的 HTTP 面。
 * @param base - 挂载基址。
 * @param method - 方法名（`delete` / `list`）。
 * @param payload - JSON 请求体。
 * @returns 状态码与响应体。
 */
async function call(base, method, payload) {
  const response = await fetch(`${base}/session-admin/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  return { status: response.status, body: await response.json() }
}

/**
 * 在沙箱里跑一轮。
 * @param run - 收到 `{ home, sessionDirOf }` 的回调。
 */
async function inSandbox(run) {
  const home = mkdtempSync(join(tmpdir(), 'session-admin-wiring-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await run({
      home,
      sessionDirOf: (id) => join(home, 'sessions', '--proj--', id),
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('走真实 HTTP 删除：先摘登记表（那时日志还在），再删文件', async () => {
  await inSandbox(async ({ home, sessionDirOf }) => {
    writeSession(home, '--proj--', 'session-sandbox', { cwd: 'C:\\sandbox', title: '沙箱会话' })
    const registry = fakeRegistry(sessionDirOf, ['session-sandbox'])
    const mounted = await mount(registry)

    try {
      const result = await call(mounted.base, 'delete', {
        sessionIds: ['session-sandbox'],
        includeWorkspace: true,
      })

      assert.equal(result.status, 200)
      assert.equal(result.body.value.removed, 1)

      // 顺序：detach 时日志必须还在，否则登记表里的成员关系已经查不到，
      // 残留就永远摘不掉了。
      assert.deepEqual(registry.calls[0], {
        method: 'detachSession',
        sessionId: 'session-sandbox',
        logPresent: true,
      })
      assert.equal(registry.membership.has('session-sandbox'), false)

      // 归档 / 置顶集合也一并清掉。
      const methods = registry.calls.map((entry) => entry.method)
      assert.ok(methods.includes('unarchiveSession'), '归档集合未清理')
      assert.ok(methods.includes('unpinSession'), '置顶集合未清理')

      assert.equal(existsSync(sessionDirOf('session-sandbox')), false, '文件最终应被删除')
    } finally {
      await mounted.close()
    }
  })
})

test('dryRun 走同一条路由：不摘登记表，也不删文件', async () => {
  await inSandbox(async ({ home, sessionDirOf }) => {
    writeSession(home, '--proj--', 'session-sandbox', { cwd: 'C:\\sandbox', title: '沙箱会话' })
    const registry = fakeRegistry(sessionDirOf, ['session-sandbox'])
    const mounted = await mount(registry)

    try {
      const result = await call(mounted.base, 'delete', {
        sessionIds: ['session-sandbox'],
        includeWorkspace: true,
        dryRun: true,
      })

      assert.equal(result.status, 200)
      assert.deepEqual(registry.calls, [])
      assert.equal(registry.membership.has('session-sandbox'), true)
      assert.equal(existsSync(sessionDirOf('session-sandbox')), true, 'dryRun 不该动文件')
    } finally {
      await mounted.close()
    }
  })
})

test('登记表摘不掉时拒绝删除：文件留下，结果里给出原因', async () => {
  await inSandbox(async ({ home, sessionDirOf }) => {
    writeSession(home, '--proj--', 'session-sandbox', { cwd: 'C:\\sandbox', title: '沙箱会话' })
    const registry = fakeRegistry(sessionDirOf, ['session-sandbox'])
    registry.list = () => {
      throw new Error('registry unavailable')
    }
    const mounted = await mount(registry)

    try {
      const result = await call(mounted.base, 'delete', {
        sessionIds: ['session-sandbox'],
        includeWorkspace: true,
      })

      assert.equal(result.status, 200)
      const value = result.body.value
      assert.equal(value.removed, 0)
      assert.equal(value.results[0].status, 'failed')
      assert.match(value.results[0].reason, /^workspace: registry unavailable$/)
      assert.equal(existsSync(sessionDirOf('session-sandbox')), true, '摘不掉就不该删')
    } finally {
      await mounted.close()
    }
  })
})

test('volatile 旋钮：loader/volatile-update 之后立即生效，不用重挂', async () => {
  await inSandbox(async () => {
    // 宿主把 volatile 字段以活引用（`{ get() }`）交给 apply，值在 Loader 写盘后原地更新，
    // 并补发一次 `loader/volatile-update`。这条测试钉住的是：插件重读活引用之后，
    // HTTP 面立刻给出新值——插件页那张配置卡片就是靠这条路径生效的。
    // 合并后卡片上有 7 个旋钮（删除 4 + 搬迁 3），这里钉住删除半边那 4 个里的 3 个
    // （工作区开关在 core 用例里另有守卫断言）。
    let allowLive = false
    let maxBatch = 200
    let headerDelete = true
    const mounted = await mount(fakeRegistry(() => undefined, []), {
      allowLiveSessions: { get: () => allowLive },
      maxBatch: { get: () => maxBatch },
      headerDeleteButton: { get: () => headerDelete },
    })

    try {
      const before = await call(mounted.base, 'config', {})
      assert.equal(before.status, 200)
      assert.equal(before.body.value.allowLiveSessions, false)
      assert.equal(before.body.value.maxBatch, 200)
      assert.equal(before.body.value.headerDeleteButton, true)

      allowLive = true
      maxBatch = 7
      headerDelete = false
      mounted.emit('loader/volatile-update')

      const after = await call(mounted.base, 'config', {})
      assert.equal(after.body.value.allowLiveSessions, true, 'volatile 更新应立刻反映到 config 面')
      assert.equal(after.body.value.maxBatch, 7, 'volatile 更新应立刻反映到 config 面')
      assert.equal(after.body.value.headerDeleteButton, false, 'volatile 更新应立刻反映到 config 面')
    } finally {
      await mounted.close()
    }
  })
})

test('合并后的 apply 同时注册两条路由与两个工具（前缀与名字逐一对应）', async () => {
  await inSandbox(async () => {
    const mounted = await mount(fakeRegistry(() => undefined, []))
    try {
      assert.deepEqual(
        mounted.routes.map((route) => route.path).sort(),
        ['/session-admin/api', '/session-move/api'],
        '两个 HTTP 前缀都必须注册（浏览器半边与模型面都按它们寻址）',
      )
      assert.deepEqual(
        mounted.tools.map((tool) => tool.name).sort(),
        ['session_admin', 'session_move'],
        '两个模型工具都必须注册',
      )
    } finally {
      await mounted.close()
    }
  })
})
