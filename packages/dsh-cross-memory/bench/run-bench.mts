/**
 * Four-arm retrieval bench over the live memory store.
 *
 * Arms answer one question each:
 *   current  — what the plugin ships today (lexical + importance + recency)
 *   bm25     — the classics one: pure lexical scoring, no hand-tuned weights
 *   dense    — qwen3-embedding:0.6b cosine, no lexical overlap needed
 *   hybrid   — reciprocal rank fusion of bm25 and dense
 *
 * Every arm ranks the whole 732-entry store for the same query, so the numbers
 * are comparable. Ranks are written to bench/data/results.json for the follow-up
 * analysis; the console report is the summary.
 *
 * Usage: node bench/run-bench.mts [--limit 10]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { searchMemories, relevanceOf, tokenize, matchCredit, hubTerms } from '../lib/search.js'
import { embedAll, cosine } from './lib/embed.mjs'

const DATA = 'bench/data'
const readJson = async (name) => JSON.parse(await readFile(join(DATA, name), 'utf8'))
const readJsonl = async (name) =>
  (await readFile(join(DATA, name), 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}
const LIMIT = Number(arg('limit', 10))
const QUERY_FILES = arg('queries', 'queries-a.jsonl,queries-b.jsonl').split(',')

const corpus = await readJson('corpus.json')
const queries = (await Promise.all(QUERY_FILES.map((name) => readJsonl(name.trim())))).flat()
const byId = new Map(corpus.map((entry) => [entry.id, entry]))
const groups = [{ scope: 'global', label: 'global', entries: corpus }]

/* ---------------------------------------------------------------- arms ---- */

/** Arm 1: the shipped scorer. `searchMemories` also filters, so a gated-out
 * target simply never appears — which is the behaviour under test. */
function armCurrent(query) {
  return searchMemories(groups, query, { limit: LIMIT }).map((hit) => hit.entry.id)
}

/** Arm 1b: lexical relevance only, importance/recency removed. */
function armRelevance(query) {
  return corpus
    .map((entry) => ({ id: entry.id, score: relevanceOf(entry, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)
    .map((item) => item.id)
}

/** Arm 2: Okapi BM25 over the same fields, same tokenizer, no tuned weights. */
const BM25_K1 = 1.2
const BM25_B = 0.75
const docs = corpus.map((entry) => {
  const text = [entry.title, entry.title, ...(entry.keys ?? []), ...(entry.keys ?? []), ...(entry.tags ?? []), entry.appliesTo ?? '', entry.body ?? ''].join('\n')
  const terms = tokenize(text)
  const tf = new Map()
  for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1)
  return { id: entry.id, tf, length: terms.length }
})
const df = new Map()
for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1)
const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length
const N = docs.length

function armBm25(query) {
  const terms = [...new Set(tokenize(query))]
  return docs
    .map((doc) => {
      let score = 0
      for (const term of terms) {
        const frequency = doc.tf.get(term)
        if (frequency === undefined) continue
        const idf = Math.log(1 + (N - df.get(term) + 0.5) / (df.get(term) + 0.5))
        score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength)))
      }
      return { id: doc.id, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)
    .map((item) => item.id)
}

/* --------------------------------------------------------- dense + fuse --- */

const docText = (entry) =>
  [entry.title, ...(entry.keys ?? []), ...(entry.tags ?? []), entry.appliesTo ?? '', (entry.body ?? '').slice(0, 2000)]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n')

const queryTexts = queries.map((item) => item.query)
const [docVectors, queryVectors] = await Promise.all([
  embedAll(corpus.map(docText), join(DATA, 'emb-docs.json')),
  embedAll(queryTexts, join(DATA, 'emb-queries.json')),
])

function armDense(index) {
  const queryVector = queryVectors[index]
  return corpus
    .map((entry, docIndex) => ({ id: entry.id, score: cosine(queryVector, docVectors[docIndex]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)
    .map((item) => item.id)
}

/** Reciprocal rank fusion: the two arms disagree about scale, not about order. */
const RRF_K = 60
function fuse(...lists) {
  const score = new Map()
  for (const list of lists) {
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, LIMIT).map(([id]) => id)
}

/* -------------------------------------------------------------- metrics --- */

function metrics(rankings) {
  const result = { 'R@1': 0, 'R@3': 0, 'R@5': 0, 'R@10': 0, 'MRR@10': 0, misses: 0, bytes: 0 }
  for (let index = 0; index < queries.length; index += 1) {
    const expected = queries[index].id
    const list = rankings[index]
    const rank = list.indexOf(expected)
    if (rank === 0) result['R@1'] += 1
    if (rank >= 0 && rank < 3) result['R@3'] += 1
    if (rank >= 0 && rank < 5) result['R@5'] += 1
    if (rank >= 0 && rank < LIMIT) result['R@10'] += 1
    if (rank >= 0 && rank < 10) result['MRR@10'] += 1 / (rank + 1)
    if (rank < 0 || rank >= LIMIT) result.misses += 1
    const injected = list.slice(0, 4).map((id) => byId.get(id)).filter(Boolean)
    result.bytes += injected.reduce((sum, entry) => sum + Buffer.byteLength(`${entry.title}\n${entry.body ?? ''}`), 0)
  }
  const total = queries.length
  for (const key of ['R@1', 'R@3', 'R@5', 'R@10', 'MRR@10']) result[key] = (result[key] / total) * 100
  result.bytes = Math.round(result.bytes / total)
  return result
}

/* ---------------------------------------------------------------- run ----- */

const arms = {
  current: (index) => armCurrent(queries[index].query),
  relevance: (index) => armRelevance(queries[index].query),
  bm25: (index) => armBm25(queries[index].query),
  dense: (index) => armDense(index),
}

const rankings = {}
const latency = {}
for (const [name, run] of Object.entries(arms)) {
  const started = process.hrtime.bigint()
  rankings[name] = queries.map((_, index) => run(index))
  latency[name] = Number(process.hrtime.bigint() - started) / 1e6 / queries.length
}

const bm25Ranks = rankings.bm25.map((list) => list)
const denseRanks = rankings.dense.map((list) => list)
rankings.hybrid = queries.map((_, index) => fuse(bm25Ranks[index], denseRanks[index]))
rankings['hybrid+current'] = queries.map((_, index) => fuse(rankings.current[index], rankings.dense[index]))

/* The injection gate as shipped: two substantive terms and a score floor. */
const hub = hubTerms(corpus, 0.25)
const MIN_SCORE = 9
const MIN_TERMS = 2
const gated = queries.map(({ id, query }) => {
  const expected = byId.get(id)
  if (expected === undefined) return { about: false, credited: false, relevance: 0, terms: 0, best: '' }
  const credit = matchCredit(expected, query, MIN_SCORE, MIN_TERMS, { hub, range: null })
  return {
    about: credit.about,
    credited: credit.credited,
    relevance: credit.relevance,
    terms: credit.evidence.strongTerms,
    best: (credit.best ?? '').slice(0, 60),
  }
})
const endToEnd = gated.filter((item) => item.credited === true).length

/* ------------------------------------------------------------- report ----- */

/* Query batch b was generated first and shipped unguarded. Batch a was written
 * against a retrieval check the generator itself ran, and ended up ranked first by
 * every lexical arm on 100% of its turns — it cannot measure a ranking change.
 * They are reported apart so a saturated batch cannot inflate the aggregate. */
const firstBatch = (await readJsonl(QUERY_FILES[0].trim())).length
const batches = { all: [0, queries.length], a: [0, firstBatch], b: [firstBatch, queries.length] }
function metricsSliced(rankings, from, to) {
  const result = { 'R@1': 0, 'R@3': 0, 'R@5': 0, 'R@10': 0, 'MRR@10': 0, misses: 0 }
  const total = to - from
  for (let index = from; index < to; index += 1) {
    const expected = queries[index].id
    const list = rankings[index]
    const rank = list.indexOf(expected)
    if (rank === 0) result['R@1'] += 1
    if (rank >= 0 && rank < 3) result['R@3'] += 1
    if (rank >= 0 && rank < 5) result['R@5'] += 1
    if (rank >= 0 && rank < LIMIT) result['R@10'] += 1
    if (rank >= 0 && rank < 10) result['MRR@10'] += 1 / (rank + 1)
    if (rank < 0 || rank >= LIMIT) result.misses += 1
  }
  for (const key of ['R@1', 'R@3', 'R@5', 'R@10', 'MRR@10']) result[key] = (result[key] / total) * 100
  return result
}

const rows = Object.keys(rankings).map((name) => ({ arm: name, ...metrics(rankings[name]), ms: latency[name] ?? null }))
rows.sort((a, b) => b['MRR@10'] - a['MRR@10'])

const pad = (value, width) => String(value).padStart(width)
console.log(`\nqueries ${queries.length} · corpus ${corpus.length} · limit ${LIMIT}\n`)
console.log('arm              batch  R@1    R@3    R@5   R@10  MRR@10')
for (const name of Object.keys(rankings)) {
  for (const [batch, [from, to]] of Object.entries(batches)) {
    const result = metricsSliced(rankings[name], from, to)
    console.log(`${name.padEnd(15)}${batch.padEnd(7)}${pad(result['R@1'].toFixed(1), 6)}${pad(result['R@3'].toFixed(1), 7)}${pad(result['R@5'].toFixed(1), 7)}${pad(result['R@10'].toFixed(1), 7)}${pad(result['MRR@10'].toFixed(1), 7)}`)
  }
}
console.log('')
console.log('arm              R@1    R@3    R@5   R@10  MRR@10   miss  bytes  ms/q')
for (const row of rows) {
  console.log(
    `${row.arm.padEnd(15)}${pad(row['R@1'].toFixed(1), 7)}${pad(row['R@3'].toFixed(1), 7)}${pad(row['R@5'].toFixed(1), 7)}${pad(row['R@10'].toFixed(1), 7)}${pad(row['MRR@10'].toFixed(1), 7)}${pad(row.misses, 7)}${pad(row.bytes, 7)}${pad(row.ms === null ? '-' : row.ms.toFixed(2), 7)}`
  )
}

/* What each arm knows that the other does not: the case for a hybrid. */
const top = (name) => rankings[name].map((list, index) => list.indexOf(queries[index].id) >= 0)
const cur = top('current')
const den = top('dense')
const both = cur.filter((hit, index) => hit && den[index]).length
const union = cur.filter((hit, index) => hit || den[index]).length
console.log(`\ncurrent ∪ dense found ${union}/${queries.length}; both ${both}; current-only ${cur.filter((hit, index) => hit && !den[index]).length}; dense-only ${den.filter((hit, index) => hit && !cur[index]).length}`)

console.log(`\ngate (>=${MIN_TERMS} strong terms and relevance >=${MIN_SCORE}): ${endToEnd}/${queries.length} would be auto-injected (${((endToEnd / queries.length) * 100).toFixed(1)}%)`)
const evidenceOnly = gated.filter((item) => item.terms >= MIN_TERMS).length
const scoreOnly = gated.filter((item) => item.relevance >= MIN_SCORE).length
console.log(`  evidence alone ${evidenceOnly}/${queries.length} (${((evidenceOnly / queries.length) * 100).toFixed(1)}%) · relevance floor alone ${scoreOnly}/${queries.length} (${((scoreOnly / queries.length) * 100).toFixed(1)}%)`)

/* Missing keys is the extraction-side hypothesis: keys are what the scorer
 * treats as the strongest per-term signal. */
const noKeys = queries.filter((item) => (byId.get(item.id)?.keys ?? []).length === 0)
if (noKeys.length > 0) {
  const hitNoKeys = noKeys.filter((item) => rankings.current[queries.indexOf(item)].includes(item.id)).length
  const withKeys = queries.filter((item) => (byId.get(item.id)?.keys ?? []).length > 0)
  const hitKeys = withKeys.filter((item) => rankings.current[queries.indexOf(item)].includes(item.id)).length
  console.log(`\ntop-${LIMIT} by key coverage: no keys ${hitNoKeys}/${noKeys.length}, with keys ${hitKeys}/${withKeys.length}`)
}

await writeFile(
  join(DATA, 'results.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), queryCount: queries.length, rows, gated, rankings: rankings.current.map((list, index) => ({ id: queries[index].id, query: queries[index].query, current: list, dense: rankings.dense[index], bm25: rankings.bm25[index] })) }, null, 2)
)
