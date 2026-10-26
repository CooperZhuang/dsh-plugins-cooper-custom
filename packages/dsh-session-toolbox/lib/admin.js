/**
 * `dsh-session-toolbox` 的**删除半边**（原 `dsh-session-admin` 的 Host 半边）。
 *
 * 代码逐字搬自 `C:/CodeRepository/dsh-session-admin/lib/index.js`，只有四处差异：
 *   - 插件 entry 的 `name` / `inject` / `SETTINGS_NS` / `Config` / `resolveConfig` / `apply`
 *     上移到 `lib/index.js`——合并后的包只有一个 entry、一份配置 schema、一个 `apply`；
 *   - `API_PREFIX` 改名 `ADMIN_API_PREFIX`（搬迁半边占着 `MOVE_API_PREFIX`）；
 *   - 配置键 `allowHosts` 改名 `adminAllowHosts`（两半的信任栅栏语义不同，见 `lib/index.js`）；
 *   - 原 `apply` 里"建配置/建日志/订阅 volatile/看 enabled"那段上移到入口，剩下的接线
 *     成为 `mountAdmin(ctx, config, log)`。
 * 其余一字未动：扫描与范围筛选、逐条守卫、`/session-admin/api` 的方法表、
 * `session_admin` 工具定义、Host 头版信任栅栏，连注释都保持原样。
 *
 * 能力：把会话的持久化数据真正从磁盘移除。一个会话在磁盘上最多占三处：
 *   - `<home>/sessions/<项目目录键>/<session-id>/`   ← 会话日志（jsonl.zstd）
 *   - `<home>/storages/session_projcache/sessions/<session-id>.json` ← 投影缓存
 *   - `<home>/rewind-snapshots/<session-id>/`        ← 回退快照（可有可无）
 * 三处一起删，并顺手清掉因此变空的项目目录。
 *
 * 刻意零 `@deepseek-ai/*` 运行时依赖：只用 Node 内置模块和一份 schemastery 配置
 * schema。工具注册用普通对象（与 `dsh-subagent-in-process-driver` 同款），不做
 * `defineTool` 导入——profile 的 node_modules 里未必解析得到 `@deepseek-ai/dsh-tools`。
 * 代价是 `parameters` / `output.schema` 都必须自己写成**已编译的 JSON Schema**：
 * register 不做编译，只把对象原样透传给 provider（详见 `TOOL_PARAMETERS` 注释）。
 *
 * @module dsh-session-toolbox/admin
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  createApiHandler,
  decodeProjectKey,
  dshHome,
  readSessionHeader,
  releaseSessionEverywhere,
  residentSessionIds,
  runningSessionIds,
} from 'dsh-session-store'

/** HTTP 路由前缀（两半各一条，合并后仍然分开）。 */
export const ADMIN_API_PREFIX = '/session-admin/api'

// ---------------------------------------------------------------------------
// 日志 / $DSH_HOME（实现在共享包 dsh-session-store）
// ---------------------------------------------------------------------------

/**
 * `$DSH_HOME`（环境变量优先，默认 `~/.dsh`）。
 *
 * 实现在 `dsh-session-store/lib/host.js`——它与 `dsh-session-move` 用的是同一份；
 * 这里再导出，保持本仓库的公开面不变。
 */
export { dshHome }

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/**
 * 把 `sessions/` 下的项目目录键还原成路径。
 *
 * 实现在 `dsh-session-store/lib/paths.js`：它与 `dsh-session-move` 的 `projectKey`
 * 是同一套规则的两个方向，规则只该有一份。这里再导出，保持本仓库的公开面不变。
 */
export { decodeProjectKey }


/** 路径是否落在某个根目录内部（防目录穿越）。 */
export function isInside(root, candidate) {
  const r = resolve(root)
  const c = resolve(candidate)
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

// ---------------------------------------------------------------------------
// 会话头
// ---------------------------------------------------------------------------

/*
 * 会话头的读取（文件名过滤、zstd 解压、首行 JSON、`路径:mtime:size` 缓存）已经搬到
 * 共享包的 `readSessionHeader`：它与 `dsh-session-move` 的帧级读取器共用同一套
 * 「什么算会话日志」的判定（`isSessionLogFile`）。
 *
 * 使用约定（两边一致）：解压失败（截断、缺 zstd 支持、文件根本不存在）返回
 * `undefined`，调用方按「未知」处理——不要在这里抛。
 */

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/** 读取工作区注册表；缺失或损坏时退化成「没有工作区」。 */
function readWorkspace(home) {
  const file = join(home, 'storages', 'workspace.json')
  const empty = { workspaces: [], accounted: new Set(), archived: new Set() }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const byId = new Map()
    const accounted = new Set()
    const workspaces = []
    for (const [workspaceId, workspace] of Object.entries(parsed?.tables?.workspaces ?? {})) {
      const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      // 注意：workspace.json 里的工作区对象自身不带 id，它只存在于外层键上，
      // 所以这里必须重新组装一份带 workspaceId 的视图再进索引——直接存原始对象
      // 会让所有工作区守卫静默失效（owner.workspaceId === undefined）。
      const view = { workspaceId, path: workspace.path, title: workspace.title, sessionIds }
      for (const id of sessionIds) {
        accounted.add(id)
        byId.set(id, view)
      }
      workspaces.push(view)
    }
    const archived = new Set(
      Array.isArray(parsed?.global?.archivedSessionIds) ? parsed.global.archivedSessionIds : [],
    )
    return { workspaces, accounted, archived, byId }
  } catch {
    return empty
  }
}

/** 会话目录的 mtime——轻量扫描时用作 `updatedAt` 的替代。 */
function dirMtime(dir) {
  try {
    return statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/** 为一个会话目录算出磁盘占用。 */
function measure(dir) {
  let bytes = 0
  let files = 0
  let newest = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(child)
        continue
      }
      try {
        const stat = statSync(child)
        bytes += stat.size
        files += 1
        if (stat.mtimeMs > newest) newest = stat.mtimeMs
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
  }
  return { bytes, files, updatedAt: newest }
}

/**
 * 构造一个会话管理员。所有根目录都可注入，便于在测试里指向沙箱。
 * @param options - `home`（DSH 主目录）、`tempRoots`（视为「临时目录」的前缀）、
 *   `releaseSession`（删文件**之前**把一个会话从登记表里摘掉的异步回调；见 `remove`）。
 * @returns 扫描 / 过滤 / 删除三个入口。
 */
export function createSessionAdmin(options = {}) {
  const home = options.home ?? dshHome()
  const sessionsRoot = join(home, 'sessions')
  const projcacheRoot = join(home, 'storages', 'session_projcache', 'sessions')
  const rewindRoot = join(home, 'rewind-snapshots')
  const tempRoots = options.tempRoots ?? [tmpdir()]
  const releaseSession = typeof options.releaseSession === 'function' ? options.releaseSession : async () => {}
  const headerCache = new Map()

  /**
   * 扫描磁盘上的全部会话。
   * @param options2 - `measure: false` 跳过逐会话的体积统计（要遍历每个会话目录，
   *   是这里最贵的一步）。角标那种「只要个数」的调用方用它把开销压到最低，
   *   代价是 `bytes` / `files` 为 0、`updatedAt` 退化成目录 mtime。
   * @returns 每个会话一条记录，按更新时间从新到旧。
   */
  function scan(options2 = {}) {
    const measureBytes = options2.measure !== false
    const workspace = readWorkspace(home)
    const temps = tempRoots.map((root) => resolve(root).toLowerCase())
    const records = []
    let projects = []
    try {
      projects = readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
    for (const project of projects) {
      const projectDir = join(sessionsRoot, project)
      let sessionDirs
      try {
        sessionDirs = readdirSync(projectDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        continue
      }
      for (const id of sessionDirs) {
        const dir = join(projectDir, id)
        const header = readSessionHeader(dir, headerCache)
        const cached = readProjCache(id)
        const cwd = header?.cwd ?? cached.cwd ?? decodeProjectKey(project)
        const measured = measureBytes ? measure(dir) : { bytes: 0, files: 0, updatedAt: dirMtime(dir) }
        const owner = workspace.byId?.get(id)
        const cwdMissing = cwd === undefined || cwd === '' || !existsSync(cwd)
        records.push({
          id,
          dir,
          project,
          cwd: cwd ?? null,
          title: cached.title ?? null,
          origin: header?.origin ?? null,
          parentSessionId: header?.parentSession ?? null,
          isSeeded: header?.isSeeded ?? null,
          headerReadable: header !== undefined,
          workspaceId: owner?.workspaceId ?? null,
          workspaceTitle: owner?.title ?? null,
          ungrouped: owner === undefined,
          archived: workspace.archived.has(id),
          subagent: header?.origin === 'subagent',
          cwdMissing,
          temp:
            cwdMissing ||
            (cwd !== undefined && temps.some((root) => cwd.toLowerCase().startsWith(root))),
          bytes: measured.bytes,
          files: measured.files,
          updatedAt: measured.updatedAt,
          hasProjCache: cached.found,
          hasRewind: existsSync(join(rewindRoot, id)),
        })
      }
    }
    records.sort((a, b) => b.updatedAt - a.updatedAt)
    return records
  }

  /** projcache 里的一条摘要（标题 / cwd 的兜底来源）。 */
  function readProjCache(id) {
    const file = join(projcacheRoot, `${id}.json`)
    if (!existsSync(file)) return { found: false, cwd: undefined, title: null }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const record = parsed?.record ?? {}
      const title = record?.rows?.title?.val
      return {
        found: true,
        cwd: record?.identity?.cwd,
        title: typeof title === 'string' && title !== '' ? title : null,
      }
    } catch {
      return { found: true, cwd: undefined, title: null }
    }
  }

  /**
   * 按范围筛选会话。
   *
   * `ungrouped` 刻意与侧边栏的「未分组」**逐行等价**：DSH 的列表会隐藏子代理行与
   * 归档行，所以这里也必须排掉它们，否则面板上显示 172 条而侧边栏只有 110 条，
   * 两边对不上号，批量删除就会比用户以为的多删 62 个。要动那两类，用它们自己的
   * 范围（`archived` / `subagent`）。
   * @param records - `scan()` 的结果。
   * @param query - `scope` / `cwdPrefix` / `search`。
   * @returns 命中的记录。
   */
  function select(records, query = {}) {
    const scope = query.scope ?? 'all'
    const prefix = query.cwdPrefix === undefined ? null : resolve(query.cwdPrefix).toLowerCase()
    const search = query.search === undefined ? null : String(query.search).toLowerCase()
    return records.filter((record) => {
      if (scope === 'ungrouped' && (!record.ungrouped || record.archived || record.subagent)) return false
      if (scope === 'temp' && !record.temp) return false
      if (scope === 'archived' && !record.archived) return false
      if (scope === 'subagent' && !record.subagent) return false
      if (scope === 'orphan' && record.hasProjCache) return false
      if (prefix !== null) {
        if (record.cwd === null) return false
        if (!record.cwd.toLowerCase().startsWith(prefix)) return false
      }
      if (search !== null) {
        const haystack = `${record.title ?? ''} ${record.cwd ?? ''} ${record.id}`.toLowerCase()
        if (!haystack.includes(search)) return false
      }
      return true
    })
  }

  /**
   * 删除若干会话的持久化数据。
   *
   * 每条要么被删掉，要么带着一个明确的拒绝理由留下——调用方拿到的是逐条的账，
   * 不是一个布尔值。
   *
   * 删文件**之前**会先 `await releaseSession(id)`（见 `createSessionAdmin` 的
   * `releaseSession` 选项）：登记表里对会话的引用必须赶在目录消失前摘掉，否则就是
   * 一条谁也看不见、只会在被选中时炸成 ENOENT 的悬空引用。摘失败的那条不删文件。
   *
   * @param ids - 目标会话 id。
   * @param options2 - `dryRun` / `includeWorkspace` / `includeArchived` /
   *   `includeSubagent` / `includeLive` / `live`（**正在跑**、因此现在不能删的 id 集合）/
   *   `callerSessionId` / `maxBatch`。
   * @returns 逐条结果与汇总。
   */
  async function remove(ids, options2 = {}) {
    const records = new Map(scan().map((record) => [record.id, record]))
    const live = options2.live ?? new Set()
    const maxBatch = options2.maxBatch ?? 200
    const dryRun = options2.dryRun === true
    const results = []
    let removed = 0
    let reclaimed = 0

    for (const id of ids) {
      const record = records.get(id)
      if (record === undefined) {
        results.push({ id, status: 'skipped', reason: 'not-found' })
        continue
      }
      if (options2.callerSessionId !== undefined && id === options2.callerSessionId) {
        results.push({ id, status: 'skipped', reason: 'caller-session' })
        continue
      }
      /*
       * `live` 是「**正在跑**」的集合，不是「Host 仍挂着」的集合。这个区分是必需的：
       *
       * 会话在创建 agent 时被 enter（dsh-agent-loop/index.js:1714），而 agent 只在被
       * dispose 时才 detach —— 长期运行的 `dsh web` 里，只要碰过就基本一直挂着。若把
       * 「挂着」当作不可删，删除功能（以及待删除队列）在真实使用中会永久失效。
       *
       * 那为什么删「挂着但空闲」的是安全的？因为删除会移除**整个会话目录**，而持久化
       * 的追加写是 `open(path, "a")`（dsh-session-persistence-jsonl/index.js:3049）：
       * 它只在文件不存在时创建文件，**不会创建父目录**。目录已经没了，于是后续写入直接
       * 拿到 ENOENT 并失败——一个响亮、局部的错误，而不是生成一个「无头日志」把整个
       * profile 的启动搞崩（那才是真正要避免的结局）。已实测该 open 语义。
       */
      if (live.has(id) && options2.includeLive !== true) {
        results.push({ id, status: 'skipped', reason: 'running-session' })
        continue
      }
      if (record.workspaceId !== null && options2.includeWorkspace !== true) {
        results.push({ id, status: 'skipped', reason: 'workspace-session' })
        continue
      }
      if (record.archived && options2.includeArchived !== true) {
        results.push({ id, status: 'skipped', reason: 'archived-session' })
        continue
      }
      if (record.subagent && options2.includeSubagent !== true) {
        results.push({ id, status: 'skipped', reason: 'subagent-session' })
        continue
      }
      if (removed >= maxBatch) {
        results.push({ id, status: 'skipped', reason: 'batch-limit' })
        continue
      }
      // 目录穿越防线：会话目录必须真的在 sessions/ 里。
      if (!isInside(sessionsRoot, record.dir)) {
        results.push({ id, status: 'skipped', reason: 'outside-sessions-root' })
        continue
      }
      if (dryRun) {
        results.push({ id, status: 'would-remove', bytes: record.bytes })
        removed += 1
        reclaimed += record.bytes
        continue
      }
      /*
       * 摘登记表**必须早于删文件**。
       *
       * `workspace.json` 里有三处会记住会话：工作区的成员表、归档集合、置顶集合。
       * 删日志不碰它们中的任何一个，残留平时也看不见——直到有人选中那条死行、
       * 去打开已经不存在的日志，才炸成 ENOENT（并且是「本轮运行失败」这种
       * 让人摸不着头脑的样子）。
       *
       * 更关键的是顺序：`Workspace.sessionIds` 是**按会话头索引过滤过的视图**，
       * 目录一删，成员关系就再也查不到，残留也就永远摘不掉了。
       *
       * 摘不掉就不删：留下一条有据可查的失败，好过制造一个悬空引用。
       */
      try {
        await releaseSession(id)
      } catch (error) {
        results.push({ id, status: 'failed', reason: `workspace: ${String(error?.message ?? error)}` })
        continue
      }
      const errors = []
      try {
        rmSync(record.dir, { recursive: true, force: true })
      } catch (error) {
        errors.push(`sessions: ${String(error?.message ?? error)}`)
      }
      const cacheFile = join(projcacheRoot, `${id}.json`)
      if (existsSync(cacheFile)) {
        try {
          rmSync(cacheFile, { force: true })
        } catch (error) {
          errors.push(`projcache: ${String(error?.message ?? error)}`)
        }
      }
      const rewindDir = join(rewindRoot, id)
      if (existsSync(rewindDir) && isInside(rewindRoot, rewindDir)) {
        try {
          rmSync(rewindDir, { recursive: true, force: true })
        } catch (error) {
          errors.push(`rewind: ${String(error?.message ?? error)}`)
        }
      }
      if (errors.length > 0) {
        results.push({ id, status: 'failed', reason: errors.join('; ') })
        continue
      }
      results.push({ id, status: 'removed', bytes: record.bytes })
      removed += 1
      reclaimed += record.bytes
    }

    const pruned = dryRun ? [] : pruneEmptyProjects()
    return { dryRun, removed, reclaimed, pruned, results }
  }

  /** 清掉 `sessions/` 下因此变空的项目目录。 */
  function pruneEmptyProjects() {
    const pruned = []
    let projects
    try {
      projects = readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch {
      return pruned
    }
    for (const entry of projects) {
      const dir = join(sessionsRoot, entry.name)
      try {
        if (readdirSync(dir).length === 0) {
          rmSync(dir, { recursive: true, force: true })
          pruned.push(entry.name)
        }
      } catch {
        /* 清不掉就留着 */
      }
    }
    return pruned
  }

  return { home, sessionsRoot, projcacheRoot, rewindRoot, scan, select, remove }
}

// ---------------------------------------------------------------------------
// 浏览器信任栅栏
// ---------------------------------------------------------------------------

/** 拆 `host[:port]`（支持 `[::1]:3080` 形态）。 */
function parseAuthority(value) {
  const text = String(value).trim()
  if (text === '') return undefined
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end === -1) return undefined
    return { hostname: text.slice(1, end), host: text.toLowerCase() }
  }
  const colon = text.lastIndexOf(':')
  const hostname = colon === -1 ? text : text.slice(0, colon)
  if (hostname === '') return undefined
  return { hostname, host: text.toLowerCase() }
}

/** 本机回环字面量。 */
function isLoopback(hostname) {
  const h = hostname.toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.endsWith('.localhost')
}

/** 配置里的额外 authority 是否覆盖该请求。 */
function isAllowedAuthority(authority, allowHosts) {
  return allowHosts.some((entry) => {
    const parsed = parseAuthority(entry)
    if (parsed === undefined) return false
    return parsed.host === authority.host || parsed.hostname === authority.hostname
  })
}

/**
 * 判断一个请求是否有权访问本插件的路由。
 *
 * 本机 `dsh web` 常被绑到 `0.0.0.0`（局域网访问），所以「能连上端口」不等于
 * 「是这台机器上的人」：非回环 authority 默认一律拒绝，除非在配置的
 * `allowHosts` 里显式列出。同时拒绝 `sec-fetch-site: cross-site` 和跨源 Origin。
 *
 * **这份栅栏刻意留在本仓库**：`dsh-session-move` 那份按 socket 的 `remoteAddress`
 * 判断回环、`allowHosts` 只做精确字符串匹配，既不解析 authority 也不看
 * `sec-fetch-site`/`Origin`——两边语义不同，合并必然改掉其中一边的对外行为。
 * 共享包只提供路由骨架（`createApiHandler`），栅栏以回调形式传进去。
 * @param req - Node HTTP 请求。
 * @param allowHosts - 额外信任的 authority 列表。
 * @returns 是否放行。
 */
export function isTrustedRequest(req, allowHosts = []) {
  const rawHost = req?.headers?.host
  if (typeof rawHost !== 'string') return false
  const authority = parseAuthority(rawHost)
  if (authority === undefined) return false
  if (!isLoopback(authority.hostname) && !isAllowedAuthority(authority, allowHosts)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === authority.hostname
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// HTTP 接口
// ---------------------------------------------------------------------------

/*
 * JSON 响应封装与请求体读取已经搬到共享包（`writeJson` / `readJsonBody`），路由骨架
 * 由 `createApiHandler` 提供。**两处差异按原样保留**，因为它们是对外可观测的：
 *   - 本插件的响应带 `content-length`（`contentLength: true`），move 那份不带；
 *   - 本插件的请求体是「宽松」读法（不 trim、不校验类型、空 body 返回 `{}`），
 *     move 那份要求必须是普通对象。
 */

/** `GET` 与 `POST` 共用的方法表。 */
function buildApi(admin, config, log, holds) {
  return {
    /**
     * 浏览器半边需要的界面开关。
     *
     * 客户端读不到 Host 侧的部署配置，所以凡是「要不要渲染某个入口」这类决定，
     * 都得由 Host 显式告诉它。配置缺失或请求失败时客户端一律按「不渲染危险入口」
     * 处理，因此这里的默认值必须是安全的那一侧。
     */
    async config() {
      return {
        headerDeleteButton: config.headerDeleteButton === true,
        allowWorkspaceSessions: config.allowWorkspaceSessions === true,
        allowLiveSessions: config.allowLiveSessions === true,
        maxBatch: config.maxBatch,
      }
    },
    /**
     * 只要个数的轻量查询，供电标这类高频调用方使用。
     *
     * 与 `list` 的区别是跳过体积统计——那一步要递归遍历每个会话目录，是扫描里
     * 最贵的部分。角标只关心「有多少条」，不需要知道它们多大。
     */
    async count(payload) {
      const records = admin.scan({ measure: false })
      return {
        total: records.length,
        matched: admin.select(records, payload).length,
        scope: payload?.scope ?? 'all',
      }
    },
    /** 扫描会话并按范围返回。 */
    async list(payload) {
      const records = admin.scan()
      const selected = admin.select(records, payload)
      const groupCounts = {}
      for (const record of records) {
        const key = record.workspaceTitle ?? 'ungrouped'
        groupCounts[key] = (groupCounts[key] ?? 0) + 1
      }
      return {
        total: records.length,
        matched: selected.length,
        groups: groupCounts,
        sessions: selected.slice(0, payload?.limit ?? 2000).map((record) => ({
          id: record.id,
          title: record.title,
          cwd: record.cwd,
          workspaceTitle: record.workspaceTitle,
          ungrouped: record.ungrouped,
          archived: record.archived,
          subagent: record.subagent,
          temp: record.temp,
          cwdMissing: record.cwdMissing,
          live: holds.resident().has(record.id),
          running: holds.running().has(record.id),
          bytes: record.bytes,
          files: record.files,
          updatedAt: record.updatedAt,
        })),
        truncated: selected.length > (payload?.limit ?? 2000),
      }
    },
    /** 删除：先按范围解析出目标集合，再逐条过守卫。 */
    async delete(payload) {
      const records = admin.scan()
      const explicit = Array.isArray(payload?.sessionIds) ? payload.sessionIds : null
      const targets =
        explicit !== null
          ? explicit
          : admin.select(records, payload).map((record) => record.id)
      if (targets.length === 0) return { removed: 0, reclaimed: 0, results: [], pruned: [] }
      const result = await admin.remove(targets, {
        dryRun: payload?.dryRun === true,
        includeWorkspace: payload?.includeWorkspace === true || config.allowWorkspaceSessions,
        includeArchived: payload?.includeArchived === true,
        includeSubagent: payload?.includeSubagent === true,
        includeLive: payload?.includeLive === true || config.allowLiveSessions,
        live: holds.running(),
        callerSessionId: typeof payload?.callerSessionId === 'string' ? payload.callerSessionId : undefined,
        maxBatch: config.maxBatch,
      })
      if (result.removed > 0 && result.dryRun !== true) {
        log('info', `deleted ${result.removed} session(s), reclaimed ${result.reclaimed} bytes`)
      }
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// 模型侧工具
// ---------------------------------------------------------------------------

const SCOPE_VALUES = ['all', 'ungrouped', 'temp', 'archived', 'subagent', 'orphan']

/**
 * 工具的输入 schema。
 *
 * 必须是**真正的 JSON Schema**：`ctx.tools.register()` 收的是「已编译」的
 * `ToolDefinition`，不会再做编译。逐属性 `required: true` 的 schemastery 方言只有
 * `defineTool()` 会转成 JSON Schema（见 dsh-tools 的
 * `parameterSchemaSpecToJsonSchema`），而 register 会把传进来的对象原样透传给
 * provider：
 *   register → schemas() → requestWithMessages() → `{type:'function', function:{parameters}}`
 * 没有根 `type: 'object'` 时，DeepSeek 直接回 400：
 *   `Invalid schema for function 'session_admin': schema must be a JSON Schema of 'type: "object"', got 'type: null'.`
 * 注册本身不会报错（`register()` 只校验 `output.schema`），所以故障只在每次请求时
 * 爆出来。字段类型一律照 `assertSupportedJsonSchema` 的子集写
 * （type/oneOf/properties/required/additionalProperties/items/enum/const + 注解）。
 */
const TOOL_PARAMETERS = {
  type: 'object',
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'delete'],
      description:
        'list = enumerate matching sessions; delete = remove them.',
    },
    scope: {
      type: 'string',
      enum: SCOPE_VALUES,
      description: 'Which sessions are in range. Defaults to all.',
    },
    sessionIds: {
      type: 'array',
      items: { type: 'string', description: 'One exact session id.' },
      description: 'Explicit ids to delete. When present, scope only narrows nothing — these ids are the target set.',
    },
    cwdPrefix: {
      type: 'string',
      description: 'Only sessions whose working directory starts with this path.',
    },
    search: {
      type: 'string',
      description: 'Case-insensitive substring match over title, working directory, and session id.',
    },
    includeWorkspace: {
      type: 'boolean',
      description: 'Allow deleting sessions attached to a workspace (default false).',
    },
    includeArchived: {
      type: 'boolean',
      description: 'Allow deleting archived sessions (default false).',
    },
    includeSubagent: {
      type: 'boolean',
      description: 'Allow deleting subagent child sessions (default false).',
    },
    dryRun: {
      type: 'boolean',
      description: 'Report what would be deleted without touching anything.',
    },
    confirm: {
      type: 'boolean',
      description: 'Must be true for action="delete" to actually remove data.',
    },
    limit: {
      type: 'integer',
      description: 'Maximum rows returned by action="list" (default 200).',
    },
  },
}

/**
 * 工具的输出 schema。
 *
 * 同样是**真正的 JSON Schema**，`required` 是对象级的字符串数组。`register()` 会对
 * 它跑 `assertSupportedJsonSchema`，写成逐属性 `required: true` 的方言会直接抛
 * `JsonSchemaError`，而插件加载失败会连带整个 profile 启动失败。
 *
 * 也只声明自己完全掌控类型的字段：会话行里 `title` / `cwd` / `workspaceTitle`
 * 都可能是 null，一律交给 `additionalProperties` 兜住，不做类型约束。
 */
const TOOL_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the call itself succeeded.' },
    summary: { type: 'string', description: 'One-line human summary of the outcome.' },
    total: { type: 'integer' },
    matched: { type: 'integer' },
    removed: { type: 'integer' },
    skipped: { type: 'integer' },
    reclaimedBytes: { type: 'integer' },
    dryRun: { type: 'boolean' },
    rejections: {
      type: 'array',
      description: 'Rows the guards refused, with the machine-readable reason.',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
}

/** 人可读的字节数。 */
function human(bytes) {
  if (!Number.isFinite(bytes)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * 会话管理工具的注册体。
 * @param admin - 会话管理员。
 * @param config - 插件配置。
 * @param log - 日志函数。
 * @param holds - `{resident, running}`：进程仍挂着的会话集合，以及其中**正在跑**的那部分。
 * @returns `ctx.tools.register` 接受的普通对象定义。
 */
function buildTool(admin, config, log, holds) {
  const api = buildApi(admin, config, log, holds)
  return {
    name: 'session_admin',
    description:
      'List or permanently delete persisted DSH sessions on this machine. DSH itself can only archive (hide) a session; this tool removes its durable data (session log, projection cache, rewind snapshots) and drops the session from its Workspace membership, archive set and pin set, so no dangling reference is left behind. ' +
      'Always start with action="list" plus a scope to see exactly what is in range, then call action="delete" with the SAME scope and confirm=true. ' +
      'Scope values: all (every persisted session), ungrouped (exactly the rows the sidebar shows under Ungrouped — no workspace, and neither archived nor a subagent child), temp (sessions whose working directory is gone or under the OS temp dir), archived, subagent, orphan (no session log left, only a stale cache entry). ' +
      'Sessions that belong to a workspace, are currently open/running, are archived, or are subagent children are REFUSED unless you pass the matching include* flag; report those refusals to the user instead of retrying blindly. ' +
      'Deletion is irreversible — there is no undo and no trash.',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'delete' ? 'Delete sessions' : 'List sessions',
      kind: 'other',
      rawInput: { action: args.action, scope: args.scope ?? 'all' },
    }),
    async execute(args, exec) {
      const scope = args.scope ?? 'all'
      const callerSessionId = exec?.agent?.session?.id
      if (args.action === 'list') {
        const payload = {
          scope,
          cwdPrefix: args.cwdPrefix,
          search: args.search,
          limit: Math.max(1, Math.min(Number(args.limit ?? 200), 2000)),
        }
        const value = await api.list(payload)
        const head = `Scope "${scope}": ${value.matched} of ${value.total} sessions match.`
        return {
          ok: true,
          total: value.total,
          matched: value.matched,
          sessions: value.sessions,
          summary: `${head} ${value.truncated ? '(list truncated) ' : ''}${value.sessions
            .slice(0, 12)
            .map((s) => `${s.id} — ${s.title ?? '(untitled)'} [${s.cwd ?? 'unknown cwd'}]`)
            .join(' | ')}`,
        }
      }
      if (args.confirm !== true) {
        // 不真删：把它们当作一次预演，把「确认后会发生什么」原样回给模型。
        const payload = {
          scope,
          sessionIds: args.sessionIds,
          cwdPrefix: args.cwdPrefix,
          search: args.search,
          dryRun: true,
          includeWorkspace: args.includeWorkspace === true,
          includeArchived: args.includeArchived === true,
          includeSubagent: args.includeSubagent === true,
        }
        const value = await api.delete(payload)
        const rejections = value.results.filter((r) => r.status === 'skipped')
        return {
          ok: true,
          dryRun: true,
          removed: 0,
          matched: value.results.length,
          reclaimedBytes: value.reclaimed,
          rejections: rejections.map((r) => ({ id: r.id, reason: r.reason })),
          summary: `DRY RUN — confirm is not true, nothing was deleted. ${value.results.length} session(s) in range, ${value.reclaimed} bytes would be reclaimed. ${rejections.length} would be refused (${summarizeReasons(rejections)}). Re-issue with confirm=true to proceed.`,
        }
      }
      const value = await api.delete({
        scope,
        sessionIds: args.sessionIds,
        cwdPrefix: args.cwdPrefix,
        search: args.search,
        dryRun: false,
        includeWorkspace: args.includeWorkspace === true,
        includeArchived: args.includeArchived === true,
        includeSubagent: args.includeSubagent === true,
        callerSessionId,
      })
      const failures = value.results.filter((r) => r.status === 'failed')
      const rejections = value.results.filter((r) => r.status === 'skipped')
      return {
        ok: true,
        removed: value.removed,
        skipped: rejections.length,
        reclaimedBytes: value.reclaimed,
        dryRun: false,
        rejections: rejections.map((r) => ({ id: r.id, reason: r.reason })),
        summary:
          `Deleted ${value.removed} session(s), reclaimed ${human(value.reclaimed)}.` +
          (value.pruned.length > 0 ? ` Pruned ${value.pruned.length} empty project dir(s).` : '') +
          (rejections.length > 0 ? ` Refused ${rejections.length}: ${summarizeReasons(rejections)}.` : '') +
          (failures.length > 0 ? ` Failed ${failures.length}: ${failures.map((r) => `${r.id} (${r.reason})`).join('; ')}.` : ''),
      }
    },
  }
}

/** 把拒绝理由压成 `reason×n` 形式的一句话。 */
function summarizeReasons(results) {
  const counts = new Map()
  for (const result of results) counts.set(result.reason, (counts.get(result.reason) ?? 0) + 1)
  return [...counts.entries()].map(([reason, count]) => `${reason}×${count}`).join(', ')
}

// ---------------------------------------------------------------------------
// Cordis 装配
// ---------------------------------------------------------------------------


/**
 * 挂载删除半边：路由 + 工具。
 *
 * 与搬迁半边刻意不同的三点（原样保留的理由）：
 *   - 信任栅栏按 `Host` 头判断（`isTrustedRequest`），额外拒绝 `sec-fetch-site: cross-site`
 *     与跨源 `Origin`；搬迁半边看 socket 的 `remoteAddress`；
 *   - 响应带 `content-length`；
 *   - 请求体按**宽松模式**读（空白 body 走 `JSON.parse` 报错，非对象不拦）。
 *
 * @param ctx - Host cordis 上下文（`webServer` / `tools` / `sessions` / `workspaceRegistry`）。
 * @param config - 已解包的**活配置对象**：身份由入口保持，volatile 更新时原地覆盖，
 *   所以下面这些闭包自动看到最新值。
 * @param log - `(level, message) => void`（入口传的是 admin 那套行格式的文件日志）。
 * @returns 无。
 */
export function mountAdmin(ctx, config, log) {
  /**
   * 把一个即将被删除的会话从它登记过的每个持久结构里摘掉。
   *
   * 实现（工作区成员表 + 归档集合 + 置顶集合，且**必须早于删文件**）在共享包
   * `releaseSessionEverywhere` 里——`dsh-session-move` 面对的是同一张登记表，
   * 「成员表是按会话头过滤过的视图」这条事实只该写一遍。
   *
   * @param sessionId - 即将删除的会话 id。
   * @returns 全部持久写入完成之后 resolve。
   */
  const releaseSession = (sessionId) => releaseSessionEverywhere(ctx.workspaceRegistry, sessionId)
  const admin = createSessionAdmin({ releaseSession })
  /**
   * Host 进程里仍挂着的会话（`ctx.sessions.list()`）。
   *
   * 注意这**不等于**「正在用」：会话是在创建 agent 时被 enter 的
   * （dsh-agent-loop/index.js:1714 `agent.ctx.sessions.enter(session)`），而 agent 只在
   * 被 dispose 时才 detach——一个长期运行的 `dsh web` 里，只要碰过就基本一直挂着。
   * 所以这个集合只用来做界面提示，不用来做删除守卫。
   */
  const residentIds = () => residentSessionIds(ctx.get('sessions'))
  /**
   * 真正不能删的：**这一轮还在跑**的会话。删它会让进行中的写入失败、把这一轮弄坏，
   * 所以一律拒绝（`allowLiveSessions` 可强行放行）。
   *
   * 驻留但空闲的会话不在这个集合里，理由见 `remove()` 里 live 守卫的注释：整目录删除
   * 之后 Host 再写只会得到 ENOENT（`open(path,'a')` 不创建父目录），不会生成无头日志。
   *
   * 拿不到 agent 服务时**保守退化**为「全部驻留会话都算在跑」——宁可拒绝，不可误删。
   * 这条退化策略与 `dsh-session-move` 的「未知」策略不同，所以两份都留在共享包里
   * （`runningSessionIds` 与 `agentSessionStatus`），各自用各自的那一个。
   */
  const runningIds = () => runningSessionIds(residentIds(), ctx.get('agents'))
  const holds = { resident: residentIds, running: runningIds }
  const api = buildApi(admin, config, log, holds)
  log('info', `mounted: home=${admin.home} prefix=${ADMIN_API_PREFIX} allowHosts=[${config.adminAllowHosts.join(', ')}]`)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ADMIN_API_PREFIX,
        // 路由骨架（403/404/200/400 的响应体、方法名解析、GET 走 query）在共享包里；
        // 三件"只有本插件才有的策略"以参数传进去：
        //   - 信任栅栏（Host 头 + Origin/sec-fetch-site 版，见 isTrustedRequest）；
        //   - 响应带 content-length（本插件原有行为）；
        //   - 请求体按**宽松模式**读（默认），与 move 的严格模式不同。
        handler: createApiHandler({
          prefix: ADMIN_API_PREFIX,
          methods: api,
          trustRequest: (req) => isTrustedRequest(req, config.adminAllowHosts),
          contentLength: true,
          log,
        }),
      }),
    'dsh-session-admin: api route',
  )

  ctx.effect(
    () => ctx.tools.register(buildTool(admin, config, log, holds)),
    'dsh-session-admin: session_admin tool',
  )
}

// 2026-09-25：本文件由 dsh-session-admin/lib/index.js 逐字搬入 dsh-session-toolbox（合并包）。
