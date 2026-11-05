/**
 * 会话存储的**路径命名**知识：项目目录键（`--C-proj--`）、会话目录、generation 文件名。
 *
 * 这些命名事实原本分散在两个插件里，而且是同一份知识的**两个方向**：
 *   - `dsh-session-move` 需要**正向**编码（`projectKey` / `encodeSegment`）——搬迁时
 *     要把会话日志放到目标 cwd 对应的 project 目录；
 *   - `dsh-session-admin` 需要**反向**还原（`decodeProjectKey`）——删除面板要给出
 *     「这条会话大概是哪个目录的」，而头部读不出来时只有目录键可猜。
 * 两份实现各自维护同一套规则，改动任何一边都要记得另一边——这就是本模块存在的理由。
 *
 * 规则（与 `dsh-session-persistence-jsonl` 的 `format.js` 逐字一致）：
 *   - 路径里每个非 `[A-Za-z0-9._-]` 的码位写成 `~XXXX`（大写十六进制、四位）；
 *   - `/` `\` `:` 三种分隔符**折叠成 `-`**（盘符的冒号也因此变成 `-`）；
 *   - 目录键形如 `--<readable>--`，`readable` 截断到 251 字符；
 *   - 会话目录 = `<root>/<projectKey(cwd)>/<encodeSegment(id)>`。
 *
 * @module dsh-session-ops/store/paths
 */
/**
 * 把任意字符串编码成一个安全路径段（与会话 id 共用同一套转义）。
 * @param raw - 原始字符串。
 * @returns 单个文件系统安全路径段。
 */
export declare function encodeSegment(raw: string): string;
/**
 * 项目目录键：分隔符折叠成 `-`，不安全码位 `~XXXX`，截断到 251 字符。
 * @param cwd - 会话的项目目录。
 * @returns 单个文件系统安全的项目目录名。
 */
export declare function projectKey(cwd: string): string;
/**
 * 把 `sessions/` 下的项目目录键还原成路径。
 *
 * 只做「够用」的反解：分隔符在磁盘上已经全部退化成 `-`，无法区分 `/` 与 `\`
 * （这里一律还原成 `\`），盘符的冒号也没有单独转义（`C:\a` → `--C-a--`，这里
 * 按 `^[A-Za-z]\\` 补回来）。**真正的 cwd 以会话头部里的记录为准**，这个只作为兜底。
 * @param key - 项目目录名。
 * @returns 反解出的路径。
 */
export declare function decodeProjectKey(key: string): string;
/**
 * **宽松**的会话日志文件名判定：`.jsonl.zstd` 或 `.jsonl` 结尾就算。
 *
 * 与 {@link parseGenerationName}（**规范** generation 名）是两件事，别互相替换：
 * 删除路径要能看见并清掉任何形状的日志文件（哪怕是手工改名或半截写入的），
 * 而搬迁路径必须只认规范名，否则会把临时文件当成真日志搬走。
 * @param name - 目录项名。
 * @returns 是否像一份会话日志。
 */
export declare function isSessionLogFile(name: string): boolean;
/** 一个规范 generation 名的解析结果。 */
export interface GenerationName {
    /** 版本号（v0 为 0）。 */
    version: number;
    /** 是否压缩。 */
    compressed: boolean;
}
/**
 * 目录里是不是规范 generation 名。
 * @param name - 目录项名。
 * @returns 版本号（v0 为 0）与是否压缩；不是规范名时 `undefined`。
 */
export declare function parseGenerationName(name: string): GenerationName | undefined;
/** 会话目录里的一个规范 generation 文件。 */
export interface GenerationEntry extends GenerationName {
    /** 目录项名（规范 generation 文件名）。 */
    name: string;
}
/** 找到了规范 generation 的扫描结果。 */
export interface GenerationFound {
    selected: GenerationEntry;
    all: GenerationEntry[];
    /** 目录里不是规范名、也不会被搬迁的其它文件。 */
    others: string[];
}
/** 没找到规范 generation 的扫描结果；错误文案被对外可见报告引用。 */
export interface GenerationMissing {
    error: string;
    others?: string[];
}
/** {@link findGeneration} 的结果（`error` 与 `selected` 互斥）。 */
export type GenerationScan = GenerationFound | GenerationMissing;
/**
 * 选出会话目录里版本最高的规范 generation 文件。
 *
 * 临时名与备份名（`*.session-move-tmp`、`*.session-move-old`）不匹配规范名，
 * 一律进 `others`——搬迁必须保证「任何时刻都不存在两份规范名日志」。
 * @param dir - 会话目录。
 * @returns `{selected, all, others}`；列不了目录或没有规范名时 `{error, others?}`
 *   （错误文案被两个插件的用户可见报告引用，改动前先看测试）。
 */
export declare function findGeneration(dir: string): GenerationScan;
/** 物理编码后缀。 */
export declare function compressionSuffix(compression: string): string;
/** 一个 generation 的规范文件名（v0 不带 `vN` 段）。 */
export declare function generationLogFilename(version: number, compression: string): string;
/** 会话目录：`<root>/<projectKey>/<encodeSegment(id)>`。 */
export declare function sessionDir(root: string, cwd: string | undefined, id: string): string;
/** 一个 generation 的绝对日志路径。 */
export declare function logPath(root: string, cwd: string | undefined, id: string, version: number, compression: string): string;
