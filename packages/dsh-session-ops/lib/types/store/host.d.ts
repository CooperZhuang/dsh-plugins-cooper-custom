/**
 * 宿主侧的公共底座：`$DSH_HOME`、尽力而为的文件日志、以及 volatile 配置的解包。
 *
 * 这几段代码在两个插件里逐字重复——它们都是「DSH 宿主约定」而不是插件策略：
 *   - `dshHome()` 认 `DSH_HOME` 环境变量（测试靠它把整个沙箱指到临时目录）；
 *   - 宿主 stdout 不落盘，排障只能靠 `$DSH_HOME/logs/<name>.log`；
 *   - 标了 `.volatile()` 的配置字段，Loader 交给 `apply` 的是活引用（`{get()}`）
 *     而不是值，值在写盘后原地更新，所以**解包必须做两次**（进 schema 之前一次、
 *     schema 出来之后再一次，后者是因为 schemastery 对 volatile 字段输出的也是活引用）。
 *
 * 文件日志的**行格式两边不同**（admin 是 `[时间] 级别 正文`，move 是 `时间 [级别] 正文`），
 * 这是对外可见的排障产物，所以这里不做统一，而是把两种格式都作为预设导出，
 * 由调用方显式选择（见 {@link LOG_LINE_LEVEL_FIRST} / {@link LOG_LINE_TIME_FIRST}）。
 *
 * @module dsh-session-ops/store/host
 */
/** 一行文件日志的 `{iso, level, message}`。 */
export interface LogEntry {
    iso: string;
    level: string;
    message: string;
}
/** 宿主 cordis 上下文里本模块用到的那一小块（只在 `createFileLogger` 里取 `logger`）。 */
export interface LoggerContext {
    logger?: Record<string, ((message: string) => unknown) | undefined> | undefined;
}
/** 日志行格式：`(entry) => 一整行（含结尾换行）`。 */
export type LogLineFormatter = (entry: LogEntry) => string;
/** 插件里到处用的日志函数。 */
export type LogFn = (level: string, message: string) => void;
/** `$DSH_HOME`：环境变量优先，默认 `~/.dsh`。 */
export declare function dshHome(): string;
/**
 * 文件日志行格式之一：`[ISO 时间] 级别 正文`（`dsh-session-admin` 在用）。
 * @param entry - `{iso, level, message}`。
 * @returns 一整行（含结尾换行）。
 */
export declare const LOG_LINE_LEVEL_FIRST: LogLineFormatter;
/**
 * 文件日志行格式之一：`ISO 时间 [级别] 正文`（`dsh-session-move` 在用）。
 * @param entry - `{iso, level, message}`。
 * @returns 一整行（含结尾换行）。
 */
export declare const LOG_LINE_TIME_FIRST: LogLineFormatter;
/** {@link createFileLogger} 的选项。 */
export interface CreateFileLoggerOptions {
    /** 日志文件名（不含 `.log`；默认 `dsh-session-ops`）。 */
    name?: string;
    /** 行格式（默认 {@link LOG_LINE_LEVEL_FIRST}）。 */
    formatLine?: LogLineFormatter;
}
/**
 * 尽力而为的文件日志：写 `$DSH_HOME/logs/<name>.log`，并顺带喂宿主 logger。
 *
 * 任何一步失败都静默吞掉——日志本身永远不该成为故障源（建目录失败、磁盘满了、
 * 宿主 logger 不可用，都不影响插件机制）。
 * @param ctx - Host cordis 上下文（只用 `ctx?.logger`，可为 undefined）。
 * @param options - `{name, formatLine}`：日志文件名（不含 `.log`；默认
 *   `dsh-session-ops`）与行格式（默认 {@link LOG_LINE_LEVEL_FIRST}）。
 * @returns `(level, message) => void`，即插件里的 `log`。
 */
export declare function createFileLogger(ctx: LoggerContext | undefined, options?: CreateFileLoggerOptions): LogFn;
/** 解包后的普通配置对象。 */
export type PlainConfig = Record<string, unknown>;
/**
 * 解包 entry 配置里的 `.volatile()` 活引用。
 * @param raw - entry 配置或普通配置对象。
 * @returns 值已解包的浅拷贝。
 */
export declare function plainConfig(raw?: unknown): PlainConfig;
/**
 * 「可调用、收普通对象、返回普通对象」的 schema 形状（schemastery 的 `Config` 就是这种）。
 *
 * 本包不依赖 `@deepseek-ai/schemastery` 的运行时类型，只要求这个最小形状。
 */
export type ConfigSchemaLike = (raw?: any) => unknown;
/**
 * 解析一份 entry 配置：先解包输入的活引用，再交给 schema 校验并补默认值，最后**再解包
 * 一次**——schemastery 对 `.volatile()` 字段输出的也是活引用，不收敛的话读到的就是
 * `{ get() }` 对象（HTTP 面上会变成一个空对象）。
 *
 * schema 由调用方传入（本包只把 `@deepseek-ai/schemastery` 当类型来源），传进来的只要是
 * 「可调用、收普通对象、返回带默认值的普通对象」即可。
 * @param schema - 插件自己的 `Config`（schemastery 对象，可调用）。
 * @param raw - entry 配置或普通配置对象。
 * @returns 普通值配置。
 */
export declare function resolveVolatileConfig(schema: ConfigSchemaLike, raw?: unknown): PlainConfig;
