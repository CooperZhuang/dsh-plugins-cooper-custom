#!/usr/bin/env node
/**
 * Post-restart verification for a ranking/injection change.
 *
 * The host loads the plugin from the profile's installed copy, so a change is
 * live only when the host process started AFTER the profile was updated. This
 * script checks that and prints the numbers the recall benches must reproduce.
 * Read-only: it changes nothing and makes no model calls.
 *
 * Usage:
 *   node scripts/post-restart-verify.mts
 *   node scripts/post-restart-verify.mts --home=/Users/you/.dsh --profile=desktop
 *
 * macOS only for the process check (`ps -o lstart`); elsewhere it reports the
 * host as not running and the version/baseline lines still apply.
 *
 * @module dsh-cross-memory/scripts/post-restart-verify
 */
import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const flags = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
  const at = arg.indexOf('=')
  return at < 0 ? [arg.slice(2), 'true'] : [arg.slice(2, at), arg.slice(at + 1)]
}))
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = flags['home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profile = flags['profile'] ?? 'desktop'
const installed = join(home, 'profiles', profile, 'node_modules', 'dsh-cross-memory')

/** The host main process's start time, or `undefined` when it is not running. */
function hostStarted(): number | undefined {
  try {
    const lines = execFileSync('ps', ['-eo', 'pid,lstart,command'], { encoding: 'utf8' })
    const line = lines.split('\n').find((row) => row.includes('MacOS/DSH Desktop Beta --updated'))
    if (line === undefined) return undefined
    // `lstart` is "Mon Nov 23 14:04:00 2026" in local time; Date.parse does not
    // take that shape, so read the fields.
    const stamp = line.match(/[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}/u)?.[0]
    if (stamp === undefined) return undefined
    const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
    const parts = stamp.split(/\s+/u)
    const month = months[parts[1] ?? ''] ?? 0
    const day = Number(parts[2])
    const [hours, minutes, seconds] = (parts[3] ?? '0:0:0').split(':').map(Number)
    return new Date(Number(parts[4]), month, day, hours, minutes, seconds).getTime()
  } catch {
    return undefined
  }
}

function mtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

const version = (() => {
  try {
    return JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version as string
  } catch {
    return undefined
  }
})()
const installedAt = mtime(join(installed, 'package.json'))
const started = hostStarted()

console.log(`profile ${profile} 版本 ${version ?? '未知'}  安装于 ${installedAt === undefined ? '未知' : new Date(installedAt).toISOString()}`)
console.log(`宿主主进程启动于 ${started === undefined ? '未运行' : new Date(started).toISOString()}`)

const live = started !== undefined && installedAt !== undefined && started > installedAt
if (live) {
  console.log('结论：改动已生效（宿主晚于安装启动）')
} else if (started === undefined) {
  console.log('结论：宿主没在运行；启动后即为生效')
} else {
  console.log('结论：未生效 —— 宿主早于安装启动，需要退出进程并重开（关窗口不算）')
  console.log('  osascript -e \'quit app "DSH Desktop Beta"\' && sleep 2 && open -a "DSH Desktop Beta"')
}

console.log('\n重启后应达到的基线（数字不符就是回归）：')
console.log('  node bench/inject-relevance.mts   # listed 20.4/会话、前 6 条相关 94.2%')
console.log('  node bench/recall-quality.mts     # 需新会话产生日志，前 3 条平均 BM25 约 54.9')
console.log('  node bench/verify-doc.mts         # 无 MISMATCH')
console.log('\n离线复核（不依赖宿主是否重启）：')
console.log('  cd packages/dsh-cross-memory && npm test')
