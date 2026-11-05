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
import { statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createApiHandler, readJsonBody } from './store/http.js';
import { dshHome } from './store/host.js';
import { SESSION_RUNNING_STATUS, accountedSessionIds, agentSessionStatus, archivedSessionIds, findWorkspace, redirectSessionWriters, residentSessionIds, sessionWriteHandles, workspaceOwningSession, } from './store/registry.js';
import { applyPlan, planMove } from './engine.js';
import { applyMemoryFollow, planMemoryFollow } from './memory.js';
import { hasZstd } from './sessionlog.js';
import { messageOf } from './store/util.js';
/** HTTP 路由前缀（两半各一条，合并后仍然分开）。 */
export const MOVE_API_PREFIX = '/session-move/api';
// ---------------------------------------------------------------------------
// 日志 / $DSH_HOME（实现在共享的 `lib/store/host.js`）
// ---------------------------------------------------------------------------
/**
 * `$DSH_HOME`（环境变量优先，默认 `~/.dsh`）。
 *
 * 实现在 `lib/store/host.js`——它与删除半边用的是同一份；
 * 这里再导出，保持本仓库的公开面不变。
 */
export { dshHome };
// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------
/**
 * 从 `Host` 头里取 hostname：去掉端口，IPv6 的方括号保留（与 `URL.hostname` 对得上）。
 * @param authority - `host` 或 `host:port`。
 * @returns hostname；取不到时 undefined。
 */
function hostnameOf(authority) {
    const text = String(authority).trim();
    if (text.length === 0)
        return undefined;
    if (text.startsWith('[')) {
        const end = text.indexOf(']');
        return end === -1 ? undefined : text.slice(0, end + 1);
    }
    const colon = text.lastIndexOf(':');
    return colon === -1 ? text : text.slice(0, colon);
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
    if (req?.headers?.['sec-fetch-site'] === 'cross-site')
        return false;
    // 2) 传输层：loopback 直达；非 loopback 必须在白名单里（精确字符串匹配，原行为）。
    const address = req.socket?.remoteAddress ?? '';
    const fromLoopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    const host = String(req.headers?.host ?? '');
    if (!fromLoopback && !(Array.isArray(allowHosts) && allowHosts.includes(host)))
        return false;
    // 3) 带了 Origin 就必须与请求的 authority 同源。
    const origin = req?.headers?.origin;
    if (origin === undefined)
        return true;
    const hostname = hostnameOf(host);
    if (hostname === undefined)
        return false;
    try {
        // 头可能是数组（重复头）；`URL` 的入参本来就是字符串，这里按原语义做一次 ToString。
        return new URL(String(origin)).hostname === hostname;
    }
    catch {
        return false;
    }
}
/** 把"旧 cwd 指向目标工作区目录"这件事落实到注册表：attach 新的、detach 旧的。 */
function createMover(ctx, config, log) {
    const persistence = ctx.sessionPersistence;
    const registry = ctx.workspaceRegistry;
    const sessionStore = ctx.get('sessions');
    const agents = ctx.get('agents');
    const rootOf = () => {
        if (typeof config.root === 'string' && config.root.length > 0)
            return config.root;
        const fromBackend = persistence?.root;
        if (typeof fromBackend === 'string' && fromBackend.length > 0)
            return fromBackend;
        throw new Error('cannot locate the session root: sessionPersistence exposes no `root`; set the plugin config `root`');
    };
    const compressionOf = () => (typeof persistence?.compression === 'string' ? persistence.compression : 'zstd');
    // 下面这几个查询都来自 `lib/store/registry.js`（与删除半边共用一份）：
    // 服务挂在哪、id 怎么比、状态叫什么，规则只写在一个地方。
    const residentIds = () => residentSessionIds(sessionStore);
    const runningOf = (id) => agentSessionStatus(agents, id);
    const writersOf = () => sessionWriteHandles(persistence);
    const ownerOf = (sessionId) => workspaceOwningSession(registry.list(), sessionId);
    const resolveWorkspace = (key) => findWorkspace(registry.list(), key);
    /** 全量快照：工作区身份 + 每条会话的 cwd/归属/驻留状态。 */
    async function list() {
        const root = rootOf();
        const snapshots = await persistence.list();
        const resident = residentIds();
        const writers = writersOf();
        const archived = archivedSessionIds(registry);
        const rows = [];
        for (const snapshot of snapshots) {
            const header = snapshot.header;
            const id = String(header.id);
            const running = runningOf(id);
            const owner = ownerOf(id);
            const handle = writers === undefined ? undefined : writers.get(id);
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
            });
        }
        rows.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
        const workspaces = registry.list().map((workspace) => ({
            id: String(workspace.id),
            title: String(workspace.title),
            path: String(workspace.path),
            visible: workspace.sessionIds.length,
            accounted: accountedSessionIds(workspace)?.length ?? 0,
        }));
        return {
            root,
            compression: compressionOf(),
            zstd: hasZstd,
            workspaces,
            sessions: rows.slice(0, Math.max(1, Number(config.maxSessions) || 2000)),
            counts: { stored: rows.length, resident: resident.size, workspaces: workspaces.length },
        };
    }
    /**
     * 记忆条目"随会话走"的模式；非法值退化成 off（绝不因为一个错拼去改写记忆库）。
     *
     * 是个函数而不是常量：`memoryFollow` 是 volatile 旋钮，在线改完就该在**下一次调用**
     * 生效，所以在用到的地方现读。
     */
    function memoryMode() {
        return ['off', 'copy', 'move'].includes(String(config.memoryFollow)) ? String(config.memoryFollow) : 'off';
    }
    /**
     * 计算一次"记忆跟随"的**只读预览**：源/目标项目 slug、该会话产出的条目数。
     * 真正写入由 {@link applyMemoryFollow} 在搬迁成功之后执行。
     */
    const memoryFollowOf = (sessionId, fromPath, targetPath) => {
        try {
            const plan = planMemoryFollow({ dshHome: dshHome(), sessionId, fromCwd: fromPath, toCwd: targetPath });
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
            };
        }
        catch (error) {
            return { plan: null, summary: { mode: memoryMode(), error: messageOf(error) } };
        }
    };
    /** 只读校验：用 DSH 自己的持久化读取器把这条会话读一遍。 */
    async function verify(sessionId) {
        const handle = await persistence.open(sessionId, 'read');
        try {
            const result = await handle.read();
            return {
                headerCwd: typeof handle.header.cwd === 'string' ? handle.header.cwd : null,
                inheritedEventCount: Number(handle.inheritedEventCount),
                events: result?.events ? result.events.length : null,
            };
        }
        finally {
            try {
                await handle.close();
            }
            catch {
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
        const sessionId = String(request.sessionId ?? '');
        if (sessionId.length === 0)
            throw new Error('sessionId is required');
        const dryRun = request.dryRun === true;
        const root = rootOf();
        const compression = compressionOf();
        const snapshots = await persistence.list();
        const snapshot = snapshots.find((candidate) => String(candidate.header.id) === sessionId);
        if (snapshot === undefined)
            throw new Error(`stored session not found: ${sessionId}`);
        const header = snapshot.header;
        if (typeof header.cwd !== 'string' || header.cwd.length === 0) {
            throw new Error(`session ${sessionId} has no cwd in its stored header`);
        }
        const target = resolveWorkspace(request.targetWorkspace);
        if (target === undefined)
            throw new Error(`unknown target workspace: ${String(request.targetWorkspace)}`);
        const targetPath = String(target.path);
        const fromPath = String(header.cwd);
        const running = runningOf(sessionId);
        if (running === SESSION_RUNNING_STATUS && config.refuseRunning !== false) {
            throw new Error(`session ${sessionId} is running a turn; wait for it to finish (or set refuseRunning: false) before moving it`);
        }
        const report = {
            sessionId,
            from: fromPath,
            to: targetPath,
            workspace: { id: String(target.id), title: String(target.title) },
            dryRun,
            running: running ?? null,
        };
        if (fromPath === targetPath) {
            // cwd 已经指向目标工作区：**不需要搬日志**，但可能压根没被这个工作区记账
            // （导入 / 同步回来 / 工作区当时还不存在的会话就是这样，界面上显示为 Ungrouped）。
            // 这种"归位"只差一次注册表成员修复。
            const owner = ownerOf(sessionId);
            if (owner !== undefined && String(owner.id) === String(target.id)) {
                report.noop = true;
                report.note = 'the session already lives in this workspace and is accounted by it';
                return report;
            }
            report.attachOnly = true;
            report.note = 'the session cwd already points at this workspace; only registry membership is repaired (no log move)';
            if (dryRun) {
                report.dryRunOnly = true;
                return report;
            }
            try {
                await target.attachSession(sessionId);
                report.attachedTo = String(target.id);
            }
            catch (error) {
                throw new Error(`cannot attach the session to workspace "${String(target.title)}": ${messageOf(error)}`);
            }
            if (owner !== undefined) {
                try {
                    await owner.detachSession(sessionId);
                    report.detachedFrom = String(owner.id);
                }
                catch (error) {
                    report.detachError = messageOf(error);
                }
            }
            try {
                report.dshReadback = await verify(sessionId);
            }
            catch (error) {
                report.dshReadbackError = messageOf(error);
            }
            report.ok = report.dshReadback !== undefined && report.dshReadback.headerCwd === targetPath;
            log('info', `re-filed ${sessionId} under workspace ${targetPath} (attach only)`);
            return report;
        }
        let targetStat;
        try {
            targetStat = statSync(targetPath);
        }
        catch (error) {
            throw new Error(`target workspace directory is not readable: ${targetPath} (${messageOf(error)})`);
        }
        if (!targetStat.isDirectory())
            throw new Error(`target workspace path is not a directory: ${targetPath}`);
        const plan = planMove({ root, compression, sessionId, fromCwd: fromPath, toCwd: targetPath });
        report.plan = {
            generation: plan.generation.name,
            version: plan.generation.version,
            compressed: plan.generation.compressed,
            bytesBefore: plan.bytesBefore,
            bytesAfter: plan.bytesAfter,
            frames: plan.frameCount,
            sourcePath: plan.sourcePath,
            targetPath: plan.targetPath,
            leaseFile: plan.leaseFile ?? null,
            leftInSourceDir: plan.otherFiles,
            otherGenerations: plan.otherGenerations,
        };
        // 记忆条目预览（只读，dry-run 也会给）：项目作用域是按工作区根目录定的，
        // 所以"要不要把这条会话在源工作区写下的条目一并带过去"是另一个显式选择。
        const memory = memoryFollowOf(sessionId, fromPath, targetPath);
        report.memoryFollow = memory.summary;
        if (dryRun) {
            report.dryRunOnly = true;
            return report;
        }
        // 1) 落盘：日志搬家 + header cwd 改写。
        const storage = applyPlan(plan);
        report.storage = storage;
        if (storage.ok !== true) {
            throw new Error(`the log was moved to ${plan.targetPath} but the rewritten header did not verify: ${JSON.stringify(storage.verifiedHeader)}`);
        }
        // 2) 内存态：让"以后继续写"落到新位置。
        //    写入句柄每次 append 都从自己的 header 重新推 logPath（appendLines → logPath(meta.cwd)），
        //    所以改写 handle.header 就够了；会话对象自身的 header 也同步，供工具解析 cwd；
        //    注册表里的头部缓存也要一起改。三处都在 `lib/store/registry.js`。
        const redirect = await redirectSessionWriters({
            writers: writersOf(),
            sessions: sessionStore,
            registry,
            sessionId,
            cwd: targetPath,
        });
        const live = redirect.liveSession;
        if (redirect.flushError !== undefined)
            report.handleFlushError = redirect.flushError;
        if (redirect.writeHandleRedirected)
            report.writeHandleRedirected = true;
        if (redirect.liveHeaderUpdated)
            report.liveHeaderUpdated = true;
        if (redirect.registryHeaderCacheUpdated)
            report.registryHeaderCacheUpdated = true;
        // 3) 注册表成员：attach 目标、detach 原属。attachSession 会校验 header.cwd
        //    （刚改写过的），并在成功后把进程内的 canonical cwd 索引指向新路径。
        const source = ownerOf(sessionId);
        try {
            await target.attachSession(sessionId);
            report.attachedTo = String(target.id);
        }
        catch (error) {
            throw new Error(`the session log was moved, but attaching it to workspace "${String(target.title)}" failed: ${messageOf(error)}`);
        }
        if (source !== undefined && String(source.id) !== String(target.id)) {
            try {
                await source.detachSession(sessionId);
                report.detachedFrom = String(source.id);
            }
            catch (error) {
                report.detachError = messageOf(error);
            }
        }
        // 记忆条目跟随（可选，默认关）：日志已搬成、注册表已换边之后才动记忆库，
        // 且失败只记录、不让一次成功的搬迁变成失败。
        if (memory.plan !== null && memoryMode() !== 'off' && memory.plan.source !== null && memory.plan.matched.length > 0) {
            try {
                memory.summary.applied = applyMemoryFollow(memory.plan, memoryMode());
            }
            catch (error) {
                memory.summary.applyError = messageOf(error);
            }
        }
        // 4) 读回：DSH 自己的读取器能读到才算真的搬成了。
        try {
            report.dshReadback = await verify(sessionId);
        }
        catch (error) {
            report.dshReadbackError = messageOf(error);
        }
        // 记忆作用域提示（只提示，不改动任何记忆数据）：
        // dsh-cross-memory 把「项目作用域」定在工作区根目录上（$DSH_HOME/memories/projects/<slug>，
        // 由 session.header.cwd 经 findProjectRoot 解析），而且解析结果按 **Session 对象**
        // 缓存在 rootCache（WeakMap）里。所以搬完 cwd 之后：冷会话下次加载就用新工作区；
        // 驻留会话要等它重新加载才会切换。记忆条目本身不随会话搬迁。
        if (ctx.get('memories') !== undefined) {
            report.memoryScope = live !== undefined
                ? 'dsh-cross-memory 在场：该会话仍驻留，工作区根被按 Session 对象缓存，项目记忆作用域要等它重新加载（重新 resume / 重启 dsh web）才切到新工作区；记忆条目不随会话搬迁。'
                : 'dsh-cross-memory 在场：该会话是冷会话，下次加载即按新 cwd 解析项目作用域；记忆条目不随会话搬迁。';
        }
        report.ok = report.dshReadback !== undefined && report.dshReadback.headerCwd === targetPath;
        log('info', `moved ${sessionId}: ${fromPath} -> ${targetPath} (${storage.bytesBefore} -> ${storage.bytesAfter} bytes)`);
        return report;
    }
    return { list, move, verify, rootOf, compressionOf, resolveWorkspace };
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
};
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
};
/** 工具的注册体。 */
function buildTool(mover, config, log) {
    return {
        name: 'session_move',
        description: 'Move one persisted DSH session into another workspace, durably: the session log is relocated to the target workspace\'s project directory, its header cwd is rewritten, and the workspace registry membership follows. ' +
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
                const snapshot = await mover.list();
                const needle = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : '';
                const filtered = needle.length === 0
                    ? snapshot.sessions
                    : snapshot.sessions.filter((row) => row.id.toLowerCase().includes(needle) ||
                        (row.cwd ?? '').toLowerCase().includes(needle) ||
                        (row.workspaceTitle ?? '').toLowerCase().includes(needle));
                const limit = Math.max(1, Math.min(Number(args.limit ?? 40), 500));
                const rows = filtered.slice(0, limit);
                return {
                    ok: true,
                    workspaces: snapshot.workspaces,
                    sessions: rows,
                    summary: `${snapshot.workspaces.length} workspaces, ${snapshot.counts.stored} stored sessions (${snapshot.counts.resident} loaded). ` +
                        `Showing ${rows.length} of ${filtered.length} matching rows. ` +
                        rows.slice(0, 10).map((row) => `${row.id} — ${row.cwd ?? 'no cwd'} [${row.workspaceTitle ?? 'ungrouped'}${row.running === SESSION_RUNNING_STATUS ? ', running' : row.resident ? ', loaded' : ''}]`).join(' | '),
                };
            }
            if (args.action === 'move') {
                const report = await mover.move({
                    sessionId: args.sessionId,
                    targetWorkspace: args.targetWorkspace,
                    dryRun: args.dryRun === true,
                });
                if (report.noop === true) {
                    return { ok: true, report, summary: `No move needed: ${report.sessionId} already lives in "${report.workspace.title}".` };
                }
                if (report.attachOnly === true) {
                    const head = report.dryRunOnly === true
                        ? `DRY RUN: would re-file ${report.sessionId} under workspace "${report.workspace.title}"`
                        : `Re-filed ${report.sessionId} under workspace "${report.workspace.title}"`;
                    return {
                        ok: true,
                        report,
                        summary: `${head}. Its cwd (${report.to}) already pointed at that workspace, so only registry membership changed (no log move).`,
                    };
                }
                // 走到这里说明 report.plan / report.storage 一定存在（move() 在 dry-run 与
                // 落盘两条路径上都先填好它们才返回）；类型上是可选字段，就地断言一次。
                const plan = report.plan;
                const storage = report.storage;
                const head = report.dryRunOnly === true
                    ? `DRY RUN: would move ${report.sessionId} from ${report.from} to ${report.to}`
                    : `Moved ${report.sessionId}: ${report.from} -> ${report.to} (workspace "${report.workspace.title}")`;
                const detail = report.dryRunOnly === true
                    ? `${plan.bytesBefore} bytes / ${plan.frames ?? 'plain'} frames -> ${plan.bytesAfter} bytes`
                    : `${storage.bytesBefore} -> ${storage.bytesAfter} bytes; readback cwd = ${report.dshReadback?.headerCwd ?? 'unverified'}` +
                        (report.writeHandleRedirected === true ? '; live write handle redirected' : '') +
                        (report.liveHeaderUpdated === true ? '; live header updated' : '');
                return { ok: true, report, summary: `${head}. ${detail}` };
            }
            return { ok: false, summary: `unknown action: ${String(args.action)}` };
        },
    };
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
        log('warn', 'this node build lacks zlib zstd support; moves are refused');
    }
    const mover = createMover(ctx, config, log);
    let rootNote = 'unknown';
    try {
        rootNote = mover.rootOf();
    }
    catch (error) {
        rootNote = `unresolved (${messageOf(error)})`;
    }
    log('info', `mounted: prefix=${MOVE_API_PREFIX} root=${rootNote} compression=${mover.compressionOf()} allowHosts=[${config.moveAllowHosts.join(', ')}] memoryFollow=${['off', 'copy', 'move'].includes(String(config.memoryFollow)) ? config.memoryFollow : 'off (invalid value ignored)'}`);
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
                    return mover.rootOf();
                }
                catch {
                    return null;
                }
            })(),
            compression: mover.compressionOf(),
            zstd: hasZstd,
            refuseRunning: config.refuseRunning,
            maxSessions: config.maxSessions,
        }),
    };
    ctx.effect(() => ctx.webServer.register({
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
    }), 'dsh-session-move: api route');
    ctx.effect(() => ctx.tools.register(buildTool(mover, config, log)), 'dsh-session-move: session_move tool');
}
// ---------------------------------------------------------------------------
// fork 子会话成员自愈
// ---------------------------------------------------------------------------
/** 一次 `session/created` 里能拿到的会话事实。 */
const FORK_CHILD_ORIGIN = 'subagent';
/**
 * 判断一条会话头是不是「普通 fork 子会话」——自愈只对这类会话动手。
 *
 * 依据是 Host 的 fork 实现（`session/fork` 里 `meta: { parentSession, isSeeded: true }`）
 * 与子代理实现（`origin: 'subagent'`、`delegationDepth: 1`）这两个实测事实：
 * 子代理会话的 cwd 同样指着工作区，但它们本来就不该入册，必须排除。
 *
 * @param header - 会话头（`session.header`）。
 * @returns 普通 fork 子会话为 true。
 */
function isForkChild(header) {
    if (header === null || typeof header !== 'object')
        return false;
    const record = header;
    if (typeof record.parentSession !== 'string' || record.parentSession.length === 0)
        return false;
    if (record.origin === FORK_CHILD_ORIGIN)
        return false;
    const depth = Number(record.delegationDepth);
    return !(Number.isFinite(depth) && depth > 0);
}
/**
 * 构建一份「fork 子会话漏挂工作区」的补记账器（创建期监听与启动期扫描共用）。
 *
 * ## 背景（实测，不是推测）
 *
 * Host 的 `session/fork` 本来会给自己找归属：`forkWorkspace(source.header)` 按
 * 「哪个工作区的成员表里有源会话」挑一个，再 `workspace.attachSession(childId)`，
 * 失败还会回 `session/workspace-attach-failed`。但实测中「编辑重发」产生的子会话
 * 最终仍是 `ungrouped`（`session_admin` 里 `workspaceTitle: null`），而第一次 fork
 * 的父会话明明是某个工作区的成员——结果是客户端只把它们记进「占位」列表，
 * 刷新/重启后侧栏里再也看不到，就是「刚才那个会话怎么找不到了」。
 *
 * ## 规则刻意收窄（创建期与启动期同一套）
 *
 *   - 只处理普通 fork 子会话（见 {@link isForkChild}）；
 *   - 父会话必须已经挂在某个工作区，子会话就挂到**同一个**工作区；父会话自己都没
 *     归属就不猜，只记一行日志；
 *   - 子会话 `header.cwd` 必须 realpath 后真的等于那个工作区的路径，否则不挂
 *     （宁可留一条 ungrouped，也不把别处的会话塞进工作区）。
 *
 * 幂等：已记账直接返回；同一 id 的并发事件用 `inFlight` 去重；attach 失败只记日志，
 * 绝不上抛——这条自愈路径失败不能影响 Host 创建会话本身。
 *
 * 不做全量扫描：343 条存量会话里 155 条是子代理、还有一批刻意 ungrouped 的迁移
 * 会话，全量 attach 会改写用户既有的侧栏结构。启动期扫描只认 fork 子会话
 * （见 {@link sweepForkChildrenOnBoot}），存量漂移仍可用 `session_move` 显式修。
 *
 * @param ctx - Host cordis 上下文（需要 `workspaceRegistry`）。
 * @param log - `(level, message) => void`（入口传的是 move 那套行格式的文件日志）。
 * @returns repairer（`{ repair, ownerOf }`），注册表不可用时 `undefined`。
 */
function createForkMembershipRepairer(ctx, log) {
    const registry = ctx.workspaceRegistry;
    if (registry === undefined || typeof registry.list !== 'function') {
        log('warn', 'membership repair skipped: workspaceRegistry is unavailable');
        return undefined;
    }
    /** 正在补记账的会话 id（并发重复事件去重）。 */
    const inFlight = new Set();
    /** realpath 不抛异常的版本：解析不出来就没法比较。 */
    const canonical = async (path) => {
        try {
            return await realpath(path);
        }
        catch {
            return undefined;
        }
    };
    /** 一条会话当前登记在哪个工作区（按注册表的完整记账，不是过滤后的视图）。 */
    const ownerOf = (sessionId) => {
        try {
            return workspaceOwningSession(registry.list(), sessionId);
        }
        catch {
            return undefined;
        }
    };
    /**
     * 给一条 fork 子会话补记账。
     * @param sessionId - 子会话 id。
     * @param header - 子会话头。
     * @param reason - 触发来源，只进日志。
     * @returns 完成（含跳过）后 resolve。
     */
    async function repair(sessionId, header, reason) {
        if (typeof sessionId !== 'string' || sessionId.length === 0)
            return;
        if (inFlight.has(sessionId))
            return;
        if (!isForkChild(header))
            return;
        if (ownerOf(sessionId) !== undefined)
            return;
        inFlight.add(sessionId);
        try {
            const parentSession = String(header.parentSession);
            const owner = ownerOf(parentSession);
            if (owner === undefined) {
                log('info', `membership: fork child ${sessionId} stays ungrouped — parent ${parentSession} belongs to no workspace`);
                return;
            }
            if (typeof owner.attachSession !== 'function') {
                log('warn', `membership: workspace ${owner.id} exposes no attachSession; cannot re-file ${sessionId}`);
                return;
            }
            const cwd = typeof header.cwd === 'string' ? header.cwd : '';
            if (cwd.length === 0) {
                log('warn', `membership: fork child ${sessionId} carries no header cwd; not attaching`);
                return;
            }
            const [sessionPath, workspacePath] = await Promise.all([canonical(cwd), canonical(String(owner.path))]);
            if (sessionPath === undefined || workspacePath === undefined || sessionPath !== workspacePath) {
                log('warn', `membership: fork child ${sessionId} cwd '${cwd}' does not resolve to workspace '${String(owner.path)}'; not attaching`);
                return;
            }
            await owner.attachSession(sessionId);
            log('info', `membership: attached fork child ${sessionId} to workspace ${owner.id} (${reason})`);
        }
        catch (error) {
            log('warn', `membership: attach failed for ${sessionId}: ${messageOf(error)}`);
        }
        finally {
            inFlight.delete(sessionId);
        }
    }
    return { repair, ownerOf };
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
export async function sweepForkChildrenOnBoot(ctx, config = {}, log = () => { }, shared) {
    const report = { checked: 0, attached: 0, skipped: undefined };
    if (config !== null && typeof config === 'object' && config.repairForkChildrenOnBoot === false) {
        report.skipped = 'disabled';
        return report;
    }
    const repairer = shared ?? createForkMembershipRepairer(ctx, log);
    if (repairer === undefined) {
        report.skipped = 'registry-unavailable';
        return report;
    }
    const persistence = ctx?.sessionPersistence;
    if (persistence === undefined || typeof persistence.list !== 'function') {
        report.skipped = 'persistence-unavailable';
        return report;
    }
    let snapshots;
    try {
        snapshots = await persistence.list();
    }
    catch (error) {
        log('warn', `membership sweep: session listing failed: ${messageOf(error)}`);
        report.skipped = 'listing-failed';
        return report;
    }
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
        const header = snapshot?.header;
        const sessionId = String(header?.id ?? snapshot?.id ?? '');
        if (sessionId.length === 0)
            continue;
        if (!isForkChild(header))
            continue;
        report.checked += 1;
        try {
            const wasAccounted = repairer.ownerOf(sessionId) !== undefined;
            await repairer.repair(sessionId, header, 'boot-sweep');
            if (!wasAccounted && repairer.ownerOf(sessionId) !== undefined)
                report.attached += 1;
        }
        catch (error) {
            log('warn', `membership sweep: ${sessionId} failed: ${messageOf(error)}`);
        }
    }
    if (report.attached > 0)
        log('info', `membership sweep: re-attached ${report.attached} of ${report.checked} fork child(ren) that had lost workspace accounting`);
    return report;
}
/**
 * 挂载 fork 子会话的成员自愈：创建期监听 + 启动期定向扫描。
 *
 * @param ctx - Host cordis 上下文。
 * @param config - 活配置对象。
 * @param log - `(level, message) => void`。
 * @returns 启动期扫描的 Promise（Host/cordis 忽略；测试可 await 以确定性观察结果）。
 */
export function mountForkMembershipRepair(ctx, config, log) {
    const repairer = createForkMembershipRepairer(ctx, log);
    if (repairer === undefined)
        return undefined;
    // 返回值给测试留一个可 await 的口子：Host 与 cordis 都忽略监听器返回值。
    ctx.on('session/created', (session) => {
        try {
            return repairer.repair(String(session?.id ?? ''), session?.header, 'session/created');
        }
        catch (error) {
            log('warn', `membership: session/created handler failed: ${messageOf(error)}`);
            return undefined;
        }
    });
    log('info', 'membership repair mounted: fork children are re-attached on session/created and by the boot sweep');
    return sweepForkChildrenOnBoot(ctx, config, log, repairer);
}
// 2026-09-25：本文件由 dsh-session-move/lib/index.js 逐字搬入 dsh-session-ops（合并包）。
