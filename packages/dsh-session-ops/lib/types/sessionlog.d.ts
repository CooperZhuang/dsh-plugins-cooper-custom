/**
 * 会话日志的帧级读写原语 —— **实现在本包的 `lib/store/` 里**（`dsh-session-ops`）。
 *
 * 这个文件现在只是一层**历史路径的门面**：`./sessionlog.js` 曾经是本插件私有的
 * 实现（从 dsh-sync 移植），而删除半边那边重复着同一套知识的另一半
 * （`decodeProjectKey`）。两个插件合并成 `dsh-session-ops` 之后：
 *   - 实现只有一份，规则与边界都写在 `lib/store/paths.js` / `lib/store/frames.js`
 *     的模块注释里；
 *   - 这里的模块路径保留下来，是为了让本包原有的 `test/*.mjs` 不必改 import 就继续可用。
 *
 * @module dsh-session-ops/sessionlog
 */
export { CHECKSUM_OPTIONS, ZSTD_MAGIC, hasZstd, readHeaderFromBuffer, rewriteHeaderCwd, scanZstdFrames, } from './store/frames.js';
export { compressionSuffix, encodeSegment, generationLogFilename, logPath, projectKey, sessionDir, } from './store/paths.js';
