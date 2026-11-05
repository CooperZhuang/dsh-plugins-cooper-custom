#!/usr/bin/env node
/**
 * Project the whole-store coverage a run of new sessions can actually reach.
 *
 * `eval:rotation` simulates the global scope alone, which is the optimistic
 * number. This script replays the *workspace mix* of the last N real sessions:
 * a session opened in `C:\Code\foo` can rotate the global scope plus `foo`'s
 * project scope, and nothing else. It reports whole-store coverage session by
 * session, starting from what `state.db` says is already surfaced, so it answers
 * "is a whole-store target reachable at all with this lever?" instead of
 * assuming it.
 *
 * Read-only: the store is copied first; no model calls.
 *
 * Usage:
 *   node scripts/eval-coverage-projection.mts
 *   node scripts/eval-coverage-projection.mts --sessions 10 --json
 *
 * @module dsh-cross-memory/scripts/eval-coverage-projection
 */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, projectSlug } from '../lib/storage.js'
import { renderMemoryIndex, selectForSummary } from '../lib/render.js'
import { findSessionLogs, parseSessionLog, decodeSessionLog } from '../lib/backfill.js'
import { readFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}
const home = args.includes('--home') ? args[args.indexOf('--home') + 1] : (process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'))
const sessions = flag('--sessions', 10)
const rotationEntries = flag('--entries', 16)
const budget = flag('--budget', 1600)
const globalShare = Math.max(1, Math.ceil(rotationEntries / 2))

/** Links used by the rotation ordering (same rule as the runtime). */
const linksOf = (entry) => [...new Set([...entry.keys, ...entry.tags].map((value) => String(value).trim().toLowerCase()).filter(Boolean))]

const work = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-coverage-projection-'))
let db
try {
  await cp(join(home, 'memories'), join(work, 'memories'), { recursive: true })
  const store = new MemoryStore(join(work, 'memories'))
  const bySlug = new Map()
  const global = [...await store.list('global', undefined, { fresh: true })]
  for (const slug of await store.listProjects()) {
    const descriptor = await store.readProjectDescriptor(slug)
    if (descriptor === undefined) continue
    bySlug.set(slug, [...await store.list('project', descriptor.root, { fresh: true })])
  }
  const all = [...global, ...bySlug.values()].flat()

  // The real workspace mix: which project scope the last N sessions opened in.
  const logs = (await findSessionLogs(join(home, 'sessions'))).slice(0, Math.max(sessions * 6, 30))
  const seenWorkspaces = []
  for (const log of logs) {
    const parsed = parseSessionLog(decodeSessionLog(await readFile(log.file)), log.file, log.modifiedAt)
    if (parsed?.cwd === undefined) continue
    seenWorkspaces.push(projectSlug(parsed.cwd))
    if (seenWorkspaces.length >= sessions) break
  }
  while (seenWorkspaces.length < sessions) seenWorkspaces.push(undefined)

  db = new DatabaseSync(join(work, 'memories', 'state.db'), { readOnly: true })
  const surfaced = new Set(db.prepare('SELECT scope, id FROM usage WHERE surfaced_at > 0').all().map((row) => `${row.scope}\u0000${row.id}`))
  const seen = new Set(all.filter((entry) => surfaced.has(`${entry.scope}\u0000${entry.id}`)).map((entry) => entry.id))
  const state = new Map(all.map((entry) => [entry.id, { ...entry, lastSurfacedAt: seen.has(entry.id) ? 1 : 0 }]))

  /** Pick titles for one scope of one session (summary reservation + rotation). */
  const rotateScope = (pool, share, clock) => {
    const fresh = pool.filter((entry) => entry.lastSurfacedAt <= 0)
      .sort((left, right) => Number(left.source === 'auto') - Number(right.source === 'auto') || left.createdAt - right.createdAt || left.title.localeCompare(right.title))
    const stale = pool.filter((entry) => entry.lastSurfacedAt > 0)
      .sort((left, right) => left.lastSurfacedAt - right.lastSurfacedAt || left.createdAt - right.createdAt || left.title.localeCompare(right.title))
    const picked = []
    for (const entry of [...fresh, ...stale]) {
      if (picked.length >= share) break
      if (renderMemoryIndex([...picked, entry], budget) === undefined) break
      picked.push(entry)
    }
    for (const entry of picked) { state.get(entry.id).lastSurfacedAt = clock; seen.add(entry.id) }
    return picked.length
  }

  const points = []
  let clock = Date.now()
  for (let session = 0; session < sessions; session += 1) {
    clock += 60_000
    const slug = seenWorkspaces[session]
    const projectEntries = slug === undefined ? [] : (bySlug.get(slug) ?? [])
    const visible = [...global, ...projectEntries].map((entry) => state.get(entry.id))
    // The summary's own selection (12 global at most, 4 when a project section
    // competes) — modelled exactly as `selectForSummary` does.
    for (const entry of selectForSummary(visible.filter((entry) => entry.scope === 'global'), projectEntries.length > 0 ? 4 : 12, { freshSlots: 3, now: clock })) {
      if (!seen.has(entry.id)) seen.add(entry.id)
      state.get(entry.id).lastSurfacedAt = clock
    }
    for (const entry of selectForSummary(visible.filter((entry) => entry.scope === 'project'), 12, { freshSlots: 3, now: clock })) {
      if (!seen.has(entry.id)) seen.add(entry.id)
      state.get(entry.id).lastSurfacedAt = clock
    }
    // Rotation: the runtime alternates global and project queues.
    rotateScope(visible.filter((entry) => entry.scope === 'global'), globalShare, clock)
    if (projectEntries.length > 0) rotateScope(visible.filter((entry) => entry.scope === 'project'), rotationEntries - globalShare, clock)
    points.push({ session: session + 1, workspace: slug ?? '(none)', coverage: Number((100 * seen.size / all.length).toFixed(1)) })
  }

  const report = {
    home,
    liveEntries: all.length,
    globalEntries: global.length,
    projectEntries: all.length - global.length,
    alreadySurfaced: all.filter((entry) => surfaced.has(`${entry.scope}\u0000${entry.id}`)).length,
    startCoverage: Number((100 * all.filter((entry) => surfaced.has(`${entry.scope}\u0000${entry.id}`)).length / all.length).toFixed(1)),
    rotationEntries,
    points,
  }
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`store: ${all.length} entries (global ${global.length}, project ${all.length - global.length}); start ${report.startCoverage}%`)
    for (const point of points) console.log(`  session ${String(point.session).padStart(2)} workspace=${String(point.workspace).slice(0, 28).padEnd(28)} coverage=${point.coverage}%`)
  }
} finally {
  try { db?.close() } catch { /* read-only */ }
  await rm(work, { recursive: true, force: true })
}
