/**
 * Okapi BM25 over the memory fields, used as the ORDERING ranker.
 *
 * The hand-weighted scorer in `search.ts` stays the gatekeeper: its evidence
 * rule (a substantive term, a phrase, an entity) decides what may be recalled
 * at all, and its `relevance` keeps the meaning of `recallMinScore`. What BM25
 * replaces is the *ordering* — which of the entries that cleared the gate comes
 * first — and there it measured better than the hand weights.
 *
 * Why a second ranker instead of retuning the first: the shipped scorer is a
 * sum of hand-set field weights (title 8, keys 7, body 2 …), and on the clean
 * query batch its top-1 was 60.0% against BM25's 76.0%, top-5 81.3% against
 * 92.0%. The gap is structural, not a constant: the hand weights cannot express
 * "a term that appears in 100 of 176 entries is worth less than one that appears
 * in three", which is exactly what separates 「同步」 from a file name. BM25's
 * idf does that, and it is why a query with only 42.5% lexical overlap with its
 * target still finds it.
 *
 * Same tokenizer as the gatekeeper (`tokenize.js`), same field weighting as
 * `bench/run-bench.mts` so the bench numbers and the shipped behaviour are the
 * same experiment. k1 = 1.2, b = 0.75 — the best cell of the 64-cell
 * sensitivity audit, and the shipped bench's configuration.
 *
 * @module dsh-cross-memory/bm25
 */
import type { MemoryEntry } from './types.js'
import { tokenize } from './tokenize.js'

/** Term frequency saturation, from the sensitivity audit's best cell. */
export const BM25_K1 = 1.2
/** Length normalisation, from the same cell. */
export const BM25_B = 0.75

/** Field multiplicity: a title word counts twice, a key twice, the rest once. */
export const BM25_FIELDS = {
  title: 2,
  keys: 2,
  tags: 1,
  appliesTo: 1,
  body: 1,
} as const

/** One document's term frequencies and length. */
interface Doc {
  readonly id: string
  readonly tf: ReadonlyMap<string, number>
  readonly length: number
}

/** A built index: scores a query against the entries it was built from. */
export interface Bm25Index {
  /** The entries in index order. */
  readonly entries: readonly MemoryEntry[]
  /**
   * Score every entry against one query.
   * @param query - raw query text.
   * @returns id → score, only entries with a positive score.
   */
  score(query: string): Map<string, number>
}

/** Cache of built indexes, keyed by the exact array they were built from. */
const indexCache = new WeakMap<readonly MemoryEntry[], Bm25Index>()

/** The searchable text of one entry, with the field multiplicity applied. */
function documentText(entry: MemoryEntry): string {
  const parts: string[] = []
  for (let index = 0; index < BM25_FIELDS.title; index += 1) parts.push(entry.title)
  for (const key of entry.keys ?? []) for (let index = 0; index < BM25_FIELDS.keys; index += 1) parts.push(key)
  for (const tag of entry.tags ?? []) for (let index = 0; index < BM25_FIELDS.tags; index += 1) parts.push(tag)
  for (let index = 0; index < BM25_FIELDS.appliesTo; index += 1) parts.push(entry.appliesTo ?? '')
  for (let index = 0; index < BM25_FIELDS.body; index += 1) parts.push(entry.body ?? '')
  return parts.filter((part) => part.length > 0).join('\n')
}

/** Build (or reuse) the index for one entry array.
 *
 * @param entries - the entries to rank, in any order.
 * @returns the index; repeated calls with the same array are free.
 */
export function createBm25Index(entries: readonly MemoryEntry[]): Bm25Index {
  const cached = indexCache.get(entries)
  if (cached !== undefined) return cached
  const docs: Doc[] = entries.map((entry) => {
    const terms = tokenize(documentText(entry))
    const tf = new Map<string, number>()
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1)
    return { id: entry.id, tf, length: terms.length }
  })
  const df = new Map<string, number>()
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length)
  const total = docs.length
  const index: Bm25Index = {
    entries,
    score(query: string): Map<string, number> {
      const terms = [...new Set(tokenize(query))]
      const scores = new Map<string, number>()
      if (terms.length === 0 || total === 0) return scores
      for (const doc of docs) {
        let score = 0
        for (const term of terms) {
          const frequency = doc.tf.get(term)
          if (frequency === undefined) continue
          const documentFrequency = df.get(term) ?? 0
          const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5))
          score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / averageLength)))
        }
        if (score > 0) scores.set(doc.id, score)
      }
      return scores
    },
  }
  indexCache.set(entries, index)
  return index
}

/**
 * Rank entries against a query by BM25, strongest first.
 *
 * Only entries with a positive score are returned: an entry that shares no term
 * with the query is not a candidate, exactly as the gatekeeper sees it.
 *
 * @param entries - the entries to rank.
 * @param query - raw query text.
 * @returns entries in descending score order.
 */
export function bm25Rank(entries: readonly MemoryEntry[], query: string): MemoryEntry[] {
  if (entries.length === 0 || query.trim().length === 0) return []
  const scores = createBm25Index(entries).score(query)
  if (scores.size === 0) return []
  return entries
    .filter((entry) => (scores.get(entry.id) ?? 0) > 0)
    .sort((left, right) => (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0))
}
