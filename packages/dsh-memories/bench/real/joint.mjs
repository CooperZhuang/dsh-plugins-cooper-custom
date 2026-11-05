/**
 * Joint recall experiment: memory plus the raw conversation passages.
 *
 * The real-session benchmark showed the memory arm losing to full-transcript RAG
 * mostly because the extraction dropped details. The Memory-Tax study found the
 * one robust fix was to retrieve the original history alongside the memory and
 * let both go to the model. This harness tests that on our own sessions:
 *
 *   memory      — the re-extracted memory entries, rendered like the plugin does
 *   raw         — top-k raw transcript chunks retrieved for the question
 *   memory+raw  — both blocks in one context
 *   rag         — the whole transcript (upper bound)
 *
 * Chunk retrieval is hybrid: character-bigram BM25 plus local ollama embeddings,
 * fused with reciprocal rank fusion (k=60). Embeddings and answers stay local
 * except the model calls themselves; results are gitignored.
 *
 * Usage:
 *   node bench/real/joint.mjs --provider deepseek
 *   node bench/real/joint.mjs --provider deepseek --reextract more20 --limit 5
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHit, renderMemorySummary } from '../../lib/render.js'
import { searchMemories } from '../../lib/search.js'
import { MemoryStore } from '../../lib/storage.js'
import { cosine, embedAll } from '../lib/embed.mjs'
import { anchorGate, createJudge, percentage } from '../e2e/judge.mjs'
import { createChat } from './chat.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')
const CANDIDATES = join(DATA, 'real-candidates.json')
const BANK = join(DATA, 'real-bank.json')
const REEXTRACT_ROOT = join(DATA, 'real-reextract')
const EMB_CACHE = join(DATA, 'real-raw-emb.json')
const RESULT = join(DATA, 'real-joint-results.json')
const SUMMARY_BYTES = 4096
const RECALL_LIMIT = 4
const CHUNK_CHARS = 900
const TOP_K = 3
const RAW_BYTES = 2200
const RRF_K = 60
const PRICE = { input: 2, output: 8 }

const ANSWER_SYSTEM = '只依据下面提供的资料回答问题。资料里有答案就直接给出结论，不要用「资料没有提到…」的口吻回避；问题问到的每个数字、名称、日期、路径都要写出来。资料里确实没有的，才回答「不知道」。回答要完整：问题问到的每件事都要答到，资料里与该问题相关的条件或替代做法一并说明；简短直接，不要复述资料。'

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** DeepSeek's off-peak window: 00:30–08:30 Beijing time, half price. */
function offPeak(now = Date.now()) {
  const beijing = new Date(now + 8 * 3_600_000)
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return minutes >= 30 && minutes <= 8 * 60 + 30
}

/** Bigram/word tokens for the lexical half of the retrieval. */
function tokens(text) {
  const clean = text.toLowerCase().replace(/[\s，。！？、；：“”‘’（）()《》【】[\]{}<>,.!?;:'"…—-]+/gu, '')
  const out = new Set()
  for (let index = 0; index < clean.length - 1; index += 1) out.add(clean.slice(index, index + 2))
  for (const word of text.toLowerCase().match(/[a-z0-9_]{3,}/gu) ?? []) out.add(word)
  return out
}

/** BM25 over the chunks of one session. */
function lexicalScores(query, chunks) {
  const queryTokens = [...tokens(query)]
  const bags = chunks.map((chunk) => tokens(chunk.text))
  const lengths = bags.map((bag) => bag.size)
  const average = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length)
  const df = new Map()
  for (const term of queryTokens) df.set(term, bags.filter((bag) => bag.has(term)).length)
  return bags.map((bag, index) => {
    let score = 0
    for (const term of queryTokens) {
      if (!bag.has(term)) continue
      const frequency = df.get(term) ?? 0
      const idf = Math.log(1 + (bags.length - frequency + 0.5) / (frequency + 0.5))
      score += idf * 2.2 / (1 + 1.2 * (0.25 + 0.75 * lengths[index] / average))
    }
    return score
  })
}

/** Reciprocal rank fusion of two rankings of chunk indices. */
function fuse(first, second) {
  const score = new Map()
  first.forEach((index, rank) => score.set(index, (score.get(index) ?? 0) + 1 / (RRF_K + rank + 1)))
  second.forEach((index, rank) => score.set(index, (score.get(index) ?? 0) + 1 / (RRF_K + rank + 1)))
  return [...score.entries()].sort((left, right) => right[1] - left[1]).map(([index]) => index)
}

/** Cut one transcript into message-boundary chunks of about CHUNK_CHARS. */
function chunkTranscript(transcript) {
  const lines = transcript.split('\n\n')
  const chunks = []
  let current = []
  let size = 0
  for (const line of lines) {
    if (current.length > 0 && size + line.length > CHUNK_CHARS) {
      chunks.push({ text: current.join('\n\n') })
      current = []
      size = 0
    }
    current.push(line)
    size += line.length + 2
  }
  if (current.length > 0) chunks.push({ text: current.join('\n\n') })
  return chunks
}

/** The memory arm's context, rendered like the plugin injects it. */
function memoryContext(entries, question) {
  const groups = [
    { scope: 'global', label: 'global', entries: entries.filter((entry) => entry.scope === 'global') },
    { scope: 'project', label: 'project', entries: entries.filter((entry) => entry.scope === 'project') },
  ].filter((group) => group.entries.length > 0)
  const summary = renderMemorySummary(groups.map((group) => ({
    label: group.label,
    heading: group.label,
    entries: group.entries,
    total: group.entries.length,
  })), { maxBytes: SUMMARY_BYTES, maxEntriesPerScope: 12 })
  const hits = searchMemories(groups, question, { limit: RECALL_LIMIT }).map(renderHit)
  return [summary ?? '', ...hits.length === 0 ? [] : ['', 'On-demand recall:', ...hits]].join('\n')
}

/** Render retrieved raw chunks, capped to the raw budget. */
function rawContext(chunks) {
  const lines = ['同一会话的原文片段（按相关度排序）：']
  let used = 0
  for (const chunk of chunks) {
    if (used + chunk.text.length > RAW_BYTES) break
    lines.push(`[片段] ${chunk.text}`)
    used += chunk.text.length + 8
  }
  return lines.join('\n\n')
}

async function answer(chat, question, context) {
  const material = context.trim().length === 0 ? '（无资料）' : context
  return await chat([
    { role: 'system', content: ANSWER_SYSTEM },
    { role: 'user', content: `资料：\n${material}\n\n问题：${question}` },
  ], { numPredict: 300 })
}

async function main() {
  const candidates = JSON.parse(await readFile(CANDIDATES, 'utf8'))
  const bank = JSON.parse(await readFile(BANK, 'utf8'))
  const reextract = argValue('--reextract') ?? 'more20'
  const limit = Number(argValue('--limit') ?? Infinity)
  const bySession = new Map(candidates.sessions.map((session) => [session.sessionId, session]))
  const { chat, usage, provider, model } = createChat({
    provider: argValue('--provider') ?? 'ollama',
    model: argValue('--model'),
    keyFile: argValue('--key-file'),
  })
  const judge = createJudge(chat)
  const anchor = await anchorGate(judge)
  if (!anchor.pass) console.log(`  WARNING: judge anchor failed ${JSON.stringify(anchor)}; grades are suspect`)

  // Entries from the re-extracted store, chunk retrieval over the transcript.
  const sessions = bank.sessions.slice(0, limit)
  const chunksBySession = new Map()
  const entriesBySession = new Map()
  const chunkTexts = []
  for (const session of sessions) {
    const candidate = bySession.get(session.sessionId)
    if (candidate === undefined) throw new Error(`${session.sessionId} not in candidates`)
    const chunks = chunkTranscript(candidate.transcript)
    chunksBySession.set(session.sessionId, chunks)
    chunkTexts.push(...chunks.map((chunk) => chunk.text))
    const dir = join(REEXTRACT_ROOT, reextract, session.sessionId, 'store')
    const root = join(REEXTRACT_ROOT, reextract, session.sessionId, 'project')
    const store = new MemoryStore(dir)
    entriesBySession.set(session.sessionId, [
      ...await store.list('project', root, { fresh: true }),
      ...await store.list('global', undefined, { fresh: true }),
    ])
  }
  const questions = sessions.flatMap((session) => session.questions)
  const embed = await embedAll([...chunkTexts, ...questions.map((question) => question.question)], EMB_CACHE)
  const chunkVectors = embed.slice(0, chunkTexts.length)
  const questionVectors = embed.slice(chunkTexts.length)
  const vectorByChunkText = new Map(chunkTexts.map((text, index) => [text, chunkVectors[index]]))
  console.log(`sessions ${sessions.length} · questions ${questions.length} · chunks ${chunkTexts.length} · variant ${reextract}`)

  const rows = []
  let cursor = 0
  for (const [index, session] of sessions.entries()) {
    const candidate = bySession.get(session.sessionId)
    const chunks = chunksBySession.get(session.sessionId)
    const entries = entriesBySession.get(session.sessionId)
    for (const question of session.questions) {
      const questionVector = questionVectors[cursor]
      cursor += 1
      // Hybrid retrieval restricted to this session's chunks.
      const lexical = lexicalScores(question.question, chunks)
      const semantic = chunks.map((chunk) => cosine(questionVector, vectorByChunkText.get(chunk.text)))
      const lexicalRanking = [...chunks.keys()].sort((left, right) => lexical[right] - lexical[left])
      const semanticRanking = [...chunks.keys()].sort((left, right) => semantic[right] - semantic[left])
      const top = fuse(lexicalRanking, semanticRanking).slice(0, TOP_K).map((chunkIndex) => chunks[chunkIndex])
      const memory = memoryContext(entries, question.question)
      const raw = rawContext(top)
      const arms = {
        memory,
        raw,
        'memory+raw': `${memory}\n\n${raw}`,
        rag: candidate.transcript,
      }
      const row = { sessionId: session.sessionId, questionId: question.id, question: question.question }
      for (const [arm, context] of Object.entries(arms)) {
        const reply = await answer(chat, question.question, context)
        const verdict = await judge(question, reply)
        row[arm] = { pass: verdict.pass, answer: reply.trim(), reason: verdict.reason, checks: verdict.checks }
      }
      rows.push(row)
      const flags = ['memory', 'raw', 'memory+raw', 'rag'].map((arm) => `${arm}=${row[arm].pass ? 'P' : 'F'}`).join(' ')
      console.log(`  ${index + 1}/${sessions.length} ${session.sessionId.slice(0, 12)} ${question.id}: ${flags}`)
    }
  }

  const cost = (usage.input / 1e6 * PRICE.input + usage.output / 1e6 * PRICE.output) * (offPeak() ? 0.5 : 1)
  const report = {
    at: new Date().toISOString(),
    provider,
    model,
    offPeak: offPeak(),
    usage: { ...usage, estimatedCny: Number(cost.toFixed(3)) },
    bankHash: bank.bankHash,
    reextract,
    chunkChars: CHUNK_CHARS,
    topK: TOP_K,
    judge: { anchor },
    sessions: sessions.length,
    questions: rows.length,
    arms: {},
    paired: {},
    rows,
  }
  const armNames = ['memory', 'raw', 'memory+raw', 'rag']
  for (const arm of armNames) {
    report.arms[arm] = percentage(rows.filter((row) => row[arm].pass).length, rows.length)
  }
  const pairs = (left, right) => `${left} 赢 ${rows.filter((row) => row[left].pass && !row[right].pass).length} / 输 ${rows.filter((row) => !row[left].pass && row[right].pass).length}`
  report.paired.memoryRawVsMemory = pairs('memory+raw', 'memory')
  report.paired.memoryRawVsRag = pairs('memory+raw', 'rag')
  report.paired.rawVsMemory = pairs('raw', 'memory')

  console.log('')
  for (const arm of armNames) console.log(`${arm.padEnd(10)} ${report.arms[arm]}`)
  console.log(`paired: ${report.paired.memoryRawVsMemory}; ${report.paired.memoryRawVsRag}; ${report.paired.rawVsMemory}`)
  console.log(`paid: ${usage.calls} calls, ${usage.input} in / ${usage.output} out, ~¥${cost.toFixed(3)}${offPeak() ? ' (off-peak 半价)' : ''}`)
  await mkdir(DATA, { recursive: true })
  await writeFile(RESULT, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`results: ${RESULT}`)
}

await main()
