#!/usr/bin/env node
/**
 * Retrieval evaluation from the plugin's own recall log.
 *
 * Every `recalled … via "…"` line is a real decision the plugin once made: a
 * query it saw, and the entries it judged worth injecting. That is a labelled
 * corpus that costs nothing to collect, and it is what "measure before changing
 * retrieval" should use on this machine — the hand-labelled probe file is
 * gitignored and absent from a fresh checkout.
 *
 * The script replays the same scorer over the current global scope and reports
 * recall@1/3/5 and MRR, plus how far the expected entries have moved since the
 * decision was logged. It is read-only: the store is copied to a temporary
 * directory first.
 *
 * Usage:
 *   node scripts/eval-recall-log.mjs
 *   node scripts/eval-recall-log.mjs --home C:/some/.dsh --top 10 --json
 *
 * @module dsh-memories/scripts/eval-recall-log
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/storage.js'
import { searchMemories } from '../lib/search.js'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}
const home = args.includes('--home') ? args[args.indexOf('--home') + 1] : (process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'))
const top = flag('--top', 5)

/** Extract one probe from a recall log line, or `undefined`. */
function probeOf(line) {
  if (!line.includes('recalled ') || !line.includes('via "')) return undefined
  // `session <id> recalled <ids> (relevance …, score …, via "<query>")`
  const match = /recalled (.+?) \((?:relevance|score)[^)]*via "([^"]*)"/u.exec(line)
  if (match === null) return undefined
  const ids = (match[1] ?? '').split(',').map((value) => value.trim()).filter((value) => value.length > 0)
  const query = (match[2] ?? '').trim()
  if (ids.length === 0 || query.length < 2) return undefined
  return { ids, query }
}

const work = await mkdtemp(join(tmpdir(), 'dsh-memories-eval-recall-'))
try {
  // A copy, because `store.list` rewrites index.json when its count disagrees.
  await cp(join(home, 'memories'), join(work, 'memories'), { recursive: true })
  const store = new MemoryStore(join(work, 'memories'))
  const scopes = []
  const globalEntries = [...await store.list('global', undefined, { fresh: true })]
  scopes.push({ scope: 'global', label: 'global', entries: globalEntries })
  const scopeOfId = new Map(globalEntries.map((entry) => [entry.id, 'global']))
  for (const slug of await store.listProjects()) {
    const descriptor = await store.readProjectDescriptor(slug)
    if (descriptor === undefined) continue
    const entries = [...await store.list('project', descriptor.root, { fresh: true })]
    if (entries.length === 0) continue
    scopes.push({ scope: 'project', label: `project:${slug}`, entries })
    for (const entry of entries) if (!scopeOfId.has(entry.id)) scopeOfId.set(entry.id, `project:${slug}`)
  }
  const live = new Set(scopeOfId.keys())

  const logPath = join(home, 'logs', 'dsh-memories.log')
  const log = await readFile(logPath, 'utf8').catch(() => '')
  const probes = []
  const seen = new Set()
  for (const line of log.split(/\r?\n/u)) {
    const probe = probeOf(line)
    if (probe === undefined) continue
    const key = `${probe.query}\u0000${probe.ids.join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    probes.push(probe)
  }

  const usable = probes.filter((probe) => probe.ids.every((id) => live.has(id)))
  const missing = probes.length - usable.length
  let hit1 = 0
  let hit3 = 0
  let hitTop = 0
  let rr = 0
  const misses = []
  for (const probe of usable) {
    // The entries this decision named tell us which scopes the session could
    // see: global always, plus the project those ids live in. Ranking against
    // the same scopes is what the runtime did.
    const needed = new Set(probe.ids.map((id) => scopeOfId.get(id)))
    const corpus = scopes.filter((item) => needed.has(item.label))
    const hits = searchMemories(corpus, probe.query, { expand: true, limit: 100 })
    const ranks = probe.ids.map((id) => hits.findIndex((hit) => hit.entry.id === id)).filter((rank) => rank >= 0)
    const best = ranks.length === 0 ? Infinity : Math.min(...ranks)
    if (best === 0) hit1 += 1
    if (best < 3) hit3 += 1
    if (best < top) hitTop += 1
    if (Number.isFinite(best)) rr += 1 / (best + 1)
    else misses.push(probe)
  }
  const count = usable.length
  const report = {
    home,
    liveEntries: scopes.reduce((total, item) => total + item.entries.length, 0),
    scopes: scopes.length,
    probes: probes.length,
    usable: count,
    skippedUnknown: missing,
    recallAt1: count === 0 ? null : Number((hit1 / count).toFixed(3)),
    recallAt3: count === 0 ? null : Number((hit3 / count).toFixed(3)),
    [`recallAt${top}`]: count === 0 ? null : Number((hitTop / count).toFixed(3)),
    mrr: count === 0 ? null : Number((rr / count).toFixed(3)),
    misses: misses.length,
    missingSample: misses.slice(0, 3).map((probe) => ({ query: probe.query.slice(0, 60), ids: probe.ids.slice(0, 3) })),
  }
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    for (const [key, value] of Object.entries(report)) {
      if (key === 'missingSample') continue
      console.log(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    }
    for (const miss of report.missingSample) console.log(`  miss: ${miss.query} → ${JSON.stringify(miss.ids)}`)
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
