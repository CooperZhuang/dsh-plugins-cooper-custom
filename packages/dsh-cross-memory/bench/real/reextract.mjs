/**
 * Re-extract the sampled real sessions with the real extraction contract, to
 * test whether the memory gap is a budget problem.
 *
 * The live store is a snapshot of what the plugin happened to extract while the
 * session was running (tail windows, default caps). This script replays each
 * sampled transcript through `runExtraction` — same prompt, same evidence-quote
 * check — over every backfill window, and stores the result per session. Then
 * `run.mjs --reextract <name>` scores the memory arm on that store instead of the
 * live one.
 *
 * Variants differ only in `extractMaxMemories`: how many facts one call may keep.
 *
 * Usage:
 *   node bench/real/reextract.mjs --name base5 --max-memories 5 --provider deepseek
 *   node bench/real/reextract.mjs --name more20 --max-memories 20 --provider deepseek
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSessionLogs, planWindows, readSessionLog } from '../../lib/backfill.js'
import { runExtraction } from '../../lib/extract.js'
import { redactSecrets } from '../../lib/extract.js'
import { MemoryStore } from '../../lib/storage.js'
import { createChat } from './chat.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')
const BANK = join(DATA, 'real-bank.json')
const ROOT = join(DATA, 'real-reextract')
const PRICE = { input: 2, output: 8 }
const WINDOW_MESSAGES = 60
const WINDOW_CHARS = 48_000

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const NAME = argValue('--name')
const MAX_MEMORIES = Number(argValue('--max-memories') ?? 5)
const MAX_OUTPUT_TOKENS = Number(argValue('--max-output-tokens') ?? 2_000)
const DSH_HOME = argValue('--dsh-home') ?? process.env['DSH_HOME'] ?? join(process.env['HOME'] ?? '', '.dsh')

/** An LlmRuntime-shaped adapter: one buffered reply rendered as one stream. */
function adapter(chat) {
  const textOf = (message) => message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return {
    stream: (options) => (async function* stream() {
      const messages = [
        ...options.system === undefined ? [] : [{ role: 'system', content: options.system }],
        ...options.messages.map((message) => ({ role: message.role ?? 'user', content: textOf(message) })),
      ]
      const text = await chat(messages, { json: true, numPredict: options.maxTokens ?? 2_000 })
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
}

/** Minimal Session stub: runExtraction only reads the id for provenance here. */
function stubSession(sessionId) {
  return { id: sessionId, requestHeader: () => undefined }
}

async function main() {
  if (NAME === undefined) throw new Error('--name is required')
  const bank = JSON.parse(await readFile(BANK, 'utf8'))
  const wanted = new Set(bank.sessions.map((session) => session.sessionId))
  const { chat, usage, provider, model } = createChat({
    provider: argValue('--provider') ?? 'ollama',
    model: argValue('--model'),
    keyFile: argValue('--key-file'),
  })
  const llm = adapter(chat)
  const logs = await findSessionLogs(join(DSH_HOME, 'sessions'))
  const messagesBySession = new Map()
  for (const log of logs) {
    if (messagesBySession.size >= wanted.size) break
    let session
    try {
      session = await readSessionLog(log.file, log.modifiedAt)
    } catch {
      continue
    }
    if (session === undefined || !wanted.has(session.sessionId) || messagesBySession.has(session.sessionId)) continue
    messagesBySession.set(session.sessionId, session.messages)
  }
  console.log(`sessions found ${messagesBySession.size}/${wanted.size} · variant ${NAME} · maxMemories ${MAX_MEMORIES}`)
  const variantRoot = join(ROOT, NAME)
  await rm(variantRoot, { recursive: true, force: true })
  await mkdir(variantRoot, { recursive: true })

  const summary = { name: NAME, maxMemories: MAX_MEMORIES, maxOutputTokens: MAX_OUTPUT_TOKENS, provider, model, at: new Date().toISOString(), sessions: [], counts: { stored: 0, drafts: 0, unsupported: 0, loops: 0, windows: 0 } }
  for (const [index, session] of bank.sessions.entries()) {
    const messages = messagesBySession.get(session.sessionId)
    if (messages === undefined) {
      summary.sessions.push({ sessionId: session.sessionId, error: 'log not found' })
      continue
    }
    const redacted = messages.map((message) => ({ ...message, text: redactSecrets(message.text) }))
    const windows = planWindows(redacted, WINDOW_MESSAGES, WINDOW_CHARS)
    const storeDir = join(variantRoot, session.sessionId, 'store')
    const projectRoot = join(variantRoot, session.sessionId, 'project')
    const store = new MemoryStore(storeDir)
    let stored = 0
    let drafts = 0
    let unsupported = 0
    let loops = 0
    for (const window of windows) {
      const outcome = await runExtraction(llm, {
        session: stubSession(session.sessionId),
        window,
        projectLabel: 'project:real',
        provider: 'deepseek',
        model: 'deepseek-chat',
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxMemories: MAX_MEMORIES,
        timeoutMs: 180_000,
        signal: AbortSignal.timeout(180_000),
      })
      summary.counts.windows += 1
      if (outcome.kind !== 'memories') {
        console.log(`    window ${window.firstSeq}-${window.lastSeq}: none (${outcome.reason})`)
        continue
      }
      drafts += outcome.drafts.length + outcome.unsupported
      unsupported += outcome.unsupported
      loops += outcome.loops.length
      for (const draft of outcome.drafts) {
        await store.upsert(draft, draft.scope === 'project' ? projectRoot : undefined, 'auto')
        stored += 1
      }
    }
    summary.counts.stored += stored
    summary.counts.drafts += drafts
    summary.counts.unsupported += unsupported
    summary.counts.loops += loops
    summary.sessions.push({ sessionId: session.sessionId, windows: windows.length, stored, drafts, unsupported, loops, transcriptHash: session.transcriptHash })
    console.log(`  ${index + 1}/${bank.sessions.length} ${session.sessionId.slice(0, 12)}: ${windows.length} window(s), ${stored} stored, ${unsupported} rejected`)
  }
  const offPeak = (() => {
    const beijing = new Date(Date.now() + 8 * 3_600_000)
    const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
    return minutes >= 30 && minutes <= 8 * 60 + 30
  })()
  summary.usage = { ...usage, estimatedCny: Number(((usage.input / 1e6 * PRICE.input + usage.output / 1e6 * PRICE.output) * (offPeak ? 0.5 : 1)).toFixed(3)) }
  summary.hash = createHash('sha256').update(JSON.stringify(summary.sessions)).digest('hex')
  await writeFile(join(variantRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`stored ${summary.counts.stored} / drafts ${summary.counts.drafts} · rejected ${summary.counts.unsupported} · loops ${summary.counts.loops}`)
  console.log(`variant ${NAME} · ~¥${summary.usage.estimatedCny} · ${variantRoot}`)
}

await main()
