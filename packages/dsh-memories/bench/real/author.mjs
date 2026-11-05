/**
 * Author questions for the real-session benchmark, from the sampled transcripts.
 *
 * The model writes questions whose answers are stated in the transcript, plus
 * grading points and a verbatim evidence quote. The quote is checked against the
 * same redacted transcript the model was shown; a question whose quote is not a
 * substring is dropped. The bank is frozen by hash: editing or re-authoring is a
 * new bank (`--force`), never an in-place change to an existing one.
 *
 * Usage:
 *   node bench/real/author.mjs --provider deepseek
 *   node bench/real/author.mjs --provider deepseek --limit 5   # smoke
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChat } from './chat.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')
const CANDIDATES = join(DATA, 'real-candidates.json')
const BANK = join(DATA, 'real-bank.json')
const PRICE = { input: 2, output: 8 }

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const LIMIT = Number(argValue('--limit') ?? Infinity)
const FORCE = process.argv.includes('--force')

/** Collapse whitespace so a re-wrapped quote still matches its transcript. */
function squash(value) {
  return value.replace(/\s+/gu, ' ').trim()
}

/** Freeze identity: the exact sessions and questions a run is measured on. */
function bankHash(sessions) {
  return createHash('sha256').update(JSON.stringify(sessions)).digest('hex')
}

const AUTHOR_RULES = [
  '角色：你是评测出题员，只返回 JSON。',
  '任务：阅读下面这段真实编码会话的节选，出 2 个「将来另一个会话会问」的问题。',
  '硬约束：',
  '1. 答案必须在节选里被明确写下，不能靠推断、统计或外部知识；回答不了的不要出。',
  '2. 优先问耐久的事实：决策及理由、命令、配置值、目录/路径约定、环境事实、踩过的坑、主人的偏好或边界。不要问「我们刚才做了什么」这类流程问题，也不要问代码细节。',
  '3. 问题要具体到能用短答案回答（名字/数字/命令/路径/一句话），不要问开放式的「怎么优化」。',
  '4. 每个问题给 required（1-3 条判分要点，语义判分）、forbidden（0-1 条明确错误说法，可为空数组）、quote（从节选逐字复制的一段证据，至少 8 个字符，不能改写或拼接）。',
  '5. 两个问题不要问同一个事实。',
  '输出：{"questions":[{"question":"...","required":["..."],"forbidden":[],"quote":"..."}]}',
].join('\n')

/** Validate and normalize one authored question. */
function normalizeQuestion(raw, transcript) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const question = typeof raw.question === 'string' ? raw.question.replace(/\s+/gu, ' ').trim() : ''
  const required = Array.isArray(raw.required)
    ? raw.required.filter((point) => typeof point === 'string').map((point) => point.replace(/\s+/gu, ' ').trim()).filter((point) => point.length > 0)
    : []
  const forbidden = Array.isArray(raw.forbidden)
    ? raw.forbidden.filter((point) => typeof point === 'string').map((point) => point.replace(/\s+/gu, ' ').trim()).filter((point) => point.length > 0)
    : []
  const quote = typeof raw.quote === 'string' ? raw.quote.replace(/\s+/gu, ' ').trim() : ''
  if (question.length < 6 || question.length > 140) return undefined
  if (required.length < 1 || required.length > 3) return undefined
  if (forbidden.length > 1) return undefined
  if (quote.length < 8 || !squash(transcript).includes(squash(quote))) return undefined
  return { question, required, forbidden, quote }
}

/** Ask whether a question can be answered directly from the transcript, with evidence. */
async function verifyQuestion(chat, session, question) {
  const reply = await chat([
    { role: 'system', content: '你是出题审核员，只返回 JSON。' },
    { role: 'user', content: JSON.stringify({
      问题: question.question,
      节选: session.transcript,
      要求: '只依据节选回答这个问题。若节选能直接、明确地回答它，返回 {"answerable":true,"answer":"一句话答案","evidence":"支持答案的原文片段（逐字）"}；若需要推断、缺信息、只能猜、或者节选只描述了现象没有原因，返回 {"answerable":false,"why":"为什么不能直接回答"}。不要用节选以外的知识。',
    }) },
  ], { json: true, numPredict: 300 })
  try {
    const value = JSON.parse(reply)
    return { answerable: value.answerable === true, why: String(value.why ?? '') }
  } catch {
    return { answerable: false, why: 'verifier reply was not JSON' }
  }
}

/**
 * Re-check every question in an existing bank and drop the ones the transcript
 * cannot answer directly. Authoring occasionally writes a "why" question when
 * the transcript only records the symptom; such a question measures inference,
 * not memory, so it is removed before any scoring.
 */
async function verifyBank({ chat, usage, provider, model }) {
  const bank = JSON.parse(await readFile(BANK, 'utf8'))
  const candidates = JSON.parse(await readFile(CANDIDATES, 'utf8'))
  const bySession = new Map(candidates.sessions.map((session) => [session.sessionId, session]))
  const kept = []
  const dropped = []
  for (const session of bank.sessions) {
    const candidate = bySession.get(session.sessionId)
    if (candidate === undefined) throw new Error(`bank session ${session.sessionId} is not in candidates`)
    const questions = []
    for (const question of session.questions) {
      const verdict = await verifyQuestion(chat, candidate, question)
      if (verdict.answerable) questions.push(question)
      else dropped.push({ id: question.id, question: question.question, why: verdict.why })
    }
    if (questions.length > 0) kept.push({ ...session, questions })
  }
  const cost = (usage.input / 1e6 * PRICE.input + usage.output / 1e6 * PRICE.output) * 0.5
  const next = {
    ...bank,
    verifiedAt: new Date().toISOString(),
    provider,
    model,
    bankHash: bankHash(kept),
    counts: { ...bank.counts, sessions: kept.length, questions: kept.reduce((sum, session) => sum + session.questions.length, 0), droppedByVerifier: dropped.length },
    verifyUsage: { ...usage, estimatedCny: Number(cost.toFixed(3)) },
    sessions: kept,
  }
  await writeFile(BANK, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`verified: ${next.counts.questions} questions kept, ${dropped.length} dropped`)
  for (const item of dropped) console.log(`  - ${item.id}: ${item.question.slice(0, 60)} → ${item.why.slice(0, 60)}`)
  console.log(`bank ${next.bankHash.slice(0, 12)} · verifier cost ~¥${cost.toFixed(3)}`)
}

async function main() {
  if (!FORCE) {
    const existing = await readFile(BANK, 'utf8').catch(() => undefined)
    if (existing !== undefined) throw new Error(`${BANK} already exists; pass --force to author a new bank (the old scores stop being comparable)`)
  }
  const candidates = JSON.parse(await readFile(CANDIDATES, 'utf8'))
  const { chat, usage, provider, model } = createChat({
    provider: argValue('--provider') ?? 'ollama',
    model: argValue('--model'),
    keyFile: argValue('--key-file'),
  })
  if (process.argv.includes('--verify')) return await verifyBank({ chat, usage, provider, model })
  const sessions = []
  let authored = 0
  let dropped = 0
  for (const [index, session] of candidates.sessions.slice(0, LIMIT).entries()) {
    const reply = await chat([
      { role: 'system', content: AUTHOR_RULES },
      { role: 'user', content: JSON.stringify({ 节选: session.transcript }) },
    ], { json: true, numPredict: 700 })
    let parsed
    try {
      parsed = JSON.parse(reply)
    } catch {
      console.log(`  ${index + 1}/${candidates.sessions.length} ${session.sessionId.slice(0, 12)}: unparseable reply, skipped`)
      continue
    }
    const questions = []
    for (const raw of Array.isArray(parsed.questions) ? parsed.questions : []) {
      const normalized = normalizeQuestion(raw, session.transcript)
      if (normalized === undefined) {
        dropped += 1
        continue
      }
      questions.push({ id: `real-${session.sessionId.slice(-8)}-${questions.length + 1}`, ...normalized })
    }
    authored += questions.length
    if (questions.length > 0) {
      sessions.push({
        sessionId: session.sessionId,
        cwd: session.cwd,
        transcriptHash: session.transcriptHash,
        questions,
      })
    }
    console.log(`  ${index + 1}/${candidates.sessions.length} ${session.sessionId.slice(0, 12)}: ${questions.length} question(s)`)
  }
  const cost = (usage.input / 1e6 * PRICE.input + usage.output / 1e6 * PRICE.output) * 0.5
  const bank = {
    version: 'real-v1',
    generatedAt: new Date().toISOString(),
    provider,
    model,
    bankHash: bankHash(sessions),
    counts: { sessions: sessions.length, questions: authored, dropped, candidateSessions: candidates.sessions.length },
    usage: { ...usage, estimatedCny: Number(cost.toFixed(3)) },
    sessions,
  }
  await mkdir(DATA, { recursive: true })
  await writeFile(BANK, `${JSON.stringify(bank, null, 2)}\n`)
  console.log(`bank ${bank.bankHash.slice(0, 12)} · ${sessions.length} sessions · ${authored} questions · dropped ${dropped} invalid`)
  console.log(`usage: ${usage.calls} calls, ${usage.input} in / ${usage.output} out, ~¥${cost.toFixed(3)}`)
  console.log(`output: ${BANK}`)
}

await main()
