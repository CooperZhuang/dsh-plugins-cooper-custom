/**
 * `dsh-session-store/registry` 的单测：工作区归属、驻留、「正在跑一轮」、内存 cwd 重定向。
 *
 * 桩形状照着两个插件真实拿到的服务写：`workspace.sessionIds` 是**过滤过的视图**，
 * 完整记账在 `workspace.record.sessionIds`（这是最容易写错的一处，见模块注释）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SESSION_RUNNING_STATUS,
  accountedSessionIds,
  agentSessionStatus,
  archivedSessionIds,
  findWorkspace,
  redirectSessionWriters,
  releaseSessionEverywhere,
  residentSessionIds,
  runningSessionIds,
  sessionWriteHandles,
  workspaceOwningSession,
} from '../lib/registry.js'

test('residentSessionIds：服务缺失/抛错都退化成空集合', () => {
  assert.deepEqual([...residentSessionIds(undefined)], [])
  assert.deepEqual([...residentSessionIds({})], [])
  assert.deepEqual([...residentSessionIds({ list: () => [{ id: 'a' }, { id: 'b' }] })], ['a', 'b'])
  assert.deepEqual([...residentSessionIds({ list: () => undefined })], [])
  assert.deepEqual([...residentSessionIds({ list: () => { throw new Error('down') } })], [])
  // id 归一成字符串，界面/守卫两边比的是同一个东西。
  assert.deepEqual([...residentSessionIds({ list: () => [{ id: 7 }] })], ['7'])
})

test('agentSessionStatus：拿不到服务就是「未知」，不是「在跑」', () => {
  const agents = { get: (id) => (id === 'a' ? { status: 'running' } : id === 'b' ? { status: 'idle' } : undefined) }
  assert.equal(agentSessionStatus(agents, 'a'), 'running')
  assert.equal(agentSessionStatus(agents, 'b'), 'idle')
  assert.equal(agentSessionStatus(agents, 'c'), undefined)
  assert.equal(agentSessionStatus(undefined, 'a'), undefined)
  assert.equal(agentSessionStatus({ get: () => { throw new Error('down') } }, 'a'), undefined)
  assert.equal(agentSessionStatus({ get: () => ({ status: 42 }) }, 'a'), undefined)
})

test('runningSessionIds：驻留 ∩ running；拿不到 agents 时保守全算在跑', () => {
  const residents = new Set(['a', 'b', 'c'])
  const agents = { get: (id) => ({ a: { status: 'running' }, b: { status: 'idle' }, c: { status: 'running' } })[id] }
  assert.deepEqual([...runningSessionIds(residents, agents)].sort(), ['a', 'c'])
  // 服务缺失：宁可拒绝，不可误删/误搬——原样返回驻留集合。
  assert.equal(runningSessionIds(residents, undefined), residents)
  assert.equal(runningSessionIds(residents, {}), residents)
  // 单条查询抛错也算在跑。
  const flaky = { get: (id) => { if (id === 'b') throw new Error('boom'); return undefined } }
  assert.deepEqual([...runningSessionIds(residents, flaky)], ['b'])
  assert.equal(SESSION_RUNNING_STATUS, 'running')
})

test('accountedSessionIds：完整记账在 record 里，没有 record 就是 undefined', () => {
  assert.deepEqual(accountedSessionIds({ record: { sessionIds: ['a'] } }), ['a'])
  assert.equal(accountedSessionIds({ sessionIds: ['a'] }), undefined)
  assert.equal(accountedSessionIds(undefined), undefined)
  assert.equal(accountedSessionIds({ record: { sessionIds: 'oops' } }), undefined)
})

test('archivedSessionIds：id 归一成字符串', () => {
  assert.deepEqual([...archivedSessionIds({ archivedSessionIds: ['a', 7] })], ['a', '7'])
  assert.deepEqual([...archivedSessionIds({ archivedSessionIds: undefined })], [])
  assert.deepEqual([...archivedSessionIds({ archivedSessionIds: 'oops' })], [])
})

test('workspaceOwningSession 按完整记账找归属', () => {
  const one = { id: 'ws-1', record: { sessionIds: ['session-1'] } }
  const two = { id: 'ws-2', record: { sessionIds: [] } }
  assert.equal(workspaceOwningSession([one, two], 'session-1'), one)
  assert.equal(workspaceOwningSession([one, two], 'session-2'), undefined)
  // 只有「可见视图」没有完整记账的工作区不参与判定。
  assert.equal(workspaceOwningSession([{ id: 'ws-3', sessionIds: ['session-1'] }], 'session-1'), undefined)
})

test('findWorkspace 按 id → path → title 找，后两者不区分大小写', () => {
  const list = [
    { id: 'ws-1', path: 'C:\\Work', title: '示例工作区' },
    { id: 'ws-2', path: 'C:\\Other', title: 'Second' },
  ]
  assert.equal(findWorkspace(list, 'ws-1').id, 'ws-1')
  assert.equal(findWorkspace(list, 'c:\\work').id, 'ws-1')
  assert.equal(findWorkspace(list, 'second').id, 'ws-2')
  assert.equal(findWorkspace(list, 'nope'), undefined)
  assert.equal(findWorkspace(list, ''), undefined)
  assert.equal(findWorkspace(list, undefined), undefined)
  // id 是精确匹配（不做大小写折叠）
  assert.equal(findWorkspace(list, 'WS-1'), undefined)
})

test('releaseSessionEverywhere：成员表 + 归档集合 + 置顶集合，幂等', async () => {
  const calls = []
  const membership = new Set(['session-1'])
  const registry = {
    list: () => [{
      id: 'ws-1',
      get sessionIds() { return [...membership] },
      async detachSession(id) { calls.push(['detachSession', id]); membership.delete(id) },
    }],
    async unarchiveSession(id) { calls.push(['unarchiveSession', id]) },
    async unpinSession(id) { calls.push(['unpinSession', id]) },
  }
  assert.deepEqual(await releaseSessionEverywhere(registry, 'session-1'), ['ws-1'])
  assert.deepEqual(calls, [['detachSession', 'session-1'], ['unarchiveSession', 'session-1'], ['unpinSession', 'session-1']])
  // 第二次：成员表里已经没有了，但归档/置顶仍然无条件调用（幂等，不多写盘）。
  calls.length = 0
  assert.deepEqual(await releaseSessionEverywhere(registry, 'session-1'), [])
  assert.deepEqual(calls, [['unarchiveSession', 'session-1'], ['unpinSession', 'session-1']])
  // 登记表本身抛错时原样向上抛（调用方要把「摘不掉」变成拒绝删除的理由）。
  await assert.rejects(() => releaseSessionEverywhere({ list: () => { throw new Error('registry unavailable') } }, 'session-1'), /registry unavailable/)
})

test('sessionWriteHandles：只在后端暴露 tracker.writers 时给句柄表', () => {
  const writers = new Map()
  assert.equal(sessionWriteHandles({ tracker: { writers } }), writers)
  assert.equal(sessionWriteHandles({ tracker: {} }), undefined)
  assert.equal(sessionWriteHandles({}), undefined)
  assert.equal(sessionWriteHandles(undefined), undefined)
})

test('redirectSessionWriters：句柄 / 驻留对象 / 注册表头部缓存三处一起改', async () => {
  const flushed = []
  const handle = { header: { id: 'session-1', cwd: 'C:\\old' }, async flush() { flushed.push('flush') } }
  const writers = new Map([['session-1', handle]])
  const live = { id: 'session-1', header: { id: 'session-1', cwd: 'C:\\old' } }
  const sessions = { get: (id) => (id === 'session-1' ? live : undefined) }
  const registry = { headers: new Map([['session-1', { id: 'session-1', cwd: 'C:\\old' }]]) }

  const outcome = await redirectSessionWriters({ writers, sessions, registry, sessionId: 'session-1', cwd: 'C:\\new' })
  assert.equal(outcome.writeHandleRedirected, true)
  assert.equal(outcome.liveHeaderUpdated, true)
  assert.equal(outcome.registryHeaderCacheUpdated, true)
  assert.equal(outcome.liveSession, live)
  assert.equal(outcome.flushError, undefined)
  assert.deepEqual(flushed, ['flush'])
  assert.equal(handle.header.cwd, 'C:\\new')
  assert.equal(live.header.cwd, 'C:\\new')
  assert.equal(registry.headers.get('session-1').cwd, 'C:\\new')
  // 原 header 对象不被就地改写（保留 id 等其余键）。
  assert.equal(handle.header.id, 'session-1')
})

test('redirectSessionWriters：flush 失败只记录；缺句柄/缺驻留/无缓存时不误报', async () => {
  const handle = { header: { id: 'session-1', cwd: 'C:\\old' }, async flush() { throw new Error('disk gone') } }
  const outcome = await redirectSessionWriters({
    writers: new Map([['session-1', handle]]),
    sessions: undefined,
    registry: {},
    sessionId: 'session-1',
    cwd: 'C:\\new',
  })
  assert.equal(outcome.flushError, 'disk gone')
  assert.equal(outcome.writeHandleRedirected, true)
  assert.equal(handle.header.cwd, 'C:\\new')
  assert.equal(outcome.liveHeaderUpdated, false)
  assert.equal(outcome.registryHeaderCacheUpdated, false)
  assert.equal(outcome.liveSession, undefined)

  // 完全没有可改的东西。
  const nothing = await redirectSessionWriters({ writers: undefined, sessions: {}, registry: {}, sessionId: 'x', cwd: 'C:\\new' })
  assert.deepEqual(nothing, {
    writeHandleRedirected: false,
    liveHeaderUpdated: false,
    registryHeaderCacheUpdated: false,
    liveSession: undefined,
  })
  // header 不是对象（半截句柄）时不动它。
  const half = await redirectSessionWriters({ writers: new Map([['x', {}]]), sessions: {}, registry: {}, sessionId: 'x', cwd: 'C:\\new' })
  assert.equal(half.writeHandleRedirected, false)
})
