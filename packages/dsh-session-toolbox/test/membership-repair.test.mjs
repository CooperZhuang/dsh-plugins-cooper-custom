/**
 * `mountForkMembershipRepair` 的单元测试：fork 子会话漏挂工作区时的创建期自愈。
 *
 * 背景是 2026-10-31 的实测事故：dsh-easyrewrite 两次「编辑重发」fork 出来的子会话
 * 最终都是 `ungrouped`，重启后侧栏里找不到。自愈只补记账、不碰 Host 源码，所以这里
 * 用假 ctx / 假注册表把每一条收窄规则都钉住：
 *
 *   - 正常 fork 子会话 → 挂回父会话所在工作区；
 *   - 已经记账 → 幂等，不重复 attach；
 *   - 子代理会话（origin: subagent）→ 不动；
 *   - 父会话没有归属 → 不猜，只记日志；
 *   - cwd 与工作区路径不一致 → 不挂；
 *   - attach 抛错 → 只记日志，绝不把异常抛给 Host。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountForkMembershipRepair, sweepForkChildrenOnBoot } from '../lib/move.js'

/** 造两个真实目录：工作区路径 + 一个不相干的目录（cwd 不匹配的用例）。 */
function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-membership-'))
  const workspace = join(root, 'ws')
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(workspace)
  mkdirSync(elsewhere)
  return { root, workspace, elsewhere, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * 假 Host：一个工作区（成员表放 `record.sessionIds`，与真注册表的「完整记账」一致），
 * 一个收集 attach 调用的实体，一个收集 `session/created` 监听器的 ctx。
 */
function host({ workspacePath, attachThrows = false, withAttach = true, headers = [] } = {}) {
  const attached = []
  const workspace = {
    id: 'ws-1',
    title: 'ws',
    path: workspacePath,
    record: { sessionIds: [] },
    sessionIds: [],
  }
  if (withAttach) {
    workspace.attachSession = async (sessionId) => {
      if (attachThrows) throw new Error('registry write failed')
      attached.push(sessionId)
      workspace.record.sessionIds.push(sessionId)
    }
  }
  const registry = { list: () => [workspace] }
  const listeners = []
  const lines = []
  const ctx = {
    workspaceRegistry: registry,
    sessionPersistence: headers === undefined ? undefined : {
      list: async () => headers.map((header) => ({ header })),
    },
    on(event, handler) {
      if (event === 'session/created') listeners.push(handler)
      return () => {}
    },
  }
  const log = (level, message) => lines.push({ level, message })
  return { ctx, log, workspace, attached, lines, emit: (session) => listeners[0](session) }
}

/** 一条普通 fork 子会话头（字段与 Host `session/fork` 写进去的 meta 一致）。 */
function forkChildHeader(cwd, parentSession = 'session-parent') {
  return {
    type: 'session',
    version: 4,
    id: 'session-child',
    createdAt: 1,
    cwd,
    parentSession,
    isSeeded: true,
    delegationDepth: 0,
  }
}

test('挂载后把 fork 子会话挂回父会话所在工作区', async () => {
  const d = dirs()
  try {
    const h = host({ workspacePath: d.workspace })
    h.workspace.record.sessionIds.push('session-parent')
    mountForkMembershipRepair(h.ctx, {}, h.log)

    await h.emit({ id: 'session-child', header: forkChildHeader(d.workspace) })

    assert.deepEqual(h.attached, ['session-child'])
    assert.ok(h.lines.some((line) => line.level === 'info' && line.message.includes('attached fork child')))
    assert.ok(h.lines.some((line) => line.message.includes('membership repair mounted')))
  } finally {
    d.cleanup()
  }
})

test('已记账的子会话直接返回（幂等，不重复 attach）', async () => {
  const d = dirs()
  try {
    const h = host({ workspacePath: d.workspace })
    // 幂等只看「是否已入册」，不看「是不是同一次事件」，所以已入册就一次都不该 attach。
    h.workspace.record.sessionIds.push('session-parent', 'session-child')
    mountForkMembershipRepair(h.ctx, {}, h.log)

    await h.emit({ id: 'session-child', header: forkChildHeader(d.workspace) })

    assert.deepEqual(h.attached, [])
  } finally {
    d.cleanup()
  }
})

test('子代理会话不动：origin=subagent 与 delegationDepth>0 都跳过', async () => {
  const d = dirs()
  try {
    const h = host({ workspacePath: d.workspace })
    h.workspace.record.sessionIds.push('session-parent')
    mountForkMembershipRepair(h.ctx, {}, h.log)

    const subagent = { ...forkChildHeader(d.workspace), origin: 'subagent', delegationDepth: 1 }
    await h.emit({ id: 'session-child', header: subagent })
    const nested = { ...forkChildHeader(d.workspace), delegationDepth: 2 }
    await h.emit({ id: 'session-child', header: nested })

    assert.deepEqual(h.attached, [])
  } finally {
    d.cleanup()
  }
})

test('父会话没有归属：不猜，只记一行日志', async () => {
  const d = dirs()
  try {
    const h = host({ workspacePath: d.workspace })
    mountForkMembershipRepair(h.ctx, {}, h.log)

    await h.emit({ id: 'session-child', header: forkChildHeader(d.workspace) })

    assert.deepEqual(h.attached, [])
    assert.ok(h.lines.some((line) => line.message.includes('belongs to no workspace')))
  } finally {
    d.cleanup()
  }
})

test('cwd 与工作区路径不一致：拒绝挂载', async () => {
  const d = dirs()
  try {
    const h = host({ workspacePath: d.workspace })
    h.workspace.record.sessionIds.push('session-parent')
    mountForkMembershipRepair(h.ctx, {}, h.log)

    await h.emit({ id: 'session-child', header: forkChildHeader(d.elsewhere) })

    assert.deepEqual(h.attached, [])
    assert.ok(h.lines.some((line) => line.level === 'warn' && line.message.includes('does not resolve to workspace')))
  } finally {
    d.cleanup()
  }
})

test('attach 抛错只记日志，不把异常抛回 Host', async () => {
  const d = dirs()
  try {
    const h = host({ workspacePath: d.workspace, attachThrows: true })
    h.workspace.record.sessionIds.push('session-parent')
    mountForkMembershipRepair(h.ctx, {}, h.log)

    await h.emit({ id: 'session-child', header: forkChildHeader(d.workspace) })

    assert.deepEqual(h.attached, [])
    assert.ok(h.lines.some((line) => line.level === 'warn' && line.message.includes('attach failed')))
  } finally {
    d.cleanup()
  }
})

test('非 fork 会话（没有 parentSession）完全不碰', async () => {
  const d = dirs()
  try {
    const h = host({ workspacePath: d.workspace })
    h.workspace.record.sessionIds.push('session-parent')
    mountForkMembershipRepair(h.ctx, {}, h.log)

    await h.emit({ id: 'fresh', header: { type: 'session', version: 4, id: 'fresh', cwd: d.workspace, isSeeded: false, delegationDepth: 0 } })

    assert.deepEqual(h.attached, [])
  } finally {
    d.cleanup()
  }
})

test('注册表不可用：只警告，不抛', () => {
  const lines = []
  const ctx = { workspaceRegistry: undefined, on: () => () => {} }
  mountForkMembershipRepair(ctx, {}, (level, message) => lines.push({ level, message }))
  assert.ok(lines.some((line) => line.level === 'warn' && line.message.includes('workspaceRegistry')))
})


// ---------------------------------------------------------------------------
// 启动期定向扫描（sweepForkChildrenOnBoot）
//
// 创建期补挂挡不住「记账写进去又被抹掉」的那一类：同机两个 Host 共用 $DSH_HOME 时，
// 另一个进程的旧内存快照会把 storages/workspace.json 整文件覆盖回去。所以挂载时
// 还要做一轮只认 fork 子会话的扫描。
// ---------------------------------------------------------------------------

test('启动扫描：挂载时把已经丢掉记账的 fork 子会话补回父工作区', async () => {
  const d = dirs()
  try {
    const accounted = { ...forkChildHeader(d.workspace, 'session-parent'), id: 'session-child' }
    const lost = { ...forkChildHeader(d.workspace, 'session-parent'), id: 'session-lost' }
    const h = host({ workspacePath: d.workspace, headers: [accounted, lost] })
    h.workspace.record.sessionIds.push('session-parent', 'session-child')

    // mount 返回启动扫描的 Promise：Host 忽略返回值，测试可 await 以获得确定性。
    const report = await mountForkMembershipRepair(h.ctx, {}, h.log)

    assert.deepEqual(h.attached, ['session-lost'])
    assert.equal(report.checked, 2)
    assert.equal(report.attached, 1)
    assert.ok(h.lines.some((line) => line.level === 'info' && line.message.includes('boot-sweep')))
  } finally {
    d.cleanup()
  }
})

test('启动扫描：已记账、子代理、非 fork 会话都不动', async () => {
  const d = dirs()
  try {
    const accounted = { ...forkChildHeader(d.workspace, 'session-parent'), id: 'session-accounted' }
    const subagent = { ...forkChildHeader(d.workspace, 'session-parent'), id: 'session-sub', origin: 'subagent', delegationDepth: 1 }
    const plain = { type: 'session', version: 4, id: 'session-plain', cwd: d.workspace, isSeeded: false, delegationDepth: 0 }
    const h = host({ workspacePath: d.workspace, headers: [accounted, subagent, plain] })
    h.workspace.record.sessionIds.push('session-parent', 'session-accounted')

    const report = await sweepForkChildrenOnBoot(h.ctx, {}, h.log)

    assert.deepEqual(h.attached, [])
    // 只有 accounted 是「普通 fork 子会话」；subagent 与 plain 都被 isForkChild 挡掉。
    assert.equal(report.checked, 1)
    assert.equal(report.attached, 0)
  } finally {
    d.cleanup()
  }
})

test('启动扫描：父会话没有归属或 cwd 不匹配都不挂', async () => {
  const d = dirs()
  try {
    const orphan = { ...forkChildHeader(d.workspace, 'session-nowhere'), id: 'session-orphan' }
    const misplaced = { ...forkChildHeader(d.elsewhere, 'session-parent'), id: 'session-misplaced' }
    const h = host({ workspacePath: d.workspace, headers: [orphan, misplaced] })
    h.workspace.record.sessionIds.push('session-parent')

    const report = await sweepForkChildrenOnBoot(h.ctx, {}, h.log)

    assert.deepEqual(h.attached, [])
    assert.equal(report.attached, 0)
    assert.ok(h.lines.some((line) => line.message.includes('belongs to no workspace')))
    assert.ok(h.lines.some((line) => line.level === 'warn' && line.message.includes('does not resolve to workspace')))
  } finally {
    d.cleanup()
  }
})

test('启动扫描：配置关闭时不扫描', async () => {
  const d = dirs()
  try {
    const lost = { ...forkChildHeader(d.workspace, 'session-parent'), id: 'session-lost' }
    const h = host({ workspacePath: d.workspace, headers: [lost] })
    h.workspace.record.sessionIds.push('session-parent')

    const report = await sweepForkChildrenOnBoot(h.ctx, { repairForkChildrenOnBoot: false }, h.log)

    assert.deepEqual(h.attached, [])
    assert.equal(report.skipped, 'disabled')
  } finally {
    d.cleanup()
  }
})

test('启动扫描：没有 sessionPersistence 或注册表时安全跳过，不抛', async () => {
  const header = forkChildHeader('/tmp')
  const h = host({ workspacePath: '/tmp', headers: [header] })
  h.ctx.sessionPersistence = undefined
  const report = await sweepForkChildrenOnBoot(h.ctx, {}, h.log)
  assert.equal(report.skipped, 'persistence-unavailable')

  const noRegistry = { sessionPersistence: { list: async () => [] } }
  const report2 = await sweepForkChildrenOnBoot(noRegistry, {}, h.log)
  assert.equal(report2.skipped, 'registry-unavailable')
})

test('启动扫描：list 抛错只记日志', async () => {
  const d = dirs()
  try {
    const h = host({ workspacePath: d.workspace, headers: [] })
    h.ctx.sessionPersistence = { list: async () => { throw new Error('listing broke') } }
    const report = await sweepForkChildrenOnBoot(h.ctx, {}, h.log)
    assert.equal(report.skipped, 'listing-failed')
    assert.ok(h.lines.some((line) => line.level === 'warn' && line.message.includes('listing broke')))
  } finally {
    d.cleanup()
  }
})

