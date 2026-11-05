/** Cordis plugin name; the profile row's `id` is independent of it. */
export declare const name = "folder-path";
/**
 * The single endpoint the browser half calls. Hand-mirrored in
 * `client/index.js`: the two halves ship as one package but cannot import each
 * other (the browser bundle is a hand-written classic script).
 */
export declare const ROUTE_PATH = "/dsh-folder-path/api/v1/clipboard-paths";
/**
 * One clipboard item as the route reports it.
 *
 * `isDirectory` is always set by the host probes; `matchDirectories` only looks
 * at `name`, so the test suite may hand it path/name pairs without the flag.
 */
export interface ClipboardEntry {
    path: string;
    name: string;
    isDirectory: boolean;
}
/**
 * The part of the profile row's `config` block this plugin reads.
 */
export interface FolderPathConfig {
    /** Set `false` to mount the host half inert. */
    enabled?: boolean;
    /** Clipboard probe budget in milliseconds. */
    timeoutMs?: number | string;
    /** PowerShell executable used for the Windows probe. */
    powershell?: string;
    /** `osascript` executable used for the macOS probe. */
    osascript?: string;
    /** Allow a browser on another machine to read this host's clipboard. */
    allowNonLoopback?: boolean;
}
/**
 * The request shape the route handler reads: a Node HTTP request, narrowed to
 * the fields this plugin touches.
 */
interface IncomingRequest {
    method?: string;
    headers: Record<string, string | undefined>;
    socket?: {
        remoteAddress?: string;
    };
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}
/** The response shape the route handler writes: a Node HTTP response. */
interface OutgoingResponse {
    writeHead(status: number, headers: Record<string, string | number>): void;
    end(body?: string): void;
}
/** An exact-route handler as the DSH web server invokes it. */
export type RouteHandler = (request: IncomingRequest, response: OutgoingResponse) => Promise<void>;
/**
 * The host context surface this plugin uses. DSH's real Cordis context is
 * richer; only these members are touched, so the local interface is kept
 * minimal instead of importing the host's types.
 */
export interface HostContext {
    logger?: {
        warn?: (message: string, ...args: unknown[]) => void;
    };
    inject(names: readonly string[], callback: (host: HostFiber) => void): void;
}
/** The fiber `ctx.inject` hands back once the web server service appears. */
export interface HostFiber {
    effect(factory: () => (() => void) | void, label: string): void;
    webServer: {
        register(route: {
            kind: 'exact';
            path: string;
            handler: RouteHandler;
        }): () => void;
    };
}
/**
 * Install the clipboard route.
 *
 * `webServer` is acquired through `ctx.inject` rather than read directly: the
 * service appears asynchronously, and a plain read inside `apply` would silently
 * see nothing and never register the route.
 *
 * @param ctx - host plugin context.
 * @param config - the profile row's `config` block.
 * @returns nothing; the route is registered once `webServer` appears.
 */
export declare function apply(ctx: HostContext, config?: FolderPathConfig): void;
/**
 * Filter clipboard directories down to the ones the browser is pasting.
 *
 * An empty `names` list means the caller wants every copied directory; a
 * non-empty list is matched by basename, case-insensitively, because that is
 * all the browser can see of the path.
 *
 * @param directories - directory entries from the clipboard.
 * @param names - basenames the browser reported.
 * @returns the matching entries, in clipboard order.
 * @remarks Exported for the host test suite; the route is its only runtime caller.
 */
export declare function matchDirectories<T extends {
    name: string;
}>(directories: T[], names: string[]): T[];
/**
 * Parse the macOS probe's stdout into absolute paths.
 * @param stdout - the probe's stdout.
 * @returns the paths it reported, in clipboard order.
 * @remarks Exported for the host test suite; the probe is its only runtime caller.
 */
export declare function parseProbePaths(stdout: unknown): string[];
export {};
