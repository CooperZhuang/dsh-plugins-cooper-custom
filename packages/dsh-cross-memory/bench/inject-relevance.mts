/**
 * Injection-relevance bench: what the injected block actually renders, and how
 * much of it the conversation is about.
 *
 * The retrieval bench (`run-bench.mts`) asks whether a known entry ranks high.
 * This one asks the question the injector answers: given the opening turn of a
 * real session, which entries reach the rendered block, and how many of them are
 * about that session. It reads the real-session corpus (`bench/data/`, gitignored)
 * and the live store, and writes nothing.
 *
 * Reported, over every sampled session:
 *   - listed/session and bytes/session (what the byte budget actually renders),
 *   - the share of listed entries the session's opening turn matches,
 *   - the same share against the session's whole transcript (a looser check),
 *   - prefix relevance: the share among the first N rendered entries, which is
 *     what the byte budget reliably reaches.
 *
 * Usage: node bench/inject-relevance.mts [--max-bytes 8192] [--corpus real-candidates.json]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryStore } from '../lib/storage.js'
import { selectForSummary, renderMemorySummaryResult, rankForSummary } from '../lib/render.js'
import { matchCredit } from '../lib/search.js'

const DATA = 'bench/data'
const args = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? fallback : (args[at + 1] ?? fallback)
}
const MAX_BYTES = Number(arg('max-bytes', '8192'))
const CORPUS = arg('corpus', 'real-candidates.json')
const HOME = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`

/** The first user message of a transcript, which is all the injector has. */
function openingOf(transcript: string): string {
  const text = String(transcript)
  const start = text.indexOf('USER:')
  if (start < 0) return ''
  const rest = text.slice(start + 5)
  const end = rest.indexOf('ASSISTANT:')
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

/** One rendered section, in the order index.ts passes it. */
function render(
  project: readonly any[],
  global: readonly any[],
  opening: string,
  now: number,
) {
  const hasProject = project.length > 0
  // Rank the scopes together: they compete for the same rendered slots.
  const merged = rankForSummary([...project, ...global], now, opening)
  const rank = new Map(merged.map((entry, at) => [entry.id, at]))
  const rankedOf = (list: readonly any[]) =>
    [...list].sort((left, right) => (rank.get(left.id) ?? 1e9) - (rank.get(right.id) ?? 1e9))
  const scopes = [
    { label: 'project', heading: 'Project memories', entries: selectForSummary(project, 20, { freshSlots: 3, now, query: opening, ranked: rankedOf(project) }), total: project.length },
    { label: 'global', heading: 'Global memories', entries: selectForSummary(global, hasProject ? 6 : 20, { freshSlots: 3, now, query: opening, ranked: rankedOf(global) }), total: global.length, ...hasProject ? { maxEntries: 6, maxBytes: 1200 } : {} },
  ]
  return renderMemorySummaryResult(scopes, { maxBytes: MAX_BYTES, maxEntriesPerScope: 20 })?.listed ?? []
}

const candidates = JSON.parse(await readFile(join(DATA, CORPUS), 'utf8'))
const store = new MemoryStore(join(HOME, 'memories'))
const globalEntries = await store.list('global')
const projectCache = new Map<string, readonly any[]>()
const projectEntries = async (cwd: string): Promise<readonly any[]> => {
  if (!projectCache.has(cwd)) projectCache.set(cwd, await store.list('project', cwd).catch(() => []))
  return projectCache.get(cwd) ?? []
}

const TOPIC = { score: 9, terms: 2, singleTerm: false }
const PREFIXES = [4, 6, 8, 12, 16]
const keep = new Map<number, number>(PREFIXES.map((cut) => [cut, 0]))
const span = new Map<number, number>(PREFIXES.map((cut) => [cut, 0]))
let listedTotal = 0
let aboutOpening = 0
let aboutTopic = 0
let bytesTotal = 0
let sessions = 0

for (const session of candidates.sessions) {
  const opening = openingOf(session.transcript)
  const now = session.modifiedAt
  const project = await projectEntries(session.cwd)
  const listed = render(project, globalEntries, opening, now)
  const topic = String(session.transcript).slice(0, 4000)
  const flags = listed.map((entry) => ({
    opening: matchCredit(entry, opening, TOPIC.score, TOPIC.terms, { singleTerm: false, now }).about,
    topic: matchCredit(entry, topic, TOPIC.score, TOPIC.terms, { singleTerm: false, now }).about,
  }))
  sessions += 1
  listedTotal += listed.length
  bytesTotal += Buffer.byteLength(JSON.stringify(listed.map((entry) => entry.title)), 'utf8')
  aboutOpening += flags.filter((flag) => flag.opening).length
  aboutTopic += flags.filter((flag) => flag.topic).length
  for (const cut of PREFIXES) {
    span.set(cut, (span.get(cut) ?? 0) + Math.min(cut, listed.length))
    keep.set(cut, (keep.get(cut) ?? 0) + flags.slice(0, cut).filter((flag) => flag.opening).length)
  }
}

const pct = (part: number, whole: number): string => `${((part / Math.max(1, whole)) * 100).toFixed(1)}%`
console.log(`sessions ${sessions} · global ${globalEntries.length} · maxBytes ${MAX_BYTES}`)
console.log(`listed/session ${(listedTotal / sessions).toFixed(1)}`)
console.log(`about opening ${pct(aboutOpening, listedTotal)} · about transcript ${pct(aboutTopic, listedTotal)}`)
console.log('prefix relevance (opening):')
for (const cut of PREFIXES) console.log(`  cut ${String(cut).padStart(2)}: ${pct(keep.get(cut) ?? 0, span.get(cut) ?? 0)}`)
