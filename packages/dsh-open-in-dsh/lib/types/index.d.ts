import type { IncomingMessage, ServerResponse } from 'node:http';
import z from '@deepseek-ai/schemastery';
/** A thrown value from a failed spawn: an `Error` that may carry an errno code. */
interface ExecFailure extends Error {
    code?: string | number;
}
/** The exact `execFile` option set this plugin passes; no shell, ever. */
interface ExecOptions {
    timeout: number;
    windowsHide: boolean;
}
/** One `execFile` call: file, argv, options, done. */
type ExecFn = (file: string, args: readonly string[], options: ExecOptions, callback: (error: ExecFailure | null) => void) => unknown;
/** The only two facts this plugin asks about an existing path. */
export interface StatProbe {
    isDirectory(): boolean;
    isFile(): boolean;
}
/** A stat probe; `statSync` and the tests' fakes both fit. */
export type StatFn = (path: string) => StatProbe;
/** A file-existence probe. */
export type ExistsFn = (path: string) => boolean;
/** A directory read yielding entries; the Session lookup probes project keys. */
export type ReadDirFn = (path: string, options: {
    withFileTypes: true;
}) => Array<{
    name: string;
    isDirectory(): boolean;
}>;
/** What an SSE follower must offer the hub; a `ServerResponse` does. */
export interface EventStream {
    write(text: string): unknown;
    on(event: string, listener: () => void): unknown;
}
/** One incoming HTTP request handler, as `webServer.register` takes it. */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
/** The exact-route row this plugin registers. */
export interface ExactRoute {
    kind: 'exact';
    path: string;
    handler: RouteHandler;
}
/** The `webServer` service slice the plugin uses. */
export interface WebServerService {
    register(route: ExactRoute): unknown;
}
/** The host context handed to an `inject` callback; only `effect` and `webServer` are read. */
export interface InjectedHost {
    effect(callback: () => unknown, label?: string): unknown;
    webServer: WebServerService;
}
/** Host logger surface: only the three levels the plugin writes. */
export interface HostLogger {
    info?(...args: unknown[]): unknown;
    warn?(...args: unknown[]): unknown;
    debug?(...args: unknown[]): unknown;
}
/** The slice of the Cordis plugin context this plugin reads. */
export interface HostContext {
    logger?: HostLogger;
    get?(key: string): unknown;
    inject(services: readonly string[], callback: (host: InjectedHost) => void): unknown;
}
/** What `createLiveCwdReader` reads: just `ctx.get`. */
export interface LiveContext {
    get?(key: string): unknown;
}
/** One announced request: sequence, canonical path, arrival time. */
export interface RequestEntry {
    readonly seq: number;
    readonly path: string;
    readonly at: number;
}
/** The settings the page receives in the `hello` frame. */
export interface HubSettings {
    readonly alwaysNewSession: boolean;
}
/** Options for {@link createHub}. */
export interface HubOptions {
    alwaysNewSession?: boolean;
    backlogTtlMs?: number;
    now?: () => number;
}
/** The shared request hub: one sequence, its followers and its replay window. */
export interface Hub {
    publish(path: string): RequestEntry;
    pending(since?: number): RequestEntry[];
    subscribe(response: EventStream): () => void;
    clients(): number;
    close(): void;
    readonly settings: HubSettings;
    readonly seq: number;
    readonly lastSeenAt: number;
}
/** One allowlist row: a launchable app on one platform. */
export interface OpenWithAppEntry {
    readonly id: string;
    /** macOS app display name handed to `open -a`. */
    readonly app?: string;
    /** macOS bundle name probed under the two Applications folders. */
    readonly bundle?: string;
    /** True for apps that exist on every install (Finder, Terminal, Explorer). */
    readonly always?: boolean;
}
/** The allowlist, per platform. A platform that is not listed has no entries. */
export interface OpenWithApps {
    readonly darwin: readonly OpenWithAppEntry[];
    readonly win32: readonly OpenWithAppEntry[];
}
/** A canonical path plus whether it is a directory. */
export interface LaunchTarget {
    readonly path: string;
    readonly directory: boolean;
}
/** One allowlisted argv to spawn. */
export interface LaunchCommand {
    readonly file: string;
    readonly args: readonly string[];
}
/** Overrides for {@link createOpenWithHandler}, for tests. */
export interface OpenWithDeps {
    platform?: string;
    stat?: StatFn;
    exec?: ExecFn;
}
/** Overrides for {@link createAppsHandler}, for tests. */
export interface AppsDeps {
    platform?: string;
    exists?: ExistsFn;
}
/** A Session id -> cwd reader. */
export type LiveCwdReader = (sessionId: string) => string | undefined;
/** Overrides for {@link createOpenSessionHandler}, for tests. */
export interface OpenSessionDeps extends OpenWithDeps {
    resolveCwd?: LiveCwdReader;
}
/** Overrides for {@link findSessionCwdOnDisk}, for tests. */
export interface DiskLookupDeps {
    home?: string;
    sessionsRoot?: string;
    readdir?: ReadDirFn;
    readSessionHeader?: (dir: string) => unknown;
}
/** `{live}` plus the stored-header overrides, for {@link resolveSessionCwd}. */
export interface ResolveSessionCwdDeps extends DiskLookupDeps {
    live?: LiveCwdReader;
}
/** Cordis plugin name; the profile row's `id` is independent of it. */
export declare const name = "open-in-dsh";
/**
 * macOS 交接套接字。**手抄**进 `scripts/macos/open-in-dsh`（`SOCKET_PATH_DEFAULT`），
 * `test/macos.test.ts` 保证两份一致；`DSH_OPEN_SOCKET`（脚本）与 config `socketPath`
 * （宿主）都能覆盖。
 *
 * 放 `~/.dsh/run/` 而不是 `$TMPDIR`：Quick Action 由 Finder 拉起，它的 TMPDIR 与终端
 * 是不是同一个目录不值得赌。
 */
export declare const DEFAULT_SOCKET_PATH: string;
/**
 * 部署层配置。
 *
 * 声明它的作用是把这一行的 `config` 变成**被校验、会补默认值**的东西：bundle 自带的
 * 默认值、profile 补丁层的覆盖、`$DSH_HOME/settings.yaml` 里同名的段，都在这条路径上
 * 合并成一份，`Config.listConfigs` 也就读得到 schema——写配置的人（或 agent）不用再猜键名。
 *
 * 它**不会**凭空长出一个可编辑的配置表单：「设置 → 插件」按设计就是只读清单
 * （inspect plugins *without changing their configuration*），而侧边栏「插件」页里那块
 * 可编辑区域要由插件**自己注册一个配置页**（官方插件是配套 UI 包做的）。
 * 本插件只有下面四个开关，不值得为它单开一页——改它们直接写 YAML 或 settings.yaml。
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** 总开关。关掉后连路由都不注册。 */
    enabled: z<boolean, boolean, "defined">;
    /**
     * 每次右键都新建一个空白会话。
     *
     * **默认 false**：复用该工作区已有的空白会话。同一个文件夹点几次就堆几个空会话
     * 是很容易发生的，而复用正是 DSH 侧边栏「新会话」自己的语义。
     */
    alwaysNewSession: z<boolean, boolean, "defined">;
    /**
     * 是否接受非回环来源。**默认 false，不要轻易打开。**
     *
     * 这条路由的作用是让浏览器把任意本地目录当成工作区打开，而工作区里会跑命令，
     * 等同于一个代码执行入口，所以「能连上端口」不等于「是这台机器上的人」。
     *
     * 内核 0.2.1 起 webserver 不再接受通配地址（`0.0.0.0` / `::` 一律拒绝加载），
     * 但**可以**钉到某个具体接口地址（比如本机的局域网 IP），那仍然是网络可达的，
     * 所以这条回环检查照旧不能省。
     */
    allowNonLoopback: z<boolean, boolean, "defined">;
    /** 冷启动补收的时间窗：页面没开着时，请求在这段时间内仍可被补收。 */
    backlogTtlMs: z<number, number, "defined">;
    /**
     * macOS 交接套接字路径；空串表示不监听。
     *
     * 桌面外壳 2.0.19 起不再接受 `--dsh-desktop-workspace`（Chromium 的选项解析会以
     * `bad option` 直接退出），也不再转发 second-instance 的 argv，所以快速操作改由本插件
     * 自己在套接字上收路径，与 Windows 那条 HTTP 路由共用同一个 handler。
     */
    socketPath: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** 总开关。关掉后连路由都不注册。 */
    enabled: z<boolean, boolean, "defined">;
    /**
     * 每次右键都新建一个空白会话。
     *
     * **默认 false**：复用该工作区已有的空白会话。同一个文件夹点几次就堆几个空会话
     * 是很容易发生的，而复用正是 DSH 侧边栏「新会话」自己的语义。
     */
    alwaysNewSession: z<boolean, boolean, "defined">;
    /**
     * 是否接受非回环来源。**默认 false，不要轻易打开。**
     *
     * 这条路由的作用是让浏览器把任意本地目录当成工作区打开，而工作区里会跑命令，
     * 等同于一个代码执行入口，所以「能连上端口」不等于「是这台机器上的人」。
     *
     * 内核 0.2.1 起 webserver 不再接受通配地址（`0.0.0.0` / `::` 一律拒绝加载），
     * 但**可以**钉到某个具体接口地址（比如本机的局域网 IP），那仍然是网络可达的，
     * 所以这条回环检查照旧不能省。
     */
    allowNonLoopback: z<boolean, boolean, "defined">;
    /** 冷启动补收的时间窗：页面没开着时，请求在这段时间内仍可被补收。 */
    backlogTtlMs: z<number, number, "defined">;
    /**
     * macOS 交接套接字路径；空串表示不监听。
     *
     * 桌面外壳 2.0.19 起不再接受 `--dsh-desktop-workspace`（Chromium 的选项解析会以
     * `bad option` 直接退出），也不再转发 second-instance 的 argv，所以快速操作改由本插件
     * 自己在套接字上收路径，与 Windows 那条 HTTP 路由共用同一个 handler。
     */
    socketPath: z<string, string, "defined">;
}>>, "plain">;
/** The config after the schema has applied its shipped defaults. */
export interface OpenInDshConfig {
    enabled: boolean;
    alwaysNewSession: boolean;
    allowNonLoopback: boolean;
    backlogTtlMs: number;
    socketPath: string;
}
/** The endpoint the Explorer verb's launcher calls. Mirrored in `scripts/`. */
export declare const ROUTE_OPEN = "/dsh-open-in-dsh/api/v1/open";
/** The endpoint the browser half follows. Hand-mirrored in `client/index.ts`. */
export declare const ROUTE_EVENTS = "/dsh-open-in-dsh/api/v1/events";
/**
 * Reports how many pages are following, without announcing anything.
 *
 * The launcher asks this after a request that found nobody listening: a page
 * that is merely mid-reconnect would otherwise look like "DSH is closed" and
 * send the user a browser window they did not ask for.
 */
export declare const ROUTE_STATUS = "/dsh-open-in-dsh/api/v1/status";
/**
 * The right-click menu's "open with <app>" action posts `{ path, app }` here.
 *
 * `app` is an id from `OPEN_WITH_APPS`, never a command, a binary path or an
 * app name: the Host owns the whole argv, so the browser can only ask for one
 * of the allowlisted launches.
 */
export declare const ROUTE_OPEN_WITH = "/dsh-open-in-dsh/api/v1/open-with";
/**
 * The menu asks this before it shows anything, so an app that is not installed
 * on this machine never becomes an action that fails on click.
 */
export declare const ROUTE_APPS = "/dsh-open-in-dsh/api/v1/apps";
/**
 * The Session-scoped entry (the sidebar row menu) knows a session id, never a
 * directory: the browser half has the Session projection, not the stored
 * header. This route is where the Host turns "session X" into "directory D"
 * and launches D.
 *
 * The browser still only names an allowlisted app id plus a session id; the
 * path never crosses the wire, so a forged request cannot open an arbitrary
 * directory through this route.
 */
export declare const ROUTE_OPEN_SESSION = "/dsh-open-in-dsh/api/v1/open-session";
/**
 * The open-with allowlist: the only commands this plugin will ever spawn.
 *
 * A menu action sends an id from this table; the Host resolves that id to a
 * fixed argv here. Nothing the browser sends is ever spliced into a command,
 * so a forged pair can at worst name one of these launches with a path the
 * Host itself validated.
 *
 * - darwin: Finder reveals with 'open -R'; every other app launches with
 *   'open -a <name> <path>'. Terminal-like apps land on a file's directory,
 *   because 'open -a Terminal <file>' would make Terminal run that file.
 * - win32: Explorer opens a directory and selects a file.
 */
export declare const OPEN_WITH_APPS: OpenWithApps;
/**
 * The allowlist entry for one id on one platform.
 * @param platform - process.platform spelling.
 * @param id - the id a menu action sent.
 * @returns the entry, or undefined when the id is not allowlisted here.
 */
export declare function findOpenWithApp(platform: string, id: string): OpenWithAppEntry | undefined;
/**
 * Ids of the allowlisted apps this platform can actually launch.
 *
 * macOS bundles are probed by path in the two Applications folders; the
 * system apps (Finder, Terminal) are always there. Windows contributes
 * Explorer. An unknown platform contributes nothing, so the menu simply does
 * not appear instead of offering launches that cannot work.
 *
 * @param platform - process.platform spelling.
 * @param exists - file probe, for tests.
 * @param appDirs - bundle search folders, for tests.
 * @returns allowlisted ids, in registry order.
 */
export declare function availableApps(platform?: string, exists?: ExistsFn, appDirs?: readonly string[]): string[];
/**
 * The exact argv for one allowlisted launch.
 * @param platform - process.platform spelling.
 * @param appId - an allowlisted id.
 * @param target - canonical path plus the directory flag.
 * @returns the command to spawn, or null when the id is not allowlisted here.
 */
export declare function openWithCommand(platform: string, appId: string, target: LaunchTarget): LaunchCommand | null;
/**
 * Install the three routes.
 *
 * `webServer` is acquired through `ctx.inject` rather than read directly: the
 * service appears asynchronously, and a plain read inside `apply` would
 * silently see nothing and never register the routes.
 *
 * The raw row config is run through `Config` first so a partial block, a
 * `settings.yaml` override and the shipped defaults all resolve the same way —
 * `apply` then reads one already-resolved object instead of re-deciding each
 * default at the point of use.
 *
 * @param ctx - host plugin context.
 * @param rawConfig - the profile row's `config` block.
 * @returns nothing; the routes are registered once `webServer` appears.
 */
export declare function apply(ctx: HostContext, rawConfig?: Partial<OpenInDshConfig>): void;
/**
 * The one piece of shared state: the request sequence and its followers.
 *
 * Kept separate from the handlers so the sequence rules — a live frame *and* a
 * replayable backlog row for the same request, an expiring replay window, and
 * a sequence that rewinds on host restart — can be tested without HTTP.
 *
 * @param options - hub options.
 * @param options.alwaysNewSession - session policy sent to the browser half.
 * @param options.backlogTtlMs - replay window in milliseconds.
 * @param options.now - clock, for tests.
 * @returns the hub.
 */
export declare function createHub(options?: HubOptions): Hub;
/**
 * Whether a page is following now, or went away so recently that one is
 * probably on its way back.
 *
 * @param hub - the shared request hub.
 * @param now - clock, for tests.
 * @returns true when the launcher should wait rather than open a window.
 */
export declare function expectsPage(hub: Hub, now?: number): boolean;
/**
 * Build the menu's availability route.
 *
 * The answer is probed once per plugin life and then cached: an app installed
 * while the host runs shows up after a restart, the same rule the kernel's own
 * open-in-app feature uses.
 *
 * @param allowNonLoopback - whether a non-loopback peer may ask.
 * @param deps - platform/exists overrides, for tests.
 * @returns the exact-route handler.
 */
export declare function createAppsHandler(allowNonLoopback?: boolean, deps?: AppsDeps): RouteHandler;
/**
 * Build the right-click action: validate a whitelisted app and an existing
 * path, then spawn the one argv the allowlist names.
 *
 * The app id is checked against the allowlist before the path is touched, so
 * a forged id is refused even by a caller that never had a valid path.
 *
 * @param ctx - host plugin context, for logs.
 * @param allowNonLoopback - whether a non-loopback peer may launch.
 * @param deps - platform/stat/exec overrides, for tests.
 * @returns the exact-route handler.
 */
export declare function createOpenWithHandler(ctx: HostContext, allowNonLoopback?: boolean, deps?: OpenWithDeps): RouteHandler;
/**
 * Read a Session's cwd from the Host's in-memory projections, when one is live.
 *
 * Two in-memory sources, both authoritative while the Host runs:
 *   - `workspaceRegistry.headers` — the header cache behind the sidebar's
 *     Workspace membership;
 *   - the resident Session object — the same header tools and the UI parse a
 *     cwd from.
 *
 * Everything here is best-effort: a missing service, a service that throws, or
 * a composition without either simply falls through to the stored header
 * ({@link resolveSessionCwd}), which is the disk truth anyway.
 *
 * @param ctx - host plugin context.
 * @returns a reader: session id -> cwd, or undefined when nothing is cached.
 */
export declare function createLiveCwdReader(ctx: LiveContext): LiveCwdReader;
/**
 * Read a Session's cwd out of the session store on disk.
 *
 * The store is keyed by project directory, so an id alone does not name a
 * path: every project key is probed for `<root>/<projectKey>/<encodeSegment(id)>`
 * and the first header carrying a cwd wins. `encodeSegment` and
 * `readSessionHeader` come from `dsh-session-ops/store`, the same header/frame
 * reader `dsh-session-ops` uses, so a storage-format change cannot make
 * the two plugins disagree.
 *
 * @param sessionId - the Session id the browser sent.
 * @param deps - root/readdir/reader overrides, for tests.
 * @returns the stored cwd, or undefined when no header carries one.
 */
export declare function findSessionCwdOnDisk(sessionId: string, deps?: DiskLookupDeps): string | undefined;
/**
 * Resolve one Session id to its project directory: live projections first,
 * stored header second.
 * @param sessionId - the Session id.
 * @param deps - `{live}` plus {@link findSessionCwdOnDisk}'s overrides.
 * @returns the cwd, or undefined when this Host cannot name one.
 */
export declare function resolveSessionCwd(sessionId: string, deps?: ResolveSessionCwdDeps): string | undefined;
/**
 * Build the Session-scoped launch route: resolve a session id to its cwd, then
 * spawn the same allowlisted argv the open-with route uses.
 *
 * The request names an app id and a session id only. The directory never
 * crosses the wire, so a forged request cannot turn this route into "open any
 * path" — the worst it can do is open a directory the Host itself resolved.
 *
 * @param ctx - host plugin context, for logs.
 * @param allowNonLoopback - whether a non-loopback peer may launch.
 * @param deps - platform/stat/exec/resolver overrides, for tests.
 * @returns the exact-route handler.
 */
export declare function createOpenSessionHandler(ctx: HostContext, allowNonLoopback?: boolean, deps?: OpenSessionDeps): RouteHandler;
/**
 * Canonicalize a claimed folder path.
 *
 * The verb passes `%V`, which is a drive root (`D:\`) at the top of a drive and
 * a bare `D:` only when something upstream already stripped the separator.
 *
 * @param value - the claimed path.
 * @returns the canonical absolute directory path, or `null` when it is not one.
 */
export declare function directoryPath(value: unknown): string | null;
/**
 * Canonicalize a claimed file or directory path.
 *
 * The path is not trusted because the browser sent it: it must be absolute,
 * short enough to be a path, and resolve to a regular file or directory.
 *
 * @param value - the claimed path.
 * @param stat - stat probe, for tests.
 * @returns canonical path plus the directory flag, or null when it is not one.
 */
export declare function existingPath(value: unknown, stat?: StatFn): LaunchTarget | null;
export {};
