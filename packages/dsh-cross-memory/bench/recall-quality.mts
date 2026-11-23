/**
 * Recall-quality bench: does the BM25 order put better entries in front of the
 * old relevance order, on the recalls the live plugin actually made?
 *
 * The on-demand recall path is not covered by `run-bench.mts` (that corpus is
 * generated from memory titles, not from real turns). This one reads the
 * `recalled … via "query"` lines the plugin logs and replays each case against
 * the live store, comparing the shipped BM25 order with the lexical relevance
 * order it replaced. Writes nothing; the log is the only input.
 *
 * A case is a "win" when the first three entries carry a higher mean BM25 under
 * the new order. Relevance is not judged here — the point is that the order
 * changed in the direction the retrieval bench measured, and never backwards.
 *
 * Usage: node bench/recall-quality.mts [--log <path>]
 */
import { readFileSync } from 'node:fs'
import { MemoryStore } from '../lib/storage.js'
import { relevanceOf } from '../lib/search.js'
import { createBm25Index } from '../lib/bm25.js'

const args = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? fallback : (args[at + 1] ?? fallback)
}
const LOG = arg('log', `${process.env.HOME}/.dsh/logs/dsh-cross-memory.log`)
const HOME = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`

interface Case {
  readonly query: string
  readonly entries: readonly any[]
}

/** The recall cases in the log, deduplicated by query plus recalled ids. */
function recallCases(log: string, byId: Map<string, any>): Case[] {
  const out: Case[] = []
  const seen = new Set<string>()
  for (const line of log.split('\n')) {
    const at = line.indexOf('recalled ')
    const via = line.lastIndexOf('via "')
    if (at < 0 || via < 0) continue
    const query = line.slice(via + 5, line.lastIndexOf('"'))
    const ids = line.slice(at + 9, line.indexOf(' (relevance')).split(', ').map((part) => part.trim()).filter(Boolean)
    const entries = ids.map((id) => byId.get(id)).filter(Boolean)
    if (entries.length < 3) continue
    const key = `${query}|${entries.map((entry) => entry.id).join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ query, entries })
  }
  return out
}

const store = new MemoryStore(`${HOME}/memories`)
const all = [...await store.list('global')]
for (const project of await store.listProjects()) all.push(...await store.list('project', project.root).catch(() => []))
const byId = new Map(all.map((entry) => [entry.id, entry]))
const index = createBm25Index(all)

let cases = 0
let better = 0
let worse = 0
let same = 0
let relevanceSum = 0
let bm25Sum = 0

for (const item of recallCases(readFileSync(LOG, 'utf8'), byId)) {
  const scores = index.score(item.query)
  const top = (list: readonly any[]): number =>
    list.slice(0, 3).reduce((sum, entry) => sum + (scores.get(entry.id) ?? 0), 0)
  const byRelevance = [...item.entries].sort((left, right) => relevanceOf(right, item.query) - relevanceOf(left, item.query))
  const byBm25 = [...item.entries].sort((left, right) => (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0))
  const before = top(byRelevance)
  const after = top(byBm25)
  cases += 1
  relevanceSum += before
  bm25Sum += after
  if (after > before + 1e-9) better += 1
  else if (after < before - 1e-9) worse += 1
  else same += 1
}

console.log(`log ${LOG}`)
console.log(`cases ${cases}`)
console.log(`mean top-3 BM25: relevance order ${(relevanceSum / Math.max(1, cases)).toFixed(2)}  bm25 order ${(bm25Sum / Math.max(1, cases)).toFixed(2)}`)
console.log(`better ${better}  worse ${worse}  same ${same}`)
