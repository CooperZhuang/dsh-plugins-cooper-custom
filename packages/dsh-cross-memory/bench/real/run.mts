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
 * The judge is the shared point-by-point judge from `../e2e/judge.mts`, blind to
 * the arm. Everything stays local (`bench/data/`, gitignored): the transcripts
 * were already credential-scrubbed by `sample.mts`, and questions were authored
 * from those scrubbed transcripts.
 *
 * Usage:
 *   node bench/real/run.mts --provider deepseek
 *   node bench/real/run.mts --provider deepseek --limit 5
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStore } from '../../lib/storage.js'
import { renderHit, renderMemorySummary } from '../../lib/render.js'
import { searchMemories } from '../../lib/search.js'
import { anchorGate, createJudge, percentage } from '../e2e/judge.mts'
import { createChat } from './chat.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')
const CANDIDATES = join(DATA, 'real-candidates.json')
const BANK = join(DATA, 'real-bank.json')
const RESULT = join(DATA, 'real-results.json')
const REEXTRACT_ROOT = join(DATA, 'real-reextract')
const SUMMARY_BYTES = 4096
const RECALL_LIMIT = 4
const PRICE = { input: 2, output: 8 }

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const LIMIT = Number(argValue('--limit') ?? Infinity)
const ANSWER_VARIANT = argValue('--answer-variant') ?? 'complete'

/**
 * Answer-side prompt variants.
 *
 * `complete` is the current prompt; `commit` additionally tells the model not to
 * hedge with "资料没有提到" when the material does contain the answer. Five of the
 * more20 failures were context-had-it-but-answer-hedged, so this is a controlled
 * test of the answer side alone (same store, same questions, same judge).
 */
const ANSWER_SYSTEMS = {
  complete: '只依据下面提供的资料回答问题；资料里没有的信息就回答「不知道」。资料可能提到多个项目，问题里的「这个项目」指资料中与问题最相关的那个项目。回答要完整：问题问到的每件事都要答到，资料里与该问题相关的条件或替代做法也要一并说明；简短直接，不要复述资料。',
  commit: '只依据下面提供的资料回答问题。资料里有答案就直接给出结论，不要用「资料没有提到…」的口吻回避；问题问到的每个数字、名称、日期、路径都要写出来。资料里确实没有的，才回答「不知道」。回答要完整：问题问到的每件事都要答到，资料里与该问题相关的条件或替代做法一并说明；简短直接，不要复述资料。',
}
const ANSWER_SYSTEM = ANSWER_SYSTEMS[ANSWER_VARIANT]
if (ANSWER_SYSTEM === undefined) throw new Error(`unknown --answer-variant: ${ANSWER_VARIANT}`)

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
    { role: 'system', content: ANSWER_SYSTEM },
    { role: 'user', content: `资料：\n${material}\n\n问题：${question}` },
  ], { numPredict: 200 })
}

async function main() {
  const candidates = JSON.parse(await readFile(CANDIDATES, 'utf8'))
  const bank = JSON.parse(await readFile(BANK, 'utf8'))
  // `--reextract <variant>`: score the memory arm on a re-extracted store instead
  // of the live one (bench/real/reextract.mts writes these stores).
  const reextract = argValue('--reextract')
  if (reextract !== undefined) {
    for (const session of candidates.sessions) {
      const dir = join(REEXTRACT_ROOT, reextract, session.sessionId, 'store')
      const root = join(REEXTRACT_ROOT, reextract, session.sessionId, 'project')
      const store = new MemoryStore(dir)
      session.entries = [
        ...await store.list('project', root, { fresh: true }),
        ...await store.list('global', undefined, { fresh: true }),
      ]
    }
  }
  const memoryOnly = process.argv.includes('--memory-only')
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
      ...memoryOnly ? {} : { rag: candidate.transcript, closed: '' },
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
      const armsLine = Object.entries(row)
        .filter(([key]) => ['memory', 'rag', 'closed'].includes(key))
        .map(([key, value]) => `${key}=${value.pass ? 'P' : 'F'}`)
        .join(' ')
      console.log(`  ${index + 1}/${bank.sessions.length} ${session.sessionId.slice(0, 12)} ${question.id}: ${armsLine}`)
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
    reextract: reextract ?? null,
    answerVariant: ANSWER_VARIANT,
    sessions: bank.sessions.length,
    questions: rows.length,
    arms: {},
    paired: {},
    rows,
  }
  for (const arm of memoryOnly ? ['memory'] : ['memory', 'rag', 'closed']) {
    report.arms[arm] = percentage(rows.filter((row) => row[arm].pass).length, rows.length)
  }
  const pairs = (left, right) => {
    const gain = rows.filter((row) => row[left].pass && !row[right].pass).length
    const loss = rows.filter((row) => !row[left].pass && row[right].pass).length
    return `${left} 赢 ${gain} / 输 ${loss}`
  }
  if (!memoryOnly) {
    report.paired.memoryVsClosed = pairs('memory', 'closed')
    report.paired.memoryVsRag = pairs('memory', 'rag')
    report.paired.ragVsClosed = pairs('rag', 'closed')
  }

  console.log('')
  console.log(`memory  ${report.arms.memory}`)
  if (!memoryOnly) {
    console.log(`rag     ${report.arms.rag}`)
    console.log(`closed  ${report.arms.closed}`)
    console.log(`paired: ${report.paired.memoryVsClosed}; ${report.paired.memoryVsRag}; ${report.paired.ragVsClosed}`)
  }
  console.log(`paid: ${usage.calls} calls, ${usage.input} in / ${usage.output} out, ~¥${cost.toFixed(3)}${offPeak() ? ' (off-peak 半价)' : ''}`)
  await mkdir(DATA, { recursive: true })
  await writeFile(RESULT, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`results: ${RESULT}`)
}

await main()
