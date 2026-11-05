/**
 * Dump the live memory store into a portable corpus for the bench.
 *
 * The bench must read entries the way the plugin reads them, not by re-parsing
 * frontmatter here: a second parser is a second definition of "the field the
 * scorer sees", and a bench that disagrees with the plugin measures nothing.
 *
 * Usage: node bench/export-corpus.mts [--sample 150] [--seed 7] [--out bench/data]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/storage.js'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const memoriesDir = join(homedir(), '.dsh', 'memories')
const outDir = arg('out', 'bench/data')
const sampleSize = Number(arg('sample', 150))
const seed = Number(arg('seed', 7))

/** Deterministic LCG: the sample must be the same sample on every machine. */
function rng(state) {
  let value = state >>> 0
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 0x100000000
  }
}

const entries = await new MemoryStore(memoriesDir).list('global', undefined, { fresh: true })
const keep = ['id', 'kind', 'title', 'body', 'tags', 'keys', 'appliesTo', 'createdAt', 'updatedAt', 'uses', 'lastUsedAt', 'lastSurfacedAt', 'source', 'session', 'durability', 'asOf']
const corpus = entries.map((entry) => Object.fromEntries(keep.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])))

const random = rng(seed)
const shuffled = corpus.map((entry) => ({ entry, order: random() })).sort((a, b) => a.order - b.order)
const sample = shuffled.slice(0, sampleSize).map((item) => item.entry)

await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'corpus.json'), JSON.stringify(corpus, null, 2))
await writeFile(join(outDir, 'sample.json'), JSON.stringify(sample, null, 2))

const withSession = corpus.filter((entry) => typeof entry.session === 'string' && entry.session.length > 0).length
const noKeys = corpus.filter((entry) => !Array.isArray(entry.keys) || entry.keys.length === 0).length
console.log(JSON.stringify({ entries: corpus.length, sample: sample.length, withSession, noKeys, outDir }, null, 2))
