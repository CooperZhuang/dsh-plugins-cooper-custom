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
import { mountForkMembershipRepair } from '../lib/move.js'

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
function host({ workspacePath, attachThrows = false, withAttach = true } = {}) {
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
