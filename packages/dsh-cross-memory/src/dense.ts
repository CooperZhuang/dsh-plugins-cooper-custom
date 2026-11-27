/**
 * Optional dense channel: embeddings for the turns the lexical ranker cannot
 * reach.
 *
 * Why it exists as an option rather than the default. On the clean query batch
 * the RRF hybrid of BM25 and `qwen3-embedding:0.6b` measured: R@1 74.7 against
 * BM25's 76.0, R@5 96.0 against 92.0, and — the point — **1 miss out of 150
 * against BM25's 5**. The gain is almost entirely in the entries that share no
 * word with the query at all, which is exactly the failure mode of a short,
 * context-dependent turn (「附件」 against a memory filed as 「邮件写作风格」).
 *
 * It costs a local embedding service and a first-pass embedding of the store,
 * so it is off unless configured, and every failure here degrades to the lexical
 * result instead of failing the recall.
 *
 * @module dsh-cross-memory/dense
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MemoryEntry } from './types.js'

/** Where the embedding service is reached; the harness never calls outside the machine by default. */
export const DEFAULT_DENSE_URL = 'http://127.0.0.1:11434'

/** The model the bench measured. Any embedding model works; the cache is keyed by name. */
export const DEFAULT_DENSE_MODEL = 'qwen3-embedding:0.6b'

/** Settings for one dense pass. */
export interface DenseOptions {
  /** Base URL of the embedding service, e.g. `http://127.0.0.1:11434`. */
  readonly url: string
  /** Model name. */
  readonly model: string
  /** Directory holding the JSON vector cache. */
  readonly cacheDir: string
}

/** The searchable text of one entry, the same fields the lexical index reads. */
function documentText(entry: MemoryEntry): string {
  return [entry.title, ...(entry.keys ?? []), ...(entry.tags ?? []), entry.appliesTo ?? '', (entry.body ?? '').slice(0, 2000)]
    .filter((part) => part.length > 0)
    .join('\n')
}

/** A vector cache keyed by text hash, shared by every caller in one process. */
interface CacheFile {
  readonly model: string
  readonly vectors: Record<string, string>
}

const hashOf = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16)

/** Encode a vector as base64 float32 (JSON-safe). */
function encode(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
}

/** Decode one base64 float32 blob. */
function decode(blob: string): Float32Array {
  const buffer = Buffer.from(blob, 'base64')
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}

/** Unit-normalize a vector, so cosine is a dot product. */
function normalize(vector: Float32Array): Float32Array {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(vector.length)
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index]! / norm
  return out
}

/** One embedding call, retried twice: ollama drops the first request after idle. */
async function callService(url: string, model: string, texts: readonly string[]): Promise<Float32Array[]> {
  const endpoint = `${url.replace(/\/+$/u, '')}/api/embed`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      })
      if (!response.ok) throw new Error(`embedding service ${response.status}: ${await response.text()}`)
      const payload: unknown = await response.json()
      const vectors = (payload as { embeddings?: number[][] }).embeddings
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error(`embedding service returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${texts.length} texts`)
      }
      return vectors.map((vector) => normalize(Float32Array.from(vector)))
    } catch (error) {
      if (attempt === 2) throw error
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
  }
  throw new Error('unreachable')
}

/**
 * Embed texts, reusing the on-disk cache.
 *
 * Failures propagate: the caller decides whether to fall back. The cache is
 * written only after every batch succeeded, so a partial run never poisons it.
 *
 * @param texts - texts to embed, in order.
 * @param options - service location, model, and cache directory.
 * @returns one unit vector per text.
 */
export async function embed(texts: readonly string[], options: DenseOptions): Promise<Float32Array[]> {
  const path = `${options.cacheDir}/dense-${options.model.replace(/[^a-z0-9._-]/giu, '_')}.json`
  let cache: CacheFile = { model: options.model, vectors: {} }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CacheFile
    if (parsed.model === options.model && typeof parsed.vectors === 'object') cache = parsed
  } catch {
    cache = { model: options.model, vectors: {} }
  }
  const missing: { key: string; text: string }[] = []
  const seen = new Set<string>()
  for (const text of texts) {
    const key = hashOf(text)
    if (cache.vectors[key] !== undefined || seen.has(key)) continue
    seen.add(key)
    missing.push({ key, text })
  }
  const BATCH = 16
  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH)
    const vectors = await callService(options.url, options.model, batch.map((item) => item.text))
    for (let index = 0; index < batch.length; index += 1) {
      cache.vectors[batch[index]!.key] = encode(vectors[index]!)
    }
  }
  if (missing.length > 0) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(cache))
  }
  return texts.map((text) => decode(cache.vectors[hashOf(text)] ?? ''))
}

/**
 * Cosine similarity of two unit vectors (a dot product).
 * @param left - one vector.
 * @param right - the other.
 * @returns similarity in `[-1, 1]`.
 */
export function cosine(left: Float32Array, right: Float32Array): number {
  let sum = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) sum += left[index]! * right[index]!
  return sum
}

/**
 * Score every entry against one query by embedding.
 *
 * @param entries - the entries to score.
 * @param query - the turn.
 * @param options - service location, model, and cache directory.
 * @returns id → cosine similarity; empty when the service is unavailable.
 */
export async function denseScores(entries: readonly MemoryEntry[], query: string, options: DenseOptions): Promise<Map<string, number>> {
  const scores = new Map<string, number>()
  if (entries.length === 0 || query.trim().length === 0) return scores
  try {
    const vectors = await embed([...entries.map(documentText), query], options)
    const queryVector = vectors[vectors.length - 1]!
    if (queryVector.length === 0) return scores
    for (let index = 0; index < entries.length; index += 1) {
      scores.set(entries[index]!.id, cosine(vectors[index]!, queryVector))
    }
  } catch {
    // Dense is an optional channel: an unavailable service must never fail a recall.
    return new Map()
  }
  return scores
}

/**
 * Reciprocal rank fusion.
 *
 * The two channels disagree about scale, not about order, so their ranks are
 * fused instead of their scores: each list contributes `1 / (k + rank)`, and
 * the constant keeps a first place worth about twice a tenth.
 *
 * @param lists - ranked id lists, best first.
 * @param k - fusion constant; 60 is the usual value.
 * @returns id → fused score, descending.
 */
export function rrf(lists: readonly (readonly string[])[], k = 60): Map<string, number> {
  const fused = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1)))
  }
  return new Map([...fused.entries()].sort((left, right) => right[1] - left[1]))
}
