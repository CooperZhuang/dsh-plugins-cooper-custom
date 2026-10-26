#!/usr/bin/env node
/**
 * The numbers that decide whether the store needs an inverted index yet.
 *
 * Recall scores every entry of the scope it reads, so the per-turn cost grows
 * linearly with the store. Measured 2026-10-23 at 200 live entries: 11 ms for a
 * full pass, 10 ms for a cold list, 9.7 ms for one write. Those are not a problem
 * — the question is when they become one, and answering it needs a repeatable
 * measurement rather than a guess made before raising the cap.
 *
 * Run this after raising `maxEntries` (or after a few weeks of growth) and compare
 * against the last reading. The threshold this plugin cares about is 50 ms per
 * turn: below it nobody notices, above it every conversation pays for it.
 *
 *   node scripts/recall-bench.mjs              # measure the real store
 *   node scripts/recall-bench.mjs --scale=5    # simulate 5x the entries
 *   node scripts/recall-bench.mjs --json       # machine-readable baseline
 *
 * @module dsh-memories/scripts/recall-bench
 */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const flags = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
  const at = arg.indexOf('=')
  return at < 0 ? [arg.slice(2), 'true'] : [arg.slice(2, at), arg.slice(at + 1)]
}))
const home = flags['home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const store = join(home, 'memories')
const scale = Number(flags['scale'] ?? 1)
const { MemoryStore, } = await import(join(process.env.DSH_REPO ?? process.cwd(), 'lib', 'storage.js'))
const { matchCredit, prefilterEntries } = await import(join(process.env.DSH_REPO ?? process.cwd(), 'lib', 'search.js'))

const live = (() => { try { return readdirSync(join(store, 'entries')).filter((f) => f.endsWith('.md')).length } catch { return 0 } })()
const memory = new MemoryStore(store)
const once = await memory.list('global', undefined, { fresh: true })
const entries = Array.from({ length: Math.ceil(scale) }, () => once).flat()

const query = '上次说的那个合并任务为什么不跑，需要重启吗'
const time = (fn, runs = 20) => {
  for (let index = 0; index < 3; index += 1) fn()
  const start = process.hrtime.bigint()
  for (let index = 0; index < runs; index += 1) fn()
  return Number(process.hrtime.bigint() - start) / 1e6 / runs
}

const cold = time(() => memory.list('global', undefined, { fresh: true }), 5)
const warm = time(() => memory.list('global', undefined), 20)
const score = time(() => { for (const entry of entries) matchCredit(entry, query, 9, 2) }, 10)
const indexed = time(() => {
  const candidates = prefilterEntries(entries, query)
  for (const entry of candidates) matchCredit(entry, query, 9, 2)
}, 10)
const candidateCount = prefilterEntries(entries, query).length

const report = {
  at: new Date().toISOString(),
  live,
  scaled: entries.length,
  coldListMs: Number(cold.toFixed(2)),
  warmListMs: Number(warm.toFixed(2)),
  scorePerTurnMs: Number(score.toFixed(2)),
  indexedScorePerTurnMs: Number(indexed.toFixed(2)),
  candidates: candidateCount,
  thresholdMs: 50,
  verdict: indexed < 50 ? 'fine' : 'needs a better index',
}
console.log(flags['json'] === 'true' ? JSON.stringify(report, null, 2)
  : 'dsh-memories · recall cost\n live ' + report.live + ' (scaled ' + report.scaled + ')\n cold list ' + report.coldListMs + ' ms\n warm list ' + report.warmListMs + ' ms\n score/turn ' + report.scorePerTurnMs + ' ms full scan, ' + report.indexedScorePerTurnMs + ' ms indexed (' + report.candidates + '/' + report.scaled + ' candidates) (threshold ' + report.thresholdMs + ' ms)\n verdict: ' + report.verdict)