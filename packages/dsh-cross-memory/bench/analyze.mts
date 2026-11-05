/**
 * Why the current arm wins or loses — the diagnosis behind the four-arm numbers.
 *
 * `run-bench.mts` says which arm ranks best. This file asks why, and every
 * section is a change someone could actually make:
 *
 *   fields     — which of the five indexed fields carries the recall
 *   attention  — whether importance × recency moves the right entry up or down
 *   gate       — which half of the injection gate rejects a correct memory
 *   kinds      — which memory kinds the extraction side writes unretrievably
 *   overlap    — how much the query leaks the answer, i.e. how much to discount
 *
 * Usage: node bench/analyze.mts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { relevanceOf, scoreEntry, tokenize, matchCredit, hubTerms } from '../lib/search.js'

const DATA = 'bench/data'
const corpus = JSON.parse(await readFile(join(DATA, 'corpus.json'), 'utf8'))
const queries = (
  await Promise.all(['queries-a.jsonl', 'queries-b.jsonl'].map(async (name) =>
    (await readFile(join(DATA, name), 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
  ))
).flat()

const byId = new Map(corpus.map((entry) => [entry.id, entry]))
const pct = (count) => ((count / queries.length) * 100).toFixed(1).padStart(6)
const ratio = (value) => (value * 100).toFixed(1).padStart(6)

/* ------------------------------------------------------------ ranking ----- */

/** Rank every entry by `key(entry, query)`; returns the target's rank or -1. */
function rankOf(query, key, entries = corpus) {
  const scored = []
  for (const entry of entries) {
    const score = key(entry, query)
    if (score > 0) scored.push({ id: entry.id, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const rank = scored.findIndex((item) => item.id === query.id)
  return rank
}

function evaluate(key, entries = corpus) {
  let hit1 = 0
  let hit10 = 0
  let mrr = 0
  for (const query of queries) {
    const rank = rankOf(query, (entry) => key(entry, query.query), entries)
    if (rank === 0) hit1 += 1
    if (rank >= 0 && rank < 10) hit10 += 1
    if (rank >= 0) mrr += 1 / (rank + 1)
  }
  return { hit1, hit10, mrr: mrr / queries.length }
}

/* ------------------------------------------------------------- fields ----- */

const FIELDS = ['title', 'keys', 'tags', 'appliesTo', 'body']
const strip = (entry, keep) => ({
  ...entry,
  title: keep.has('title') ? entry.title : '',
  keys: keep.has('keys') ? entry.keys : [],
  tags: keep.has('tags') ? entry.tags : [],
  appliesTo: keep.has('appliesTo') ? entry.appliesTo : '',
  body: keep.has('body') ? entry.body : '',
})

console.log('\n[fields] recall when only one field is indexed (relevance only, 732 candidates)')
console.log('field        R@1     R@10    MRR@10')
for (const field of FIELDS) {
  const result = evaluate((entry, query) => relevanceOf(strip(entry, new Set([field])), query))
  console.log(`${field.padEnd(12)}${pct(result.hit1)}%${pct(result.hit10)}%${ratio(result.mrr)}%`)
}
console.log('\n[fields] drop one field from the full index — what the scorer loses without it')
for (const field of FIELDS) {
  const keep = new Set(FIELDS.filter((item) => item !== field))
  const result = evaluate((entry, query) => relevanceOf(strip(entry, keep), query))
  console.log(`without ${field.padEnd(9)} R@1${pct(result.hit1)}%  R@10${pct(result.hit10)}%  MRR${(result.mrr * 100).toFixed(1)}`)
}

/* ---------------------------------------------------------- attention ----- */

console.log('\n[attention] importance × recency vs plain lexical relevance')
const lexicalHit1 = []
const boostedHit1 = []
for (const query of queries) {
  lexicalHit1.push(rankOf(query, (entry) => relevanceOf(entry, query.query)) === 0)
  boostedHit1.push(rankOf(query, (entry) => scoreEntry(entry, query.query)) === 0)
}
const lostToBoost = queries.filter((_, index) => lexicalHit1[index] && !boostedHit1[index])
const gainedFromBoost = queries.filter((_, index) => !lexicalHit1[index] && boostedHit1[index])
console.log(`  top-1 by relevance ${pct(lexicalHit1.filter(Boolean).length)}%  top-1 by score ${pct(boostedHit1.filter(Boolean).length)}%`)
console.log(`  demoted by the attention model: ${lostToBoost.length} · promoted by it: ${gainedFromBoost.length}`)
for (const query of lostToBoost.slice(0, 5)) console.log(`   - ${query.query}`)

/* --------------------------------------------------------------- gate ----- */

const hub = hubTerms(corpus, 0.25)
const MIN_SCORE = 9
const MIN_TERMS = 2
let credited = 0
const reasons = { terms: 0, relevance: 0, both: 0 }
const nearTerms = []
const nearScore = []
for (const query of queries) {
  const entry = byId.get(query.id)
  const credit = matchCredit(entry, query.query, MIN_SCORE, MIN_TERMS, { hub, range: null })
  if (credit.credited) {
    credited += 1
    continue
  }
  const terms = credit.evidence.strongTerms
  const lowTerms = terms < MIN_TERMS
  const lowScore = credit.relevance < MIN_SCORE
  if (lowTerms && lowScore) reasons.both += 1
  else if (lowTerms) reasons.terms += 1
  else reasons.relevance += 1
  if (lowTerms && terms === 1) nearTerms.push({ query: query.query, relevance: credit.relevance.toFixed(1) })
  if (lowScore && credit.relevance >= MIN_SCORE - 4) nearScore.push({ query: query.query, relevance: credit.relevance.toFixed(1), terms })
}
console.log(`\n[gate] credited ${pct(credited)}% (${credited}/${queries.length})`)
console.log(`  rejected on terms only ${reasons.terms} · on relevance only ${reasons.relevance} · on both ${reasons.both}`)
console.log('  one strong term but relevance high enough (a singleTerm escape hatch would admit these):')
for (const item of nearTerms.slice(0, 8)) console.log(`   - ${item.query}  (relevance ${item.relevance})`)
console.log('  relevance near the floor but evidence satisfied:')
for (const item of nearScore.slice(0, 8)) console.log(`   - ${item.query}  (relevance ${item.relevance}, terms ${item.terms})`)

/* --------------------------------------------------------------- kinds ---- */

console.log('\n[kinds] current top-10 recall by memory kind')
const kinds = new Map()
for (const query of queries) {
  const entry = byId.get(query.id)
  const kind = entry.kind ?? 'unknown'
  const bucket = kinds.get(kind) ?? { total: 0, hit: 0, withKeys: 0, hitWithKeys: 0 }
  bucket.total += 1
  const rank = rankOf(query, (candidate) => relevanceOf(candidate, query.query))
  if (rank >= 0 && rank < 10) {
    bucket.hit += 1
    if ((entry.keys ?? []).length > 0) bucket.hitWithKeys += 1
  }
  if ((entry.keys ?? []).length > 0) bucket.withKeys += 1
  kinds.set(kind, bucket)
}
for (const [kind, bucket] of [...kinds.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${kind.padEnd(11)} ${String(bucket.hit).padStart(3)}/${String(bucket.total).padStart(3)}  R@10 ${((bucket.hit / bucket.total) * 100).toFixed(1)}%`)
}

/* ------------------------------------------------------------- overlap ---- */

const df = new Map()
for (const entry of corpus) {
  for (const term of new Set(tokenize(`${entry.title} ${(entry.keys ?? []).join(' ')} ${(entry.tags ?? []).join(' ')} ${entry.appliesTo ?? ''} ${entry.body ?? ''}`))) {
    df.set(term, (df.get(term) ?? 0) + 1)
  }
}
const idf = (term) => Math.log(1 + corpus.length / (df.get(term) ?? corpus.length))
let leakSum = 0
for (const query of queries) {
  const terms = [...new Set(tokenize(query.query))].filter((term) => (df.get(term) ?? 0) > 0)
  if (terms.length === 0) continue
  const target = byId.get(query.id)
  const targetText = tokenize(`${target.title} ${(target.keys ?? []).join(' ')} ${(target.tags ?? []).join(' ')} ${target.appliesTo ?? ''} ${target.body ?? ''}`)
  const targetSet = new Set(targetText)
  const weight = terms.reduce((sum, term) => sum + idf(term), 0)
  const shared = terms.filter((term) => targetSet.has(term)).reduce((sum, term) => sum + idf(term), 0)
  leakSum += shared / (weight || 1)
}
console.log(`\n[overlap] mean IDF-weighted share of query terms present in the target: ${((leakSum / queries.length) * 100).toFixed(1)}%`)
