/**
 * `dsh-session-ops` 的**删除半边**（原 `dsh-session-admin` 插件的 Host 半边）。
 *
 * 这一半的代码搬自原 `dsh-session-admin` 的 `lib/index.js`，只有四处差异：
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
 * @module dsh-session-ops/admin
 */
import { dshHome } from './store/host.js';
import type { LogFn } from './store/host.js';
import type { HttpRequest } from './store/http.js';
import { decodeProjectKey } from './store/paths.js';
import type { WorkspaceRegistryLike } from './store/registry.js';
import type { SessionOpsConfig } from './index.js';
/** HTTP 路由前缀（两半各一条，合并后仍然分开）。 */
export declare const ADMIN_API_PREFIX = "/session-admin/api";
/**
 * `$DSH_HOME`（环境变量优先，默认 `~/.dsh`）。
 *
 * 实现在 `lib/store/host.js`——它与搬迁半边用的是同一份；
 * 这里再导出，保持本仓库的公开面不变。
 */
export { dshHome };
/**
 * 把 `sessions/` 下的项目目录键还原成路径。
 *
 * 实现在 `lib/store/paths.js`：它与搬迁半边的 `projectKey`
 * 是同一套规则的两个方向，规则只该有一份。这里再导出，保持本仓库的公开面不变。
 */
export { decodeProjectKey };
/** 路径是否落在某个根目录内部（防目录穿越）。 */
export declare function isInside(root: string, candidate: string): boolean;
/** 扫描出来的一条会话记录。 */
export interface SessionRecord {
    id: string;
    dir: string;
    project: string;
    cwd: string | null;
    title: string | null;
    origin: string | null;
    parentSessionId: string | null;
    isSeeded: boolean | null;
    headerReadable: boolean;
    workspaceId: string | null;
    workspaceTitle: string | null;
    ungrouped: boolean;
    archived: boolean;
    subagent: boolean;
    cwdMissing: boolean;
    temp: boolean;
    bytes: number;
    files: number;
    updatedAt: number;
    hasProjCache: boolean;
    hasRewind: boolean;
}
/** {@link SessionAdmin.scan} 的选项。 */
export interface ScanOptions {
    /** `false` 跳过逐会话的体积统计（只要个数的调用方用它压开销）。 */
    measure?: boolean;
}
/** {@link SessionAdmin.select} 的范围查询。 */
export interface SelectQuery {
    scope?: string;
    cwdPrefix?: string;
    search?: string;
}
/** {@link SessionAdmin.remove} 的选项。 */
export interface RemoveOptions {
    dryRun?: boolean;
    includeWorkspace?: boolean;
    includeArchived?: boolean;
    includeSubagent?: boolean;
    includeLive?: boolean;
    /** **正在跑**、因此现在不能删的 id 集合。 */
    live?: Set<string>;
    callerSessionId?: string;
    maxBatch?: number;
}
/** {@link SessionAdmin.remove} 里逐条的结果。 */
export interface RemoveResult {
    id: string;
    status: 'skipped' | 'would-remove' | 'failed' | 'removed';
    reason?: string;
    bytes?: number;
}
/** {@link SessionAdmin.remove} 的汇总。 */
export interface RemoveReport {
    /** 早退（目标集合为空）时这个键不存在——与改动前的返回形状一致。 */
    dryRun?: boolean;
    removed: number;
    reclaimed: number;
    pruned: string[];
    results: RemoveResult[];
}
/** {@link createSessionAdmin} 的选项。 */
export interface CreateSessionAdminOptions {
    /** DSH 主目录（默认 `dshHome()`）。 */
    home?: string;
    /** 视为「临时目录」的前缀。 */
    tempRoots?: string[];
    /** 删文件**之前**把一个会话从登记表里摘掉的异步回调。 */
    releaseSession?: (sessionId: string) => Promise<unknown>;
}
/** 会话管理员（扫描 / 过滤 / 删除三个入口）。 */
export interface SessionAdmin {
    home: string;
    sessionsRoot: string;
    projcacheRoot: string;
    rewindRoot: string;
    scan(options?: ScanOptions): SessionRecord[];
    select(records: SessionRecord[], query?: SelectQuery): SessionRecord[];
    remove(ids: string[], options?: RemoveOptions): Promise<RemoveReport>;
}
/**
 * 构造一个会话管理员。所有根目录都可注入，便于在测试里指向沙箱。
 * @param options - `home`（DSH 主目录）、`tempRoots`（视为「临时目录」的前缀）、
 *   `releaseSession`（删文件**之前**把一个会话从登记表里摘掉的异步回调；见 `remove`）。
 * @returns 扫描 / 过滤 / 删除三个入口。
 */
export declare function createSessionAdmin(options?: CreateSessionAdminOptions): SessionAdmin;
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
export declare function isTrustedRequest(req: HttpRequest, allowHosts?: string[]): boolean;
/**
 * Host cordis 上下文里删除半边用到的那部分（最小本地接口，见 `src/index.ts` 的说明）。
 */
export interface AdminContext {
    logger?: Record<string, ((message: string) => unknown) | undefined> | undefined;
    effect: (fn: () => unknown, label?: string) => unknown;
    get: (name: string) => any;
    webServer: {
        register(options: unknown): unknown;
    };
    tools: {
        register(definition: unknown): unknown;
    };
    workspaceRegistry: WorkspaceRegistryLike;
}
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
export declare function mountAdmin(ctx: AdminContext, config: SessionOpsConfig, log: LogFn): void;
