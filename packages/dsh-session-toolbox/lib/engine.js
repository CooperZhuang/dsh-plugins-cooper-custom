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
 * @module dsh-session-move/engine
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import {
  ZSTD_MAGIC,
  findGeneration,
  parseGenerationName,
  projectKey,
  readHeaderFromBuffer,
  rewriteHeaderCwd,
  scanZstdFrames,
  sessionDir,
} from 'dsh-session-store'

/** 迁移中使用的临时文件名后缀（都**不**匹配 generation 规范名）。 */
export const TMP_SUFFIX = '.session-move-tmp'
export const PARKED_SUFFIX = '.session-move-old'

/**
 * `findGeneration` / `parseGenerationName`（「目录里哪份才算规范 generation」）已经搬到
 * `dsh-session-store/lib/paths.js`——删除路径也要认得同一套命名，规则只该有一份。
 * 这里保留再导出，是为了不打断本仓库既有的导入者（`test/core.test.mjs` 就按
 * `../lib/engine.js` 导入它们）。
 */
export { findGeneration, parseGenerationName }

/**
 * 计算一次搬迁的计划：读源日志、改写 cwd、给出目标路径。**只读**，不写任何东西。
 *
 * @param options - `{root, sessionId, fromCwd, toCwd, compression}`。
 * @returns 计划对象（含 `buffer`，供 {@link applyPlan} 直接落盘）。
 * @throws 源日志缺失、header 与请求不符、目标已存在、源与目标同目录时。
 */
export function planMove(options) {
  const { root, sessionId, fromCwd, toCwd } = options
  const compression = options.compression ?? 'zstd'
  if (typeof root !== 'string' || root.length === 0) throw new Error('session root is unknown')
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('session id is required')
  if (typeof fromCwd !== 'string' || fromCwd.length === 0) throw new Error('source cwd is required')
  if (typeof toCwd !== 'string' || toCwd.length === 0) throw new Error('target cwd is required')
  if (fromCwd === toCwd) throw new Error('source and target cwd are identical')
  const fromKey = projectKey(fromCwd)
  const toKey = projectKey(toCwd)
  if (fromKey === toKey) throw new Error('source and target resolve to the same project directory')

  const sourceDir = sessionDir(root, fromCwd, sessionId)
  const targetDir = sessionDir(root, toCwd, sessionId)
  const found = findGeneration(sourceDir)
  if (found.error !== undefined) {
    throw new Error(`${found.error}${found.others !== undefined && found.others.length > 0 ? ` (found: ${found.others.join(', ')})` : ''}`)
  }
  const sourcePath = join(sourceDir, found.selected.name)
  const targetPath = join(targetDir, found.selected.name)
  const buffer = readFileSync(sourcePath)
  const compressed = found.selected.compressed
  const header = readHeaderFromBuffer(buffer, compressed)
  if (header === undefined) throw new Error(`cannot read a session header from ${sourcePath}`)
  if (String(header.id) !== sessionId) throw new Error(`header id ${String(header.id)} does not match requested session ${sessionId}`)
  if (typeof header.cwd === 'string' && header.cwd !== fromCwd) {
    throw new Error(`header cwd ${header.cwd} does not match the stored cwd ${fromCwd}`)
  }
  const rewritten = rewriteHeaderCwd(buffer, toCwd, { compressed })
  if (rewritten.rewritten !== true) throw new Error(`cannot rewrite the header cwd: ${rewritten.reason ?? 'unknown reason'}`)
  let targetExists = false
  try {
    statSync(targetPath)
    targetExists = true
  } catch {
    targetExists = false
  }
  if (targetExists) throw new Error(`target log already exists (refusing to overwrite): ${targetPath}`)
  const frames = compressed ? scanZstdFrames(buffer) : { frames: [], incomplete: false }
  if (compressed && frames.incomplete) throw new Error(`source log has an incomplete trailing frame: ${frames.reason}`)

  return {
    root,
    compression,
    sessionId,
    fromCwd,
    toCwd,
    fromKey,
    toKey,
    generation: found.selected,
    /** 源目录里除 generation 之外的文件（租约文件等），搬迁时保留原样。 */
    otherFiles: found.others,
    otherGenerations: found.all.slice(1).map((entry) => entry.name),
    sourceDir,
    targetDir,
    sourcePath,
    targetPath,
    bytesBefore: buffer.length,
    bytesAfter: rewritten.buffer.length,
    frameCount: compressed ? frames.frames.length : null,
    header,
    rewrittenHeader: rewritten.header,
    buffer: rewritten.buffer,
  }
}

/** 原子落盘：写 + fsync（崩在中间也不会留下半个文件）。 */
function writeDurable(path, buffer) {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, buffer, 0, buffer.length, 0)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
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
export function applyPlan(plan) {
  const report = {
    sessionId: plan.sessionId,
    from: plan.fromCwd,
    to: plan.toCwd,
    generation: plan.generation.name,
    bytesBefore: plan.bytesBefore,
    bytesAfter: plan.bytesAfter,
    frames: plan.frameCount,
    sourcePath: plan.sourcePath,
    targetPath: plan.targetPath,
    moved: true,
  }
  mkdirSync(plan.targetDir, { recursive: true })
  const tmpPath = plan.targetPath + TMP_SUFFIX
  const parkedPath = plan.sourcePath + PARKED_SUFFIX
  writeDurable(tmpPath, plan.buffer)
  renameSync(plan.sourcePath, parkedPath)
  renameSync(tmpPath, plan.targetPath)
  rmSync(parkedPath, { force: true })

  let removedSourceDir = false
  let leftover = []
  try {
    leftover = readdirSync(plan.sourceDir)
  } catch {
    leftover = []
  }
  if (leftover.length === 0) {
    try {
      rmdirSync(plan.sourceDir)
      removedSourceDir = true
    } catch (error) {
      report.sourceDirCleanupError = String(error?.message ?? error)
    }
  }
  report.removedSourceDir = removedSourceDir
  report.leftInSourceDir = leftover

  // 落盘之后再读一遍目标文件：确认帧结构可解、header 已是新 cwd。
  const after = readFileSync(plan.targetPath)
  const header = readHeaderFromBuffer(after, plan.generation.compressed)
  report.verifiedHeader = header === undefined
    ? null
    : { id: String(header.id), cwd: typeof header.cwd === 'string' ? header.cwd : null, version: header.version }
  report.verifiedBytes = after.length
  report.ok = report.verifiedHeader !== null && report.verifiedHeader.cwd === plan.toCwd
  return report
}

/**
 * 只读校验：目标位置上是否有一份可解析、id/cwd 都对得上的日志。
 * @param options - `{root, sessionId, cwd, compression}`。
 * @returns `{ok, header, bytes}` 或 `{ok:false, error}`。
 */
export function verifyStoredLog(options) {
  try {
    const dir = sessionDir(options.root, options.cwd, options.sessionId)
    const found = findGeneration(dir)
    if (found.error !== undefined) return { ok: false, error: found.error }
    const buffer = readFileSync(join(dir, found.selected.name))
    const header = readHeaderFromBuffer(buffer, found.selected.compressed)
    if (header === undefined) return { ok: false, error: 'header is unreadable' }
    return {
      ok: String(header.id) === options.sessionId && header.cwd === options.cwd,
      header: { id: String(header.id), cwd: typeof header.cwd === 'string' ? header.cwd : null },
      bytes: buffer.length,
      magic: buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC ? 'zstd' : 'plain',
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
