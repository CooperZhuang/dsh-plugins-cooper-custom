#!/usr/bin/env node
/**
 * Acceptance check for the exposure-rotation goal (option A).
 *
 * Two promises are measured independently, because they have very different
 * ceilings:
 *
 * - `globalCoverage`: share of the GLOBAL scope ever injected or read. This is
 *   the scope every conversation can reach, so the 50% target lives here.
 * - `wholeDeadShare`: share of the WHOLE live store never injected or read.
 *   Project scopes are only discoverable from their own workspace, so this
 *   number moves slowly; the promise is a measurable drop below the recorded
 *   baseline, not a fixed percentage.
 *
 * The baseline is `eval/coverage-baseline.json`. On the first run the script
 * records it and exits 0; later runs compare against it and fail when either
 * promise is unmet.
 *
 * Read-only: the store is copied to a temporary directory first.
 *
 * Usage:
 *   node scripts/eval-acceptance.mts
 *   node scripts/eval-acceptance.mts --json
 *   node scripts/eval-acceptance.mts --record-baseline
 *
 * @module dsh-cross-memory/scripts/eval-acceptance
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../lib/storage.js'
import { decodeSessionLog, findSessionLogs } from '../lib/backfill.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const home = args.includes('--home') ? args[args.indexOf('--home') + 1] : (process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'))
const baselinePath = join(root, 'eval', 'coverage-baseline.json')
const record = args.includes('--record-baseline')

const work = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-acceptance-'))
let db
try {
  await cp(join(home, 'memories'), join(work, 'memories'), { recursive: true })
  const store = new MemoryStore(join(work, 'memories'))
  const global = [...await store.list('global', undefined, { fresh: true })]
  const projects = []
  for (const slug of await store.listProjects()) {
    const descriptor = await store.readProjectDescriptor(slug)
    if (descriptor === undefined) continue
    projects.push(...await store.list('project', descriptor.root, { fresh: true }))
  }
  db = new DatabaseSync(join(work, 'memories', 'state.db'), { readOnly: true })
  const rows = new Map(db.prepare('SELECT scope, id, surfaced_at, last_used_at FROM usage').all()
    .map((row) => [`${row.scope}\u0000${row.id}`, { surfacedAt: Number(row.surfaced_at), lastUsedAt: Number(row.last_used_at) }]))
  const stateIsAuthoritative = db !== undefined
  const seen = (entry) => {
    const row = rows.get(`${entry.scope}\u0000${entry.id}`)
    // The entry file mirrors the counters for human readers, but the mirror is
    // refreshed at most hourly and legacy entries never got a usage row: the
    // state database is the authority the runtime's own selection reads.
    // Measured on this store, trusting the mirror reports 86.7% global coverage
    // where state.db reports 37.8%.
    if (stateIsAuthoritative) return (row?.surfacedAt ?? 0) > 0 || (row?.lastUsedAt ?? 0) > 0
    return entry.lastSurfacedAt > 0 || entry.lastUsedAt > 0
  }
  const count = (entries) => ({ total: entries.length, seen: entries.filter(seen).length })
  const globalCount = count(global)
  const projectCount = count(projects)
  const whole = { total: globalCount.total + projectCount.total, seen: globalCount.seen + projectCount.seen }
  const pct = (value) => (value.total === 0 ? null : Number((100 * value.seen / value.total).toFixed(1)))

  // How much rotation has actually reached a persisted log since the baseline.
  const logs = await findSessionLogs(join(home, 'sessions'))
  let rotationLogs = 0
  let rotationTitleLines = 0
  for (const log of logs) {
    const raw = await readFile(log.file).catch(() => null)
    if (raw === null) continue
    let text
    try {
      text = decodeSessionLog(raw)
    } catch {
      continue
    }
    if (!text.includes('<memory-index>')) continue
    let blocks = 0
    for (const line of text.split('\n')) {
      if (!line.includes('<memory-index>')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event?.type !== 'user/message') continue
      if (!String(event?.data?.source?.kind ?? '').startsWith('plugin')) continue
      const body = (event.data.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
      const matched = [...body.matchAll(/<memory-index>[\s\S]*?<\/memory-index>/gu)]
      if (matched.length === 0) continue
      blocks += matched.length
      for (const match of matched) rotationTitleLines += (match[0].match(/^- /gmu) ?? []).length
    }
    if (blocks > 0) rotationLogs += 1
  }

  const current = {
    takenAt: new Date().toISOString(),
    global: { ...globalCount, coverage: pct(globalCount) },
    project: projectCount,
    whole: { ...whole, coverage: pct(whole), deadShare: whole.total === 0 ? null : Number((100 * (whole.total - whole.seen) / whole.total).toFixed(1)) },
    persistedRotationLogs: rotationLogs,
    persistedRotationTitleLines: rotationTitleLines,
  }

  let baseline
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  } catch {
    baseline = undefined
  }
  const mustRecord = record || baseline === undefined
  if (baseline === undefined && !record) {
    // Never silently agree with an absent baseline: recording one automatically
    // turns the next run into "dead below baseline: PASS" for free, which is
    // exactly the shape of a self-fulfilling acceptance.
    console.error(`baseline missing: ${baselinePath}; record it once with --record-baseline and commit it`)
    process.exitCode = 2
  } else if (mustRecord) {
    await mkdir(dirname(baselinePath), { recursive: true })
    await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
    console.log(`recorded baseline at ${baselinePath}`)
    console.log(JSON.stringify(current, null, 2))
    process.exitCode = 0
  } else {
    const globalPass = current.global.coverage !== null && current.global.coverage >= 50
    const deadPass = baseline.whole?.deadShare === null || baseline.whole?.deadShare === undefined
      ? null
      : current.whole.deadShare < baseline.whole.deadShare
    const report = {
      baseline: { takenAt: baseline.takenAt, globalCoverage: baseline.global.coverage, wholeDeadShare: baseline.whole.deadShare, persistedRotationLogs: baseline.persistedRotationLogs },
      current,
      delta: {
        globalCoverage: current.global.coverage === null || baseline.global.coverage === null ? null : Number((current.global.coverage - baseline.global.coverage).toFixed(1)),
        wholeDeadShare: current.whole.deadShare === null || baseline.whole.deadShare === null ? null : Number((current.whole.deadShare - baseline.whole.deadShare).toFixed(1)),
      },
      verdict: {
        globalCoverageAtLeast50: globalPass,
        wholeDeadShareBelowBaseline: deadPass,
        pass: globalPass && deadPass === true,
      },
    }
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`baseline ${baseline.takenAt}: global ${baseline.global.coverage}% · whole dead ${baseline.whole.deadShare}% · rotation logs ${baseline.persistedRotationLogs ?? '?'}`)
      console.log(`current  ${current.takenAt}: global ${current.global.coverage}% · whole dead ${current.whole.deadShare}% · rotation logs ${current.persistedRotationLogs}`)
      console.log(`delta    global ${report.delta.globalCoverage >= 0 ? '+' : ''}${report.delta.globalCoverage}pp · dead ${report.delta.wholeDeadShare}pp`)
      console.log(`verdict  global>=50: ${globalPass ? 'PASS' : 'FAIL'} · dead below baseline: ${deadPass === null ? 'n/a' : deadPass ? 'PASS' : 'FAIL'} → ${report.verdict.pass ? 'PASS' : 'NOT YET'}`)
    }
    process.exitCode = report.verdict.pass ? 0 : 1
  }
} finally {
  try { db?.close() } catch { /* read-only */ }
  await rm(work, { recursive: true, force: true })
}
