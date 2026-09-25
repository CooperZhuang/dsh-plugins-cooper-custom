/**
 * `dsh-session-toolbox` Host 半边（插件入口）。
 *
 * 这个包把原先两个独立插件合并成**一个** DSH 插件：
 *   - `dsh-session-admin`（删除）→ {@link module:dsh-session-toolbox/admin}；
 *   - `dsh-session-move`（搬迁）→ {@link module:dsh-session-toolbox/move}。
 *
 * 两个半边的代码是**逐字搬过来的**（见两个模块头部列出的差异清单），这里只做合并后的
 * 那一层：一份配置 schema、一个活配置对象、一次 `loader/volatile-update` 订阅、
 * 一个 `apply`，把两条路由与两个工具注册出去。
 *
 * ## 对外契约（合并后一条都不许变）
 *
 *   - HTTP：`/session-admin/api/<method>` 与 `/session-move/api/<method>` 的方法名、
 *     入参、`{ok:true,value}` / `{ok:false,error:{code,message}}` 响应形状；
 *   - 模型工具：`session_admin` 与 `session_move` 的名字、`parameters`、`output.schema`；
 *   - 文档与排障产物：`$DSH_HOME/logs/dsh-session-admin.log`（`[时间] 级别 正文`）与
 *     `$DSH_HOME/logs/dsh-session-move.log`（`时间 [级别] 正文`）两个文件与两种行格式；
 *   - 安全默认：`allowWorkspaceSessions` / `allowLiveSessions` / `moveAllowHosts` /
 *     `adminAllowHosts` / `memoryFollow` 一律落在安全的一侧（见 {@link Config}）。
 *
 * ## 配置键的合并方式
 *
 * 两半原先各有一个 `allowHosts`，但语义不同（删除半边按 `Host` 头解析 authority，
 * 搬迁半边按 socket 的 `remoteAddress` 精确匹配），所以**拆成两个键**而不是合并：
 *
 * | 旧键（dsh-session-admin） | 旧键（dsh-session-move） | 新键 |
 * | --- | --- | --- |
 * | `enabled` | `enabled` | `enabled`（两半共用一个总开关） |
 * | `allowHosts` | — | `adminAllowHosts` |
 * | — | `allowHosts` | `moveAllowHosts` |
 * | — | `root` | `root` |
 * | `headerDeleteButton` | — | `headerDeleteButton` |
 * | `allowWorkspaceSessions` | — | `allowWorkspaceSessions` |
 * | `allowLiveSessions` | — | `allowLiveSessions` |
 * | `maxBatch` | — | `maxBatch` |
 * | — | `refuseRunning` | `refuseRunning` |
 * | — | `maxSessions` | `maxSessions` |
 * | — | `memoryFollow` | `memoryFollow` |
 *
 * 只有 `enabled` 是**语义合并**（两半原先各一个，现在一个）：任一旧值为 `false` 的
 * 组合在新键下都会变成「全开或全关」，profile patch 要按新语义重写。
 *
 * @module dsh-session-toolbox
 */

import z from '@deepseek-ai/schemastery'
import {
  LOG_LINE_LEVEL_FIRST,
  LOG_LINE_TIME_FIRST,
  createFileLogger,
  resolveVolatileConfig,
} from 'dsh-session-store'
import {
  ADMIN_API_PREFIX,
  createSessionAdmin,
  isInside,
  isTrustedRequest as isTrustedAdminRequest,
  mountAdmin,
} from './admin.js'
import { MOVE_API_PREFIX, isTrustedRequest as isTrustedMoveRequest, mountMove } from './move.js'

export {
  ADMIN_API_PREFIX,
  MOVE_API_PREFIX,
  createSessionAdmin,
  isInside,
  isTrustedAdminRequest,
  isTrustedMoveRequest,
  mountAdmin,
  mountMove,
}

/**
 * 搬迁半边原来的公开名（`dsh-session-move` 的 `API_PREFIX = '/session-move/api'`）。
 *
 * 合并后两半各有一个前缀，明确的名字是 {@link ADMIN_API_PREFIX} / {@link MOVE_API_PREFIX}；
 * 这个别名留着，是为了让按 `dsh-session-move/lib/index.js` 写过 import 的脚本/测试不改也能跑。
 */
export const API_PREFIX = MOVE_API_PREFIX

// ---------------------------------------------------------------------------
// 插件元信息
// ---------------------------------------------------------------------------

/** Cordis 插件名（profile 行 id 是 `session-toolbox`，两者刻意不同名）。 */
export const name = 'dsh-session-toolbox'

/**
 * 依赖的服务。**这不是可选的**：cordis 里没有声明 inject 就拿不到服务，
 * `ctx.webServer` / `ctx.tools` / `ctx.sessions` / `ctx.sessionPersistence` 会静默是
 * undefined——表现是日志照常打「mounted」但路由 404、工具根本没注册、守卫形同虚设。
 *
 * 两份清单的并集：删除半边要 `sessions`（Host 进程里挂着的会话），搬迁半边要
 * `sessionPersistence`（会话根与写入句柄）。`workspaceRegistry` / `webServer` / `tools`
 * 两边都要。
 */
export const inject = ['webServer', 'tools', 'sessions', 'sessionPersistence', 'workspaceRegistry']

/** 设置命名空间；与 client 半边 `settings.section` 的 id 必须一致。 */
export const SETTINGS_NS = 'session-toolbox'

// ---------------------------------------------------------------------------
// 配置（两半合并成一份 schema）
// ---------------------------------------------------------------------------

/**
 * 插件配置（两份原配置的**并集**，键名与默认值见 {@link module:dsh-session-toolbox} 的表）。
 *
 * 键分两类，区别是**能不能在线改**：
 *
 *   - **旋钮**：标了 `.volatile()` 的字段由 Loader 以活引用（`{ get() }`）交给 `apply`，
 *     写盘后原地更新引用、再补发一次 `loader/volatile-update`。插件页上本行的「配置」
 *     卡片写的就是这 7 个字段，落盘在 profile 的 `cordis.patch.yml` 里，**不重启、不重挂**。
 *   - **组合事实**：`enabled`（挂载期决定注册什么）、`root`（挂载期解析会话根）、
 *     `adminAllowHosts` / `moveAllowHosts`（挂载期决定 HTTP 信任栅栏）。刻意不标 volatile：
 *     不进表单，要改就改 profile 的 patch（改完本行会重挂一次）。
 *
 * `description` 会随 schema 进入表单描述，是界面文案的权威来源。
 */
export const Config = z.object({
  /** 总开关（两半共用）。关掉后两条路由与两个工具都不注册。改它需要重挂本行（非 volatile）。 */
  enabled: z.boolean().default(true),
  /** 会话根目录；留空则从 `sessionPersistence.root` 推断（jsonl 后端会暴露它）。搬迁半边用。 */
  root: z.string().default(''),
  /**
   * 删除半边的额外信任 authority（`host` 或 `host:port`，按 `Host` 头解析）。
   * 原 `dsh-session-admin` 的 `allowHosts`。默认空——只信 loopback。
   */
  adminAllowHosts: z.array(String).default([]),
  /**
   * 搬迁半边的额外信任 authority（`host` 或 `host:port`，按 socket 的 `remoteAddress`
   * 精确匹配）。原 `dsh-session-move` 的 `allowHosts`。默认空——只信 loopback。
   */
  moveAllowHosts: z.array(String).default([]),
  /** 是否允许删「属于某个工作区」的会话。默认否——工作区会话通常还想留。 */
  allowWorkspaceSessions: z.boolean().default(false)
    .description('允许删除「属于某个工作区」的会话。默认否——工作区会话通常还想留。')
    .volatile(),
  /** 是否允许删仍然挂在 Host 进程里的会话（正在浏览/正在跑）。默认否。 */
  allowLiveSessions: z.boolean().default(false)
    .description('允许删除仍然挂在 Host 进程里的会话（正在浏览或正在跑）。默认否。')
    .volatile(),
  /** 一次调用最多删多少个，防手滑。 */
  maxBatch: z.number().default(200)
    .description('一次调用最多删多少个会话，防手滑。默认 200。')
    .volatile(),
  /**
   * 是否在会话标题栏显示「删除当前会话」的垃圾桶图标。**默认开启。**
   *
   * 形态刻意是「图标 + 二次确认」而不是带字面标签的按钮：标签会招来点击，而这里
   * 删的正是你正在用的会话。图标不占字面位置，误点最多弹出一个确认框，离真正删除
   * 还隔着一步。清理由右侧「会话管理」面板或设置页承担，那是显式挑选动作。
   *
   * 这是个 volatile 旋钮：浏览器半边在挂载时问一次 Host（`config` 接口），所以
   * 改完**刷新页面**就生效——不需要重启 dsh web，也不需要重挂本插件。
   */
  headerDeleteButton: z.boolean().default(true)
    .description('在会话标题栏显示「删除当前会话」的垃圾桶图标。默认开启；关掉后清理由「会话管理」面板/设置页承担。改完刷新页面生效。')
    .volatile(),
  /** 是否拒绝搬"正在跑一轮"的会话。默认拒绝——搬运期间它的写入句柄可能落盘。 */
  refuseRunning: z.boolean().default(true)
    .description('拒绝搬迁「正在跑一轮」的会话。默认开启——搬运期间它的写入句柄可能落盘。')
    .volatile(),
  /** `list` 一次最多返回多少条会话（浏览器半边还要筛选）。 */
  maxSessions: z.number().default(2000)
    .description('`list` 一次最多返回多少条会话（浏览器半边还要筛选）。默认 2000。')
    .volatile(),
  /**
   * 项目作用域记忆的条目要不要跟着会话走。**默认 off**。
   *
   * 项目记忆是**工作区共享**的（一次写入、那个工作区里所有会话都读），所以把一条
   * 会话的条目拖到另一个工作区会改变那边的记忆视图——只有"这条会话本来就该在目标
   * 工作区"（纠正错放）时才该这么做：
   *   - `off`  ：什么都不做。报告里仍给出**只读预览**（若开启会复制哪几条）。
   *   - `copy` ：把该会话产出的条目（frontmatter `session:` 精确匹配）复制到目标
   *              工作区，按文件名去重，源工作区不动。
   *   - `move` ：同上，但复制后从源工作区移除（不可逆，谨慎）。
   */
  memoryFollow: z.string().default('off')
    .description('项目记忆跟随：off 只给只读预览（默认 / 推荐）；copy 把本会话产出的条目复制到目标工作区；move 复制后从源移除（不可逆）。')
    .volatile(),
})

/**
 * 解包 entry 配置里的 `.volatile()` 活引用，并交给 schema 校验补默认值。
 *
 * 实现在 `dsh-session-store/lib/host.js`：先解包输入、再校验、最后**再解包一次**——
 * schemastery 对 `.volatile()` 字段输出的也是活引用，不收敛的话读到的就是 `{ get() }`
 * 对象（HTTP 面上会变成一个空对象）。
 * @param raw - entry 配置或普通配置对象。
 * @returns 普通值配置。
 */
export function resolveConfig(raw = {}) {
  return resolveVolatileConfig(Config, raw)
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * 挂载插件：两条路由 + 两个工具。
 *
 * 两个半边共用**同一个活配置对象**（见下），各自的信任栅栏读各自的那个键
 * （`adminAllowHosts` / `moveAllowHosts`），所以 volatile 更新只需要在这里重读一次。
 *
 * 日志刻意保留两份、两种行格式：`$DSH_HOME/logs/dsh-session-admin.log`
 * （`[时间] 级别 正文`）与 `$DSH_HOME/logs/dsh-session-move.log`（`时间 [级别] 正文`）
 * 是合并前就存在的排障产物，合并后依然按各自的格式写各自那份。
 *
 * @param ctx - Host cordis 上下文（已 inject 五个服务）。
 * @param rawConfig - 部署层配置。
 * @returns 无。
 */
export function apply(ctx, rawConfig) {
  /**
   * 当前生效的配置。
   *
   * 对象**身份保持不变**：volatile 字段更新时只把新值 `Object.assign` 进来，于是两个
   * 半边里所有已经捕获了 `config` 的闭包（HTTP 方法表、工具、信任栅栏、日志）自动
   * 看到最新值，不需要重挂，也不需要额外的 getter 管道。
   */
  const config = { ...resolveConfig(rawConfig) }
  // 两个半边各自的文件日志（行格式是各自原有的排障产物，见 dsh-session-store/host）。
  const adminLog = createFileLogger(ctx, { name: 'dsh-session-admin', formatLine: LOG_LINE_LEVEL_FIRST })
  const moveLog = createFileLogger(ctx, { name: 'dsh-session-move', formatLine: LOG_LINE_TIME_FIRST })
  const logs = [adminLog, moveLog]
  // volatile 字段写盘后 Loader 原地换引用并补发这个事件：重读一次就能拿到新值。
  ctx.on('loader/volatile-update', () => {
    try {
      Object.assign(config, resolveConfig(rawConfig))
    } catch (error) {
      // 表单写盘前会先校验候选值，正常路径不会走到这里；真出错也不能把插件带崩。
      for (const log of logs) log('warn', `config refresh failed: ${String(error)}`)
    }
  })
  if (config.enabled === false) {
    for (const log of logs) log('info', 'disabled by config; nothing registered')
    return
  }

  mountAdmin(ctx, config, adminLog)
  mountMove(ctx, config, moveLog)
}

// ---------------------------------------------------------------------------
// 兼容再导出
// ---------------------------------------------------------------------------

/** `$DSH_HOME` 与项目目录键的反解（原两个插件都从这里再导出，合并后仍然可用）。 */
export { decodeProjectKey, dshHome } from 'dsh-session-store'

// 2026-09-25：本文件是 dsh-session-admin + dsh-session-move 的合并入口
// （两个源仓库保持原样、可回退；共享存储知识来自 dsh-session-store）。
