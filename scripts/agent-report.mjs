#!/usr/bin/env node
/**
 * One screen on the personal-agent layer: is it speaking, is it being heard, and
 * is its picture of the user growing?
 *
 * This is the probe the user asked to keep: after a week of running, the numbers
 * below — how many notices were raised, how many were acted on or dismissed, how
 * large the profile grew, how long the pending backlog sat — are what tells us
 * whether the agent is useful or merely noisy. Read-only.
 *
 * Usage:
 *   node scripts/agent-report.mjs            # human summary
 *   node scripts/agent-report.mjs --json     # machine-readable, for later comparison
 *   node scripts/agent-report.mjs --home=... # a different DSH home
 *
 * @module dsh-memories/scripts/agent-report
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const flags = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
  const at = arg.indexOf('=')
  return at < 0 ? [arg.slice(2), 'true'] : [arg.slice(2, at), arg.slice(at + 1)]
}))
const home = flags['home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const store = join(home, 'memories')
const size = (path) => { try { return statSync(path).size } catch { return 0 } }
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }

const queue = readJson(join(store, 'notices.json')) ?? { notices: [] }
const notices = Array.isArray(queue.notices) ? queue.notices : []
const byState = {}
const byKind = {}
for (const notice of notices) {
  byState[notice.state] = (byState[notice.state] ?? 0) + 1
  byKind[notice.kind] = (byKind[notice.kind] ?? 0) + 1
}
const answered = notices.filter((notice) => notice.state === 'acked')
const acted = answered.filter((notice) => notice.outcome === 'acted').length
const dismissed = answered.filter((notice) => notice.outcome === 'dismissed').length
const oldestOpen = notices.filter((notice) => notice.state === 'open')
  .map((notice) => notice.createdAt).sort((a, b) => a - b)[0]

const personas = {}
for (const block of ['human', 'assistant']) {
  const path = join(store, 'persona', block + '.md')
  personas[block] = { bytes: size(path), exists: existsSync(path) }
}
const legacy = size(join(store, 'persona.md'))

let pending = undefined
try {
  const plan = readJson(join(store, 'pending', 'consolidation.json'))
  if (plan !== undefined) pending = { disputes: plan.disputes?.length ?? 0, stagedHours: Math.round((Date.now() - plan.at) / 3_600_000) }
} catch { /* no pending plan */ }

const logPath = join(home, 'logs', 'dsh-memories.log')
const logLines = existsSync(logPath) ? readFileSync(logPath, 'utf8').split(/\r?\n/u).filter((line) => line.length > 0) : []
const count = (needle) => logLines.filter((line) => line.includes(needle)).length
const maintenance = {
  stored: count(' stored '),
  retired: count(' retired '),
  consolidated: count(' consolidated '),
  sweeps: count('sweep:'),
  delivered: count('notice delivered'),
  suppressed: count('notice suppressed'),
  pumpFailed: count('notice pump failed'),
}

const report = {
  at: new Date().toISOString(),
  home,
  live: (() => { try { return readdirSync(join(store, 'entries')).filter((f) => f.endsWith('.md')).length } catch { return 0 } })(),
  notices: { total: notices.length, byState, byKind, acted, dismissed, oldestOpenHours: oldestOpen === undefined ? null : Math.round((Date.now() - oldestOpen) / 3_600_000) },
  personas,
  legacyPersonaBytes: legacy,
  pending,
  maintenance,
}

if (flags['json'] === 'true') {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('dsh-memories · personal agent probe')
  console.log('at', report.at, ' home', report.home, ' live', report.live)
  console.log('notices  total', report.notices.total, ' states', JSON.stringify(byState), ' kinds', JSON.stringify(byKind))
  console.log('         acted', acted, ' dismissed', dismissed, ' oldest open (h)', report.notices.oldestOpenHours)
  console.log('persona  human', personas.human.bytes + 'B', ' assistant', personas.assistant.bytes + 'B', legacy > 0 ? '(legacy single file still present: ' + legacy + 'B)' : '')
  console.log('pending ', pending === undefined ? 'none' : pending.disputes + ' dispute(s), staged ' + pending.stagedHours + 'h ago')
  console.log('maint    stored', maintenance.stored, ' retired', maintenance.retired, ' consolidated', maintenance.consolidated, ' sweeps', maintenance.sweeps)
  console.log('delivery delivered', maintenance.delivered, ' suppressed', maintenance.suppressed, ' pumpFailed', maintenance.pumpFailed)
}
