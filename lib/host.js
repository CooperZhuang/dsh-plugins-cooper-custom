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
 * @module dsh-session-store/host
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `$DSH_HOME`：环境变量优先，默认 `~/.dsh`。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * 文件日志行格式之一：`[ISO 时间] 级别 正文`（`dsh-session-admin` 在用）。
 * @param entry - `{iso, level, message}`。
 * @returns 一整行（含结尾换行）。
 */
export const LOG_LINE_LEVEL_FIRST = ({ iso, level, message }) => `[${iso}] ${level} ${message}\n`

/**
 * 文件日志行格式之一：`ISO 时间 [级别] 正文`（`dsh-session-move` 在用）。
 * @param entry - `{iso, level, message}`。
 * @returns 一整行（含结尾换行）。
 */
export const LOG_LINE_TIME_FIRST = ({ iso, level, message }) => `${iso} [${level}] ${message}\n`

/**
 * 尽力而为的文件日志：写 `$DSH_HOME/logs/<name>.log`，并顺带喂宿主 logger。
 *
 * 任何一步失败都静默吞掉——日志本身永远不该成为故障源（建目录失败、磁盘满了、
 * 宿主 logger 不可用，都不影响插件机制）。
 * @param ctx - Host cordis 上下文（只用 `ctx?.logger`，可为 undefined）。
 * @param options - `{name, formatLine}`：日志文件名（不含 `.log`；默认
 *   `dsh-session-store`）与行格式（默认 {@link LOG_LINE_LEVEL_FIRST}）。
 * @returns `(level, message) => void`，即插件里的 `log`。
 */
export function createFileLogger(ctx, options = {}) {
  const name = typeof options.name === 'string' && options.name.length > 0 ? options.name : 'dsh-session-store'
  const formatLine = typeof options.formatLine === 'function' ? options.formatLine : LOG_LINE_LEVEL_FIRST
  let path
  try {
    const dir = join(dshHome(), 'logs')
    mkdirSync(dir, { recursive: true })
    path = join(dir, `${name}.log`)
  } catch {
    path = undefined
  }
  return (level, message) => {
    try {
      ctx?.logger?.[level]?.(message)
    } catch {
      /* 宿主 logger 不可用不影响文件日志 */
    }
    if (path === undefined) return
    try {
      appendFileSync(path, formatLine({ iso: new Date().toISOString(), level, message }), 'utf8')
    } catch {
      /* 日志写不进去就算了 */
    }
  }
}

/**
 * 解包 entry 配置里的 `.volatile()` 活引用。
 * @param raw - entry 配置或普通配置对象。
 * @returns 值已解包的浅拷贝。
 */
export function plainConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const plain = {}
  for (const [key, value] of Object.entries(source)) {
    plain[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return plain
}

/**
 * 解析一份 entry 配置：先解包输入的活引用，再交给 schema 校验并补默认值，最后**再解包
 * 一次**——schemastery 对 `.volatile()` 字段输出的也是活引用，不收敛的话读到的就是
 * `{ get() }` 对象（HTTP 面上会变成一个空对象）。
 *
 * schema 由调用方传入（本包不依赖 `@deepseek-ai/schemastery`），传进来的只要是
 * 「可调用、收普通对象、返回带默认值的普通对象」即可。
 * @param schema - 插件自己的 `Config`（schemastery 对象，可调用）。
 * @param raw - entry 配置或普通配置对象。
 * @returns 普通值配置。
 */
export function resolveVolatileConfig(schema, raw = {}) {
  return plainConfig(schema(plainConfig(raw)))
}
