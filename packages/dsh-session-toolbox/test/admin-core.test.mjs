/**
 * `dsh-session-toolbox` **删除半边**的沙箱单测（原 `dsh-session-admin/test/core.test.mjs`，
 * 只改了 import：entry 面拆到 `lib/index.js` + `lib/admin.js`）。
 *
 * 不依赖 DSH 运行时：在临时目录里搭一个假的 `$DSH_HOME`（会话日志 + projcache +
 * workspace.json + rewind-snapshots），再验证扫描分类、范围筛选、逐条守卫与清理。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import zlib from 'node:zlib'

import { Config, decodeProjectKey, resolveConfig } from '../lib/index.js'
import { createSessionAdmin, isInside, isTrustedRequest } from '../lib/admin.js'

/** 会话日志第一行（头部）。 */
function headerLine(id, cwd, extra = {}) {
  return JSON.stringify({ version: 3, id, createdAt: Date.now(), cwd, isSeeded: false, ...extra })
}

/**
 * 写一个会话的持久化数据。
 * @param home - 沙箱 DSH 主目录。
 * @param project - `sessions/` 下的项目目录键。
 * @param id - 会话 id。
 * @param options - `cwd` / `title` / `header` / `rewind`。
 */
function writeSession(home, project, id, options = {}) {
  const dir = join(home, 'sessions', project, id)
  mkdirSync(dir, { recursive: true })
  const header = options.header ?? { cwd: options.cwd ?? 'C:\\work' }
  // 真实的会话日志是**多个 zstd 帧**拼接：第 0 帧恰好只有头部行，之后每帧是一批
  // 事件。DSH 自己会校验这一点（`assertIndependentHeaderFrame`：first frame is
  // not exactly one header line），把头和事件压进同一帧会让整个 profile 启动失败。
  // 夹具必须照着写，否则它只验证得了「我们的读取器宽松」而不是真实形状。
  const headerFrame = zlib.zstdCompressSync(Buffer.from(`${headerLine(id, header.cwd ?? null, header)}\n`, 'utf8'))
  const eventFrame = zlib.zstdCompressSync(Buffer.from('{"type":"turn/start"}\n', 'utf8'))
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([headerFrame, eventFrame]))

  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, `${id}.json`),
    JSON.stringify({
      version: 7,
      record: {
        identity: { cwd: options.cwd ?? 'C:\\work', createdAt: Date.now() },
        rows: { title: { val: options.title ?? null } },
      },
    }),
  )

  if (options.rewind === true) {
    const rewind = join(home, 'rewind-snapshots', id)
    mkdirSync(rewind, { recursive: true })
    writeFileSync(join(rewind, 'snap.json'), '{}')
  }
}

/** 在沙箱里写一份工作区注册表。 */
function writeWorkspace(home, workspaces, archived = []) {
  const dir = join(home, 'storages')
  mkdirSync(dir, { recursive: true })
  const tables = {}
  for (const [id, spec] of Object.entries(workspaces)) {
    tables[id] = {
      path: spec.path,
      title: spec.title,
      sessionIds: spec.sessionIds,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }
  writeFileSync(
    join(dir, 'workspace.json'),
    JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: Object.keys(workspaces), archivedSessionIds: archived }, tables: { workspaces: tables } }),
  )
}

describe('dsh-session-admin core', () => {
  let home
  let tempRoot
  let admin

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'session-admin-test-'))
    // 沙箱自己就在系统 Temp 里，所以「临时目录」判定用沙箱内一个专门的假 temp 根，
    // 这样 workdir 上的会话不会被误判成 temp。
    tempRoot = join(home, 'fake-temp')
    const work = join(home, 'workdir')
    mkdirSync(work, { recursive: true })
    const underTemp = join(tempRoot, 'probe-001')
    mkdirSync(underTemp, { recursive: true })
    const gone = join(home, 'gone-dir')

    // 工作区会话（应被默认守卫拒绝）
    writeSession(home, '--proj-a--', 'session-in-workspace', { cwd: work, title: '工作区里的会话', rewind: true })
    // 未分组、目录仍存在（默认也会被删——scope 不拦，只有工作区/归档/子代理才拦）
    writeSession(home, '--proj-a--', 'session-ungrouped', { cwd: work, title: '未分组会话' })
    // 目录已消失 → temp
    writeSession(home, '--proj-b--', 'session-missing-dir', { cwd: gone, title: '目录没了的会话' })
    // 工作目录落在（假）临时根下 → temp
    writeSession(home, '--proj-c--', 'session-in-temp', { cwd: underTemp, title: '临时目录里的会话' })
    // 归档会话
    writeSession(home, '--proj-b--', 'session-archived', { cwd: work, title: '归档会话' })
    // 子代理子会话
    writeSession(home, '--proj-b--', 'session-child', {
      cwd: work,
      title: '子代理',
      header: { cwd: work, origin: 'subagent', parentSession: 'session-ungrouped' },
    })

    writeWorkspace(
      home,
      {
        'ws-1': { path: 'C:\\work', title: '示例工作区', sessionIds: ['session-in-workspace'] },
      },
      ['session-archived'],
    )

    admin = createSessionAdmin({ home, tempRoots: [tempRoot] })
  })

  after(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  })

  it('扫描出全部会话并正确分类', () => {
    const records = admin.scan()
    const byId = new Map(records.map((r) => [r.id, r]))
    assert.equal(records.length, 6)

    const inWorkspace = byId.get('session-in-workspace')
    assert.equal(inWorkspace.workspaceTitle, '示例工作区')
    assert.equal(inWorkspace.workspaceId, 'ws-1')
    assert.equal(inWorkspace.ungrouped, false)
    assert.equal(inWorkspace.hasRewind, true)

    assert.equal(byId.get('session-ungrouped').ungrouped, true)
    assert.equal(byId.get('session-ungrouped').temp, false)

    const missing = byId.get('session-missing-dir')
    assert.equal(missing.cwdMissing, true)
    assert.equal(missing.temp, true)

    const inTemp = byId.get('session-in-temp')
    assert.equal(inTemp.cwdMissing, false)
    assert.equal(inTemp.temp, true)

    assert.equal(byId.get('session-archived').archived, true)
    assert.equal(byId.get('session-child').subagent, true)
    assert.equal(byId.get('session-child').parentSessionId, 'session-ungrouped')
  })

  it('按范围筛选会话', () => {
    const records = admin.scan()
    const ids = (scope) => admin.select(records, { scope }).map((r) => r.id).sort()
    // ungrouped 必须与侧边栏的「未分组」逐行等价：不含归档、不含子代理。
    assert.deepEqual(ids('ungrouped'), ['session-in-temp', 'session-missing-dir', 'session-ungrouped'])
    assert.deepEqual(ids('temp'), ['session-in-temp', 'session-missing-dir'])
    assert.deepEqual(ids('archived'), ['session-archived'])
    assert.deepEqual(ids('subagent'), ['session-child'])
    assert.equal(ids('all').length, 6)
    // 三个范围互不重叠，且 ungrouped ⊂ all
    const union = new Set([...ids('ungrouped'), ...ids('archived'), ...ids('subagent')])
    assert.equal(union.size, 5)
  })

  it('dryRun 不动任何文件', async () => {
    const target = join(home, 'sessions', '--proj-a--', 'session-ungrouped')
    const result = await admin.remove(['session-ungrouped'], { dryRun: true })
    assert.equal(result.removed, 1)
    assert.equal(result.results[0].status, 'would-remove')
    assert.equal(existsSync(target), true)
  })

  it('守卫：工作区 / 归档 / 子代理 / 活会话一律拒绝', async () => {
    const result = await admin.remove(
      ['session-in-workspace', 'session-archived', 'session-child', 'session-ungrouped'],
      { live: new Set(['session-ungrouped']) },
    )
    const reasons = new Map(result.results.map((r) => [r.id, r.reason]))
    assert.equal(reasons.get('session-in-workspace'), 'workspace-session')
    assert.equal(reasons.get('session-archived'), 'archived-session')
    assert.equal(reasons.get('session-child'), 'subagent-session')
    assert.equal(reasons.get('session-ungrouped'), 'running-session')
    assert.equal(result.removed, 0)
  })

  it('拒绝删除调用方自己的会话', async () => {
    const result = await admin.remove(['session-ungrouped'], { callerSessionId: 'session-ungrouped' })
    assert.equal(result.results[0].reason, 'caller-session')
  })

  it('拒绝未知 id，且不越出 sessions 根目录', async () => {
    const result = await admin.remove(['nope'], {})
    assert.equal(result.results[0].reason, 'not-found')
  })

  it('显式放开守卫后真的删掉三处数据并清空空目录', async () => {
    const result = await admin.remove(['session-in-workspace', 'session-ungrouped'], {
      includeWorkspace: true,
    })
    assert.equal(result.removed, 2)
    assert.equal(existsSync(join(home, 'sessions', '--proj-a--', 'session-in-workspace')), false)
    assert.equal(existsSync(join(home, 'sessions', '--proj-a--', 'session-ungrouped')), false)
    assert.equal(existsSync(join(home, 'storages', 'session_projcache', 'sessions', 'session-in-workspace.json')), false)
    assert.equal(existsSync(join(home, 'rewind-snapshots', 'session-in-workspace')), false)
    // --proj-a-- 里两个会话都删了，空目录应被清掉
    assert.equal(existsSync(join(home, 'sessions', '--proj-a--')), false)
    assert.deepEqual(result.pruned, ['--proj-a--'])
    // 剩下的仍在
    assert.equal(existsSync(join(home, 'sessions', '--proj-b--', 'session-child')), true)
  })

  it('maxBatch 生效', async () => {
    const result = await admin.remove(['session-archived', 'session-child'], {
      includeArchived: true,
      includeSubagent: true,
      maxBatch: 1,
    })
    assert.equal(result.removed, 1)
    assert.equal(result.results.filter((r) => r.reason === 'batch-limit').length, 1)
  })

  it('删文件之前先把会话从登记表里摘掉，dryRun 不摘', async () => {
    const dir = join(home, 'workdir-release')
    mkdirSync(dir, { recursive: true })
    writeSession(home, '--proj-z--', 'session-release', { cwd: dir, title: '待摘' })

    const calls = []
    const dirStillThere = []
    const scoped = createSessionAdmin({
      home,
      tempRoots: [tempRoot],
      releaseSession: async (id) => {
        calls.push(id)
        dirStillThere.push(existsSync(join(home, 'sessions', '--proj-z--', id)))
      },
    })

    await scoped.remove(['session-release'], { dryRun: true })
    assert.deepEqual(calls, [], 'dryRun 不该碰登记表')

    await scoped.remove(['session-release'], {})
    assert.deepEqual(calls, ['session-release'])
    // 顺序是硬要求：成员关系是按会话头索引过滤过的视图，文件一删就查不到了。
    assert.deepEqual(dirStillThere, [true], '摘登记表必须早于删文件')
  })

  it('摘不掉登记表就不删文件，并留下可读的失败原因', async () => {
    const dir = join(home, 'workdir-stuck')
    mkdirSync(dir, { recursive: true })
    writeSession(home, '--proj-z--', 'session-stuck', { cwd: dir, title: '摘不掉' })

    const scoped = createSessionAdmin({
      home,
      tempRoots: [tempRoot],
      releaseSession: async () => {
        throw new Error('registry down')
      },
    })
    const result = await scoped.remove(['session-stuck'], {})

    assert.equal(result.removed, 0)
    assert.equal(result.results[0].status, 'failed')
    assert.equal(result.results[0].reason, 'workspace: registry down')
    assert.equal(existsSync(join(home, 'sessions', '--proj-z--', 'session-stuck')), true, '摘不掉就不该删')
  })
})

describe('辅助函数', () => {
  it('decodeProjectKey 还原路径分隔符与转义', () => {
    assert.equal(decodeProjectKey('--C-CodeRepository-dsh-memories--'), 'C:\\CodeRepository\\dsh\\memories')
    assert.equal(decodeProjectKey('--C-Program~0020Files~0020~0028x86~0029--'), 'C:\\Program Files (x86)')
  })

  it('isInside 挡住目录穿越', () => {
    const root = join(tmpdir(), 'root')
    assert.equal(isInside(root, join(root, 'a', 'b')), true)
    assert.equal(isInside(root, join(root, '..', 'evil')), false)
    assert.equal(isInside(root, root), true)
  })

  it('isTrustedRequest 默认只信回环', () => {
    assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080' } }), true)
    assert.equal(isTrustedRequest({ headers: { host: 'localhost:3080' } }), true)
    assert.equal(isTrustedRequest({ headers: { host: '10.0.0.5:3080' } }), false)
    assert.equal(isTrustedRequest({ headers: { host: '10.0.0.5:3080' } }, ['10.0.0.5:3080']), true)
    assert.equal(
      isTrustedRequest({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }),
      false,
    )
    assert.equal(
      isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }),
      false,
    )
    assert.equal(
      isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }),
      true,
    )
    assert.equal(isTrustedRequest({ headers: {} }), false)
  })

  it('配置的默认值一律落在安全的一侧', () => {
    // `Config()` 对 volatile 字段输出的是活引用（`{ get() }`），所以要经 `resolveConfig`
    // 收敛成普通值再断言——运行时那条路径走的也是同一个函数。
    const config = resolveConfig({})
    // 真正危险的三项必须默认关闭：工作区会话、Host 持有的会话、回环之外的信源。
    assert.equal(config.allowWorkspaceSessions, false)
    assert.equal(config.allowLiveSessions, false)
    // 合并后两个 allowHosts 拆成两个键（两半的栅栏语义不同），默认都必须为空。
    assert.deepEqual(config.adminAllowHosts, [])
    assert.deepEqual(config.moveAllowHosts, [])
    // 标题栏垃圾桶默认开启，但它的安全性来自**形态**而不是默认值：图标不占字面
    // 标签（标签会招来点击），点击后 Host 先跑一次预演，前端再弹确认框——
    // 离真正删除隔着两步。
    assert.equal(config.headerDeleteButton, true)
    // 显式关闭仍然有效
    assert.equal(resolveConfig({ headerDeleteButton: false }).headerDeleteButton, false)
    // volatile 字段接受活引用；解包后就是普通值。
    assert.equal(resolveConfig({ maxBatch: { get: () => 7 } }).maxBatch, 7)
  })
})
