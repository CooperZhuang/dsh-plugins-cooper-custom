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
  const rankHistogram = {}
  const relevanceGaps = []
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
    // Why a decision is not at rank 1: a missing graph edge and a lost
    // tie-break are different problems, and only the second is cheap to fix.
    if (Number.isFinite(best)) {
      const bucket = best <= 10 ? String(best) : '>10'
      rankHistogram[bucket] = (rankHistogram[bucket] ?? 0) + 1
      const top = hits[0]
      const expected = hits[best]
      if (best > 0 && top !== undefined && expected !== undefined) {
        relevanceGaps.push(Number(((top.relevance ?? 0) - (expected.relevance ?? 0)).toFixed(1)))
      }
    } else {
      rankHistogram['absent'] = (rankHistogram['absent'] ?? 0) + 1
    }
  }
  const sortedGaps = relevanceGaps.slice().sort((left, right) => left - right)
  const medianGap = sortedGaps.length === 0 ? null : sortedGaps[Math.floor(sortedGaps.length / 2)]
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
    rankHistogram,
    medianRelevanceGap: medianGap,
    within3Relevance: relevanceGaps.filter((gap) => gap <= 3).length,
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

  // `--variants` replays alternative orderings over the same probes. Read the
  // caveat first: these probes are decisions the INJECTOR made (it ranks by the
  // attention score), so a variant that reorders by that score looks better by
  // construction. The variants are a screening tool, not a verdict: a change
  // still needs the search-surface rule (relevance first) to agree.
  if (args.includes('--variants')) {
    const linksOf = (entry) => [...new Set([...entry.keys, ...entry.tags].map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
    const runVariant = (variant) => {
      let at1 = 0
      let at3 = 0
      let at5 = 0
      let rr = 0
      let n = 0
      for (const probe of usable) {
        const needed = new Set(probe.ids.map((id) => scopeOfId.get(id)))
        const corpus = scopes.filter((item) => needed.has(item.label))
        const base = searchMemories(corpus, probe.query, { expand: true, limit: 100 })
        let ranked = base
        if (variant === 'score') ranked = [...base].sort((left, right) => right.score - left.score)
        if (variant === 'expand-query' && base[0] !== undefined) {
          const entries = corpus.flatMap((item) => item.entries)
          const df = new Map()
          for (const entry of entries) for (const link of linksOf(entry)) df.set(link, (df.get(link) ?? 0) + 1)
          const terms = linksOf(base[0].entry).filter((link) => (df.get(link) ?? 0) <= entries.length * 0.5).slice(0, 3)
          if (terms.length > 0) ranked = searchMemories(corpus, `${probe.query} ${terms.join(' ')}`, { expand: true, limit: 100 })
        }
        if (variant === 'link-boost' && base[0] !== undefined) {
          const entries = corpus.flatMap((item) => item.entries)
          const df = new Map()
          for (const entry of entries) for (const link of linksOf(entry)) df.set(link, (df.get(link) ?? 0) + 1)
          const information = (link) => {
            const share = (df.get(link) ?? 0) / entries.length
            return share > 0.5 ? 0 : 1 - share
          }
          const topLinks = new Set(linksOf(base[0].entry))
          ranked = [...base].map((hit) => {
            const own = linksOf(hit.entry)
            let shared = 0
            for (const link of own) if (topLinks.has(link)) shared += information(link)
            return { hit, boost: shared }
          }).sort((left, right) => (right.hit.relevance + 5 * right.boost) - (left.hit.relevance + 5 * left.boost)).map((row) => row.hit)
        }
        const ranks = probe.ids.map((id) => ranked.findIndex((hit) => hit.entry.id === id)).filter((rank) => rank >= 0)
        const best = ranks.length === 0 ? Infinity : Math.min(...ranks)
        n += 1
        if (best === 0) at1 += 1
        if (best < 3) at3 += 1
        if (best < 5) at5 += 1
        rr += Number.isFinite(best) ? 1 / (best + 1) : 0
      }
      return { at1: Number((at1 / n).toFixed(3)), at3: Number((at3 / n).toFixed(3)), at5: Number((at5 / n).toFixed(3)), mrr: Number((rr / n).toFixed(3)) }
    }
    console.log('\nvariant comparison (screening only; probes come from the injector):')
    for (const variant of ['baseline', 'score', 'link-boost', 'expand-query']) {
      console.log(`  ${variant.padEnd(11)} ${JSON.stringify(runVariant(variant))}`)
    }
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
