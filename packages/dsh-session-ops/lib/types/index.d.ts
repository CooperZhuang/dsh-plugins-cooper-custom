/**
 * `dsh-session-ops` Host 半边（插件入口）。
 *
 * 这个包把原先两个独立插件合并成**一个** DSH 插件：
 *   - `dsh-session-admin`（删除）→ {@link module:dsh-session-ops/admin}；
 *   - `dsh-session-move`（搬迁）→ {@link module:dsh-session-ops/move}。
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
 * @module dsh-session-ops
 */
import z from '@deepseek-ai/schemastery';
import { ADMIN_API_PREFIX, createSessionAdmin, isInside, isTrustedRequest as isTrustedAdminRequest, mountAdmin } from './admin.js';
import { MOVE_API_PREFIX, isTrustedRequest as isTrustedMoveRequest, mountForkMembershipRepair, mountMove, sweepForkChildrenOnBoot } from './move.js';
import type { WorkspaceRegistryLike } from './store/registry.js';
import type { SessionPersistenceLike } from './move.js';
export { ADMIN_API_PREFIX, MOVE_API_PREFIX, createSessionAdmin, isInside, isTrustedAdminRequest, isTrustedMoveRequest, mountAdmin, mountForkMembershipRepair, mountMove, sweepForkChildrenOnBoot, };
/**
 * 搬迁半边原来的公开名（`dsh-session-move` 的 `API_PREFIX = '/session-move/api'`）。
 *
 * 合并后两半各有一个前缀，明确的名字是 {@link ADMIN_API_PREFIX} / {@link MOVE_API_PREFIX}；
 * 这个别名留着，是为了让按 `dsh-session-move/lib/index.js` 写过 import 的脚本/测试不改也能跑。
 */
export declare const API_PREFIX = "/session-move/api";
/** Cordis 插件名（profile 行 id 是 `session-toolbox`，两者刻意不同名）。 */
export declare const name = "dsh-session-ops";
/**
 * 依赖的服务。**这不是可选的**：cordis 里没有声明 inject 就拿不到服务，
 * `ctx.webServer` / `ctx.tools` / `ctx.sessions` / `ctx.sessionPersistence` 会静默是
 * undefined——表现是日志照常打「mounted」但路由 404、工具根本没注册、守卫形同虚设。
 *
 * 两份清单的并集：删除半边要 `sessions`（Host 进程里挂着的会话），搬迁半边要
 * `sessionPersistence`（会话根与写入句柄）。`workspaceRegistry` / `webServer` / `tools`
 * 两边都要。
 */
export declare const inject: string[];
/** 设置命名空间；与 client 半边 `settings.section` 的 id 必须一致。 */
export declare const SETTINGS_NS = "session-toolbox";
/**
 * 插件配置（两份原配置的**并集**，键名与默认值见 {@link module:dsh-session-ops} 的表）。
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
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** 总开关（两半共用）。关掉后两条路由与两个工具都不注册。改它需要重挂本行（非 volatile）。 */
    enabled: z<boolean, boolean, "defined">;
    /** 会话根目录；留空则从 `sessionPersistence.root` 推断（jsonl 后端会暴露它）。搬迁半边用。 */
    root: z<string, string, "defined">;
    /**
     * 删除半边的额外信任 authority（`host` 或 `host:port`，按 `Host` 头解析）。
     * 原 `dsh-session-admin` 的 `allowHosts`。默认空——只信 loopback。
     */
    adminAllowHosts: z<string[], string[], "defined">;
    /**
     * 搬迁半边的额外信任 authority（`host` 或 `host:port`，按 socket 的 `remoteAddress`
     * 精确匹配）。原 `dsh-session-move` 的 `allowHosts`。默认空——只信 loopback。
     */
    moveAllowHosts: z<string[], string[], "defined">;
    /** 是否允许删「属于某个工作区」的会话。默认否——工作区会话通常还想留。 */
    allowWorkspaceSessions: z<boolean, boolean, "volatile-defined">;
    /** 是否允许删仍然挂在 Host 进程里的会话（正在浏览/正在跑）。默认否。 */
    allowLiveSessions: z<boolean, boolean, "volatile-defined">;
    /** 一次调用最多删多少个，防手滑。 */
    maxBatch: z<number, number, "volatile-defined">;
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
    headerDeleteButton: z<boolean, boolean, "volatile-defined">;
    /** 是否拒绝搬"正在跑一轮"的会话。默认拒绝——搬运期间它的写入句柄可能落盘。 */
    refuseRunning: z<boolean, boolean, "volatile-defined">;
    /** `list` 一次最多返回多少条会话（浏览器半边还要筛选）。 */
    maxSessions: z<number, number, "volatile-defined">;
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
    memoryFollow: z<string, string, "volatile-defined">;
    /**
     * 启动时是否做一轮「fork 子会话漏挂工作区」的定向扫描。
     *
     * 创建期的 `session/created` 补挂只挡住「Host fork 时就没挂」。记账写进去之后
     * 又被抹掉的那一类（同机两个 Host 共用 `$DSH_HOME` 时，另一个进程用旧内存快照
     * 重写 `storages/workspace.json`）只有启动期扫描能补回来，所以默认开启。
     *
     * 扫描范围收得很窄：只认带 `parentSession` 的普通 fork 子会话（排除 `origin:
     * subagent` 与 `delegationDepth > 0`），且父会话已被某个工作区记账、子会话
     * `cwd` 规范化后等于该工作区路径。刻意 ungrouped 的普通会话/迁移会话不碰。
     */
    repairForkChildrenOnBoot: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** 总开关（两半共用）。关掉后两条路由与两个工具都不注册。改它需要重挂本行（非 volatile）。 */
    enabled: z<boolean, boolean, "defined">;
    /** 会话根目录；留空则从 `sessionPersistence.root` 推断（jsonl 后端会暴露它）。搬迁半边用。 */
    root: z<string, string, "defined">;
    /**
     * 删除半边的额外信任 authority（`host` 或 `host:port`，按 `Host` 头解析）。
     * 原 `dsh-session-admin` 的 `allowHosts`。默认空——只信 loopback。
     */
    adminAllowHosts: z<string[], string[], "defined">;
    /**
     * 搬迁半边的额外信任 authority（`host` 或 `host:port`，按 socket 的 `remoteAddress`
     * 精确匹配）。原 `dsh-session-move` 的 `allowHosts`。默认空——只信 loopback。
     */
    moveAllowHosts: z<string[], string[], "defined">;
    /** 是否允许删「属于某个工作区」的会话。默认否——工作区会话通常还想留。 */
    allowWorkspaceSessions: z<boolean, boolean, "volatile-defined">;
    /** 是否允许删仍然挂在 Host 进程里的会话（正在浏览/正在跑）。默认否。 */
    allowLiveSessions: z<boolean, boolean, "volatile-defined">;
    /** 一次调用最多删多少个，防手滑。 */
    maxBatch: z<number, number, "volatile-defined">;
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
    headerDeleteButton: z<boolean, boolean, "volatile-defined">;
    /** 是否拒绝搬"正在跑一轮"的会话。默认拒绝——搬运期间它的写入句柄可能落盘。 */
    refuseRunning: z<boolean, boolean, "volatile-defined">;
    /** `list` 一次最多返回多少条会话（浏览器半边还要筛选）。 */
    maxSessions: z<number, number, "volatile-defined">;
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
    memoryFollow: z<string, string, "volatile-defined">;
    /**
     * 启动时是否做一轮「fork 子会话漏挂工作区」的定向扫描。
     *
     * 创建期的 `session/created` 补挂只挡住「Host fork 时就没挂」。记账写进去之后
     * 又被抹掉的那一类（同机两个 Host 共用 `$DSH_HOME` 时，另一个进程用旧内存快照
     * 重写 `storages/workspace.json`）只有启动期扫描能补回来，所以默认开启。
     *
     * 扫描范围收得很窄：只认带 `parentSession` 的普通 fork 子会话（排除 `origin:
     * subagent` 与 `delegationDepth > 0`），且父会话已被某个工作区记账、子会话
     * `cwd` 规范化后等于该工作区路径。刻意 ungrouped 的普通会话/迁移会话不碰。
     */
    repairForkChildrenOnBoot: z<boolean, boolean, "defined">;
}>>, "plain">;
/**
 * 解包后的插件配置（键名与 {@link Config} 一一对应，值都已收敛成普通值）。
 *
 * 手写而不是从 schemastery 推导：推到 `Config` 的完整类型会把 `.volatile()` 的
 * `Volatile<T>` 包装也带出来，而 `apply` 里看到的永远是解包后的普通值。
 */
export interface SessionOpsConfig {
    enabled: boolean;
    root: string;
    adminAllowHosts: string[];
    moveAllowHosts: string[];
    allowWorkspaceSessions: boolean;
    allowLiveSessions: boolean;
    maxBatch: number;
    headerDeleteButton: boolean;
    refuseRunning: boolean;
    maxSessions: number;
    memoryFollow: string;
    repairForkChildrenOnBoot: boolean;
}
/**
 * 解包 entry 配置里的 `.volatile()` 活引用，并交给 schema 校验补默认值。
 *
 * 实现在 `lib/store/host.js`：先解包输入、再校验、最后**再解包一次**——
 * schemastery 对 `.volatile()` 字段输出的也是活引用，不收敛的话读到的就是 `{ get() }`
 * 对象（HTTP 面上会变成一个空对象）。
 * @param raw - entry 配置或普通配置对象。
 * @returns 普通值配置。
 */
export declare function resolveConfig(raw?: Record<string, unknown>): SessionOpsConfig;
/**
 * Host cordis 上下文里本入口用到的那部分。
 *
 * DSH/Cordis 的 `Context` 在编译期拿不到（本包没有把 `@deepseek-ai/cordis` 列为依赖），
 * 而这里只需要这几个成员：`inject` 声明过的服务、`ctx.get()`、`ctx.effect()`、`ctx.on()`。
 */
export interface SessionOpsContext {
    logger?: Record<string, ((message: string) => unknown) | undefined> | undefined;
    on: (event: string, handler: (...args: any[]) => unknown) => unknown;
    effect: (fn: () => unknown, label?: string) => unknown;
    get: (name: string) => any;
    webServer: {
        register(options: unknown): unknown;
    };
    tools: {
        register(definition: unknown): unknown;
    };
    workspaceRegistry: WorkspaceRegistryLike;
    sessionPersistence?: SessionPersistenceLike | undefined;
}
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
export declare function apply(ctx: SessionOpsContext, rawConfig?: Record<string, unknown>): void;
/**
 * 会话存储原语全量再导出（`lib/store/` 的五个模块）：
 * `dshHome`、`encodeSegment`、`readSessionHeader`、`hasZstd`、`decodeProjectKey` 等。
 *
 * 原来的会话存储共享库根入口就是这个形状；合并成单包后保留同一份公开面，
 * 外部按包名导入的脚本（如 dsh-open-in-dsh）只改包名即可，不必换符号名。
 * 需要显式分层时也可以用子路径 `dsh-session-ops/store`（见 package.json exports）。
 */
export * from './store/index.js';
