/**
 * Sample real sessions for the end-to-end memory benchmark.
 *
 * Reads the persisted session logs under `<DSH_HOME>/sessions`, keeps the ones
 * that (a) have enough prose and (b) already produced at least one memory entry
 * linked through `sourceSession` — that link is what lets the memory arm show
 * what the plugin actually remembered from that conversation. Transcripts are
 * credential-scrubbed before anything is written or sent.
 *
 * Output stays local: `bench/data/real-candidates.json` is gitignored.
 *
 * Usage:
 *   node bench/real/sample.mts                 # newest 20 eligible sessions
 *   node bench/real/sample.mts --count 10
 *   node bench/real/sample.mts --dsh-home ~/.dsh
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSessionLogs, readSessionLog } from '../../lib/backfill.js'
import { redactSecrets } from '../../lib/extract.js'
import { MemoryStore } from '../../lib/storage.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')
const OUT = join(DATA, 'real-candidates.json')
const MIN_MESSAGES = 10
const MAX_MESSAGES = 160
const MIN_CHARS = 800
const MAX_CHARS = 24_000
const TRANSCRIPT_CAP = 12_000

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const COUNT = Number(argValue('--count') ?? 20)
const DSH_HOME = argValue('--dsh-home') ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')

/** All memory entries, grouped by the session that produced them. */
async function entriesBySession(memoriesDir) {
  const store = new MemoryStore(memoriesDir)
  const entries = []
  entries.push(...await store.list('global', undefined, { fresh: true }).catch(() => []))
  for (const slug of await store.listProjects()) {
    const descriptor = await store.readProjectDescriptor(slug)
    if (descriptor?.root === undefined) continue
    entries.push(...await store.list('project', descriptor.root, { fresh: true }).catch(() => []))
  }
  const bySession = new Map()
  for (const entry of entries) {
    if (entry.sourceSession === undefined || entry.sourceSession.length === 0) continue
    const bucket = bySession.get(entry.sourceSession) ?? []
    // The full entry, not a subset: the memory arm renders it with the plugin's
    // own summary/recall code, which reads tags, keys, timestamps and counters.
    bucket.push(entry)
    bySession.set(entry.sourceSession, bucket)
  }
  return { bySession, totalEntries: entries.length }
}

/** Render one transcript for the model, capped from the start of the session. */
function renderTranscript(messages) {
  const lines = []
  let used = 0
  for (const message of messages) {
    const text = redactSecrets(message.text)
    const line = `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${text}`
    if (used + line.length > TRANSCRIPT_CAP) break
    lines.push(line)
    used += line.length + 2
  }
  return lines.join('\n\n')
}

async function main() {
  const { bySession, totalEntries } = await entriesBySession(join(DSH_HOME, 'memories'))
  const logs = await findSessionLogs(join(DSH_HOME, 'sessions'))
  const eligible = []
  let parsed = 0
  let failed = 0
  for (const log of logs) {
    let session
    try {
      session = await readSessionLog(log.file, log.modifiedAt)
    } catch {
      failed += 1
      continue
    }
    if (session === undefined) continue
    parsed += 1
    const messages = session.messages
    const chars = messages.reduce((sum, message) => sum + message.text.length, 0)
    const linked = bySession.get(session.sessionId)
    if (linked === undefined) continue
    if (messages.length < MIN_MESSAGES || messages.length > MAX_MESSAGES) continue
    if (chars < MIN_CHARS || chars > MAX_CHARS) continue
    if (messages.filter((message) => message.role === 'user').length < 2) continue
    const transcript = renderTranscript(messages)
    if (transcript.length < MIN_CHARS) continue
    eligible.push({
      sessionId: session.sessionId,
      cwd: session.cwd,
      modifiedAt: session.modifiedAt,
      messages: messages.length,
      chars,
      entries: linked,
      transcript,
      transcriptHash: createHash('sha256').update(transcript).digest('hex'),
    })
  }
  eligible.sort((left, right) => right.modifiedAt - left.modifiedAt)
  const selected = eligible.slice(0, Math.max(1, COUNT))
  await mkdir(DATA, { recursive: true })
  await writeFile(OUT, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    dshHome: DSH_HOME,
    counts: { logs: logs.length, parsed, failed, entries: totalEntries, eligible: eligible.length, selected: selected.length },
    sessions: selected,
  }, null, 2)}\n`)
  console.log(`logs ${logs.length} · parsed ${parsed} · failed ${failed} · entries ${totalEntries} · eligible ${eligible.length} · selected ${selected.length}`)
  console.log(`entries per selected session: ${selected.map((session) => session.entries.length).join(',')}`)
  console.log(`output: ${OUT}`)
}

await main()
