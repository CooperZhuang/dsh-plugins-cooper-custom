#!/usr/bin/env node
/**
 * Coverage simulation: does the title-only rotation block actually raise how
 * much of the store ever gets seen?
 *
 * Reads a COPY of the real memory store (never the live one), models the
 * summary selection and the rotation selection over N new conversations, and
 * prints the share of entries that have been surfaced at 1/5/10/20/40
 * conversations for two policies:
 *
 * - `baseline` — the summary alone (what shipped before the rotation block);
 * - `rotation` — the summary plus `rotationEntries` titles per conversation.
 *
 * Entries already surfaced in the real store count from the start, so the first
 * row is the real starting coverage, not zero. The output is what the goal's
 * acceptance numbers are read from; `scripts/coverage.mts` measures the live
 * store after those conversations actually happen.
 *
 * Usage:
 *   node scripts/eval-rotation.mts
 *   node scripts/eval-rotation.mts --home C:/some/.dsh --entries 30 --json
 *
 * @module dsh-cross-memory/scripts/eval-rotation
 */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../lib/storage.js'
import { renderMemoryIndex, selectForSummary } from '../lib/render.js'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}
const home = args.includes('--home') ? args[args.indexOf('--home') + 1] : (process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'))
const rotationEntries = flag('--entries', 16)
const sessions = flag('--sessions', 40)
const budget = flag('--budget', 1600)

const work = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-eval-rotation-'))
try {
  // Work on a copy: `store.list` rewrites index.json when it disagrees with the
  // directory, and the evaluation must never touch the live store.
  await cp(join(home, 'memories'), join(work, 'memories'), { recursive: true })
  const store = new MemoryStore(join(work, 'memories'))
  const loaded = [...await store.list('global', undefined, { fresh: true })]
  // Selection reads the surfaced clock from state.db, not the entry file's
  // mirror: the mirror is refreshed hourly and legacy entries never got a row.
  // Model that here, or the simulation starts from a coverage the runtime does
  // not actually believe.
  let db
  const surfacedRows = new Map()
  try {
    db = new DatabaseSync(join(work, 'memories', 'state.db'), { readOnly: true })
    for (const row of db.prepare('SELECT scope, id, surfaced_at FROM usage WHERE surfaced_at > 0').all()) {
      surfacedRows.set(`${row.scope}\u0000${row.id}`, Number(row.surfaced_at))
    }
  } catch {
    // A missing state.db means the mirror is all there is; fall through with an
    // empty map, which matches the runtime's non-durable branch.
  } finally {
    try { db?.close() } catch { /* read-only handle */ }
  }
  const surfacedByState = surfacedRows.size > 0
  const global = loaded.map((entry) => surfacedByState
    ? { ...entry, lastSurfacedAt: surfacedRows.get(`${entry.scope}\u0000${entry.id}`) ?? 0 }
    : entry)
  const total = global.length
  const startCovered = global.filter((entry) => entry.lastSurfacedAt > 0).length

  /** Run a policy over `sessions` conversations; entries are mutated in place. */
  const simulate = (withRotation) => {
    // The runtime spends three quarters of the block on the global scope and the
    // rest on the current project. This simulation covers the global scope
    // alone, so it models that share (12 of 16 titles), not the whole block.
    const globalShare = Math.max(1, Math.ceil(rotationEntries * 0.75))
    const entries = global.map((entry) => ({ ...entry }))
    const surfaced = new Set(entries.filter((entry) => entry.lastSurfacedAt > 0).map((entry) => entry.id))
    const points = new Map()
    let clock = Date.now()
    for (let session = 1; session <= sessions; session += 1) {
      clock += 60_000
      const listed = selectForSummary(entries, 4, { freshSlots: 3, now: clock })
      for (const entry of listed) {
        surfaced.add(entry.id)
        entry.lastSurfacedAt = clock
      }
      if (withRotation) {
        const shown = new Set(listed.map((entry) => entry.id))
        const pool = entries.filter((entry) => !shown.has(entry.id))
        const fresh = pool.filter((entry) => entry.lastSurfacedAt <= 0)
          .sort((left, right) => Number(left.source === 'auto') - Number(right.source === 'auto')
            || left.createdAt - right.createdAt
            || left.title.localeCompare(right.title))
        const stale = pool.filter((entry) => entry.lastSurfacedAt > 0)
          .sort((left, right) => left.lastSurfacedAt - right.lastSurfacedAt
            || left.createdAt - right.createdAt
            || left.title.localeCompare(right.title))
        const picked = []
        for (const entry of [...fresh, ...stale]) {
          if (picked.length >= globalShare) break
          if (renderMemoryIndex([...picked, entry], budget) === undefined) break
          picked.push(entry)
        }
        for (const entry of picked) {
          surfaced.add(entry.id)
          entry.lastSurfacedAt = clock
        }
      }
      if ([1, 5, 10, 20, 40].includes(session) || session === sessions) {
        points.set(session, `${(100 * surfaced.size / total).toFixed(1)}%`)
      }
    }
    return points
  }

  const baseline = simulate(false)
  const rotation = simulate(true)
  const report = {
    home,
    total,
    alreadySurfaced: startCovered,
    startCoverage: `${(100 * startCovered / total).toFixed(1)}%`,
    rotationEntries,
    budget,
    baseline: Object.fromEntries(baseline),
    rotation: Object.fromEntries(rotation),
  }
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`store: ${total} entries, ${startCovered} already surfaced (${report.startCoverage})`)
    console.log(`sessions | baseline | rotation (half of ${rotationEntries}/session to global)`)
    for (const session of [1, 5, 10, 20, 40].filter((value) => baseline.has(value))) {
      console.log(`${String(session).padStart(8)} | ${String(baseline.get(session)).padStart(8)} | ${rotation.get(session)}`)
    }
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
