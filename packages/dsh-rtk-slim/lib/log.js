/**
 * Startup evidence. The harness never logs plugin activation to disk (dsh web
 * and the Desktop shell keep stdout in memory), so "did it actually mount, and
 * with which config?" is otherwise unanswerable after a restart. One appended
 * line per activation settles it.
 *
 * Never throws: a logging failure must not stop the plugin from loading.
 *
 * @module dsh-rtk-slim/log
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * `$DSH_HOME/logs/dsh-rtk-slim.log`, falling back to `~/.dsh/logs/...`.
 * @returns {string}
 */
export function defaultLogPath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'logs', 'dsh-rtk-slim.log')
}

/**
 * Append one timestamped line.
 * @param {string} line
 * @param {string} [path]
 * @returns {boolean} whether the line was written
 */
export function logStartup(line, path = defaultLogPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
    return true
  } catch {
    return false
  }
}
