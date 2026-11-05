/**
 * Sensitivity audit of the BM25 bench arm.
 *
 * The question this file exists to answer: is "BM25 scores R@1 88.0" a plateau
 * of the method, or one lucky point in (k1, b, field duplication)? It rebuilds
 * the arm from bench/data only, sweeps the grid, checks the tokenizer the arm is
 * allowed to use, tries a second corpus, and prints the per-query disagreements
 * with the shipped scorer so the reason each one flips can be read off.
 *
 * Nothing here writes under src/, lib/ or bench/data/.
 *
 * Usage: node bench/sensitivity.mjs
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { tokenize, termWeight, searchMemories, explainEntry, matchCredit, hubTerms } from '../lib/search.js'
import { MemoryStore } from '../lib/storage.js'

const HERE = import.meta.dirname
const DATA = join(HERE, 'data')

const readJson = async (name) => JSON.parse(await readFile(join(DATA, name), 'utf8'))
const readJsonl = async (name) =>
  (await readFile(join(DATA, name), 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))

const corpus = await readJson('corpus.json')
const queriesA = await readJsonl('queries-a.jsonl')
const queriesB = await readJsonl('queries-b.jsonl')
const queries = [...queriesA, ...queriesB]
const shipped = await readJson('results.json')
const byId = new Map(corpus.map((entry) => [entry.id, entry]))

const pct = (value) => (value).toFixed(1)
const pad = (value, width) => String(value).padStart(width)
const line = (left, width = 20) => String(left).padEnd(width)

console.log('\n=== snapshot: exact inputs this run read (pin the report to these) ===')
for (const name of ['corpus.json', 'queries-a.jsonl', 'queries-b.jsonl', 'results.json']) {
  const path = join(DATA, name)
  const bytes = await readFile(path)
  const info = await stat(path)
  console.log(`  ${name.padEnd(16)} sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}  ${String(bytes.length).padStart(7)} B  mtime ${info.mtime.toISOString()}`)
}
console.log(`  results.json generatedAt ${shipped.generatedAt} · queryCount ${shipped.queryCount} · files read ${queries.length} queries`)
const libraryPath = join(HERE, '..', 'lib', 'search.js')
const libraryBytes = await readFile(libraryPath)
const libraryInfo = await stat(libraryPath)
console.log(`  lib/search.js    sha256 ${createHash('sha256').update(libraryBytes).digest('hex').slice(0, 16)}  ${String(libraryBytes.length).padStart(7)} B  mtime ${libraryInfo.mtime.toISOString()}`)

/* ============================================================ BM25 arm ==== */

/**
 * Field duplication recipes. `current` is exactly what run-bench.mjs builds:
 * title twice, keys twice, tags once, appliesTo once, body once, joined by
 * newlines so the tokenizer cannot merge across fields.
 */
const RECIPES = {
  none: { label: 'none', title: 1, keys: 1, tags: 1, appliesTo: 1, body: 1 },
  current: { label: 'title×2+keys×2 (current)', title: 2, keys: 2, tags: 1, appliesTo: 1, body: 1 },
  title3: { label: 'title×3+keys×2+tags×2', title: 3, keys: 2, tags: 2, appliesTo: 1, body: 1 },
  appliesTo2: { label: 'appliesTo×2', title: 1, keys: 1, tags: 1, appliesTo: 2, body: 1 },
}
const FIELDS = ['title', 'keys', 'tags', 'appliesTo', 'body']

/** The document text for one recipe, in the same field order run-bench uses. */
function docText(entry, recipe) {
  const parts = []
  for (const field of FIELDS) {
    const value = entry[field]
    const repeats = recipe[field]
    if (Array.isArray(value)) {
      for (let repeat = 0; repeat < repeats; repeat += 1) for (const item of value) parts.push(String(item))
    } else if (typeof value === 'string' && value.length > 0) {
      for (let repeat = 0; repeat < repeats; repeat += 1) parts.push(value)
    }
  }
  return parts.join('\n')
}

function buildIndex(entries, recipe, tokenizer) {
  const docs = entries.map((entry) => {
    const terms = tokenizer(docText(entry, recipe))
    const tf = new Map()
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1)
    return { id: entry.id, tf, length: terms.length }
  })
  const postings = new Map()
  let totalLength = 0
  for (let index = 0; index < docs.length; index += 1) {
    totalLength += docs[index].length
    for (const [term, frequency] of docs[index].tf) {
      let posting = postings.get(term)
      if (posting === undefined) {
        posting = { df: 0, list: [] }
        postings.set(term, posting)
      }
      posting.df += 1
      posting.list.push([index, frequency])
    }
  }
  return {
    entries,
    docs,
    postings,
    N: docs.length,
    avgLength: docs.length === 0 ? 1 : totalLength / docs.length,
  }
}

const queryTerms = (query, tokenizer) => [...new Set(tokenizer(query))]

/**
 * One BM25 cell. `weight` is the per-term multiplier; a plain BM25 uses 1 for
 * every term, the plugin-tokenizer fairness check passes termWeight so CJK
 * bigrams carry the same half weight they carry inside the shipped scorer.
 */
function rankBm25(index, terms, k1, b, { weight = () => 1 } = {}) {
  const { docs, postings, N, avgLength } = index
  const scores = new Float64Array(N)
  for (const term of terms) {
    const posting = postings.get(term)
    if (posting === undefined) continue
    const idf = Math.log(1 + (N - posting.df + 0.5) / (posting.df + 0.5))
    const factor = weight(term)
    if (factor === 0) continue
    for (const [docIndex, frequency] of posting.list) {
      scores[docIndex] +=
        factor * idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * docs[docIndex].length) / avgLength)))
    }
  }
  const order = []
  for (let index = 0; index < N; index += 1) if (scores[index] > 0) order.push(index)
  // Stable in the same sense run-bench is: ties keep corpus order.
  order.sort((left, right) => scores[right] - scores[left] || left - right)
  return { order, scores }
}

/** R@1 / R@10 / MRR@10 over the 150 queries. Rankings hold entry ids. */
function evaluate(rankings, queryList = queries) {
  let hit1 = 0
  let hit10 = 0
  let mrr = 0
  for (let index = 0; index < queryList.length; index += 1) {
    const rank = rankings[index].indexOf(queryList[index].id)
    if (rank === 0) hit1 += 1
    if (rank >= 0 && rank < 10) hit10 += 1
    if (rank >= 0 && rank < 10) mrr += 1 / (rank + 1)
  }
  const total = queryList.length
  return { R1: (hit1 / total) * 100, R10: (hit10 / total) * 100, MRR: (mrr / total) * 100 }
}

const K1S = [0.9, 1.2, 1.6, 2.0]
const BS = [0.3, 0.5, 0.75, 0.9]

console.log('\n=== 0. sanity: rebuild the shipped baseline cell and diff against results.json ===')
const baselineIndex = buildIndex(corpus, RECIPES.current, tokenize)
const baselineTerms = queries.map((item) => queryTerms(item.query, tokenize))
const baselineRankings = baselineTerms.map((terms) =>
  rankBm25(baselineIndex, terms, 1.2, 0.75).order.slice(0, 10).map((index) => corpus[index].id),
)
let sameTop10 = 0
for (let index = 0; index < queries.length; index += 1) {
  if (baselineRankings[index].join('|') === shipped.rankings[index].bm25.join('|')) sameTop10 += 1
}
const baselineMetrics = evaluate(baselineRankings)
console.log(`rebuilt (k1=1.2 b=0.75, title×2+keys×2) : R@1 ${pct(baselineMetrics.R1)}  R@10 ${pct(baselineMetrics.R10)}  MRR@10 ${pct(baselineMetrics.MRR)}`)
const shippedBm25 = shipped.rows.find((row) => row.arm === 'bm25')
const shippedCurrent = shipped.rows.find((row) => row.arm === 'current')
console.log(`results.json bm25 row                   : R@1 ${pct(shippedBm25['R@1'])}  R@10 ${pct(shippedBm25['R@10'])}  MRR@10 ${pct(shippedBm25['MRR@10'])}`)
console.log(`top-10 lists identical: ${sameTop10}/${queries.length}`)
console.log(`results.json current (shipped scorer)   : R@1 ${pct(shippedCurrent['R@1'])}  R@10 ${pct(shippedCurrent['R@10'])}  MRR@10 ${pct(shippedCurrent['MRR@10'])}`)

/* ===================================================== 1. parameter sweep == */

console.log('\n=== 1. sweep: k1 × b × field duplication (64 cells) ===')
const cells = []
for (const [key, recipe] of Object.entries(RECIPES)) {
  const index = buildIndex(corpus, recipe, tokenize)
  for (const k1 of K1S) {
    for (const b of BS) {
      const rankings = baselineTerms.map((terms) =>
        rankBm25(index, terms, k1, b).order.slice(0, 10).map((docIndex) => corpus[docIndex].id),
      )
      cells.push({ key, recipe, k1, b, ...evaluate(rankings) })
    }
  }
}

for (const [key, recipe] of Object.entries(RECIPES)) {
  console.log(`\nrecipe ${key}: ${recipe.label}  [title ${recipe.title}× · keys ${recipe.keys}× · tags ${recipe.tags}× · appliesTo ${recipe.appliesTo}× · body ${recipe.body}×]`)
  console.log(`  ${line('k1 \\ b', 8)}${BS.map((b) => pad(`b=${b}`, 15)).join('')}`)
  for (const k1 of K1S) {
    const row = BS.map((b) => {
      const cell = cells.find((item) => item.key === key && item.k1 === k1 && item.b === b)
      return pad(`${pct(cell.R1)} / ${pct(cell.MRR)}`, 15)
    }).join('')
    console.log(`  ${line(`k1=${k1}`, 8)}${row}`)
  }
}

const byR1 = [...cells].sort((left, right) => right.R1 - left.R1 || right.MRR - left.MRR)
const best = byR1[0]
const worst = byR1[byR1.length - 1]
const R1S = cells.map((cell) => cell.R1)
const MRRS = cells.map((cell) => cell.MRR)
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
console.log('\nsweep summary (R@1, 64 cells):')
console.log(`  min ${pct(Math.min(...R1S))} · max ${pct(Math.max(...R1S))} · mean ${pct(mean(R1S))} · stdev ${pct(Math.sqrt(mean(R1S.map((v) => (v - mean(R1S)) ** 2))))}`)
console.log(`  cells at R@1 >= 88.0: ${R1S.filter((value) => value >= 88).length}/64`)
console.log(`  cells at R@1 >= 87.3 (within 1 point): ${R1S.filter((value) => value >= 87.3).length}/64`)
console.log(`  cells at R@1 >= 86.7 (the baseline cell on these queries): ${R1S.filter((value) => value >= 86.7).length}/64`)
console.log(`  cells at R@1 >= 85.3 (within 1.5 of the shipped scorer): ${R1S.filter((value) => value >= 85.3).length}/64`)
console.log(`  MRR@10 range ${pct(Math.min(...MRRS))} – ${pct(Math.max(...MRRS))}, mean ${pct(mean(MRRS))}`)
console.log(`  best cell : ${best.key} k1=${best.k1} b=${best.b}  R@1 ${pct(best.R1)}  MRR@10 ${pct(best.MRR)}`)
console.log(`  worst cell: ${worst.key} k1=${worst.k1} b=${worst.b}  R@1 ${pct(worst.R1)}  MRR@10 ${pct(worst.MRR)}`)
console.log('  top 5 cells:')
for (const cell of byR1.slice(0, 5)) console.log(`    ${line(`${cell.key} k1=${cell.k1} b=${cell.b}`, 40)} R@1 ${pct(cell.R1)}  MRR@10 ${pct(cell.MRR)}`)
console.log('  bottom 5 cells:')
for (const cell of byR1.slice(-5)) console.log(`    ${line(`${cell.key} k1=${cell.k1} b=${cell.b}`, 40)} R@1 ${pct(cell.R1)}  MRR@10 ${pct(cell.MRR)}`)

console.log('\nper recipe, best cell:')
for (const key of Object.keys(RECIPES)) {
  const scoped = cells.filter((cell) => cell.key === key).sort((left, right) => right.R1 - left.R1 || right.MRR - left.MRR)
  const top = scoped[0]
  console.log(`  ${line(top.recipe.label, 30)} best R@1 ${pct(top.R1)} @ k1=${top.k1} b=${top.b} · MRR@10 ${pct(top.MRR)}`)
}

/* ================================================== 2. tokenizer fairness === */

console.log('\n=== 2. tokenizer fairness (best cell above) ===')
const bestIndex = buildIndex(corpus, RECIPES[best.key], tokenize)
const bestRecipeLabel = best.recipe.label
const bestTerms = queries.map((item) => queryTerms(item.query, tokenize))
const bestFull = bestTerms.map((terms) => rankBm25(bestIndex, terms, best.k1, best.b).order)
const baselineFull = baselineTerms.map((terms) => rankBm25(baselineIndex, terms, 1.2, 0.75).order)
const fullCurrent = queries.map((item) =>
  searchMemories([{ scope: 'global', label: 'global', entries: corpus }], item.query, { limit: corpus.length }).map((hit) => hit.entry.id),
)

/** Naive split: whitespace/punctuation only. A Chinese run is one indivisible token. */
const naiveTokenize = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/gu).filter(Boolean)
const naiveIndex = buildIndex(corpus, RECIPES[best.key], naiveTokenize)
const naiveTerms = queries.map((item) => queryTerms(item.query, naiveTokenize))
const naiveRankings = naiveTerms.map((terms) =>
  rankBm25(naiveIndex, terms, best.k1, best.b).order.slice(0, 10).map((index) => corpus[index].id),
)
const naiveMetrics = evaluate(naiveRankings)

const weightedRankings = baselineTerms.map((terms) =>
  rankBm25(bestIndex, terms, best.k1, best.b, { weight: termWeight }).order.slice(0, 10).map((index) => corpus[index].id),
)
const weightedMetrics = evaluate(weightedRankings)

const unmatchedRate = (index, termLists) => {
  let total = 0
  let matched = 0
  for (const terms of termLists) {
    for (const term of terms) {
      total += 1
      if (index.postings.has(term)) matched += 1
    }
  }
  return { total, matched, rate: total === 0 ? 0 : (matched / total) * 100 }
}
const pluginMatch = unmatchedRate(bestIndex, baselineTerms)
const naiveMatch = unmatchedRate(naiveIndex, naiveTerms)

console.log(`best cell: ${best.key} k1=${best.k1} b=${best.b} (${bestRecipeLabel})`)
console.log(`  (a) plugin tokenize (same tokenizer the shipped scorer uses): R@1 ${pct(best.R1)}  MRR@10 ${pct(best.MRR)}`)
console.log(`  (b) naive whitespace/punctuation split                      : R@1 ${pct(naiveMetrics.R1)}  MRR@10 ${pct(naiveMetrics.MRR)}  R@10 ${pct(naiveMetrics.R10)}`)
console.log(`  (c) plugin tokenize + plugin termWeight (CJK bigram ×0.5)   : R@1 ${pct(weightedMetrics.R1)}  MRR@10 ${pct(weightedMetrics.MRR)}  R@10 ${pct(weightedMetrics.R10)}`)
console.log(`  query terms with a posting in the corpus: plugin tokenizer ${pct(pluginMatch.rate)}% (${pluginMatch.matched}/${pluginMatch.total}) · naive split ${pct(naiveMatch.rate)}% (${naiveMatch.matched}/${naiveMatch.total})`)

console.log('\nquery-batch split (75 queries per batch):')
for (const [name, offset, list] of [['queries-a', 0, queriesA], ['queries-b', queriesA.length, queriesB]]) {
  const rankOf = (full, item, position) => full[offset + position].findIndex((docIndex) => corpus[docIndex].id === item.id)
  const pluginRanks = list.map((item, position) => fullCurrent[offset + position].indexOf(item.id))
  const baselineMetrics = evaluateRanks(list.map((item, position) => rankOf(baselineFull, item, position)), list)
  const bestMetrics = evaluateRanks(list.map((item, position) => rankOf(bestFull, item, position)), list)
  const pluginMetrics = evaluateRanks(pluginRanks, list)
  console.log(`  ${name}: bm25 baseline R@1 ${pct(baselineMetrics.R1)} MRR@10 ${pct(baselineMetrics.MRR)} · bm25 best R@1 ${pct(bestMetrics.R1)} MRR@10 ${pct(bestMetrics.MRR)} · shipped ${pct(pluginMetrics.R1)} / ${pct(pluginMetrics.MRR)}`)
}

function evaluateRanks(ranks, list) {
  let hit1 = 0
  let mrr = 0
  for (let index = 0; index < list.length; index += 1) {
    if (ranks[index] === 0) hit1 += 1
    if (ranks[index] >= 0 && ranks[index] < 10) mrr += 1 / (ranks[index] + 1)
  }
  return { R1: (hit1 / list.length) * 100, MRR: (mrr / list.length) * 100 }
}

/* ===================================================== 3. second corpus ==== */

console.log('\n=== 3. second corpus: project scopes under ~/.dsh/memories/projects ===')
const memoriesDir = join(homedir(), '.dsh', 'memories')
const projectsDir = join(memoriesDir, 'projects')
const store = new MemoryStore(memoriesDir)
const scopes = []
const dirents = await readdir(projectsDir, { withFileTypes: true })
for (const dirent of dirents) {
  if (!dirent.isDirectory()) continue
  const dir = join(projectsDir, dirent.name)
  let root
  try {
    root = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')).root
  } catch {
    root = undefined
  }
  let files = []
  try {
    files = (await readdir(join(dir, 'entries'))).filter((name) => name.endsWith('.md'))
  } catch {
    files = []
  }
  let entries = []
  if (root !== undefined) {
    try {
      entries = await store.list('project', root, { fresh: true })
    } catch {
      entries = []
    }
  }
  // Entry ids for coverage: index.json is authoritative; otherwise the
  // frontmatter `id:` is (file names can be truncated for long ids).
  let ids = new Set()
  let idSource = 'none'
  try {
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
    for (const item of index.entries ?? []) if (typeof item?.id === 'string') ids.add(item.id)
    if (ids.size > 0) idSource = 'index.json'
  } catch {
    ids = new Set()
  }
  if (ids.size === 0 && files.length > 0) {
    for (const name of files) {
      try {
        const text = await readFile(join(dir, 'entries', name), 'utf8')
        const match = /^id:\s*(.+)$/mu.exec(text)
        ids.add(match === null ? name.slice(0, -3) : match[1].trim())
      } catch {
        ids.add(name.slice(0, -3))
      }
    }
    idSource = 'frontmatter'
  }
  const idsFromFiles = new Set(files.map((name) => name.slice(0, -3)))
  // Confirm "entry file name is entry id" on the scopes that can be listed.
  let nameMismatch = 0
  for (const entry of entries) if (!idsFromFiles.has(entry.id)) nameMismatch += 1
  scopes.push({ slug: dirent.name, root, count: entries.length > 0 ? entries.length : files.length, entries, ids, idSource, nameMismatch })
}
scopes.sort((left, right) => right.count - left.count)
const targets = new Set(queries.map((item) => item.id))
const coverage = (ids) => [...targets].filter((id) => ids.has(id)).length
console.log(`scopes ${scopes.length} · largest: ${scopes[0].slug} (${scopes[0].count} entries)`)
console.log('top 5 scopes by size and target coverage:')
for (const scope of scopes.slice(0, 5)) {
  console.log(`  ${line(scope.slug, 38)} ${pad(scope.count, 4)} entries · ${coverage(scope.ids)}/150 targets here · ids from ${scope.idSource}`)
}
const unionFound = scopes.flatMap((scope) => [...targets].filter((id) => scope.ids.has(id)))
console.log(`targets present in at least one project scope: ${new Set(unionFound).size}/150 (${[new Set(unionFound)].map((set) => [...set].join(', '))[0]})`)
const largest = scopes[0]
console.log(`file-name / frontmatter-id mismatches in the largest scope: ${largest.nameMismatch}`)

// Evaluate every query against the largest scope with both arms, and report
// only the queries whose target actually exists there.
if (largest.count > 0) {
  const largestEntries = largest.entries
  if (largestEntries.length === 0) {
    console.log('largest scope could not be listed through MemoryStore — no per-query score computed')
  } else {
    const present = queries.filter((item) => largest.ids.has(item.id))
    console.log(`queries whose target is in the largest scope: ${present.length}/150`)
    if (present.length === 0) {
      console.log('R@10 / MRR for either arm is undefined here: no target exists in this corpus, so this test cannot rank anything.')
    } else {
      const projectIndex = buildIndex(largestEntries, RECIPES[best.key], tokenize)
      for (const [name, run] of [
        ['shipped current', (query) => {
          const full = searchMemories([{ scope: 'project', label: 'project', entries: largestEntries }], query, { limit: largestEntries.length })
          return full.findIndex((hit) => hit.entry.id === query.id)
        }],
        ['bm25 best cell', (query) => {
          const ranking = rankBm25(projectIndex, queryTerms(query.query, tokenize), best.k1, best.b).order
          return ranking.findIndex((docIndex) => largestEntries[docIndex].id === query.id)
        }],
      ]) {
        const ranks = present.map((item) => run(item.query))
        const metrics = evaluateRanks(ranks, present)
        console.log(`  ${line(name, 18)} R@10 ${pct(metrics.R1)}  MRR ${pct(metrics.MRR)} (n=${present.length})`)
      }
    }
  }
}

// Supplementary: the few targets that exist in a different project scope.
const otherScope = scopes.find((scope) => scope.slug !== largest.slug && scope.entries.length > 0 && coverage(scope.ids) > 0)
if (otherScope !== undefined) {
  const hitIds = [...targets].filter((id) => otherScope.ids.has(id))
  console.log(`supplementary: ${otherScope.slug} contains ${hitIds.length} target(s): ${hitIds.join(', ')}`)
  if (otherScope.entries.length > 0) {
    const otherIndex = buildIndex(otherScope.entries, RECIPES[best.key], tokenize)
    for (const id of hitIds) {
      const item = queries.find((query) => query.id === id)
      const current = searchMemories([{ scope: 'project', label: 'project', entries: otherScope.entries }], item.query, { limit: otherScope.entries.length })
      const currentRank = current.findIndex((hit) => hit.entry.id === id)
      const bm25Order = rankBm25(otherIndex, queryTerms(item.query, tokenize), best.k1, best.b).order
      const bm25Rank = bm25Order.findIndex((docIndex) => otherScope.entries[docIndex].id === id)
      console.log(`  n=1, no inferential claim: ${id}`)
      console.log(`    shipped current rank ${currentRank} · bm25 best-cell rank ${bm25Rank} (corpus ${otherScope.entries.length})`)
    }
  }
}

/* ======================================================== 4. taxonomy ===== */

console.log('\n=== 4. disagreement taxonomy (results.json ranking lists, top 10) ===')
const classify = {
  bm25Top1PluginMiss: [],
  bm25Top1PluginLower: [],
  pluginTop1Bm25Miss: [],
  pluginTop1Bm25Lower: [],
  bothMiss: [],
  agreeTop1: 0,
}
for (let index = 0; index < shipped.rankings.length; index += 1) {
  const row = shipped.rankings[index]
  const bm25Rank = row.bm25.indexOf(row.id)
  const pluginRank = row.current.indexOf(row.id)
  if (bm25Rank === 0 && pluginRank === -1) classify.bm25Top1PluginMiss.push({ index, row, bm25Rank, pluginRank })
  else if (bm25Rank === 0 && pluginRank > 0) classify.bm25Top1PluginLower.push({ index, row, bm25Rank, pluginRank })
  else if (pluginRank === 0 && bm25Rank === -1) classify.pluginTop1Bm25Miss.push({ index, row, bm25Rank, pluginRank })
  else if (pluginRank === 0 && bm25Rank > 0) classify.pluginTop1Bm25Lower.push({ index, row, bm25Rank, pluginRank })
  else if (bm25Rank === -1 && pluginRank === -1) classify.bothMiss.push({ index, row, bm25Rank, pluginRank })
  else if (bm25Rank === 0 && pluginRank === 0) classify.agreeTop1 += 1
}
console.log(`  bm25 top-1 & plugin outside top-10 : ${classify.bm25Top1PluginMiss.length}`)
console.log(`  plugin top-1 & bm25 outside top-10 : ${classify.pluginTop1Bm25Miss.length}`)
console.log(`  bm25 top-1 & plugin lower in top-10 : ${classify.bm25Top1PluginLower.length}`)
console.log(`  plugin top-1 & bm25 lower in top-10 : ${classify.pluginTop1Bm25Lower.length}`)
console.log(`  both outside top-10 : ${classify.bothMiss.length}`)
console.log(`  both top-1 (agreement) : ${classify.agreeTop1}`)

// Full plugin ranking already computed in section 2 as `fullCurrent`.
let top10Agree = 0
for (let index = 0; index < queries.length; index += 1) {
  if (fullCurrent[index].slice(0, 10).join('|') === shipped.rankings[index].current.join('|')) top10Agree += 1
}
console.log(`  recomputed shipped-scorer top-10 vs results.json: ${top10Agree}/${queries.length} identical`)

const hub = hubTerms(corpus, 0.25)
const MIN_SCORE = 9
const MIN_TERMS = 2

/** Shared tokens between the query and one field of one entry (token-set intersection). */
function sharedWith(entry, query) {
  const querySet = new Set(tokenize(query))
  const result = {}
  for (const field of FIELDS) {
    const value = entry[field]
    const text = Array.isArray(value) ? value.join(' ') : value ?? ''
    const fieldSet = new Set(tokenize(text))
    result[field] = [...querySet].filter((term) => fieldSet.has(term))
  }
  return result
}

/** BM25 per-term contribution for one doc, at the baseline cell. */
function contributions(index, terms, docIndex, k1, b) {
  const { docs, postings, N, avgLength } = index
  const out = []
  for (const term of terms) {
    const posting = postings.get(term)
    if (posting === undefined) continue
    const entry = posting.list.find((item) => item[0] === docIndex)
    if (entry === undefined) continue
    const frequency = entry[1]
    const idf = Math.log(1 + (N - posting.df + 0.5) / (posting.df + 0.5))
    out.push({ term, idf: Number(idf.toFixed(2)), tf: frequency, value: Number((idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * docs[docIndex].length) / avgLength)))).toFixed(2)) })
  }
  return out
}

function describeCase({ index, row, bm25Rank, pluginRank }) {
  const target = byId.get(row.id)
  const fullPluginRank = fullCurrent[index].indexOf(row.id)
  const baselineRank = baselineFull[index].findIndex((docIndex) => corpus[docIndex].id === row.id)
  const bestRank = bestFull[index].findIndex((docIndex) => corpus[docIndex].id === row.id)
  const pluginTop = fullCurrent[index][0]
  const pluginTopEntry = byId.get(pluginTop)
  const bm25Top = corpus[baselineFull[index][0]].id
  const bm25TopEntry = byId.get(bm25Top)
  const evidence = explainEntry(target, row.query, Date.now(), null)
  const credit = matchCredit(target, row.query, MIN_SCORE, MIN_TERMS, { hub, range: null })
  const shared = sharedWith(target, row.query)
  const pluginTopShared = sharedWith(pluginTopEntry, row.query)
  const bm25TopShared = sharedWith(bm25TopEntry, row.query)
  const targetContrib = contributions(baselineIndex, baselineTerms[index], corpus.findIndex((entry) => entry.id === row.id), 1.2, 0.75)
  const bm25TopIndex = corpus.findIndex((entry) => entry.id === bm25Top)
  const bm25TopContrib = contributions(baselineIndex, baselineTerms[index], bm25TopIndex, 1.2, 0.75)
  const pluginTopRelevance = explainEntry(pluginTopEntry, row.query, Date.now(), null).relevance
  const dfOf = (term) => baselineIndex.postings.get(term)?.df ?? 0
  const withDf = (terms) => terms.map((term) => `${term}(${dfOf(term)})`).join(',')
  const sharedText = (sharedFields) => FIELDS.map((field) => `${field}=[${withDf(sharedFields[field])}]`).join(' ')
  const targetIndex = corpus.findIndex((entry) => entry.id === row.id)
  console.log(`\n  [${row.id}]`)
  console.log(`    query            : ${row.query}`)
  console.log(`    target title     : ${target.title}`)
  console.log(`    target body[:180]: ${(target.body ?? '').slice(0, 180)}`)
  console.log(`    ranks: results.json bm25 ${bm25Rank === -1 ? '>10' : bm25Rank} · plugin ${pluginRank === -1 ? '>10' : pluginRank} | full: bm25 ${baselineRank === -1 ? 'miss' : baselineRank} · plugin ${fullPluginRank === -1 ? 'miss' : fullPluginRank} · best-cell bm25 ${bestRank === -1 ? 'miss' : bestRank}`)
  console.log(`    doc lengths (tokens): target ${baselineIndex.docs[targetIndex].length} · plugin top-1 ${baselineIndex.docs[corpus.findIndex((entry) => entry.id === pluginTop)].length} · bm25 top-1 ${baselineIndex.docs[bm25TopIndex].length}`)
  console.log(`    plugin evidence: relevance ${pct(evidence.relevance)} · strongTerms ${evidence.evidence.strongTerms} · phrase ${evidence.evidence.phrase} · credited ${credit.credited} · best sentence: ${evidence.best.slice(0, 90)}`)
  console.log(`    target shared (df): ${sharedText(shared)}`)
  console.log(`    bm25 target terms: ${targetContrib.map((item) => `${item.term}:${item.value}`).join(' ') || '(none)'}`)
  console.log(`    plugin top-1     : ${pluginTopEntry.title.slice(0, 70)} (relevance ${pct(pluginTopRelevance)}, df-weighted shared below)`)
  console.log(`    plugin top-1 shared (df): ${sharedText(pluginTopShared)}`)
  console.log(`    bm25 top-1       : ${bm25TopEntry.title.slice(0, 70)}`)
  console.log(`    bm25 top-1 terms : ${bm25TopContrib.map((item) => `${item.term}:${item.value}`).join(' ') || '(none)'}`)
  console.log(`    bm25 top-1 shared (df): ${sharedText(bm25TopShared)}`)
}

const strictCases = [...classify.bm25Top1PluginMiss, ...classify.pluginTop1Bm25Miss]
const lowerCases = [...classify.bm25Top1PluginLower, ...classify.pluginTop1Bm25Lower]
console.log('\n  -- strict cases (one arm top-1, the other outside top-10) --')
for (const item of strictCases) describeCase(item)
console.log('\n  -- one arm top-1, the other lower inside the top-10 --')
for (const item of lowerCases) describeCase(item)

/* ================================================== 5. verdict numbers ===== */

console.log('\n=== 5. headline comparison ===')
console.log(`  shipped current (results.json) : R@1 ${pct(shippedCurrent['R@1'])}  MRR@10 ${pct(shippedCurrent['MRR@10'])}  R@10 ${pct(shippedCurrent['R@10'])}`)
console.log(`  bm25 baseline cell             : R@1 ${pct(baselineMetrics.R1)}  MRR@10 ${pct(baselineMetrics.MRR)}  R@10 ${pct(baselineMetrics.R10)}`)
console.log(`  bm25 best cell (${best.key} k1=${best.k1} b=${best.b}) : R@1 ${pct(best.R1)}  MRR@10 ${pct(best.MRR)}  R@10 ${pct(best.R10)}`)
console.log(`  gap vs shipped, baseline: ${pct(baselineMetrics.R1 - shippedCurrent['R@1'])} R@1 / ${pct(baselineMetrics.MRR - shippedCurrent['MRR@10'])} MRR`)
console.log(`  gap vs shipped, best    : ${pct(best.R1 - shippedCurrent['R@1'])} R@1 / ${pct(best.MRR - shippedCurrent['MRR@10'])} MRR`)

/** Two-sided exact McNemar on top-1 agreement between two arms. */
function mcnemar(left, right) {
  let both = 0
  let leftOnly = 0
  let rightOnly = 0
  for (let index = 0; index < queries.length; index += 1) {
    const expected = queries[index].id
    const isLeft = left[index].indexOf(expected) === 0
    const isRight = right[index].indexOf(expected) === 0
    if (isLeft && isRight) both += 1
    else if (isLeft) leftOnly += 1
    else if (isRight) rightOnly += 1
  }
  const n = leftOnly + rightOnly
  const k = Math.min(leftOnly, rightOnly)
  const choose = (n, k) => {
    let value = 1
    for (let i = 1; i <= k; i += 1) value = (value * (n - k + i)) / i
    return value
  }
  let cumulative = 0
  for (let i = 0; i <= k; i += 1) cumulative += choose(n, i) / 2 ** n
  return { both, leftOnly, rightOnly, p: Math.min(1, 2 * cumulative) }
}
const vsBaseline = mcnemar(baselineFull.map((order) => order.map((docIndex) => corpus[docIndex].id)), fullCurrent)
const vsBest = mcnemar(bestFull.map((order) => order.map((docIndex) => corpus[docIndex].id)), fullCurrent)
console.log(`\ntop-1 agreement / disagreement (paired, 150 queries):`)
console.log(`  bm25 baseline  vs shipped: both ${vsBaseline.both} · bm25-only ${vsBaseline.leftOnly} · shipped-only ${vsBaseline.rightOnly} · exact McNemar two-sided p=${vsBaseline.p.toFixed(3)}`)
console.log(`  bm25 best cell vs shipped: both ${vsBest.both} · bm25-only ${vsBest.leftOnly} · shipped-only ${vsBest.rightOnly} · exact McNemar two-sided p=${vsBest.p.toFixed(3)}`)
