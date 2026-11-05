/**
 * 两个会话插件共用的 **HTTP 面**：JSON 响应封装、请求体读取、以及前缀路由的骨架。
 *
 * 路由协议（响应码与响应体）是两个插件对浏览器半边的**公开契约**，必须逐字一致，
 * 所以它只在写一份：
 *   - 403 `{ok:false,error:{code:'forbidden',message:'forbidden'}}` —— 信任栅栏拒绝；
 *   - 404 `{ok:false,error:{code:'not-found',message:'unknown method'}}` —— 路径没落在
 *     前缀下，或方法名里还有 `/`；
 *   - 404 `{ok:false,error:{code:'not-found',message:'unknown method <m>'}}` —— 方法不在表里；
 *   - 200 `{ok:true,value}`；
 *   - 400 `{ok:false,error:{code:'bad-request',message:<err.message>}}` —— 处理器抛错。
 *   `GET` 的载荷是 query string，其余方法读 `JSON` 请求体（1 MiB 上限）。
 *
 * **信任栅栏本身刻意不在这里**：两个插件的判定依据不同（`dsh-session-admin` 看
 * `Host` 头 + `sec-fetch-site`/`Origin` + `allowHosts` 的 host/hostname 匹配；
 * `dsh-session-move` 看 socket 的 `remoteAddress` + `allowHosts` 精确字符串匹配），
 * 语义不同就不能合并——合并必然改动其中一边的对外行为。这里只收一个
 * `trustRequest(req) => boolean` 回调。
 *
 * 同理，`writeJson` 的 `content-length` 与 `readJsonBody` 的严格程度两边也不同，
 * 都用显式开关保留原状（见各参数）。
 *
 * @module dsh-session-ops/store/http
 */
/**
 * 本模块用到的请求形状（Node 的 `IncomingMessage` 与测试里的假请求都满足它）。
 *
 * 刻意写成最小本地接口而不是直接引用 `node:http`：两个插件只用到这几个字段，
 * 测试里的假请求也不实现完整的 `IncomingMessage`。
 */
export interface HttpRequest extends AsyncIterable<Buffer> {
    url?: string | undefined;
    method?: string | undefined;
    headers?: Record<string, string | string[] | undefined> | undefined;
    socket?: {
        remoteAddress?: string | undefined;
    } | undefined;
}
/** 本模块用到的响应形状（Node 的 `ServerResponse` 与测试里的假响应都满足它）。 */
export interface HttpResponse {
    writeHead(status: number, headers: Record<string, string | number>): unknown;
    end(body?: string): unknown;
}
/** 路由方法表里的一个处理器：收载荷，返回值包成 `{ok:true,value}`。 */
export type ApiMethod = (payload: any) => unknown | Promise<unknown>;
/** {@link createApiHandler} 的选项。 */
export interface CreateApiHandlerOptions {
    /** 路由前缀，如 `/session-admin/api`。 */
    prefix: string;
    /** 方法名 → `async (payload) => value`。 */
    methods: Record<string, ApiMethod | undefined>;
    /** `(req) => boolean`：请求是否来自受信的浏览器（各插件自己的栅栏）。 */
    trustRequest?: ((req: HttpRequest) => boolean) | undefined;
    /** `(level, message) => void`（可为 undefined）。 */
    log?: ((level: string, message: string) => void) | undefined;
    /** 读请求体，默认 {@link readJsonBody}（宽松）。 */
    readBody?: (req: HttpRequest) => Promise<unknown>;
    /** 透传给 {@link writeJson}。 */
    contentLength?: boolean;
}
/**
 * 写一个 JSON 响应。
 * @param res - Node HTTP 响应。
 * @param status - 状态码。
 * @param body - 任意可 JSON 序列化的值。
 * @param options - `{contentLength}`：是否带上 `content-length` 头。默认 `false`
 *   （`dsh-session-move` 的原样行为，响应走 chunked）；`dsh-session-admin` 传 `true`
 *   以保留它原有的 `content-length`。
 * @returns 无。
 */
export declare function writeJson(res: HttpResponse, status: number, body: unknown, options?: {
    contentLength?: boolean;
}): void;
/**
 * 读一个 JSON 请求体（上限 1 MiB）。
 *
 * 严格程度由调用方选，因为两个插件原本就不一样：
 *   - `requireObject: false`（默认，`dsh-session-admin` 的行为）：不 trim、不校验类型，
 *     空 body 返回 `{}`，其余原样交给 `JSON.parse`（一个空白 body 会抛出
 *     `Unexpected end of JSON input`，进而变成 400）；
 *   - `requireObject: true`（`dsh-session-move` 的行为）：trim 后空串返回 `{}`，
 *     解析结果必须是**普通对象**，否则抛 `request body must be a JSON object`。
 * @param req - Node HTTP 请求。
 * @param options - `{requireObject}`。
 * @returns 解析出来的载荷对象。
 */
export declare function readJsonBody(req: HttpRequest, options?: {
    requireObject?: boolean;
}): Promise<unknown>;
/**
 * 造一个 `kind: 'prefix'` 路由处理器（`ctx.webServer.register({kind:'prefix', path, handler})` 的 `handler`）。
 *
 * 方法表里的每个处理器收到 `payload`，返回值包成 `{ok:true,value}`；抛错变成 400 并写一行
 * `<method> failed: <message>` 日志。`GET` 的载荷是 query string（全部是字符串）。
 * @param options - 见下。
 * @param options.prefix - 路由前缀，如 `/session-admin/api`。
 * @param options.methods - 方法名 → `async (payload) => value`。
 * @param options.trustRequest - `(req) => boolean`：请求是否来自受信的浏览器（各插件自己的栅栏）。
 * @param options.log - `(level, message) => void`（可为 undefined）。
 * @param options.readBody - 读请求体，默认 {@link readJsonBody}（宽松）；`dsh-session-move`
 *   传 `(req) => readJsonBody(req, {requireObject: true})`。
 * @param options.contentLength - 透传给 {@link writeJson}。
 * @returns `async (req, res) => void`。
 */
export declare function createApiHandler(options: CreateApiHandlerOptions): (req: HttpRequest, res: HttpResponse) => Promise<void>;
