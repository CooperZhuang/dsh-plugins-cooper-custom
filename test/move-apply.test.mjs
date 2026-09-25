/**
 * `dsh-session-toolbox` **搬迁半边**的装配测试（原 `dsh-session-move/test/apply.test.mjs`）：
 * 用一个假 ctx 把合并后的 `apply()` 真的挂起来，走一遍搬迁那半边的 HTTP 路由与工具注册。
 *
 * 这一层专门抓"接线"错误（路由前缀、JSON schema 形状、config 默认值、guard 顺序），
 * 单元测试抓不到的都在这里。真机上的搬迁由 lib/engine.js 的单测 + 实际使用覆盖。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { Config, MOVE_API_PREFIX, apply, resolveConfig } from '../lib/index.js'
// 两半的信任栅栏同名不同义：搬迁半边这份在 lib/move.js（socket remoteAddress 版）。
import { isTrustedRequest } from '../lib/move.js'
import { verifyStoredLog } from '../lib/engine.js'
import { CHECKSUM_OPTIONS, sessionDir } from '../lib/sessionlog.js'

/**
 * 合并后 `apply()` 会同时注册删除半边与搬迁半边两条路由；这个助手挑出搬迁那条
 * （合并前它就是 `moveRoute(state)`，迁移时只改"怎么找到它"，断言一条没删）。
 * @param state - `stubCtx` 返回的注册记录。
 * @returns 搬迁半边的路由。
 */
function moveRoute(state) {
  const route = state.routes.find((entry) => entry.path === MOVE_API_PREFIX)
  assert.ok(route !== undefined, `missing route ${MOVE_API_PREFIX}`)
  return route
}

/*
 * 日志隔离：`apply()` 会把 `mounted:` 行写进 `$DSH_HOME/logs/dsh-session-move.log`，
 * 而这个文件里的 root 全是夹具（C:\root、%TEMP%\dsh-session-move-*）。
 * 不隔离的话，跑一次 `npm test` 就往真机排障日志里插几十行假 mounted，和线上记录混在一起
 * ——排查线上问题时会把夹具当成配置错位。
 *
 * `dshHome()` 是环境变量优先（见 lib/index.js），所以把本测试进程的 $DSH_HOME 指到临时目录即可。
 * node --test 每个测试文件跑在独立子进程里，不会影响别的文件或生产进程。
 */
const testHome = mkdtempSync(join(tmpdir(), 'dsh-session-move-home-'))
process.env.DSH_HOME = testHome
after(() => {
  rmSync(testHome, { recursive: true, force: true })
})

/** 造一份合成日志（帧 0 只含 header 行）。 */
function syntheticLog(cwd, id) {
  const header = { type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd }
  return Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), CHECKSUM_OPTIONS),
    zlib.zstdCompressSync(Buffer.from('{"seq":0,"type":"turn/start"}\n', 'utf8'), CHECKSUM_OPTIONS),
  ])
}

/** 假 ctx：记录注册的 effect / 路由 / 工具。 */
function stubCtx({ persistence, registry, sessions, agents } = {}) {
  const state = { routes: [], tools: [], effects: [], listeners: new Map() }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) {
      const list = state.listeners.get(event) ?? []
      list.push(handler)
      state.listeners.set(event, list)
      return () => {
        const current = state.listeners.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(fn, label) {
      const disposer = fn()
      state.effects.push({ label, disposer })
      return () => {}
    },
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'agents') return agents
      return undefined
    },
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        state.tools.push(tool)
        return () => {}
      },
    },
  }
  return {
    ctx,
    state,
    /** 触发一次 Host 事件（测 volatile 更新用）。 */
    emit: (event) => {
      for (const handler of state.listeners.get(event) ?? []) handler()
    },
  }
}

/** 假响应，收集状态码与 body。 */
function fakeRes() {
  const out = { status: 0, body: '' }
  return {
    out,
    res: {
      writeHead(status) {
        out.status = status
      },
      end(text) {
        out.body = text
      },
    },
  }
}

/** 假请求（GET 用 query，POST 用 JSON body）。 */
function fakeReq({ url, method = 'GET', payload, host = '127.0.0.1:3080', remoteAddress = '127.0.0.1' }) {
  const text = payload === undefined ? '' : JSON.stringify(payload)
  return {
    url,
    method,
    headers: { host },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (text.length > 0) yield Buffer.from(text, 'utf8')
    },
  }
}

/** 造一套最小的持久化/注册表桩，root 指向临时目录。 */
function stubs(root, fromCwd, toCwd, sessionId) {
  const workspaces = [
    { id: 'ws-from', title: 'from-ws', path: fromCwd, sessionIds: [sessionId], record: { sessionIds: [sessionId] } },
    { id: 'ws-to', title: 'to-ws', path: toCwd, sessionIds: [], record: { sessionIds: [] } },
  ]
  for (const workspace of workspaces) {
    workspace.attachSession = async (id) => {
      if (!workspace.record.sessionIds.includes(id)) workspace.record.sessionIds.push(id)
    }
    workspace.detachSession = async (id) => {
      workspace.record.sessionIds = workspace.record.sessionIds.filter((candidate) => candidate !== id)
    }
  }
  const persistence = {
    root,
    compression: 'zstd',
    tracker: { writers: new Map() },
    async list() {
      return [{ header: { type: 'session', version: 3, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: fromCwd } }]
    },
    // 读回校验：真去看目标位置有没有那份日志（搬迁后才有）。
    async open(id) {
      const found = verifyStoredLog({ root, sessionId: id, cwd: toCwd, compression: 'zstd' })
      return {
        header: { cwd: found.ok ? toCwd : fromCwd },
        inheritedEventCount: 0,
        async read() {
          return { events: [1, 2, 3] }
        },
        async close() {},
      }
    },
  }
  const registry = {
    archivedSessionIds: [],
    headers: new Map([[sessionId, { id: sessionId, cwd: fromCwd }]]),
    list: () => workspaces,
    get: (id) => workspaces.find((workspace) => workspace.id === id),
  }
  return { persistence, registry }
}

test('Config 默认值稳定', () => {
  // `Config()` 对 volatile 字段输出的是活引用（`{ get() }`），所以要经 `resolveConfig`
  // 收敛成普通值再断言——运行时那条路径走的也是同一个函数。
  const defaults = resolveConfig({})
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.refuseRunning, true)
  // 合并后 allowHosts 拆成两个键（两半的栅栏语义不同），默认都必须为空。
  assert.deepEqual(defaults.moveAllowHosts, [])
  assert.deepEqual(defaults.adminAllowHosts, [])
  assert.equal(defaults.maxSessions, 2000)
  assert.equal(defaults.memoryFollow, 'off')
  // volatile 字段接受活引用；解包后就是普通值。
  assert.equal(resolveConfig({ maxSessions: { get: () => 7 } }).maxSessions, 7)
})

test('isTrustedRequest 只放行 loopback 与白名单 authority', () => {
  assert.equal(isTrustedRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, []), true)
  assert.equal(isTrustedRequest({ socket: { remoteAddress: '::1' }, headers: {} }, []), true)
  assert.equal(isTrustedRequest({ socket: { remoteAddress: '198.51.100.9' }, headers: { host: 'box:3080' } }, []), false)
  assert.equal(isTrustedRequest({ socket: { remoteAddress: '198.51.100.9' }, headers: { host: 'box:3080' } }, ['box:3080']), true)

  // 2026-09-25 与 dsh-session-admin 的栅栏对齐后新增的约束：跨站 / 跨源一律拒绝。
  // 恶意页面从任意站点 POST 到 loopback 时 remoteAddress 同样是 127.0.0.1，只看它拦不住。
  const loop = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }
  assert.equal(
    isTrustedRequest({ ...loop, headers: { ...loop.headers, 'sec-fetch-site': 'cross-site' } }, []),
    false,
    'sec-fetch-site: cross-site 必须拒绝',
  )
  assert.equal(
    isTrustedRequest({ ...loop, headers: { ...loop.headers, origin: 'http://evil.example' } }, []),
    false,
    '跨源 Origin 必须拒绝',
  )
  assert.equal(
    isTrustedRequest({ ...loop, headers: { ...loop.headers, origin: 'http://127.0.0.1:3080' } }, []),
    true,
    '同源 Origin 仍放行',
  )
  assert.equal(
    isTrustedRequest(
      { socket: { remoteAddress: '28.0.0.1' }, headers: { host: '28.0.0.1:3080', origin: 'http://28.0.0.1:3080' } },
      ['28.0.0.1:3080'],
    ),
    true,
    '白名单 authority + 同源 Origin 仍放行（LAN 访问不能被这次收紧误伤）',
  )
})

test('apply 注册两条路由与两个工具，且工具 schema 是真 JSON Schema', () => {
  const { ctx, state } = stubCtx({})
  apply(ctx, {})
  // 合并后两半各一条路由、各一个工具（顺序即 apply 里的挂载顺序：先删除后搬迁）。
  assert.deepEqual(state.routes.map((route) => route.path), ['/session-admin/api', '/session-move/api'])
  assert.deepEqual(state.routes.map((route) => route.kind), ['prefix', 'prefix'])
  assert.equal(state.tools.length, 2)
  assert.deepEqual(state.tools.map((entry) => entry.name), ['session_admin', 'session_move'])
  const tool = state.tools[1]
  assert.equal(tool.name, 'session_move')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(tool.output.schema.type, 'object')
  assert.ok(Array.isArray(tool.output.schema.required))
})

test('路由：config / list 返回 Host 事实', async () => {
  const { ctx, state } = stubCtx({})
  apply(ctx, {})
  const route = moveRoute(state)

  const configRes = fakeRes()
  await route.handler(fakeReq({ url: `${MOVE_API_PREFIX}/config` }), configRes.res)
  assert.equal(configRes.out.status, 200)
  const configBody = JSON.parse(configRes.out.body)
  assert.equal(configBody.ok, true)
  assert.equal(configBody.value.prefix, MOVE_API_PREFIX)

  const { persistence, registry } = stubs('C:\\nonexistent-root', 'C:\\a', 'C:\\b', 'session-1')
  const { ctx: ctx2, state: state2 } = stubCtx({ persistence, registry })
  apply(ctx2, {})
  const listRes = fakeRes()
  await moveRoute(state2).handler(fakeReq({ url: `${MOVE_API_PREFIX}/list` }), listRes.res)
  assert.equal(listRes.out.status, 200)
  const listBody = JSON.parse(listRes.out.body)
  assert.equal(listBody.ok, true)
  assert.equal(listBody.value.workspaces.length, 2)
  assert.equal(listBody.value.sessions.length, 1)
  assert.equal(listBody.value.sessions[0].workspaceTitle, 'from-ws')
  assert.equal(listBody.value.sessions[0].movable, true)
  assert.equal(listBody.value.counts.workspaces, 2)
})

test('路由：拒绝非 loopback 且不在白名单的请求', async () => {
  const { ctx, state } = stubCtx({})
  apply(ctx, {})
  const res = fakeRes()
  await moveRoute(state).handler(
    fakeReq({ url: `${MOVE_API_PREFIX}/config`, host: 'evil.example', remoteAddress: '10.0.0.5' }),
    res.res,
  )
  assert.equal(res.out.status, 403)
})

test('路由：move 的预演走完整计划路径（不落盘）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-move-apply-'))
  const fromCwd = join(root, 'from-ws')
  const toCwd = join(root, 'to-ws')
  const sessionId = 'session-apply-1'
  try {
    mkdirSync(fromCwd, { recursive: true })
    mkdirSync(toCwd, { recursive: true })
    const dir = sessionDir(root, fromCwd, sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), syntheticLog(fromCwd, sessionId))
    const { persistence, registry } = stubs(root, fromCwd, toCwd, sessionId)
    const { ctx, state } = stubCtx({ persistence, registry })
    apply(ctx, {})
    const res = fakeRes()
    await moveRoute(state).handler(
      fakeReq({
        url: `${MOVE_API_PREFIX}/move`,
        method: 'POST',
        payload: { sessionId, targetWorkspace: 'to-ws', dryRun: true },
      }),
      res.res,
    )
    assert.equal(res.out.body.includes('"ok":true'), true, res.out.body)
    assert.equal(res.out.status, 200)
    const body = JSON.parse(res.out.body)
    assert.equal(body.ok, true)
    assert.equal(body.value.dryRunOnly, true)
    assert.equal(body.value.plan.generation, 'session.v3.jsonl.zstd')
    assert.equal(body.value.plan.bytesAfter > 0, true)
    // 预演不该动注册表。
    assert.equal(registry.list()[0].record.sessionIds.includes(sessionId), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('路由：move 对正在跑的会话直接拒绝', async () => {
  const { persistence, registry } = stubs('C:\\root', 'C:\\a', 'C:\\b', 'session-busy')
  const agents = { get: () => ({ status: 'running' }) }
  const { ctx, state } = stubCtx({ persistence, registry, agents })
  apply(ctx, {})
  const res = fakeRes()
  await moveRoute(state).handler(
    fakeReq({
      url: `${MOVE_API_PREFIX}/move`,
      method: 'POST',
      payload: { sessionId: 'session-busy', targetWorkspace: 'to-ws' },
    }),
    res.res,
  )
  assert.equal(res.out.status, 400)
  assert.match(JSON.parse(res.out.body).error.message, /running a turn/)
})

test('路由：move 真搬迁（临时目录里走完落盘+注册表+读回）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-move-real-'))
  const fromCwd = join(root, 'from-ws')
  const toCwd = join(root, 'to-ws')
  const sessionId = 'session-real-1'
  try {
    mkdirSync(fromCwd, { recursive: true })
    mkdirSync(toCwd, { recursive: true })
    mkdirSync(sessionDir(root, fromCwd, sessionId), { recursive: true })
    writeFileSync(join(sessionDir(root, fromCwd, sessionId), 'session.v3.jsonl.zstd'), syntheticLog(fromCwd, sessionId))

    const { persistence, registry } = stubs(root, fromCwd, toCwd, sessionId)
    const { ctx, state } = stubCtx({ persistence, registry })
    apply(ctx, {})
    const res = fakeRes()
    await moveRoute(state).handler(
      fakeReq({
        url: `${MOVE_API_PREFIX}/move`,
        method: 'POST',
        payload: { sessionId, targetWorkspace: 'to-ws' },
      }),
      res.res,
    )
    const body = JSON.parse(res.out.body)
    assert.equal(body.ok, true, res.out.body)
    const report = body.value
    assert.equal(report.ok, true, JSON.stringify(report.dshReadback ?? report.dshReadbackError))
    assert.equal(report.storage.moved, true)
    assert.equal(report.storage.verifiedHeader.cwd, toCwd)
    assert.equal(report.attachedTo, 'ws-to')
    assert.equal(report.detachedFrom, 'ws-from')
    assert.equal(report.registryHeaderCacheUpdated, true)
    assert.equal(report.dshReadback.headerCwd, toCwd)
    // 日志真的换了位置，源目录已清。
    assert.equal(existsSync(sessionDir(root, fromCwd, sessionId)), false)
    assert.equal(existsSync(join(sessionDir(root, toCwd, sessionId), 'session.v3.jsonl.zstd')), true)
    // 注册表成员换边。
    assert.deepEqual(registry.get('ws-to').record.sessionIds, [sessionId])
    assert.deepEqual(registry.get('ws-from').record.sessionIds, [])
    // 没装 dsh-memories 时不产生记忆作用域提示（装了才会带）。
    assert.equal(report.memoryScope, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('路由：move 在 cwd 已一致时只补注册表成员（归位 Ungrouped 会话）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-move-attach-'))
  const cwd = join(root, 'same-ws')
  const sessionId = 'session-unfiled-1'
  try {
    mkdirSync(cwd, { recursive: true })
    mkdirSync(sessionDir(root, cwd, sessionId), { recursive: true })
    const logPath = join(sessionDir(root, cwd, sessionId), 'session.v3.jsonl.zstd')
    writeFileSync(logPath, syntheticLog(cwd, sessionId))
    const before = readFileSync(logPath)

    // 会话没被任何工作区记账，但 cwd 已经等于目标工作区路径。
    const workspaces = [
      {
        id: 'ws-same',
        title: 'same-ws',
        path: cwd,
        sessionIds: [],
        record: { sessionIds: [] },
        attachSession: async (id) => {
          workspaces[0].record.sessionIds.push(id)
        },
        detachSession: async () => {},
      },
    ]
    const persistence = {
      root,
      compression: 'zstd',
      tracker: { writers: new Map() },
      async list() {
        return [{ header: { type: 'session', version: 3, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd } }]
      },
      async open() {
        return {
          header: { cwd },
          inheritedEventCount: 0,
          async read() {
            return { events: [] }
          },
          async close() {},
        }
      },
    }
    const registry = { archivedSessionIds: [], headers: new Map(), list: () => workspaces, get: (id) => workspaces.find((workspace) => workspace.id === id) }
    const { ctx, state } = stubCtx({ persistence, registry })
    apply(ctx, {})
    const res = fakeRes()
    await moveRoute(state).handler(
      fakeReq({ url: `${MOVE_API_PREFIX}/move`, method: 'POST', payload: { sessionId, targetWorkspace: 'same-ws' } }),
      res.res,
    )
    const body = JSON.parse(res.out.body)
    assert.equal(body.ok, true, res.out.body)
    assert.equal(body.value.attachOnly, true)
    assert.equal(body.value.attachedTo, 'ws-same')
    assert.equal(body.value.storage, undefined, 'attach-only must not touch the log')
    assert.deepEqual(workspaces[0].record.sessionIds, [sessionId])
    // 日志一个字节都没动。
    assert.equal(readFileSync(logPath).equals(before), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('工具：list 动作能回话（含工作区与会话行）', async () => {
  const { persistence, registry } = stubs('C:\\root', 'C:\\a', 'C:\\b', 'session-1')
  const { ctx, state } = stubCtx({ persistence, registry })
  apply(ctx, {})
  const value = await state.tools.find((entry) => entry.name === 'session_move').execute({ action: 'list' })
  assert.equal(value.ok, true)
  assert.equal(value.workspaces.length, 2)
  assert.match(value.summary, /stored sessions/)
})

test('volatile 旋钮：loader/volatile-update 之后立即生效，不用重挂', async () => {
  // 宿主把 volatile 字段以活引用（`{ get() }`）交给 apply，值在 Loader 写盘后原地更新，
  // 并补发一次 `loader/volatile-update`。这条测试钉住的是：重读活引用之后 HTTP 面立刻
  // 给出新值——插件页那张配置卡片就靠这条路径生效。
  const { persistence, registry } = stubs('C:\\root', 'C:\\a', 'C:\\b', 'session-1')
  let refuseRunning = true
  let maxSessions = 2000

  const { ctx, state, emit } = stubCtx({ persistence, registry })
  apply(ctx, {
    refuseRunning: { get: () => refuseRunning },
    maxSessions: { get: () => maxSessions },
  })

  const configOf = async () => {
    const res = fakeRes()
    await moveRoute(state).handler(fakeReq({ url: `${MOVE_API_PREFIX}/config` }), res.res)
    return JSON.parse(res.out.body).value
  }

  const before = await configOf()
  assert.equal(before.refuseRunning, true)
  assert.equal(before.maxSessions, 2000)

  refuseRunning = false
  maxSessions = 7
  emit('loader/volatile-update')

  const after = await configOf()
  assert.equal(after.refuseRunning, false, 'volatile 更新应立刻反映到 config 面')
  assert.equal(after.maxSessions, 7, 'volatile 更新应立刻反映到 config 面')
})