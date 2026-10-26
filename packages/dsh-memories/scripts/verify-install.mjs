#!/usr/bin/env node
/**
 * Warn before a restart instead of after it.
 *
 * A `file:` dependency in a DSH profile is installed as a HARDLINK: `npm run
 * build` writes through the files that already exist, so an EDIT reaches the live
 * install immediately — but a NEW module does not propagate at all, and the host
 * dies on the next boot with ERR_MODULE_NOT_FOUND. That failure is silent until
 * you read the app log, which is how three restarts in a row loaded nothing.
 *
 * This script compares the repository build against the installed copy and prints
 * the one command that fixes it. Read-only, exits non-zero when they disagree.
 *
 * Usage:
 *   node scripts/verify-install.mjs
 *   node scripts/verify-install.mjs --home=/Users/you/.dsh --profile=desktop
 *
 * @module dsh-memories/scripts/verify-install
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
const installed = join(home, 'profiles', profile, 'node_modules', 'dsh-memories')

if (!existsSync(installed)) {
  console.log('not installed in ' + profile + ' — nothing to compare (that is fine if you do not use it here)')
  process.exit(0)
}

const list = (dir) => {
  const out = new Map()
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else out.set(path.slice(dir.length + 1), statSync(path).size)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

const built = list(join(repo, 'lib'))
const live = list(join(installed, 'lib'))
const missing = [...built.keys()].filter((file) => !live.has(file))
const stale = [...built.entries()].filter(([file, size]) => live.has(file) && live.get(file) !== size)

const inode = (path) => { try { return statSync(path).ino } catch { return 0 } }
const hardlinked = (file) => inode(join(repo, 'lib', file)) === inode(join(installed, 'lib', file))

if (missing.length === 0 && stale.length === 0) {
  console.log('install matches the build: ' + built.size + ' files in ' + installed)
  const sample = [...built.keys()].find((file) => file.endsWith('.js'))
  if (sample !== undefined && !hardlinked(sample)) {
    console.log('note: files are copies, not hardlinks — a plain build will NOT reach the live install; reinstall after each build')
  }
  process.exit(0)
}

console.log('INSTALL IS OUT OF SYNC with ' + repo + '/lib')
if (missing.length > 0) console.log('  missing (new modules never propagate): ' + missing.join(', '))
if (stale.length > 0) console.log('  different size: ' + stale.map(([file]) => file).join(', '))
console.log()
console.log('fix (rebuilds the hardlinks; restart the host afterwards):')
console.log('  cd ' + join(home, 'profiles', profile))
console.log('  pnpm remove dsh-memories && pnpm add "file:' + repo + '"')
process.exit(1)
