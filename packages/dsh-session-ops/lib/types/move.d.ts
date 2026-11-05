/**
 * `dsh-session-ops` 的**搬迁半边**（原 `dsh-session-move` 插件的 Host 半边）。
 *
 * 这一半的代码搬自原 `dsh-session-move` 的 `lib/index.js`，差异只有四处：
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
 * 宿主与 HTTP 面的底座）在 `lib/store/` 里；本文件只保留搬迁策略本身。
 *
 * @module dsh-session-ops/move
 */
import type { HttpRequest } from './store/http.js';
import { dshHome } from './store/host.js';
import type { LogFn } from './store/host.js';
import type { PersistenceLike, WorkspaceEntity, WorkspaceRegistryLike } from './store/registry.js';
import type { MoveReport } from './engine.js';
import type { MemoryFollowOutcome } from './memory.js';
import type { SessionOpsConfig } from './index.js';
/** HTTP 路由前缀（两半各一条，合并后仍然分开）。 */
export declare const MOVE_API_PREFIX = "/session-move/api";
/**
 * `$DSH_HOME`（环境变量优先，默认 `~/.dsh`）。
 *
 * 实现在 `lib/store/host.js`——它与删除半边用的是同一份；
 * 这里再导出，保持本仓库的公开面不变。
 */
export { dshHome };
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
export declare function isTrustedRequest(req: HttpRequest, allowHosts: string[]): boolean;
/** 持久化后端 `list()` 返回的一条会话快照。 */
export interface SessionSnapshotLike {
    id?: unknown;
    header: Record<string, unknown>;
}
/** 持久化后端 `open()` 返回的读句柄。 */
export interface PersistenceHandleLike {
    header: Record<string, unknown>;
    inheritedEventCount?: unknown;
    read(): Promise<{
        events?: unknown[];
    } | undefined>;
    close(): Promise<unknown>;
}
/** 搬迁半边用到的持久化后端能力（`ctx.sessionPersistence` 的子集）。 */
export interface SessionPersistenceLike extends PersistenceLike {
    list: () => Promise<SessionSnapshotLike[]>;
    open: (sessionId: string, mode: string) => Promise<PersistenceHandleLike>;
}
/** `list` 快照里的一行工作区。 */
export interface WorkspaceSummary {
    id: string;
    title: string;
    path: string;
    visible: number;
    accounted: number;
}
/** `list` 快照里的一条会话。 */
export interface SessionRow {
    id: string;
    cwd: string | null;
    createdAt: number | null;
    resident: boolean;
    running: string | null;
    hasWriteHandle: boolean;
    archived: boolean;
    workspaceId: string | null;
    workspaceTitle: string | null;
    movable: boolean;
}
/** {@link Mover.list} 的返回。 */
export interface ListSnapshot {
    root: string;
    compression: string;
    zstd: boolean;
    workspaces: WorkspaceSummary[];
    sessions: SessionRow[];
    counts: {
        stored: number;
        resident: number;
        workspaces: number;
    };
}
/** `mover.move` 的入参（HTTP / 工具都把浏览器或模型给的对象原样递进来）。 */
export interface MoveRequest {
    sessionId?: unknown;
    targetWorkspace?: unknown;
    dryRun?: unknown;
}
/** 计划摘要在报告里的形状。 */
export interface MovePlanSummary {
    generation: string;
    version: number;
    compressed: boolean;
    bytesBefore: number;
    bytesAfter: number;
    frames: number | null;
    sourcePath: string;
    targetPath: string;
    leaseFile: string | null;
    leftInSourceDir: string[];
    otherGenerations: string[];
}
/** 记忆跟随预览/结果摘要在报告里的形状。 */
export interface MemoryFollowSummary {
    mode: string;
    sourceSlug?: string | null;
    targetSlug?: string;
    targetHadProject?: boolean;
    sourceEntries?: number;
    matched?: number;
    titles?: string[];
    alreadyInTarget?: number;
    note?: string;
    error?: string;
    applied?: MemoryFollowOutcome;
    applyError?: string;
}
/** `mover.verify` 的读回结果。 */
export interface VerifyReadback {
    headerCwd: string | null;
    inheritedEventCount: number;
    events: number | null;
}
/** {@link Mover.move} 的完整报告。字段按路径可选（noop / attach-only / dry-run）。 */
export interface MoveActionReport {
    sessionId: string;
    from: string;
    to: string;
    workspace: {
        id: string;
        title: string;
    };
    dryRun: boolean;
    running: string | null;
    noop?: boolean;
    note?: string;
    attachOnly?: boolean;
    dryRunOnly?: boolean;
    plan?: MovePlanSummary;
    memoryFollow?: MemoryFollowSummary;
    storage?: MoveReport;
    handleFlushError?: string;
    writeHandleRedirected?: boolean;
    liveHeaderUpdated?: boolean;
    registryHeaderCacheUpdated?: boolean;
    attachedTo?: string;
    detachedFrom?: string;
    detachError?: string;
    dshReadback?: VerifyReadback;
    dshReadbackError?: string;
    memoryScope?: string;
    ok?: boolean;
}
/** `list` / `move` / `verify` 三个入口（`createMover` 的返回）。 */
export interface Mover {
    list: () => Promise<ListSnapshot>;
    move: (request: MoveRequest) => Promise<MoveActionReport>;
    verify: (sessionId: string) => Promise<VerifyReadback>;
    rootOf: () => string;
    compressionOf: () => string;
    resolveWorkspace: (key: unknown) => WorkspaceEntity | undefined;
}
/** {@link createMover} 用到的 Host 上下文（最小本地接口，见 `src/index.ts` 的说明）。 */
export interface MoveContext {
    sessionPersistence?: SessionPersistenceLike | undefined;
    workspaceRegistry: WorkspaceRegistryLike;
    get: (name: string) => any;
    webServer: {
        register(options: unknown): unknown;
    };
    tools: {
        register(definition: unknown): unknown;
    };
    effect: (fn: () => unknown, label?: string) => unknown;
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
export declare function mountMove(ctx: MoveContext, config: SessionOpsConfig, log: LogFn): void;
/** 成员自愈扫描的汇总。 */
export interface ForkSweepReport {
    checked: number;
    attached: number;
    skipped?: string;
}
/** 成员自愈器（创建期监听与启动期扫描共用）。 */
export interface ForkMembershipRepairer {
    repair: (sessionId: string, header: Record<string, unknown> | undefined, reason: string) => Promise<void>;
    ownerOf: (sessionId: string) => WorkspaceEntity | undefined;
}
/**
 * 成员自愈用到的 Host 上下文（`workspaceRegistry` 可缺：缺了就跳过自愈）。
 */
export interface RepairContext {
    workspaceRegistry?: WorkspaceRegistryLike | undefined;
    sessionPersistence?: SessionPersistenceLike | undefined;
    on: (event: string, handler: (...args: any[]) => unknown) => unknown;
}
/**
 * 启动期的成员自愈扫描：把**已经丢掉记账**的 fork 子会话补回去。
 *
 * ## 为什么创建期补挂不够（实测的第二条证据链）
 *
 * `session/created` 那一刻补挂只挡住「Host fork 时就没挂」这一种。实测中有些 fork
 * 在 Host 侧确实走了 `workspace.attachSession(childId)`（RPC 返回成功、插件侧没有
 * `fork 失败` 日志），但子会话最终仍不在任何工作区的 `sessionIds` 里——也就是说
 * 记账**写进去之后又没了**。同一个时间窗里，父会话的归档也没落住。
 *
 * 能同时抹掉「新 attach」与「归档集合」的只有一件事：**另一个 Host 进程用自己内存里
 * 的旧快照重写了 `$DSH_HOME/storages/workspace.json`**。存储层是整文件原子替换、
 * 无跨进程锁（`dsh-storage-json` 的注释写的就是「一个 unit 文件只有一个写者，后写
 * 覆盖先写是对的」），而同一台机器上同时跑两个 Host、共用同一个 `~/.dsh` 就会出现
 * 这类丢失。这类丢失发生在 attach 之后，创建期的补挂拦不住。
 *
 * 所以这里补一道**启动期**的定向扫描：只处理 fork 子会话（`isForkChild`），且仍然
 * 要求「父会话已被工作区记账 + 子会话 cwd 规范化后等于该工作区路径」；不碰子代理、
 * 不碰没有父会话的普通会话，也不做全量 attach，避免改写用户刻意留着的 ungrouped。
 *
 * 幂等：已记账直接跳过；失败只记日志，绝不让插件挂载失败。
 *
 * @param ctx - Host cordis 上下文（需要 `workspaceRegistry` 与 `sessionPersistence`）。
 * @param config - 活配置对象；`repairForkChildrenOnBoot === false` 时跳过整轮扫描。
 * @param log - `(level, message) => void`。
 * @param shared - 与创建期监听器共享的 repairer（`mountForkMembershipRepair` 内部用）。
 * @returns 扫描结束（含跳过）后 resolve 的报告；永不 reject。
 */
export declare function sweepForkChildrenOnBoot(ctx: RepairContext, config?: Partial<SessionOpsConfig>, log?: LogFn, shared?: ForkMembershipRepairer): Promise<ForkSweepReport>;
/**
 * 挂载 fork 子会话的成员自愈：创建期监听 + 启动期定向扫描。
 *
 * @param ctx - Host cordis 上下文。
 * @param config - 活配置对象。
 * @param log - `(level, message) => void`。
 * @returns 启动期扫描的 Promise（Host/cordis 忽略；测试可 await 以确定性观察结果）。
 */
export declare function mountForkMembershipRepair(ctx: RepairContext, config: Partial<SessionOpsConfig>, log: LogFn): Promise<ForkSweepReport> | undefined;
