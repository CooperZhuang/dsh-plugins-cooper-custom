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
 * @module dsh-session-store/frames
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

import { isSessionLogFile } from './paths.js'

/** zstd 帧魔数（小端）。 */
export const ZSTD_MAGIC = 0xfd2fb528

/** 与 DSH 一致的压缩选项：带内容校验和。 */
export const CHECKSUM_OPTIONS =
  zlib.constants?.ZSTD_c_checksumFlag === undefined
    ? {}
    : { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

/** `zstdCompressSync` 需要 Node ≥22.15 / ≥23.8；缺失时插件拒绝搬迁而不是写坏日志。 */
export const hasZstd = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'

/** `zstdDecompressSync` 同样需要 Node ≥22.15；缺失时降级为「读不到会话头」。 */
const zstdDecompress =
  typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : undefined

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
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, incomplete: true, reason: `尾部剩 ${buffer.length - offset} 字节，不足以构成帧魔数` }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      return { frames, incomplete: true, reason: `偏移 ${offset} 处不是 zstd 魔数` }
    }
    offset += 4
    if (offset >= buffer.length) return { frames, incomplete: true, reason: '帧头被截断（缺少描述符）' }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionaryFlag = descriptor & 3

    if (singleSegment === 0) offset += 1 // Window_Descriptor
    offset += dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4
    const fcsSize = fcsFlag === 0 ? (singleSegment === 1 ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    offset += fcsSize
    if (offset > buffer.length) return { frames, incomplete: true, reason: '帧头字段越过文件尾' }

    for (;;) {
      if (offset + 3 > buffer.length) return { frames, incomplete: true, reason: '块头被截断' }
      const header = buffer.readUInt8(offset) | (buffer.readUInt8(offset + 1) << 8) | (buffer.readUInt8(offset + 2) << 16)
      offset += 3
      const lastBlock = header & 1
      const blockType = (header >> 1) & 3
      const blockSize = header >> 3
      if (blockType === 0) offset += blockSize
      else if (blockType === 1) offset += 1
      else if (blockType === 2) offset += blockSize
      else return { frames, incomplete: true, reason: `偏移 ${offset - 3} 处出现保留块类型` }
      if (lastBlock === 1) break
    }
    if (checksum === 1) offset += 4
    if (offset > buffer.length) return { frames, incomplete: true, reason: '帧体越过文件尾' }
    frames.push({ start, end: offset })
  }
  return { frames, incomplete: false }
}

/**
 * 读出日志第一帧里的 header 对象（只解析，不改写）。
 * @param buffer - 日志内容。
 * @param compressed - `true`（默认）表示 zstd 帧日志，`false` 表示未压缩的行式日志。
 * @returns header 对象；不是合法会话日志时 `undefined`。
 */
export function readHeaderFromBuffer(buffer, compressed = true) {
  if (!compressed) {
    try {
      const text = buffer.toString('utf8')
      const newlineIndex = text.indexOf('\n')
      const parsed = JSON.parse(newlineIndex === -1 ? text : text.slice(0, newlineIndex))
      return parsed !== null && typeof parsed === 'object' && parsed.type === 'session' ? parsed : undefined
    } catch {
      return undefined
    }
  }
  const scan = scanZstdFrames(buffer)
  if (scan.frames.length === 0) return undefined
  try {
    const first = scan.frames[0]
    const inflated = zlib.zstdDecompressSync(buffer.subarray(first.start, first.end))
    const text = Buffer.from(inflated).toString('utf8')
    const newlineIndex = text.indexOf('\n')
    const parsed = JSON.parse(newlineIndex === -1 ? text : text.slice(0, newlineIndex))
    return parsed !== null && typeof parsed === 'object' && parsed.type === 'session' ? parsed : undefined
  } catch {
    return undefined
  }
}

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
export function readSessionHeader(dir, cache = new Map()) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const log = entries.find((e) => e.isFile() && isSessionLogFile(e.name))
  if (log === undefined) return undefined
  const path = join(dir, log.name)
  let stat
  try {
    stat = statSync(path)
  } catch {
    return undefined
  }
  const key = `${path}:${stat.mtimeMs}:${stat.size}`
  if (cache.has(key)) return cache.get(key)
  let header
  try {
    const raw = readFileSync(path)
    const text = log.name.endsWith('.zstd')
      ? zstdDecompress === undefined
        ? undefined
        : zstdDecompress(raw).toString('utf8')
      : raw.toString('utf8')
    if (text !== undefined) {
      const end = text.indexOf('\n')
      header = JSON.parse(end === -1 ? text : text.slice(0, end))
    }
  } catch {
    header = undefined
  }
  cache.set(key, header)
  return header
}

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
export function rewriteHeaderCwd(buffer, newCwd, options = {}) {
  const compressed = options.compressed !== false
  if (typeof newCwd !== 'string' || newCwd.length === 0) {
    return { buffer, rewritten: false, reason: 'empty target cwd' }
  }
  if (!compressed) {
    const text = buffer.toString('utf8')
    const newlineIndex = text.indexOf('\n')
    const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex)
    const rest = newlineIndex === -1 ? '' : text.slice(newlineIndex)
    let header
    try {
      header = JSON.parse(firstLine)
    } catch {
      return { buffer, rewritten: false, reason: 'header line is not JSON' }
    }
    if (header?.type !== 'session' || typeof header.cwd !== 'string') {
      return { buffer, rewritten: false, reason: 'header has no cwd' }
    }
    if (header.cwd === newCwd) return { buffer, rewritten: false, header }
    const rebuilt = {}
    for (const [key, value] of Object.entries(header)) rebuilt[key] = key === 'cwd' ? newCwd : value
    return { buffer: Buffer.from(JSON.stringify(rebuilt) + rest, 'utf8'), rewritten: true, header: rebuilt }
  }

  if (!hasZstd) return { buffer, rewritten: false, reason: 'this node build lacks zlib zstd support' }
  const scan = scanZstdFrames(buffer)
  if (scan.incomplete || scan.frames.length === 0) {
    return { buffer, rewritten: false, reason: scan.reason ?? 'no complete frame' }
  }
  const firstFrame = scan.frames[0]
  let header
  let rest
  try {
    const inflated = zlib.zstdDecompressSync(buffer.subarray(firstFrame.start, firstFrame.end))
    const text = Buffer.from(inflated).toString('utf8')
    const newlineIndex = text.indexOf('\n')
    header = JSON.parse(newlineIndex === -1 ? text : text.slice(0, newlineIndex))
    rest = newlineIndex === -1 ? '' : text.slice(newlineIndex)
  } catch (error) {
    return { buffer, rewritten: false, reason: `cannot decode header frame: ${String(error?.message ?? error)}` }
  }
  if (header?.type !== 'session' || typeof header.cwd !== 'string') {
    return { buffer, rewritten: false, reason: 'header has no cwd' }
  }
  if (header.cwd === newCwd) return { buffer, rewritten: false, header, frames: scan.frames.length }

  const rebuilt = {}
  for (const [key, value] of Object.entries(header)) rebuilt[key] = key === 'cwd' ? newCwd : value
  let newFrame
  try {
    newFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(rebuilt) + rest, 'utf8'), CHECKSUM_OPTIONS)
  } catch (error) {
    return { buffer, rewritten: false, reason: `cannot recompress header frame: ${String(error?.message ?? error)}` }
  }
  return {
    buffer: Buffer.concat([newFrame, buffer.subarray(firstFrame.end)]),
    rewritten: true,
    header: rebuilt,
    frames: scan.frames.length,
  }
}
