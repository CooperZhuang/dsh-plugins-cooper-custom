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
 * @module dsh-session-store/paths
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** generation 规范名：`session.jsonl[.zstd]` 或 `session.vN.jsonl[.zstd]`。 */
const GENERATION_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/**
 * 把任意字符串编码成一个安全路径段（与会话 id 共用同一套转义）。
 * @param raw - 原始字符串。
 * @returns 单个文件系统安全路径段。
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * 项目目录键：分隔符折叠成 `-`，不安全码位 `~XXXX`，截断到 251 字符。
 * @param cwd - 会话的项目目录。
 * @returns 单个文件系统安全的项目目录名。
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 把 `sessions/` 下的项目目录键还原成路径。
 *
 * 只做「够用」的反解：分隔符在磁盘上已经全部退化成 `-`，无法区分 `/` 与 `\`
 * （这里一律还原成 `\`），盘符的冒号也没有单独转义（`C:\a` → `--C-a--`，这里
 * 按 `^[A-Za-z]\\` 补回来）。**真正的 cwd 以会话头部里的记录为准**，这个只作为兜底。
 * @param key - 项目目录名。
 * @returns 反解出的路径。
 */
export function decodeProjectKey(key) {
  let s = key
  if (s.startsWith('--')) s = s.slice(2)
  if (s.endsWith('--')) s = s.slice(0, -2)
  s = s.replace(/~([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  s = s.replace(/-/g, '\\')
  // 盘符的冒号在目录键里没有单独转义（`C:\a` → `--C-a--`），补回来。
  return /^[A-Za-z]\\/.test(s) ? `${s[0]}:${s.slice(1)}` : s
}

/**
 * **宽松**的会话日志文件名判定：`.jsonl.zstd` 或 `.jsonl` 结尾就算。
 *
 * 与 {@link parseGenerationName}（**规范** generation 名）是两件事，别互相替换：
 * 删除路径要能看见并清掉任何形状的日志文件（哪怕是手工改名或半截写入的），
 * 而搬迁路径必须只认规范名，否则会把临时文件当成真日志搬走。
 * @param name - 目录项名。
 * @returns 是否像一份会话日志。
 */
export function isSessionLogFile(name) {
  return name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl')
}

/**
 * 目录里是不是规范 generation 名。
 * @param name - 目录项名。
 * @returns 版本号（v0 为 0）与是否压缩；不是规范名时 `undefined`。
 */
export function parseGenerationName(name) {
  const match = GENERATION_NAME.exec(name)
  if (match === null) return undefined
  return { version: match[1] === undefined ? 0 : Number(match[1]), compressed: match[2] === '.zstd' }
}

/**
 * 选出会话目录里版本最高的规范 generation 文件。
 *
 * 临时名与备份名（`*.session-move-tmp`、`*.session-move-old`）不匹配规范名，
 * 一律进 `others`——搬迁必须保证「任何时刻都不存在两份规范名日志」。
 * @param dir - 会话目录。
 * @returns `{selected, all, others}`；列不了目录或没有规范名时 `{error, others?}`
 *   （错误文案被两个插件的用户可见报告引用，改动前先看测试）。
 */
export function findGeneration(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return { error: `cannot list session directory ${dir}: ${String(error?.message ?? error)}` }
  }
  const generations = []
  const others = []
  for (const entry of entries) {
    const parsed = parseGenerationName(entry.name)
    if (parsed === undefined) {
      others.push(entry.name)
      continue
    }
    generations.push({ name: entry.name, version: parsed.version, compressed: parsed.compressed })
  }
  if (generations.length === 0) return { error: `no canonical session log in ${dir}`, others }
  generations.sort((left, right) => right.version - left.version)
  return { selected: generations[0], all: generations, others }
}

/** 物理编码后缀。 */
export function compressionSuffix(compression) {
  return compression === 'zstd' ? '.zstd' : ''
}

/** 一个 generation 的规范文件名（v0 不带 `vN` 段）。 */
export function generationLogFilename(version, compression) {
  return `${version === 0 ? 'session' : `session.v${version}`}.jsonl${compressionSuffix(compression)}`
}

/** 会话目录：`<root>/<projectKey>/<encodeSegment(id)>`。 */
export function sessionDir(root, cwd, id) {
  return join(join(root, cwd === undefined ? '_no-cwd' : projectKey(cwd)), encodeSegment(id))
}

/** 一个 generation 的绝对日志路径。 */
export function logPath(root, cwd, id, version, compression) {
  return join(sessionDir(root, cwd, id), generationLogFilename(version, compression))
}
