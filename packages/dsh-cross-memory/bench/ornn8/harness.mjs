/**
 * Ornn8 chat-memory-benchmark adapter for dsh-cross-memory.
 *
 * Drives the plugin's real extraction/injection/recall code against the frozen
 * six-persona dataset.  History is replayed through the plugin's own session
 * surface; extraction runs through `MemoriesRuntime.mine` (the native idle
 * pass), and each exam is answered from the plugin's own summary + on-demand
 * recall projection plus the declared six-turn short-term window.
 *
 * No full transcript and no answer key is ever handed to the answering model.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MemoriesRuntime } from '/Users/cooper/Documents/Code/Dsh/dsh-plugins-cooper-custom/packages/dsh-cross-memory/lib/index.js'

const ROOT = '/tmp/chat-memory-benchmark'
const DATA = join(ROOT, 'datasets/natural-timegrid-20261101-v2')
const WORK = '/tmp/ornn8-work'
const OUT = join(ROOT, 'outputs')

const PERSONAS = ['P01', 'P12', 'P14', 'P16', 'P17', 'P20']
const MIN_IDLE_HOURS = 0.5
const RECENT_TURNS = 6
const ANSWER_MODEL = 'deepseek-chat'
const EXTRACT_MODEL = 'deepseek-chat'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

function readJsonl(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function credential(name) {
  const text = readFileSync('/Users/cooper/.dsh/.credentials.yaml', 'utf8')
  const match = new RegExp(`^\\s+${name}:\\s*(\\S+)\\s*$`, 'mu').exec(text)
  if (match === null) throw new Error(`missing credential ${name}`)
  return match[1]
}

const DEEPSEEK_KEY = credential('DEEPSEEK_API_KEY')
const usage = { extract: { input: 0, output: 0, calls: 0 }, answer: { input: 0, output: 0, calls: 0 } }

/*
 * The benchmark runs on logical time.  The plugin resolves relative dates and
 * loop deadlines against `Date.now()` / `new Date()`, so the harness process
 * presents the logical clock to it without touching the OS clock.  Only the
 * no-argument forms are shifted; `new Date(iso)` still parses the real instant.
 */
const RealDate = Date
let logicalNow = RealDate.now()
class HarnessDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(logicalNow)
    else super(...args)
  }
  static now() { return logicalNow }
}
globalThis.Date = HarnessDate
function setLogicalNow(ms) { logicalNow = ms }

/** One DeepSeek chat completion, with retries on transient transport/HTTP errors. */
async function deepseek(messages, { maxTokens = 2000, system } = {}) {
  const body = {
    model: ANSWER_MODEL,
    messages: [...(system === undefined ? [] : [{ role: 'system', content: system }]), ...messages],
    temperature: 0,
    max_tokens: maxTokens,
  }
  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${DEEPSEEK_KEY}` },
        body: JSON.stringify(body),
      })
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`deepseek HTTP ${response.status}`)
      }
      if (!response.ok) throw new Error(`deepseek HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
      const value = await response.json()
      return {
        text: value.choices?.[0]?.message?.content ?? '',
        input: value.usage?.prompt_tokens ?? 0,
        output: value.usage?.completion_tokens ?? 0,
      }
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)))
    }
  }
  throw lastError
}

/** The plugin's LLM seam: streams one JSON extraction reply. */
function makeLlm(log, tag) {
  return {
    async *stream(options) {
      const messages = options.messages.map((message) => ({
        role: message.role,
        content: message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
      }))
      const reply = await deepseek(messages, { system: options.system, maxTokens: options.maxTokens ?? 2000 })
      usage[tag].calls += 1
      usage[tag].input += reply.input
      usage[tag].output += reply.output
      log.push({ tag, inputTokens: reply.input, outputTokens: reply.output, system: options.system, user: messages.map((m) => m.content).join('\n'), reply: reply.text })
      yield { type: 'text-delta', index: 0, text: reply.text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function makeContext(llm) {
  return {
    get: (name) => (name === 'llm' ? llm : undefined),
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  }
}

/** A session stand-in with a controllable surface, matching the plugin's tests. */
function makeSession(id, cwd, route) {
  const events = []
  let nextSeq = 1
  const session = {
    id,
    header: { version: 0, id, createdAt: 0, cwd, isSeeded: false },
    surface: { nodes: [] },
    eventAt(seq) {
      const event = events.find((item) => item.seq === seq)
      if (event === undefined) return undefined
      if (event.role === 'user') {
        return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: event.text }], source: { kind: event.sourceKind } } }
      }
      return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: event.text }], source: { kind: 'model' } } } }
    },
    requestHeader: () => ({ config: { provider: route.provider, model: route.model } }),
    deriveMessages() {
      return events.map((event) => ({
        id: `m${event.seq}`,
        role: event.role,
        content: [{ type: 'text', text: event.text }],
        source: event.role === 'user' ? { kind: event.sourceKind, form: 'recall' } : { kind: 'model' },
      }))
    },
    appendUser(text, sourceKind = 'user') {
      const seq = nextSeq++
      events.push({ seq, role: 'user', text, sourceKind })
      session.surface.nodes.push(seq)
      return seq
    },
    appendAssistant(text) {
      const seq = nextSeq++
      events.push({ seq, role: 'assistant', text })
      session.surface.nodes.push(seq)
      return seq
    },
  }
  return session
}

function makeAgent(session) {
  return { id: session.id, session, status: 'idle', async runMaintenance(fn) { return await fn() } }
}

function messageText(message) {
  if (message === undefined) return ''
  return (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

function runtimeConfig(storeDir, logFile) {
  return {
    memoriesDir: storeDir,
    projectRootMarkers: ['.git'],
    logFile,
    autoExtract: true,
    extractWindowMessages: 200,
    extractMaxInputChars: 96000,
    extractMaxMemories: 8,
    extractMaxOutputTokens: 8192,
    extractTimeoutMs: 120000,
    extractIntervalMinutes: 30,
    minIdleHours: MIN_IDLE_HOURS,
    peakHours: '',
    maxSummaryBytes: 8192,
    globalSummaryEntries: 6,
    globalSummaryBytes: 1200,
    summaryFreshSlots: 3,
    rawRecall: true,
    recallMode: 'on-demand',
    recallMinScore: 6,
    recallMinTerms: 1,
    recallMaxPerConversation: 8,
    recallMaxBytes: 2400,
    consolidate: true,
    sweepIntervalHours: 12,
    maxEntriesPerScope: 1000,
    maxUnusedDays: 90,
    maxAgeDays: 10,
  }
}

async function runPersona(persona, history, exams, route, log) {
  const storeDir = join(WORK, 'stores', persona)
  const projectRoot = join(WORK, 'projects', persona)
  mkdirSync(join(projectRoot, '.git'), { recursive: true })
  const logFile = join(WORK, 'logs', `${persona}.log`)
  mkdirSync(join(WORK, 'logs'), { recursive: true })
  const runtime = new MemoriesRuntime(makeContext(makeLlm(log, 'extract')), runtimeConfig(storeDir, logFile))
  const session = makeSession(`ornn8-${persona}`, projectRoot, route)
  const agent = makeAgent(session)

  const counters = { extractions: 0, stored: 0, empty: 0, exams: 0, answers: 0 }
  const answers = []
  let turnIndex = 0
  let lastTurnTime = -Infinity

  const extract = async (why, at) => {
    counters.extractions += 1
    if (at !== undefined) setLogicalNow(at)
    let outcome
    try {
      outcome = await runtime.mine(agent, { ignoreIdleWindow: true, ignorePeakHours: true })
    } catch (error) {
      outcome = { stored: 0, reason: `error: ${String(error)}` }
    }
    counters.stored += outcome.stored
    if (outcome.stored === 0) counters.empty += 1
    log.push({ event: 'extract', persona, why, ...outcome })
    return outcome
  }

  for (const exam of exams) {
    // Replay every turn up to this exam's cutoff, running the native idle
    // extraction during gaps long enough to settle.
    while (turnIndex < exam.cutoff_turn) {
      const turn = history[turnIndex]
      const turnTime = new Date(turn['逻辑时间']).getTime()
      if (turnIndex > 0 && turnTime - lastTurnTime >= MIN_IDLE_HOURS * 3_600_000) {
        await extract(`idle-gap-before-turn-${turn['轮次']}`, lastTurnTime + MIN_IDLE_HOURS * 3_600_000)
      }
      session.appendUser(turn['用户消息'])
      session.appendAssistant(turn['助手回复'])
      runtime.recordActivity(session, turnTime)
      lastTurnTime = turnTime
      turnIndex += 1
    }
    // Maintenance that would have fired between the last turn and the exam.
    const examTime = new Date(exam.now).getTime()
    if (turnIndex > 0 && examTime - lastTurnTime >= MIN_IDLE_HOURS * 3_600_000) {
      await extract(`idle-gap-before-exam-${exam.id}`, examTime)
    }
    setLogicalNow(examTime)

    // Independent exam session: declared six-turn window + the question.
    const examSession = makeSession(`${persona}-exam-${exam.id}`, projectRoot, route)
    const examAgent = makeAgent(examSession)
    const start = Math.max(0, exam.cutoff_turn - RECENT_TURNS)
    for (let index = start; index < exam.cutoff_turn; index += 1) {
      examSession.appendUser(history[index]['用户消息'])
      examSession.appendAssistant(history[index]['助手回复'])
    }
    let summary
    let recall
    try {
      summary = await runtime.injectionFor(examAgent)
      examSession.appendUser(exam.question)
      recall = await runtime.recallFor(examAgent)
    } catch (error) {
      log.push({ event: 'projection-error', persona, id: exam.id, error: String(error) })
      examSession.appendUser(exam.question)
    }

    const memoryState = {
      global: (await runtime.store.list('global', undefined, { fresh: true }).catch(() => [])).map((entry) => ({ id: entry.id, title: entry.title, body: entry.body })),
      project: (await runtime.store.list('project', projectRoot, { fresh: true }).catch(() => [])).map((entry) => ({ id: entry.id, title: entry.title, body: entry.body })),
    }
    let loops = []
    try { loops = JSON.parse(readFileSync(join(storeDir, 'loops.json'), 'utf8')).loops } catch { loops = [] }

    const recent = history.slice(start, exam.cutoff_turn)
      .map((turn) => `用户：${turn['用户消息']}\n助手：${turn['助手回复']}`)
      .join('\n\n')
    const memoryBlocks = [messageText(summary), messageText(recall)].filter((text) => text.trim().length > 0).join('\n\n')
    const system = '你是助手。只依据下面提供的资料回答问题。资料里没有的信息就回答「不知道」。问题问到的每件事都要答到；资料里与该问题相关的条件、期限或替代做法也要一并说明。资料里没有说明原因、后续或结果时，要明确说「没有说明」，不要自己推测。只回答问题问到的内容，不要补充与问题无关的细节。简短直接，不要复述资料。'
    const prompt = [
      memoryBlocks.trim().length === 0 ? '' : `记忆资料：\n${memoryBlocks}\n\n`,
      `最近对话：\n${recent}\n\n`,
      `当前时间：${exam.now}\n问题：${exam.question}`,
    ].join('')

    let answer = ''
    let error = undefined
    try {
      const reply = await deepseek([{ role: 'user', content: prompt }], { system, maxTokens: 500 })
      usage.answer.calls += 1
      usage.answer.input += reply.input
      usage.answer.output += reply.output
      answer = reply.text.trim()
      counters.answers += 1
    } catch (caught) {
      error = String(caught)
    }
    counters.exams += 1
    answers.push({ id: exam.id, answer, error })
    log.push({
      event: 'exam', persona, id: exam.id, now: exam.now, cutoff_turn: exam.cutoff_turn,
      summary: messageText(summary), recall: messageText(recall), memoryState, loops, answer, error,
    })
  }

  runtime.dispose()
  return { persona, counters, answers }
}

async function main() {
  const only = arg('--personas', null)
  const limitTurns = Number(arg('--limit-turns', '0'))
  const personas = only === null ? PERSONAS : only.split(',')
  rmSync(join(WORK, 'stores'), { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const log = []
  const allAnswers = []
  const results = await Promise.all(personas.map(async (persona) => {
    const history = readJsonl(join(DATA, 'histories', `${persona}.jsonl`))
    const rows = readJsonl(join(DATA, 'exam-inputs.jsonl')).filter((row) => row.persona === persona)
    rows.sort((left, right) => new Date(left.now) - new Date(right.now))
    if (limitTurns > 0) {
      const maxCutoff = Math.max(...rows.map((row) => row.cutoff_turn))
      const keep = Math.min(maxCutoff, limitTurns)
      return await runPersona(persona, history, rows.filter((row) => row.cutoff_turn <= keep), { provider: 'deepseek', model: EXTRACT_MODEL }, log)
    }
    return await runPersona(persona, history, rows, { provider: 'deepseek', model: EXTRACT_MODEL }, log)
  }))
  for (const result of results) {
    allAnswers.push(...result.answers)
    console.log(`${result.persona}: ${JSON.stringify(result.counters)}`)
  }
  allAnswers.sort((left, right) => left.id.localeCompare(right.id))
  writeFileSync(join(OUT, 'answers.jsonl'), allAnswers.map((row) => JSON.stringify({ id: row.id, answer: row.answer })).join('\n') + '\n')
  writeFileSync(join(OUT, 'run-log.jsonl'), log.map((row) => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(OUT, 'usage.json'), JSON.stringify(usage, null, 2) + '\n')
  console.log(`answers: ${allAnswers.length}, errors: ${allAnswers.filter((row) => row.error).length}`)
  console.log(`usage: ${JSON.stringify(usage)}`)
}

await main()
