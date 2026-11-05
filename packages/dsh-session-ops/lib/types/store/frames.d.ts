/**
 * 会话日志（`session[.vN].jsonl[.zstd]`）的**帧级读写原语**。
 *
 * ## 帧格式
 *
 * 日志是**独立 Zstandard 帧的标准拼接**：帧 0 只含 header 行（DSH 的
 * `assertIndependentHeaderFrame` 强制），之后每帧是一个事件批次。于是改写只需重压
 * 帧 0、再把剩余字节原样接上——后续帧一个字节都不动。
 *
 * 两个必须对齐的细节：
 *   - DSH 压缩时带内容校验和（`params: {[ZSTD_c_checksumFlag]: 1}`），重压帧 0
 *     也必须带（见 {@link CHECKSUM_OPTIONS}）；
 *   - 帧边界要自己走一遍（Node 不暴露「已消费输入字节数」），就是下面的
 *     {@link scanZstdFrames}。
 *
 * ## 为什么头部这么要紧
 *
 * header 承载 `cwd` / `origin` / `parentSession` / `isSeeded`：
 *   - 「会话属于哪个工作区」在 DSH 里**只**由 `header.cwd` 决定
 *     （`WorkspaceEntity.sessionIds` 每次读取都用 `realpath(header.cwd) === workspace.path`
 *     过滤），加上 `assertStoredIdentity` 要求物理路径等于
 *     `logPath(root, header.cwd, id)`，所以搬迁 == 改 cwd + 挪目录；
 *   - 「是不是子代理会话」只能从 `origin` 拿，projcache 里没有。
 *
 * 于是本模块同时提供两种读法，**语义不同、不要互相替换**：
 *   - {@link readHeaderFromBuffer}：只解**帧 0**（帧结构严格，给搬迁用）；
 *   - {@link readSessionHeader}：按目录找日志文件、整段解压取第一行（宽松，给扫描/删除用）。
 *
 * @module dsh-session-ops/store/frames
 */
/** zstd 帧魔数（小端）。 */
export declare const ZSTD_MAGIC = 4247762216;
/** zstd 压缩选项（带内容校验和时才有 `params`）。 */
export interface ZstdCompressOptions {
    params?: Record<number, number>;
}
/** 与 DSH 一致的压缩选项：带内容校验和。 */
export declare const CHECKSUM_OPTIONS: ZstdCompressOptions;
/** `zstdCompressSync` 需要 Node ≥22.15 / ≥23.8；缺失时插件拒绝搬迁而不是写坏日志。 */
export declare const hasZstd: boolean;
/** 会话头（日志第一行）。字段按 DSH 实际写入的形状声明，其余键原样保留。 */
export interface SessionHeader {
    type?: string;
    version?: number;
    id?: string;
    cwd?: string;
    origin?: string;
    parentSession?: string;
    isSeeded?: boolean;
    delegationDepth?: number;
    createdAt?: number;
    [key: string]: unknown;
}
/** 拼接帧里的一个帧范围。 */
export interface ZstdFrameRange {
    start: number;
    end: number;
}
/** {@link scanZstdFrames} 的扫描结果。 */
export interface ZstdFrameScan {
    frames: ZstdFrameRange[];
    incomplete: boolean;
    reason?: string;
}
/**
 * 走一遍拼接帧，给出每帧的字节范围。
 *
 * 按 zstd 规范解析帧头（魔数 → Frame_Header_Descriptor → 可选窗口描述符 /
 * 字典 id / 内容长度）与块序列（3 字节块头 → 块体），直到 Last_Block，
 * 再按标志位跳过 4 字节内容校验和。
 *
 * @param buffer - 整个日志文件的内容。
 * @returns `{frames, incomplete, reason}`；`frames` 每项含 `{start, end}`。
 */
export declare function scanZstdFrames(buffer: Buffer): ZstdFrameScan;
/**
 * 读出日志第一帧里的 header 对象（只解析，不改写）。
 * @param buffer - 日志内容。
 * @param compressed - `true`（默认）表示 zstd 帧日志，`false` 表示未压缩的行式日志。
 * @returns header 对象；不是合法会话日志时 `undefined`。
 */
export declare function readHeaderFromBuffer(buffer: Buffer, compressed?: boolean): SessionHeader | undefined;
/**
 * 把一个会话目录里的会话头读出来（**宽松**读法：扫目录找日志文件，取解压后的第一行）。
 *
 * 与 {@link readHeaderFromBuffer} 的区别是它不校验帧结构、也不要求 `type === 'session'`：
 * 目录里可能有半截写入或手工改名的日志，扫描/删除路径宁可拿到一个「像头部」的对象，
 * 也不要因为格式不严格就把整条会话当成不可读。
 *
 * 解压失败（截断、缺 zstd 支持）返回 `undefined`，调用方按「未知」处理。
 * @param dir - 会话目录。
 * @param cache - 以 `路径:mtime:size` 为键的头部缓存（可选；不传就现建一个）。
 * @returns 头部对象，或 undefined。
 */
export declare function readSessionHeader(dir: string, cache?: Map<string, SessionHeader | undefined>): SessionHeader | undefined;
/** {@link rewriteHeaderCwd} 成功时的结果。 */
export interface HeaderRewriteSuccess {
    buffer: Buffer;
    rewritten: true;
    header: SessionHeader;
    frames?: number;
    reason?: undefined;
}
/** {@link rewriteHeaderCwd} 无法改写时的结果（原样返回 buffer）。 */
export interface HeaderRewriteFailure {
    buffer: Buffer;
    rewritten: false;
    header?: SessionHeader;
    frames?: number;
    reason?: string;
}
/** {@link rewriteHeaderCwd} 的结果。 */
export type HeaderRewriteResult = HeaderRewriteSuccess | HeaderRewriteFailure;
/**
 * 把会话头的 `cwd` 改写成另一条绝对路径。
 *
 * 只动 `cwd` 一个键，其余键（含该 generation 自己的字段）按原顺序逐字保留；
 * 帧 0 之后的字节**原样接上**，所以事件批次一个字节都没变。
 *
 * @param buffer - 日志内容。
 * @param newCwd - 改写后的绝对路径。
 * @param options - `{compressed}`：帧日志（默认 `true`）或未压缩行式日志。
 * @returns `{buffer, rewritten, header, frames?, reason?}`；无需改写或无法改写时
 *   `rewritten: false` 并原样返回。
 */
export declare function rewriteHeaderCwd(buffer: Buffer, newCwd: string, options?: {
    compressed?: boolean;
}): HeaderRewriteResult;
