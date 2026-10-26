/**
 * 会话**归属**知识：工作区注册表（`ctx.workspaceRegistry`）、驻留会话、以及「正在跑一轮」。
 *
 * 这份知识在两个插件里各有一半，写在一处才不会走形：
 *   - `dsh-session-admin` 要判断「这条会话属于哪个工作区 / 归档没有」才能决定能不能删，
 *     并在删文件**之前**把它从登记表里摘掉；
 *   - `dsh-session-move` 要判断「属于谁 / 目标工作区是哪一个 / 正在跑没有」才能搬，
 *     并在搬完之后 attach 目标、detach 原属、把内存里缓存的 cwd 一起改掉。
 *
 * ## 三个容易踩的坑（都是实测结论，不是推测）
 *
 * 1. **`workspace.sessionIds` 是「按会话头索引过滤过的视图」**，不是完整记账：
 *    DSH 每次读取都用 `realpath(header.cwd) === workspace.path` 过滤一遍。完整记账在
 *    `workspace.record.sessionIds`（见 {@link accountedSessionIds}）。
 *    会话目录一删，`sessionIds` 就再也查不到这条会话——所以「摘登记表」必须早于「删文件」。
 * 2. **「挂着」≠「正在跑」**：会话在创建 agent 时被 enter，只在 agent dispose 时才 detach，
 *    长期运行的 `dsh web` 里只要碰过就基本一直挂着。删/搬的守卫只认「正在跑一轮」。
 * 3. **`workspace.json` 里的工作区对象自身不带 id**，id 只存在于外层键上；从磁盘读表时
 *    必须重新组装视图，否则所有守卫会因为 `owner.workspaceId === undefined` 静默失效。
 *
 * 出错时的策略刻意**不统一**，两边各自保留（见各函数的文档）：
 * 拿不到 `agents` 服务时 admin 保守地把全部驻留会话当成「在跑」（宁可拒绝），
 * move 则把状态当成未知（`undefined`，界面照常显示）。
 *
 * @module dsh-session-store/registry
 */

/** agent 表示「这一轮还在跑」的状态值。 */
export const SESSION_RUNNING_STATUS = 'running'

/**
 * Host 进程里仍挂着的会话 id 集合（`ctx.sessions.list()`）。
 *
 * 服务缺失或抛错时退化成空集合——**这个集合只用于界面提示，不要拿它当删除守卫**
 * （理由见模块注释第 2 条）。
 * @param sessions - `ctx.get('sessions')` 拿到的会话服务（可为 undefined）。
 * @returns `Set<string>`。
 */
export function residentSessionIds(sessions) {
  const ids = new Set()
  try {
    const list = typeof sessions?.list === 'function' ? sessions.list() : []
    for (const session of list) ids.add(String(session.id))
  } catch {
    /* 没有会话存储时视为无驻留 */
  }
  return ids
}

/**
 * 一条会话的 agent 状态（`ctx.get('agents').get(id)?.status`）。
 * @param agents - `ctx.get('agents')` 拿到的 agent 服务（可为 undefined）。
 * @param sessionId - 会话 id。
 * @returns 状态字符串；没有 agent、拿不到服务或抛错时 `undefined`（**未知**）。
 */
export function agentSessionStatus(agents, sessionId) {
  try {
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    return agent !== undefined && typeof agent.status === 'string' ? agent.status : undefined
  } catch {
    return undefined
  }
}

/**
 * 真正「正在跑一轮」的会话：驻留集合里 agent 状态为 {@link SESSION_RUNNING_STATUS} 的那部分。
 *
 * 拿不到 agents 服务时**保守退化**为「全部驻留会话都算在跑」——宁可拒绝，不可误删/误搬。
 * 单条查询抛错也算在跑（同一条原则）。
 * @param residents - {@link residentSessionIds} 的结果。
 * @param agents - `ctx.get('agents')`。
 * @returns `Set<string>`（可能就是 `residents` 本身）。
 */
export function runningSessionIds(residents, agents) {
  if (agents === undefined || typeof agents.get !== 'function') return residents
  const running = new Set()
  for (const id of residents) {
    try {
      if (agents.get(id)?.status === SESSION_RUNNING_STATUS) running.add(id)
    } catch {
      running.add(id)
    }
  }
  return running
}

/**
 * 工作区的**完整记账**成员表（`workspace.record.sessionIds`）。
 * @param workspace - 工作区实体。
 * @returns id 数组；实体没有 record 视图时 `undefined`。
 */
export function accountedSessionIds(workspace) {
  const record = workspace?.record
  return record !== undefined && Array.isArray(record.sessionIds) ? record.sessionIds : undefined
}

/**
 * 归档集合（`registry.archivedSessionIds`）。
 * @param registry - `ctx.workspaceRegistry`。
 * @returns `Set<string>`（id 归一成字符串）。
 */
export function archivedSessionIds(registry) {
  return new Set(Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.map(String) : [])
}

/**
 * 按**完整记账**找出会话所属的工作区。
 * @param workspaces - 工作区实体数组（通常是 `registry.list()`）。
 * @param sessionId - 会话 id。
 * @returns 工作区实体，或 `undefined`。
 */
export function workspaceOwningSession(workspaces, sessionId) {
  for (const workspace of workspaces) {
    const ids = accountedSessionIds(workspace)
    if (ids !== undefined && ids.includes(sessionId)) return workspace
  }
  return undefined
}

/**
 * 按 id → path → title 的顺序找一个工作区（后两者不区分大小写）。
 * @param workspaces - 工作区实体数组（通常是 `registry.list()`）。
 * @param key - id、绝对路径或标题；空值一律不匹配。
 * @returns 工作区实体，或 `undefined`。
 */
export function findWorkspace(workspaces, key) {
  if (typeof key !== 'string' || key.length === 0) return undefined
  for (const workspace of workspaces) if (String(workspace.id) === key) return workspace
  const lowered = key.toLowerCase()
  for (const workspace of workspaces) if (String(workspace.path).toLowerCase() === lowered) return workspace
  for (const workspace of workspaces) if (String(workspace.title).toLowerCase() === lowered) return workspace
  return undefined
}

/**
 * 把一个即将被删除的会话从它登记过的每个持久结构里摘掉。
 *
 * 走 `workspaceRegistry`（宿主的权威登记表）而不是直接改 `storages/workspace.json`：
 * 宿主自己也把这份表放在内存里，手改文件要么被下一次写入覆盖，要么让内存与磁盘脱节。
 *
 * 覆盖三处：工作区成员表、归档集合、置顶集合。后两个是幂等的（不在集合里就不写盘），
 * 所以无条件调用它们不会产生多余的写入。
 *
 * **必须在删文件之前调用**：`Workspace.sessionIds` 是按会话头索引过滤过的视图，
 * 目录一删，成员关系就再也查不到了。
 * @param registry - `ctx.workspaceRegistry`。
 * @param sessionId - 即将删除的会话 id。
 * @returns 全部持久写入完成之后 resolve；值是真正被 detach 的工作区 id 列表。
 */
export async function releaseSessionEverywhere(registry, sessionId) {
  const detached = []
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    await workspace.detachSession(sessionId)
    detached.push(String(workspace.id))
  }
  await registry.unarchiveSession(sessionId)
  await registry.unpinSession(sessionId)
  return detached
}

/**
 * 持久化后端的**写入句柄表**（`persistence.tracker.writers`）。
 *
 * 有句柄 = 这条会话随时可能落盘。搬迁必须抢在它下一次 append 之前把 header 改掉。
 * @param persistence - `ctx.sessionPersistence`（可为 undefined）。
 * @returns `Map<id, handle>`，或 `undefined`（后端不暴露 tracker 时）。
 */
export function sessionWriteHandles(persistence) {
  const tracker = persistence?.tracker
  return tracker !== undefined && tracker.writers instanceof Map ? tracker.writers : undefined
}

/**
 * 把「这条会话以后往哪写」在**内存里**也改成新 cwd。
 *
 * 搬迁只搬了磁盘上的目录，内存里还有三处记着旧 cwd，漏掉任何一处都会让下一次 append
 * 写到不存在的位置（ENOENT）：
 *   1. 持久化写入句柄的 `header`——它每次 append 都从自己的 header 重新推 logPath
 *      （`appendLines → logPath(meta.cwd)`），所以改 header 就够了；改之前先 `flush()`，
 *      免得把还没落盘的缓冲写到旧路径；
 *   2. 驻留会话对象自身的 `header`（工具/界面从它解析 cwd）；
 *   3. 注册表里的头部缓存（`registry.headers`，`Map<id, header>`）。
 *
 * 每一步都独立尽力而为：句柄 flush 失败只记录，不阻断其余改写。
 * @param options - `{writers, sessions, registry, sessionId, cwd}`；`writers` 来自
 *   {@link sessionWriteHandles}，`sessions` 是 `ctx.get('sessions')`。
 * @returns `{writeHandleRedirected, liveHeaderUpdated, registryHeaderCacheUpdated, flushError?, liveSession}`
 *   ——`flushError` 只在 flush 抛错时出现；`liveSession` 是驻留会话对象（没有则 undefined）。
 */
export async function redirectSessionWriters(options) {
  const { writers, sessions, registry, sessionId, cwd } = options
  const outcome = {
    writeHandleRedirected: false,
    liveHeaderUpdated: false,
    registryHeaderCacheUpdated: false,
    liveSession: undefined,
  }
  const handle = writers === undefined ? undefined : writers.get(sessionId)
  if (handle !== undefined && handle !== null && typeof handle.header === 'object') {
    try {
      await handle.flush()
    } catch (error) {
      outcome.flushError = String(error?.message ?? error)
    }
    handle.header = { ...handle.header, cwd }
    outcome.writeHandleRedirected = true
  }
  const live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
  outcome.liveSession = live
  if (live !== undefined) {
    live.header = { ...live.header, cwd }
    outcome.liveHeaderUpdated = true
  }
  if (registry.headers instanceof Map) {
    const cached = registry.headers.get(sessionId)
    if (cached !== undefined) {
      registry.headers.set(sessionId, { ...cached, cwd })
      outcome.registryHeaderCacheUpdated = true
    }
  }
  return outcome
}
