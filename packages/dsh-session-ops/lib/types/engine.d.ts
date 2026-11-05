/**
 * 搬迁引擎：把一条会话日志从「旧 cwd 的 project 目录」搬到「新 cwd 的 project 目录」，
 * 并改写 header 里的 cwd。不依赖 cordis，便于单测（见 test/core.test.mjs）。
 *
 * 命名与格式事实（都来自 dsh-session-persistence-jsonl 的实测与源码）：
 *   - 日志路径 `<root>/<projectKey(cwd)>/<encodeSegment(id)>/session[.vN].jsonl[.zstd]`；
 *   - `findLog` 会扫**所有** project 目录找同一个 id，多于一处就抛
 *     `duplicate JSONL session id ... appears in multiple project directories`；
 *   - generation 文件名必须规范（v0 不带 `vN`），临时名/带后缀的备份名不会被当成 generation。
 * 因此搬迁必须做到「任何时刻都不存在两份规范名的日志」，见 {@link applyPlan} 的三步改名。
 *
 * @module dsh-session-ops/engine
 */
import type { SessionHeader } from './store/frames.js';
import { findGeneration, parseGenerationName } from './store/paths.js';
import type { GenerationEntry } from './store/paths.js';
/** 迁移中使用的临时文件名后缀（都**不**匹配 generation 规范名）。 */
export declare const TMP_SUFFIX = ".session-move-tmp";
export declare const PARKED_SUFFIX = ".session-move-old";
/**
 * `findGeneration` / `parseGenerationName`（「目录里哪份才算规范 generation」）已经搬到
 * `lib/store/paths.js`——删除路径也要认得同一套命名，规则只该有一份。
 * 这里保留再导出，是为了不打断本仓库既有的导入者（`test/core.test.mjs` 就按
 * `../lib/engine.js` 导入它们）。
 */
export { findGeneration, parseGenerationName };
/** {@link planMove} 的选项。 */
export interface PlanMoveOptions {
    root: string;
    sessionId: string;
    fromCwd: string;
    toCwd: string;
    compression?: string;
}
/** 一次搬迁的计划（含 `buffer`，供 {@link applyPlan} 直接落盘）。 */
export interface MovePlan {
    root: string;
    compression: string;
    sessionId: string;
    fromCwd: string;
    toCwd: string;
    fromKey: string;
    toKey: string;
    generation: GenerationEntry;
    /** 源目录里除 generation 与 `session.lock` 之外的文件（真正会留在原地的）。 */
    otherFiles: string[];
    /** 源目录里是否有写租约文件；有则由 {@link applyPlan} 随目录一起搬走。 */
    leaseFile: string | null;
    otherGenerations: string[];
    sourceDir: string;
    targetDir: string;
    sourcePath: string;
    targetPath: string;
    bytesBefore: number;
    bytesAfter: number;
    frameCount: number | null;
    header: SessionHeader;
    rewrittenHeader: SessionHeader;
    buffer: Buffer;
}
/**
 * 计算一次搬迁的计划：读源日志、改写 cwd、给出目标路径。**只读**，不写任何东西。
 *
 * @param options - `{root, sessionId, fromCwd, toCwd, compression}`。
 * @returns 计划对象（含 `buffer`，供 {@link applyPlan} 直接落盘）。
 * @throws 源日志缺失、header 与请求不符、目标已存在、源与目标同目录时。
 */
export declare function planMove(options: PlanMoveOptions): MovePlan;
/** {@link applyPlan} 的搬迁报告（HTTP/工具直接回话用的就是它）。 */
export interface MoveReport {
    sessionId: string;
    from: string;
    to: string;
    generation: string;
    bytesBefore: number;
    bytesAfter: number;
    frames: number | null;
    sourcePath: string;
    targetPath: string;
    moved: boolean;
    /** 目标目录里已有租约文件、无法把源租约搬过去时，记下冲突路径。 */
    leaseConflict?: string;
    /** 搬租约失败时的错误文案。 */
    leaseMoveError?: string;
    /** 租约文件是否搬到了目标目录。 */
    leaseMoved?: boolean;
    /** 清空源目录失败时的错误文案。 */
    sourceDirCleanupError?: string;
    /** 源目录是否被清掉。 */
    removedSourceDir?: boolean;
    /** 源目录里剩下的文件（清空失败时非空）。 */
    leftInSourceDir?: string[];
    /** 落盘后读回的 header。 */
    verifiedHeader?: {
        id: string;
        cwd: string | null;
        version?: number;
    } | null;
    verifiedBytes?: number;
    ok?: boolean;
}
/**
 * 执行计划。三步改名保证「任何时刻都不存在两份规范名日志」：
 *   1. 新日志先以临时名写进目标目录（此时还不是 generation）；
 *   2. 源文件改名成 `*.session-move-old`（源目录里不再有规范名）；
 *   3. 临时名改成规范名（此刻新日志才生效），随后删掉 `.old` 与空的源目录。
 * 崩在 2 与 3 之间时，源数据仍在 `.old` 里、新数据仍在 `.tmp` 里，人工可救。
 *
 * @param plan - {@link planMove} 的返回值。
 * @returns 搬迁报告（含 `dshReadbackSafe` 之外的事实字段，供 HTTP/工具直接回话）。
 */
export declare function applyPlan(plan: MovePlan): MoveReport;
/** {@link verifyStoredLog} 的选项。 */
export interface VerifyStoredLogOptions {
    root: string;
    sessionId: string;
    cwd: string;
    compression?: string;
}
/** {@link verifyStoredLog} 的报告（`header`/`bytes`/`magic` 只在可读时出现）。 */
export interface StoredLogVerification {
    ok: boolean;
    error?: string;
    header?: {
        id: string;
        cwd: string | null;
    };
    bytes?: number;
    magic?: string;
}
/**
 * 只读校验：目标位置上是否有一份可解析、id/cwd 都对得上的日志。
 * @param options - `{root, sessionId, cwd, compression}`。
 * @returns `{ok, header, bytes}` 或 `{ok:false, error}`。
 */
export declare function verifyStoredLog(options: VerifyStoredLogOptions): StoredLogVerification;
