/**
 * Which part of the shipped scorer costs recall against plain BM25, and does the
 * injector put the right memory in its four slots?
 *
 * `run-bench.mts` says BM25 wins. That number is useless for a fix unless it names
 * the term, so this file reimplements the scorer's arithmetic and asserts it
 * against `relevanceOf` on the full 150×732 grid before trusting anything below.
 * Then it changes one thing at a time:
 *
 *   idf        — corpus-frequency discount on every per-term contribution
 *   length     — the same discount BM25 gets from document length
 *   saturation — BM25's TF curve instead of a flat per-field constant
 *   order      — whether the recall path's decayed-score sort keeps the memory
 *
 * Usage: node bench/ablate.mts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tokenize, relevanceOf, importanceOf, decayOf, matchCredit, hubTerms } from '../lib/search.js'
import { queryMessages } from '../lib/query.js'

const DATA = 'bench/data'
const corpus = JSON.parse(await readFile(join(DATA, 'corpus.json'), 'utf8'))
const queries = (
  await Promise.all(
    ['queries-a.jsonl', 'queries-b.jsonl'].map(async (name) =>
      (await readFile(join(DATA, name), 'utf8'))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
    )
  )
).flat()

/* ---------------------------------------- copy of the scoring path ------- */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu
const WORD = /[a-z0-9_]+/gu
const FIELD_WEIGHTS = { title: 40, keys: 26, tags: 20, appliesTo: 18, body: 12 }
const TERM_WEIGHTS = { title: 8, keys: 7, tags: 6, appliesTo: 5, body: 2 }
const BODY_TERM_CAP = 4

const occurrences = (haystack, needle) => {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
const words = (field) => new Set(field.match(WORD) ?? [])
function termWeight(term) {
  const cjk = (term.match(CJK_CHAR) ?? []).length
  if (cjk === 0) return 1
  return cjk <= 2 ? 0.5 : Math.min(1, 0.5 + (cjk - 2) * 0.15)
}
const isNoise = (token) => (CJK.test(token) ? false : token.length < 2)

/** One entry's fields prepared once: lowercased text, Latin words, token counts. */
const prepared = corpus.map((entry) => {
  const fields = {
    title: entry.title.toLowerCase(),
    body: (entry.body ?? '').toLowerCase(),
    keys: (entry.keys ?? []).join(' ').toLowerCase(),
    tags: (entry.tags ?? []).join(' ').toLowerCase(),
    appliesTo: (entry.appliesTo ?? '').toLowerCase(),
  }
  const wordSets = {
    title: words(fields.title),
    body: words(fields.body),
    keys: words(fields.keys),
    tags: words(fields.tags),
    appliesTo: words(fields.appliesTo),
  }
  const length = Object.values(fields).reduce((sum, text) => sum + tokenize(text).length, 0)
  return { fields, wordSets, length }
})
const averageLength = prepared.reduce((sum, item) => sum + item.length, 0) / prepared.length
const matches = (field, fieldWords, term) => (CJK.test(term) ? field.includes(term) : fieldWords.has(term))

/** The shipped score for one already-extracted query string (evidence omitted). */
function shipped(at, normalized, idfAt = () => 1) {
  const { fields, wordSets } = prepared[at]
  let score = 0
  if (matches(fields.title, wordSets.title, normalized)) score += FIELD_WEIGHTS.title
  if (matches(fields.keys, wordSets.keys, normalized)) score += FIELD_WEIGHTS.keys
  if (matches(fields.tags, wordSets.tags, normalized)) score += FIELD_WEIGHTS.tags
  if (matches(fields.appliesTo, wordSets.appliesTo, normalized)) score += FIELD_WEIGHTS.appliesTo
  if (matches(fields.body, wordSets.body, normalized)) score += FIELD_WEIGHTS.body
  const lengthNorm = lengthFactor(at)
  for (const term of tokenize(normalized)) {
    if (isNoise(term)) continue
    const weight = termWeight(term) * idfAt(term)
    if (matches(fields.title, wordSets.title, term)) score += (TERM_WEIGHTS.title + (CJK.test(term) ? 0 : occurrences(fields.title, term))) * weight
    if (matches(fields.keys, wordSets.keys, term)) score += TERM_WEIGHTS.keys * weight
    if (matches(fields.tags, wordSets.tags, term)) score += TERM_WEIGHTS.tags * weight
    if (matches(fields.appliesTo, wordSets.appliesTo, term)) score += TERM_WEIGHTS.appliesTo * weight
    score += Math.min(BODY_TERM_CAP, occurrences(fields.body, term)) * TERM_WEIGHTS.body * weight * lengthNorm
  }
  return score
}

/** BM25 document-length factor, applied only to the body term (see `variants`). */
let lengthNormalization = false
const lengthFactor = (at) => (lengthNormalization ? 1 / (1 - 0.75 + (0.75 * prepared[at].length) / averageLength) : 1)

/** The shipped turn-level wrapper: best sentence wins, two mentions earn 15%. */
function shippedTurn(at, query, idfAt = () => 1) {
  let bestScore = 0
  let mentions = 0
  for (const message of queryMessages(query)) {
    const score = shipped(at, message, idfAt)
    if (score > 0) mentions += 1
    if (score > bestScore) bestScore = score
  }
  if (bestScore === 0) return 0
  return bestScore * Math.min(1.15, 1 + (mentions - 1) * 0.15)
}

/* ----------------------------------------------------------- the check --- */

const baseline = queries.map((query) => corpus.map((_entry, at) => relevanceOf(corpus[at], query.query)))
let mismatches = 0
let worst = 0
for (let q = 0; q < queries.length; q += 1) {
  for (let at = 0; at < corpus.length; at += 1) {
    const delta = Math.abs(shippedTurn(at, queries[q].query) - baseline[q][at])
    if (delta > 1e-9) {
      mismatches += 1
      worst = Math.max(worst, delta)
    }
  }
}
console.log(`copy check: ${queries.length * corpus.length} pairs, ${mismatches} mismatches (worst ${worst.toFixed(3)})`)
if (mismatches > 0) {
  console.log('ABORT: the copy does not reproduce relevanceOf; everything below would be fiction.')
  process.exit(1)
}

/* ------------------------------------------------------- document stats --- */

const N = corpus.length
const df = new Map()
for (const { fields } of prepared) {
  const seen = new Set()
  for (const text of Object.values(fields)) for (const term of tokenize(text)) seen.add(term)
  for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1)
}
const idfOf = (term) => Math.log(1 + N / (df.get(term) ?? N))
/* A term in a quarter of the store is the reference: factor 1.0, so the existing
 * score scale, and the recall gate's absolute thresholds, stay meaningful. */
const REFERENCE_IDF = Math.log(5)

/* ------------------------------------------------------------- variants --- */

const K1 = 1.2
const B = 0.75

/** BM25 TF saturation with the plugin's per-field term weights kept. */
function fieldWeighted(at, normalized, { idf = true, phrase = true, saturation = true, flatWeight = false } = {}) {
  const { fields, wordSets } = prepared[at]
  let score = 0
  if (phrase) {
    if (matches(fields.title, wordSets.title, normalized)) score += FIELD_WEIGHTS.title
    if (matches(fields.keys, wordSets.keys, normalized)) score += FIELD_WEIGHTS.keys
    if (matches(fields.tags, wordSets.tags, normalized)) score += FIELD_WEIGHTS.tags
    if (matches(fields.appliesTo, wordSets.appliesTo, normalized)) score += FIELD_WEIGHTS.appliesTo
    if (matches(fields.body, wordSets.body, normalized)) score += FIELD_WEIGHTS.body
  }
  const lengthScale = 1 - B + (B * prepared[at].length) / averageLength
  for (const term of tokenize(normalized)) {
    if (isNoise(term)) continue
    const factor = (idf ? idfOf(term) / REFERENCE_IDF : 1) * (flatWeight ? 1 : termWeight(term)) * 3
    for (const field of ['title', 'keys', 'tags', 'appliesTo', 'body']) {
      if (!matches(fields[field], wordSets[field], term)) continue
      const tf = field === 'body' ? Math.min(BODY_TERM_CAP, occurrences(fields.body, term)) : 1
      const saturated = saturation ? (tf * (K1 + 1)) / (tf + K1 * lengthScale) : tf
      score += TERM_WEIGHTS[field] * factor * saturated
    }
  }
  return score
}

function fieldWeightedTurn(at, query, options) {
  let bestScore = 0
  let mentions = 0
  for (const message of queryMessages(query)) {
    const score = fieldWeighted(at, message, options)
    if (score > 0) mentions += 1
    if (score > bestScore) bestScore = score
  }
  if (bestScore === 0) return 0
  return bestScore * Math.min(1.15, 1 + (mentions - 1) * 0.15)
}

/** Plain Okapi BM25 over title×2 + keys×2 + tags + appliesTo + body. */
const bm25Docs = corpus.map((entry) => {
  const text = [entry.title, entry.title, (entry.keys ?? []).join(' '), (entry.keys ?? []).join(' '), (entry.tags ?? []).join(' '), entry.appliesTo ?? '', entry.body ?? ''].join('\n').toLowerCase()
  const terms = tokenize(text)
  const tf = new Map()
  for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1)
  return { tf, length: terms.length }
})
const bm25Df = new Map()
for (const doc of bm25Docs) for (const term of doc.tf.keys()) bm25Df.set(term, (bm25Df.get(term) ?? 0) + 1)
const bm25Avg = bm25Docs.reduce((sum, doc) => sum + doc.length, 0) / bm25Docs.length
function bm25(at, query, withTermWeight = false, noIdf = false, noLengthNorm = false) {
  const doc = bm25Docs[at]
  let score = 0
  for (const term of new Set(tokenize(query.toLowerCase()))) {
    const frequency = doc.tf.get(term)
    if (frequency === undefined) continue
    const df = bm25Df.get(term)
    const idf = noIdf ? 1 : Math.log(1 + (N - df + 0.5) / (df + 0.5))
    const scale = noLengthNorm ? 1 : 1 - B + (B * doc.length) / bm25Avg
    score += idf * ((frequency * (K1 + 1)) / (frequency + K1 * scale)) * (withTermWeight ? termWeight(term) : 1)
  }
  return score
}

/** Rank every entry, return the target's 0-based rank and the top-4 set. */
function scoreMatrix(key) {
  return queries.map((query) => corpus.map((_entry, at) => key(at, query.query)))
}

function evaluate(scores, from = 0, to = queries.length) {
  let hit1 = 0
  let hit4 = 0
  let hit10 = 0
  let mrr = 0
  for (let q = from; q < to; q += 1) {
    const order = scores[q].map((score, at) => ({ id: corpus[at].id, score })).filter((item) => item.score > 0)
    order.sort((a, b) => b.score - a.score)
    const rank = order.findIndex((item) => item.id === queries[q].id)
    if (rank === 0) hit1 += 1
    if (rank >= 0 && rank < 4) hit4 += 1
    if (rank >= 0 && rank < 10) hit10 += 1
    if (rank >= 0) mrr += 1 / (rank + 1)
  }
  const count = to - from
  return { hit1: hit1 / count, hit4: hit4 / count, hit10: hit10 / count, mrr: mrr / count }
}

const termMatrices = new Map()
const add = (name, scores) => termMatrices.set(name, scores)
const pct = (value) => (value * 100).toFixed(1).padStart(6)

lengthNormalization = false
add('current', baseline)
add('current×idf', scoreMatrix((at, query) => shippedTurn(at, query, (term) => idfOf(term) / REFERENCE_IDF)))
add('current×idf²', scoreMatrix((at, query) => shippedTurn(at, query, (term) => (idfOf(term) / REFERENCE_IDF) ** 2)))
lengthNormalization = true
add('current×idf²+len', scoreMatrix((at, query) => shippedTurn(at, query, (term) => (idfOf(term) / REFERENCE_IDF) ** 2)))
lengthNormalization = false
add('fieldw, no idf', scoreMatrix((at, query) => fieldWeightedTurn(at, query, { idf: false })))
add('fieldw, no phrase', scoreMatrix((at, query) => fieldWeightedTurn(at, query, { phrase: false })))
add('fieldw, no sat', scoreMatrix((at, query) => fieldWeightedTurn(at, query, { saturation: false })))
add('fieldw (candidate)', scoreMatrix((at, query) => fieldWeightedTurn(at, query)))
add('fieldw, weight≡1', scoreMatrix((at, query) => fieldWeightedTurn(at, query, { idf: true, flatWeight: true })))
add('bm25 (reference)', scoreMatrix((at, query) => bm25(at, query)))
add('bm25×termWeight', scoreMatrix((at, query) => bm25(at, query, true)))
add('bm25, no idf', scoreMatrix((at, query) => bm25(at, query, false, true)))
add('bm25, no len norm', scoreMatrix((at, query) => bm25(at, query, false, false, true)))

const batchA = (await readFile(join(DATA, 'queries-a.jsonl'), 'utf8')).split('\n').filter((line) => line.trim().length > 0).length
console.log('\n[terms] all / a (generator-tuned) / b (unguarded)')
console.log('variant             batch   R@1     R@4     R@10   MRR@10')
for (const [name, scores] of termMatrices) {
  for (const [batch, [from, to]] of Object.entries({ all: [0, queries.length], a: [0, batchA], b: [batchA, queries.length] })) {
    const result = evaluate(scores, from, to)
    console.log(`${name.padEnd(20)}${batch.padEnd(7)}${pct(result.hit1)}%${pct(result.hit4)}%${pct(result.hit10)}%${pct(result.mrr)}%`)
  }
}

/* ------------------------------------------------------------- ordering --- */

/* The recall path sorts candidates it has ALREADY credited by the decayed score.
 * So the question is narrower than the earlier all-732 comparison: among the
 * entries that cleared the gate, does that sort keep the right one first and in
 * the four slots the block may fill? */
const hub = hubTerms(corpus, 0.25)
const MIN_SCORE = 9
const MIN_TERMS = 2
const eligiblePerQuery = queries.map((query) => {
  const eligible = []
  for (let at = 0; at < corpus.length; at += 1) {
    const credit = matchCredit(corpus[at], query.query, MIN_SCORE, MIN_TERMS, { hub, range: null })
    if (credit.about) eligible.push({ at, relevance: credit.relevance, score: credit.score })
  }
  return eligible
})
const sizes = eligiblePerQuery.map((list) => list.length)
const multi = sizes.filter((size) => size > 1).length
const orderings = {
  'by relevance': (list) => [...list].sort((a, b) => b.relevance - a.relevance),
  'relevance×decay^0.25': (list) => [...list].sort((a, b) => b.relevance * decayOf(corpus[b.at]) ** 0.25 - a.relevance * decayOf(corpus[a.at]) ** 0.25),
  'relevance×decay^0.5': (list) => [...list].sort((a, b) => b.relevance * decayOf(corpus[b.at]) ** 0.5 - a.relevance * decayOf(corpus[a.at]) ** 0.5),
  'by decayed score (shipped)': (list) => [...list].sort((a, b) => b.score - a.score),
}
console.log(`\n[ordering] eligible sets: mean ${(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(2)}, singleton ${sizes.filter((s) => s === 1).length}, multi ${multi}`)
const firstBatch = (await readFile(join(DATA, 'queries-a.jsonl'), 'utf8')).split('\n').filter((line) => line.trim().length > 0).length
const scopeOf = (batch) => (batch === 'all' ? [0, queries.length] : batch === 'a' ? [0, firstBatch] : [firstBatch, queries.length])
console.log('ordering                     batch  target first   target in first 4')
for (const [name, sort] of Object.entries(orderings)) {
  for (const batch of ['all', 'a', 'b']) {
    const [from, to] = scopeOf(batch)
    let first = 0
    let inFour = 0
    for (let q = from; q < to; q += 1) {
      const sorted = sort(eligiblePerQuery[q])
      if (sorted[0]?.at !== undefined && corpus[sorted[0].at].id === queries[q].id) first += 1
      if (sorted.slice(0, 4).some((item) => corpus[item.at].id === queries[q].id)) inFour += 1
    }
    console.log(`${name.padEnd(28)}${batch.padEnd(7)}${pct(first / (to - from))}%${pct(inFour / (to - from)).padStart(18)}%`)
  }
}

/* Of the multi-entry sets, how often does the two orderings actually disagree on
 * the first slot — the sort only costs anything when it has a choice. */
let disagree = 0
let lost = 0
for (let q = 0; q < queries.length; q += 1) {
  const list = eligiblePerQuery[q]
  if (list.length < 2) continue
  const byRelevance = orderings['by relevance'](list)[0]
  const byScore = orderings['by decayed score (shipped)'](list)[0]
  if (byRelevance.at === byScore.at) continue
  disagree += 1
  if (corpus[byRelevance.at].id === queries[q].id) lost += 1
}
console.log(`multi-entry sets where the two orderings pick different firsts: ${disagree}; the shipped one drops the right memory in ${lost}`)
