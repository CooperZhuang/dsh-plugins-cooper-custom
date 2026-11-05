/**
 * Real-session end-to-end benchmark: three arms on questions authored from real
 * conversations.
 *
 *   memory  — only the memory entries the plugin actually stored from that
 *             session (`sourceSession` link), rendered the way the plugin
 *             injects them plus on-demand recall for the question;
 *   rag     — the session transcript itself (the cheap upper bound);
 *   closed  — no context at all.
 *
 * The judge is the shared point-by-point judge from `../e2e/judge.mjs`, blind to
 * the arm. Everything stays local (`bench/data/`, gitignored): the transcripts
 * were already credential-scrubbed by `sample.mjs`, and questions were authored
 * from those scrubbed transcripts.
 *
 * Usage:
 *   node bench/real/run.mjs --provider deepseek
 *   node bench/real/run.mjs --provider deepseek --limit 5
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHit, renderMemorySummary } from '../../lib/render.js'
import { searchMemories } from '../../lib/search.js'
import { anchorGate, createJudge, percentage } from '../e2e/judge.mjs'
import { createChat } from './chat.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')
const CANDIDATES = join(DATA, 'real-candidates.json')
const BANK = join(DATA, 'real-bank.json')
const RESULT = join(DATA, 'real-results.json')
const SUMMARY_BYTES = 4096
const RECALL_LIMIT = 4
const PRICE = { input: 2, output: 8 }

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const LIMIT = Number(argValue('--limit') ?? Infinity)

/** DeepSeek's off-peak window: 00:30–08:30 Beijing time, half price. */
function offPeak(now = Date.now()) {
  const beijing = new Date(now + 8 * 3_600_000)
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return minutes >= 30 && minutes <= 8 * 60 + 30
}

/** The memory arm's context: the injected summary over this session's entries, plus recall. */
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
  const hits = searchMemories(groups.map((group) => ({ ...group, label: group.label })), question, { limit: RECALL_LIMIT }).map(renderHit)
  return [summary ?? '', ...hits.length === 0 ? [] : ['', 'On-demand recall:', ...hits]].join('\n')
}

/** Ask one arm to answer, using only what that arm is given. */
async function answer(chat, question, context) {
  const material = context.trim().length === 0 ? '（无资料）' : context
  return await chat([
    { role: 'system', content: '只依据下面提供的资料回答问题；资料里没有的信息就回答「不知道」。资料可能提到多个项目，问题里的「这个项目」指资料中与问题最相关的那个项目。回答要完整：问题问到的每件事都要答到，资料里与该问题相关的条件或替代做法也要一并说明；简短直接，不要复述资料。' },
    { role: 'user', content: `资料：\n${material}\n\n问题：${question}` },
  ], { numPredict: 200 })
}

async function main() {
  const candidates = JSON.parse(await readFile(CANDIDATES, 'utf8'))
  const bank = JSON.parse(await readFile(BANK, 'utf8'))
  const bySession = new Map(candidates.sessions.map((session) => [session.sessionId, session]))
  const { chat, usage, provider, model } = createChat({
    provider: argValue('--provider') ?? 'ollama',
    model: argValue('--model'),
    keyFile: argValue('--key-file'),
  })
  const judge = createJudge(chat)
  const anchor = await anchorGate(judge)
  if (!anchor.pass) console.log(`  WARNING: judge anchor failed ${JSON.stringify(anchor)}; grades are suspect`)

  const rows = []
  for (const [index, session] of bank.sessions.slice(0, LIMIT).entries()) {
    const candidate = bySession.get(session.sessionId)
    if (candidate === undefined) throw new Error(`bank session ${session.sessionId} is not in the candidates file`)
    const arms = {
      memory: memoryContext(candidate.entries, session.questions[0]?.question ?? ''),
      rag: candidate.transcript,
      closed: '',
    }
    for (const question of session.questions) {
      const row = { sessionId: session.sessionId, questionId: question.id, question: question.question }
      for (const [arm, context] of Object.entries(arms)) {
        // The recall query is the question itself, so the memory arm is rebuilt
        // per question; the summary half is the same and stays cheap.
        const armContext = arm === 'memory' ? memoryContext(candidate.entries, question.question) : context
        const reply = await answer(chat, question.question, armContext)
        const verdict = await judge(question, reply)
        row[arm] = { pass: verdict.pass, answer: reply.trim(), reason: verdict.reason, checks: verdict.checks }
      }
      rows.push(row)
      console.log(`  ${index + 1}/${bank.sessions.length} ${session.sessionId.slice(0, 12)} ${question.id}: memory=${row.memory.pass ? 'P' : 'F'} rag=${row.rag.pass ? 'P' : 'F'} closed=${row.closed.pass ? 'P' : 'F'}`)
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
    candidatesHash: createHash('sha256').update(JSON.stringify(candidates.sessions.map((session) => session.sessionId))).digest('hex'),
    judge: { anchor },
    sessions: bank.sessions.length,
    questions: rows.length,
    arms: {},
    paired: {},
    rows,
  }
  for (const arm of ['memory', 'rag', 'closed']) {
    report.arms[arm] = percentage(rows.filter((row) => row[arm].pass).length, rows.length)
  }
  const pairs = (left, right) => {
    const gain = rows.filter((row) => row[left].pass && !row[right].pass).length
    const loss = rows.filter((row) => !row[left].pass && row[right].pass).length
    return `${left} 赢 ${gain} / 输 ${loss}`
  }
  report.paired.memoryVsClosed = pairs('memory', 'closed')
  report.paired.memoryVsRag = pairs('memory', 'rag')
  report.paired.ragVsClosed = pairs('rag', 'closed')

  console.log('')
  console.log(`memory  ${report.arms.memory}`)
  console.log(`rag     ${report.arms.rag}`)
  console.log(`closed  ${report.arms.closed}`)
  console.log(`paired: ${report.paired.memoryVsClosed}; ${report.paired.memoryVsRag}; ${report.paired.ragVsClosed}`)
  console.log(`paid: ${usage.calls} calls, ${usage.input} in / ${usage.output} out, ~¥${cost.toFixed(3)}${offPeak() ? ' (off-peak 半价)' : ''}`)
  await mkdir(DATA, { recursive: true })
  await writeFile(RESULT, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`results: ${RESULT}`)
}

await main()
