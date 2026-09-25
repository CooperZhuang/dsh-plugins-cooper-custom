/**
 * 会话日志的帧级读写原语 —— **实现已搬到共享包 `dsh-session-store`**。
 *
 * 这个文件现在只是一层**历史路径的门面**：`./sessionlog.js` 曾经是本插件私有的
 * 实现（从 dsh-sync 移植），而 `dsh-session-admin` 那边重复着同一套知识的另一半
 * （`decodeProjectKey`）。两边合并到 `dsh-session-store` 之后：
 *   - 实现只有一份，规则与边界都写在 `lib/paths.js` / `lib/frames.js` 的模块注释里；
 *   - 这里的模块路径保留下来，是为了让本仓库原有的 `test/*.mjs`（以及任何按
 *     `dsh-session-move/lib/sessionlog.js` 导入的外部脚本）不必改 import 就继续可用。
 *
 * @module dsh-session-move/sessionlog
 */

export {
  CHECKSUM_OPTIONS,
  ZSTD_MAGIC,
  compressionSuffix,
  encodeSegment,
  generationLogFilename,
  hasZstd,
  logPath,
  projectKey,
  readHeaderFromBuffer,
  rewriteHeaderCwd,
  scanZstdFrames,
  sessionDir,
} from 'dsh-session-store'
