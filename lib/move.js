/**
 * `dsh-session-toolbox` 的**搬迁半边**（原 `dsh-session-move` 的 Host 半边）。
 *
 * 代码逐字搬自 `C:/CodeRepository/dsh-session-move/lib/index.js`，差异只有四处：
 *   - 插件 entry 的 `name` / `inject` / `Config` / `resolveConfig` / `apply` 上移到
 *     `lib/index.js`（合并后只有一个 entry、一份配置 schema、一个 `apply`）；
 *   - `API_PREFIX` 改名 `MOVE_API_PREFIX`（删除半边占着 `ADMIN_API_PREFIX`）；
 *   - 配置键 `allowHosts` 改名 `moveAllowHosts`（与 `adminAllowHosts` 语义不同）；
 *   - 原 `apply` 里"建配置/建日志/订阅 volatile/看 enabled"那段上移到入口，剩下的接线
 *     成为 `mountMove(ctx, config, log)`。
 * 其余一字未动（`createMover`、`/session-move/api` 的方法表、`session_move` 工具定义、
 * socket 版信任栅栏、注释）。`./engine.js` / `./memory.js` / `./sessionlog.js` 也原样搬来。
 *
 * 能力：把一条已持久化的会话搬到另一个工作区——**真搬迁**：
 *   1. 会话日志搬到目标工作区的 project 目录，header 的 `cwd` 改写成目标路径；
 *   2. 目标工作区 `attachSession`、原工作区 `detachSession`（工作区注册表成员随动）；
 *   3. 若该会话此刻正被 Host 持有（`ctx.sessions` 里挂着），同时改写内存里的
 *      `session.header.cwd` 与持久化写入句柄的 header，让它之后继续往新位置写。
 *
 * 一处硬边界：**正在跑一轮的会话一律拒绝**（`refuseRunning` 默认 true）。它的写入句柄
 * 随时可能落盘，搬家窗口里挪目录会让这一轮的事件写到一个不存在的位置（ENOENT）。
 *
 * 会话存储的公共知识（路径命名、帧读写、注册表成员/归档集合、「正在跑」判定、
 * 宿主与 HTTP 面的底座）在共享包 `dsh-session-store` 里；本文件只保留搬迁策略本身。
 *
 * @module dsh-session-toolbox/move
 */

import { statSync } from 'node:fs'
import {
  SESSION_RUNNING_STATUS,
  accountedSessionIds,
  agentSessionStatus,
  archivedSessionIds,
  createApiHandler,
  dshHome,
  findWorkspace,
  readJsonBody,
  redirectSessionWriters,
  residentSessionIds,
  sessionWriteHandles,
  workspaceOwningSession,
} from 'dsh-session-store'
import { applyPlan, planMove, verifyStoredLog } from './engine.js'
import { applyMemoryFollow, planMemoryFollow } from './memory.js'
import { hasZstd } from './sessionlog.js'

/** HTTP 路由前缀（两半各一条，合并后仍然分开）。 */
export const MOVE_API_PREFIX = '/session-move/api'

// ---------------------------------------------------------------------------
// 日志 / $DSH_HOME（实现在共享包 dsh-session-store）
// ---------------------------------------------------------------------------

/**
 * `$DSH_HOME`（环境变量优先，默认 `~/.dsh`）。
 *
 * 实现在 `dsh-session-store/lib/host.js`——它与 `dsh-session-admin` 用的是同一份；
 * 这里再导出，保持本仓库的公开面不变。
 */
export { dshHome }

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

/**
 * 从 `Host` 头里取 hostname：去掉端口，IPv6 的方括号保留（与 `URL.hostname` 对得上）。
 * @param authority - `host` 或 `host:port`。
 * @returns hostname；取不到时 undefined。
 */
function hostnameOf(authority) {
  const text = String(authority).trim()
  if (text.length === 0) return undefined
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    return end === -1 ? undefined : text.slice(0, end + 1)
  }
  const colon = text.lastIndexOf(':')
  return colon === -1 ? text : text.slice(0, colon)
}

/**
 * loopback 或显式白名单 authority 才放行，并额外拒绝浏览器侧的跨站 / 跨源请求。
 *
 * 原先这份栅栏只按 socket 的 `remoteAddress` 判断回环、`allowHosts` 只做精确字符串
 * 匹配，**不看 `sec-fetch-site` / `Origin`**——恶意页面从任意站点 POST 到本机
 * `127.0.0.1:3080` 时，socket 地址同样是回环，只看 `remoteAddress` 拦不住。
 * 2026-09-25 与 `dsh-session-admin` 那份栅栏对齐（那条缺口已补），差异只剩
 * 「本份以 `remoteAddress` 为回环判据、admin 以 `Host` 头为判据」。
 * 共享包只提供路由骨架（`createApiHandler`），栅栏以回调形式传进去。
 */
export function isTrustedRequest(req, allowHosts) {
  // 1) 浏览器侧的跨站向量先拦掉。
  if (req?.headers?.['sec-fetch-site'] === 'cross-site') return false

  // 2) 传输层：loopback 直达；非 loopback 必须在白名单里（精确字符串匹配，原行为）。
  const address = req.socket?.remoteAddress ?? ''
  const fromLoopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  const host = String(req.headers?.host ?? '')
  if (!fromLoopback && !(Array.isArray(allowHosts) && allowHosts.includes(host))) return false

  // 3) 带了 Origin 就必须与请求的 authority 同源。
  const origin = req?.headers?.origin
  if (origin === undefined) return true
  const hostname = hostnameOf(host)
  if (hostname === undefined) return false
  try {
    return new URL(origin).hostname === hostname
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 搬迁器
// ---------------------------------------------------------------------------

/** 把"旧 cwd 指向目标工作区目录"这件事落实到注册表：attach 新的、detach 旧的。 */
function createMover(ctx, config, log) {
  const persistence = ctx.sessionPersistence
  const registry = ctx.workspaceRegistry
  const sessionStore = ctx.get('sessions')
  const agents = ctx.get('agents')

  const rootOf = () => {
    if (typeof config.root === 'string' && config.root.length > 0) return config.root
    const fromBackend = persistence?.root
    if (typeof fromBackend === 'string' && fromBackend.length > 0) return fromBackend
    throw new Error('cannot locate the session root: sessionPersistence exposes no `root`; set the plugin config `root`')
  }
  const compressionOf = () => (typeof persistence?.compression === 'string' ? persistence.compression : 'zstd')

  // 下面这几个查询都来自共享包 dsh-session-store（与 dsh-session-admin 共用一份）：
  // 服务挂在哪、id 怎么比、状态叫什么，规则只写在一个地方。
  const residentIds = () => residentSessionIds(sessionStore)
  const runningOf = (id) => agentSessionStatus(agents, id)
  const writersOf = () => sessionWriteHandles(persistence)
  const ownerOf = (sessionId) => workspaceOwningSession(registry.list(), sessionId)
  const resolveWorkspace = (key) => findWorkspace(registry.list(), key)

  /** 全量快照：工作区身份 + 每条会话的 cwd/归属/驻留状态。 */
  async function list() {
    const root = rootOf()
    const snapshots = await persistence.list()
    const resident = residentIds()
    const writers = writersOf()
    const archived = archivedSessionIds(registry)
    const rows = []
    for (const snapshot of snapshots) {
      const header = snapshot.header
      const id = String(header.id)
      const running = runningOf(id)
      const owner = ownerOf(id)
      const handle = writers === undefined ? undefined : writers.get(id)
      rows.push({
        id,
        cwd: typeof header.cwd === 'string' ? header.cwd : null,
        createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
        resident: resident.has(id),
        running: running ?? null,
        hasWriteHandle: handle !== undefined && handle !== null,
        archived: archived.has(id),
        workspaceId: owner === undefined ? null : String(owner.id),
        workspaceTitle: owner === undefined ? null : String(owner.title),
        movable: typeof header.cwd === 'string' && (running !== SESSION_RUNNING_STATUS || config.refuseRunning !== true),
      })
    }
    rows.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    const workspaces = registry.list().map((workspace) => ({
      id: String(workspace.id),
      title: String(workspace.title),
      path: String(workspace.path),
      visible: workspace.sessionIds.length,
      accounted: accountedSessionIds(workspace)?.length ?? 0,
    }))
    return {
      root,
      compression: compressionOf(),
      zstd: hasZstd,
      workspaces,
      sessions: rows.slice(0, Math.max(1, Number(config.maxSessions) || 2000)),
      counts: { stored: rows.length, resident: resident.size, workspaces: workspaces.length },
    }
  }

  /**
   * 记忆条目"随会话走"的模式；非法值退化成 off（绝不因为一个错拼去改写记忆库）。
   *
   * 是个函数而不是常量：`memoryFollow` 是 volatile 旋钮，在线改完就该在**下一次调用**
   * 生效，所以在用到的地方现读。
   */
  function memoryMode() {
    return ['off', 'copy', 'move'].includes(String(config.memoryFollow)) ? String(config.memoryFollow) : 'off'
  }

  /**
   * 计算一次"记忆跟随"的**只读预览**：源/目标项目 slug、该会话产出的条目数。
   * 真正写入由 {@link applyMemoryFollow} 在搬迁成功之后执行。
   */
  const memoryFollowOf = (sessionId, fromPath, targetPath) => {
    try {
      const plan = planMemoryFollow({ dshHome: dshHome(), sessionId, fromCwd: fromPath, toCwd: targetPath })
      return {
        plan,
        summary: {
          mode: memoryMode(),
          sourceSlug: plan.source === null ? null : plan.source.slug,
          targetSlug: plan.target.slug,
          targetHadProject: plan.target.existed,
          sourceEntries: plan.totalInSource,
          matched: plan.matched.length,
          titles: plan.matched.slice(0, 10).map((entry) => entry.title),
          alreadyInTarget: plan.matched.filter((entry) => entry.existsInTarget).length,
          note: memoryMode() === 'off'
            ? 'memoryFollow=off：未改动任何记忆条目；上面是"若开启会复制哪些"的预览（条目按 frontmatter 的 session: 归属匹配）'
            : undefined,
        },
      }
    } catch (error) {
      return { plan: null, summary: { mode: memoryMode(), error: String(error?.message ?? error) } }
    }
  }

  /** 只读校验：用 DSH 自己的持久化读取器把这条会话读一遍。 */
  async function verify(sessionId) {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const result = await handle.read()
      return {
        headerCwd: typeof handle.header.cwd === 'string' ? handle.header.cwd : null,
        inheritedEventCount: Number(handle.inheritedEventCount),
        events: result?.events ? result.events.length : null,
      }
    } finally {
      try {
        await handle.close()
      } catch {
        /* 已经关掉了 */
      }
    }
  }

  /**
   * 搬一条会话。
   * @param request - `{sessionId, targetWorkspace, dryRun}`。
   * @returns 报告：存储搬迁事实 + 内存状态改写事实 + 注册表成员变更事实 + 读回校验。
   */
  async function move(request) {
    const sessionId = String(request.sessionId ?? '')
    if (sessionId.length === 0) throw new Error('sessionId is required')
    const dryRun = request.dryRun === true
    const root = rootOf()
    const compression = compressionOf()

    const snapshots = await persistence.list()
    const snapshot = snapshots.find((candidate) => String(candidate.header.id) === sessionId)
    if (snapshot === undefined) throw new Error(`stored session not found: ${sessionId}`)
    const header = snapshot.header
    if (typeof header.cwd !== 'string' || header.cwd.length === 0) {
      throw new Error(`session ${sessionId} has no cwd in its stored header`)
    }
    const target = resolveWorkspace(request.targetWorkspace)
    if (target === undefined) throw new Error(`unknown target workspace: ${String(request.targetWorkspace)}`)
    const targetPath = String(target.path)
    const fromPath = String(header.cwd)

    const running = runningOf(sessionId)
    if (running === SESSION_RUNNING_STATUS && config.refuseRunning !== false) {
      throw new Error(`session ${sessionId} is running a turn; wait for it to finish (or set refuseRunning: false) before moving it`)
    }
    const report = {
      sessionId,
      from: fromPath,
      to: targetPath,
      workspace: { id: String(target.id), title: String(target.title) },
      dryRun,
      running: running ?? null,
    }
    if (fromPath === targetPath) {
      // cwd 已经指向目标工作区：**不需要搬日志**，但可能压根没被这个工作区记账
      // （导入 / 同步回来 / 工作区当时还不存在的会话就是这样，界面上显示为 Ungrouped）。
      // 这种"归位"只差一次注册表成员修复。
      const owner = ownerOf(sessionId)
      if (owner !== undefined && String(owner.id) === String(target.id)) {
        report.noop = true
        report.note = 'the session already lives in this workspace and is accounted by it'
        return report
      }
      report.attachOnly = true
      report.note = 'the session cwd already points at this workspace; only registry membership is repaired (no log move)'
      if (dryRun) {
        report.dryRunOnly = true
        return report
      }
      try {
        await target.attachSession(sessionId)
        report.attachedTo = String(target.id)
      } catch (error) {
        throw new Error(`cannot attach the session to workspace "${String(target.title)}": ${String(error?.message ?? error)}`)
      }
      if (owner !== undefined) {
        try {
          await owner.detachSession(sessionId)
          report.detachedFrom = String(owner.id)
        } catch (error) {
          report.detachError = String(error?.message ?? error)
        }
      }
      try {
        report.dshReadback = await verify(sessionId)
      } catch (error) {
        report.dshReadbackError = String(error?.message ?? error)
      }
      report.ok = report.dshReadback !== undefined && report.dshReadback.headerCwd === targetPath
      log('info', `re-filed ${sessionId} under workspace ${targetPath} (attach only)`)
      return report
    }
    let targetStat
    try {
      targetStat = statSync(targetPath)
    } catch (error) {
      throw new Error(`target workspace directory is not readable: ${targetPath} (${String(error?.message ?? error)})`)
    }
    if (!targetStat.isDirectory()) throw new Error(`target workspace path is not a directory: ${targetPath}`)

    const plan = planMove({ root, compression, sessionId, fromCwd: fromPath, toCwd: targetPath })
    report.plan = {
      generation: plan.generation.name,
      version: plan.generation.version,
      compressed: plan.generation.compressed,
      bytesBefore: plan.bytesBefore,
      bytesAfter: plan.bytesAfter,
      frames: plan.frameCount,
      sourcePath: plan.sourcePath,
      targetPath: plan.targetPath,
      leftInSourceDir: plan.otherFiles,
      otherGenerations: plan.otherGenerations,
    }
    // 记忆条目预览（只读，dry-run 也会给）：项目作用域是按工作区根目录定的，
    // 所以"要不要把这条会话在源工作区写下的条目一并带过去"是另一个显式选择。
    const memory = memoryFollowOf(sessionId, fromPath, targetPath)
    report.memoryFollow = memory.summary
    if (dryRun) {
      report.dryRunOnly = true
      return report
    }

    // 1) 落盘：日志搬家 + header cwd 改写。
    report.storage = applyPlan(plan)
    if (report.storage.ok !== true) {
      throw new Error(`the log was moved to ${plan.targetPath} but the rewritten header did not verify: ${JSON.stringify(report.storage.verifiedHeader)}`)
    }

    // 2) 内存态：让"以后继续写"落到新位置。
    //    写入句柄每次 append 都从自己的 header 重新推 logPath（appendLines → logPath(meta.cwd)），
    //    所以改写 handle.header 就够了；会话对象自身的 header 也同步，供工具解析 cwd；
    //    注册表里的头部缓存也要一起改。三处都在共享包里（见 dsh-session-store/registry.js）。
    const redirect = await redirectSessionWriters({
      writers: writersOf(),
      sessions: sessionStore,
      registry,
      sessionId,
      cwd: targetPath,
    })
    const live = redirect.liveSession
    if (redirect.flushError !== undefined) report.handleFlushError = redirect.flushError
    if (redirect.writeHandleRedirected) report.writeHandleRedirected = true
    if (redirect.liveHeaderUpdated) report.liveHeaderUpdated = true
    if (redirect.registryHeaderCacheUpdated) report.registryHeaderCacheUpdated = true

    // 3) 注册表成员：attach 目标、detach 原属。attachSession 会校验 header.cwd
    //    （刚改写过的），并在成功后把进程内的 canonical cwd 索引指向新路径。
    const source = ownerOf(sessionId)
    try {
      await target.attachSession(sessionId)
      report.attachedTo = String(target.id)
    } catch (error) {
      throw new Error(`the session log was moved, but attaching it to workspace "${String(target.title)}" failed: ${String(error?.message ?? error)}`)
    }
    if (source !== undefined && String(source.id) !== String(target.id)) {
      try {
        await source.detachSession(sessionId)
        report.detachedFrom = String(source.id)
      } catch (error) {
        report.detachError = String(error?.message ?? error)
      }
    }

    // 记忆条目跟随（可选，默认关）：日志已搬成、注册表已换边之后才动记忆库，
    // 且失败只记录、不让一次成功的搬迁变成失败。
    if (memory.plan !== null && memoryMode() !== 'off' && memory.plan.source !== null && memory.plan.matched.length > 0) {
      try {
        report.memoryFollow.applied = applyMemoryFollow(memory.plan, memoryMode())
      } catch (error) {
        report.memoryFollow.applyError = String(error?.message ?? error)
      }
    }

    // 4) 读回：DSH 自己的读取器能读到才算真的搬成了。
    try {
      report.dshReadback = await verify(sessionId)
    } catch (error) {
      report.dshReadbackError = String(error?.message ?? error)
    }
    // 记忆作用域提示（只提示，不改动任何记忆数据）：
    // dsh-memories 把「项目作用域」定在工作区根目录上（$DSH_HOME/memories/projects/<slug>，
    // 由 session.header.cwd 经 findProjectRoot 解析），而且解析结果按 **Session 对象**
    // 缓存在 rootCache（WeakMap）里。所以搬完 cwd 之后：冷会话下次加载就用新工作区；
    // 驻留会话要等它重新加载才会切换。记忆条目本身不随会话搬迁。
    if (ctx.get('memories') !== undefined) {
      report.memoryScope = live !== undefined
        ? 'dsh-memories 在场：该会话仍驻留，工作区根被按 Session 对象缓存，项目记忆作用域要等它重新加载（重新 resume / 重启 dsh web）才切到新工作区；记忆条目不随会话搬迁。'
        : 'dsh-memories 在场：该会话是冷会话，下次加载即按新 cwd 解析项目作用域；记忆条目不随会话搬迁。'
    }
    report.ok = report.dshReadback !== undefined && report.dshReadback.headerCwd === targetPath
    log('info', `moved ${sessionId}: ${fromPath} -> ${targetPath} (${report.storage.bytesBefore} -> ${report.storage.bytesAfter} bytes)`)
    return report
  }

  return { list, move, verify, rootOf, compressionOf, resolveWorkspace }
}

// ---------------------------------------------------------------------------
// 模型侧工具
// ---------------------------------------------------------------------------

/**
 * 工具输入 schema。**必须是真正的 JSON Schema**：`ctx.tools.register()` 收的是
 * 已编译的 ToolDefinition，`required` 得是对象级的字符串数组，且根必须有
 * `type: 'object'`，否则请求会被上游 400 掉。
 */
const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: true,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'move'],
      description: 'list = 列出工作区与会话（含归属/驻留状态）；move = 把一条会话搬到目标工作区。',
    },
    sessionId: { type: 'string', description: 'action="move"：要搬的会话 id（如 session-<uuid>）。' },
    targetWorkspace: { type: 'string', description: 'action="move"：目标工作区 id、绝对路径或标题（唯一匹配）。' },
    dryRun: { type: 'boolean', description: 'action="move"：只报告计划，不动任何数据。' },
    filter: { type: 'string', description: 'action="list"：按 id / cwd / 工作区标题过滤。' },
    limit: { type: 'integer', description: 'action="list"：最多返回多少条（默认 40）。' },
  },
  required: ['action'],
}

/** 工具输出 schema（同样是真 JSON Schema）。 */
const TOOL_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean', description: '调用本身是否成功。' },
    summary: { type: 'string', description: '一句话结论。' },
    report: { type: 'object', additionalProperties: true, description: 'action="move" 的完整报告。' },
    workspaces: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'action="list" 的工作区行。' },
    sessions: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'action="list" 的会话行。' },
  },
}

/** 工具的注册体。 */
function buildTool(mover, config, log) {
  return {
    name: 'session_move',
    description:
      'Move one persisted DSH session into another workspace, durably: the session log is relocated to the target workspace\'s project directory, its header cwd is rewritten, and the workspace registry membership follows. ' +
      'DSH ties a session to a workspace ONLY through the session header cwd, so this is the real move (not a display grouping). ' +
      'Always call action="list" first to see workspace ids/titles and which sessions are movable, then action="move" with the ids. ' +
      'Sessions running a turn are refused. Sessions currently loaded but idle are supported: their in-memory header and persistence write handle are redirected too. ' +
      'Use dryRun=true to preview without touching anything.',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'move' ? 'Move session to workspace' : 'List sessions and workspaces',
      kind: 'other',
      rawInput: { action: args.action, sessionId: args.sessionId, targetWorkspace: args.targetWorkspace },
    }),
    async execute(args) {
      if (args.action === 'list') {
        const snapshot = await mover.list()
        const needle = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : ''
        const filtered = needle.length === 0
          ? snapshot.sessions
          : snapshot.sessions.filter((row) =>
              row.id.toLowerCase().includes(needle) ||
              (row.cwd ?? '').toLowerCase().includes(needle) ||
              (row.workspaceTitle ?? '').toLowerCase().includes(needle))
        const limit = Math.max(1, Math.min(Number(args.limit ?? 40), 500))
        const rows = filtered.slice(0, limit)
        return {
          ok: true,
          workspaces: snapshot.workspaces,
          sessions: rows,
          summary:
            `${snapshot.workspaces.length} workspaces, ${snapshot.counts.stored} stored sessions (${snapshot.counts.resident} loaded). ` +
            `Showing ${rows.length} of ${filtered.length} matching rows. ` +
            rows.slice(0, 10).map((row) => `${row.id} — ${row.cwd ?? 'no cwd'} [${row.workspaceTitle ?? 'ungrouped'}${row.running === SESSION_RUNNING_STATUS ? ', running' : row.resident ? ', loaded' : ''}]`).join(' | '),
        }
      }
      if (args.action === 'move') {
        const report = await mover.move({
          sessionId: args.sessionId,
          targetWorkspace: args.targetWorkspace,
          dryRun: args.dryRun === true,
        })
        if (report.noop === true) {
          return { ok: true, report, summary: `No move needed: ${report.sessionId} already lives in "${report.workspace.title}".` }
        }
        if (report.attachOnly === true) {
          const head = report.dryRunOnly === true
            ? `DRY RUN: would re-file ${report.sessionId} under workspace "${report.workspace.title}"`
            : `Re-filed ${report.sessionId} under workspace "${report.workspace.title}"`
          return {
            ok: true,
            report,
            summary: `${head}. Its cwd (${report.to}) already pointed at that workspace, so only registry membership changed (no log move).`,
          }
        }
        const head = report.dryRunOnly === true
          ? `DRY RUN: would move ${report.sessionId} from ${report.from} to ${report.to}`
          : `Moved ${report.sessionId}: ${report.from} -> ${report.to} (workspace "${report.workspace.title}")`
        const detail = report.dryRunOnly === true
          ? `${report.plan.bytesBefore} bytes / ${report.plan.frames ?? 'plain'} frames -> ${report.plan.bytesAfter} bytes`
          : `${report.storage.bytesBefore} -> ${report.storage.bytesAfter} bytes; readback cwd = ${report.dshReadback?.headerCwd ?? 'unverified'}` +
            (report.writeHandleRedirected === true ? '; live write handle redirected' : '') +
            (report.liveHeaderUpdated === true ? '; live header updated' : '')
        return { ok: true, report, summary: `${head}. ${detail}` }
      }
      return { ok: false, summary: `unknown action: ${String(args.action)}` }
    },
  }
}

/**
 * 挂载搬迁半边：路由 + 工具。
 *
 * 与删除半边刻意不同的两点（原样保留的理由）：
 *   - 信任栅栏看 socket 的 `remoteAddress`（`isTrustedRequest`），`allowHosts` 只做精确
 *     字符串匹配；删除半边看 `Host` 头；
 *   - 请求体按**严格模式**读（`requireObject: true`，非普通对象一律 400）。
 *
 * @param ctx - Host cordis 上下文（`webServer` / `tools` / `sessionPersistence` /
 *   `workspaceRegistry`；`sessions` / `agents` 是可选事实源，用 `ctx.get` 取）。
 * @param config - 已解包的**活配置对象**（身份由入口保持，volatile 更新时原地覆盖）。
 * @param log - `(level, message) => void`（入口传的是 move 那套行格式的文件日志）。
 * @returns 无。
 */
export function mountMove(ctx, config, log) {
  if (!hasZstd) {
    log('warn', 'this node build lacks zlib zstd support; moves are refused')
  }
  const mover = createMover(ctx, config, log)
  let rootNote = 'unknown'
  try {
    rootNote = mover.rootOf()
  } catch (error) {
    rootNote = `unresolved (${String(error?.message ?? error)})`
  }
  log('info', `mounted: prefix=${MOVE_API_PREFIX} root=${rootNote} compression=${mover.compressionOf()} allowHosts=[${config.moveAllowHosts.join(', ')}] memoryFollow=${['off', 'copy', 'move'].includes(String(config.memoryFollow)) ? config.memoryFollow : 'off (invalid value ignored)'}`)

  const api = {
    /** 工作区 + 会话快照。 */
    list: async () => mover.list(),
    /** 搬一条会话。 */
    move: async (payload) => mover.move(payload),
    /** 用 DSH 自己的读取器读回一条会话。 */
    verify: async (payload) => mover.verify(String(payload.sessionId ?? '')),
    /** 能力/诊断。 */
    config: async () => ({
      prefix: MOVE_API_PREFIX,
      root: (() => {
        try {
          return mover.rootOf()
        } catch {
          return null
        }
      })(),
      compression: mover.compressionOf(),
      zstd: hasZstd,
      refuseRunning: config.refuseRunning,
      maxSessions: config.maxSessions,
    }),
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: MOVE_API_PREFIX,
        // 路由骨架（403/404/200/400 的响应体、方法名解析、GET 走 query）在共享包里；
        // 两件"只有本插件才有的策略"以参数传进去：
        //   - 信任栅栏（socket remoteAddress 版，见 isTrustedRequest）；
        //   - 请求体按**严格模式**读（非普通对象一律 400），这是本插件原有的行为。
        handler: createApiHandler({
          prefix: MOVE_API_PREFIX,
          methods: api,
          trustRequest: (req) => isTrustedRequest(req, config.moveAllowHosts),
          readBody: (req) => readJsonBody(req, { requireObject: true }),
          log,
        }),
      }),
    'dsh-session-move: api route',
  )

  ctx.effect(
    () => ctx.tools.register(buildTool(mover, config, log)),
    'dsh-session-move: session_move tool',
  )
}

// 2026-09-25：本文件由 dsh-session-move/lib/index.js 逐字搬入 dsh-session-toolbox（合并包）。
