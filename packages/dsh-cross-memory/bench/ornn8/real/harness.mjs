/**
 * Real-session validation for dsh-cross-memory.
 *
 * Reads the user's ACTUAL production session logs (read-only) for one project,
 * replays them through the plugin's own extraction in time order, and at each
 * real user question checks whether the cross-session memory (everything BEFORE
 * that session) can reproduce what the assistant actually answered at the time.
 *
 * Nothing in the production project is touched: the store is a scratch dir.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MemoriesRuntime } from '/Users/cooper/Documents/Code/Dsh/dsh-plugins-cooper-custom/packages/dsh-cross-memory/lib/index.js'

const SESSIONS = '/tmp/mii-sessions.json'
const WORK = '/tmp/real-work'
const OUT = '/tmp/real-work/out'
const ANSWER_MODEL = 'deepseek-chat'
const RECENT_TURNS = 6

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
function credential(name) {
  const text = readFileSync('/Users/cooper/.dsh/.credentials.yaml', 'utf8')
  const match = new RegExp(`^\\s+${name}:\\s*(\\S+)\\s*$`, 'mu').exec(text)
  if (match === null) throw new Error(`missing credential ${name}`)
  return match[1]
}
const DEEPSEEK_KEY = credential('DEEPSEEK_API_KEY')

const RealDate = Date
let logicalNow = RealDate.now()
class HarnessDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(logicalNow); else super(...args) }
  static now() { return logicalNow }
}
globalThis.Date = HarnessDate
function setLogicalNow(ms) { logicalNow = ms }

async function deepseek(messages, { maxTokens = 2000, system } = {}) {
  const body = { model: ANSWER_MODEL, messages: [...(system === undefined ? [] : [{ role: 'system', content: system }]), ...messages], temperature: 0, max_tokens: maxTokens }
  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${DEEPSEEK_KEY}` }, body: JSON.stringify(body),
      })
      if (response.status === 429 || response.status >= 500) throw new Error(`deepseek HTTP ${response.status}`)
      if (!response.ok) throw new Error(`deepseek HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
      const value = await response.json()
      return { text: value.choices?.[0]?.message?.content ?? '', input: value.usage?.prompt_tokens ?? 0, output: value.usage?.completion_tokens ?? 0 }
    } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1))) }
  }
  throw lastError
}

function makeLlm(log, tag) {
  return {
    async *stream(options) {
      const messages = options.messages.map((m) => ({ role: m.role, content: m.content.filter((b) => b.type === 'text').map((b) => b.text).join('') }))
      const reply = await deepseek(messages, { system: options.system, maxTokens: options.maxTokens ?? 2000 })
      log.push({ tag, system: options.system, user: messages.map((m) => m.content).join('\n'), reply: reply.text })
      yield { type: 'text-delta', index: 0, text: reply.text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
function makeContext(llm) { return { get: (n) => (n === 'llm' ? llm : undefined), logger: { info: () => {}, warn: () => {}, debug: () => {} } } }

function makeSession(id, cwd) {
  const events = []
  let nextSeq = 1
  const session = {
    id,
    header: { version: 0, id, createdAt: 0, cwd, isSeeded: false },
    surface: { nodes: [] },
    eventAt(seq) {
      const event = events.find((item) => item.seq === seq)
      if (event === undefined) return undefined
      if (event.role === 'user') return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: event.text }], source: { kind: event.sourceKind } } }
      return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: event.text }], source: { kind: 'model' } } } }
    },
    requestHeader: () => ({ config: { provider: 'deepseek-account', model: ANSWER_MODEL } }),
    deriveMessages() {
      return events.map((event) => ({ id: `m${event.seq}`, role: event.role, content: [{ type: 'text', text: event.text }], source: event.role === 'user' ? { kind: event.sourceKind, form: 'recall' } : { kind: 'model' } }))
    },
    appendUser(text, sourceKind = 'user') { const seq = nextSeq++; events.push({ seq, role: 'user', text, sourceKind }); session.surface.nodes.push(seq); return seq },
    appendAssistant(text) { const seq = nextSeq++; events.push({ seq, role: 'assistant', text }); session.surface.nodes.push(seq); return seq },
  }
  return session
}
function makeAgent(session) { return { id: session.id, session, status: 'idle', async runMaintenance(fn) { return await fn() } } }
function messageText(message) {
  if (message === undefined) return ''
  return (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

/** Optimised (current) vs baseline (pre-optimisation) tunables. */
function runtimeConfig(storeDir, mode) {
  const base = {
    memoriesDir: storeDir, projectRootMarkers: ['.git'], autoExtract: true,
    extractWindowMessages: 200, extractMaxInputChars: 96000, extractMaxMemories: 5,
    extractMaxOutputTokens: 8192, extractTimeoutMs: 120000, extractIntervalMinutes: 30,
    minIdleHours: 0.5, peakHours: '', consolidate: true, sweepIntervalHours: 12,
    maxEntriesPerScope: 0, maxUnusedDays: 0, snapshotMaxAgeDays: 0, rawRecall: true,
  }
  if (mode === 'base') return { ...base, maxSummaryBytes: 4096, maxSummaryEntries: 12, globalSummaryEntries: 4, recallMinScore: 9, recallMinTerms: 2, recallMaxPerConversation: 4, recallMaxBytes: 1200, recallMaxPerConversation_unused: undefined }
  return { ...base, maxSummaryBytes: 8192, maxSummaryEntries: 20, globalSummaryEntries: 6, summaryFreshSlots: 3, recallMode: 'on-demand', recallMinScore: 6, recallMinTerms: 1, recallMaxPerConversation: 8, recallMaxBytes: 2400 }
}

const mode = arg('--mode', 'opt')
const reuse = arg('--reuse', 'true') !== 'false'
const projectRoot = arg('--root', '/Users/cooper/Documents/Code/Mubea/Mubea_Invoice-Insight')
const storeDir = join(WORK, 'stores', `mii-${mode}`)
const log = []
if (!reuse) rmSync(storeDir, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const sessions = JSON.parse(readFileSync(SESSIONS, 'utf8'))
const runtime = new MemoriesRuntime(makeContext(makeLlm(log, 'extract')), runtimeConfig(storeDir, mode))
const results = []
let fedSessions = 0

for (let index = 0; index < sessions.length; index += 1) {
  const record = sessions[index]
  const msgs = record.msgs
  if (msgs.length === 0) continue
  const firstTime = Math.min(...msgs.map((m) => m.time).filter(Boolean))
  setLogicalNow(firstTime)

  // The memory under test is everything BEFORE this session.
  const realQuestions = []
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i]
    if (m.role !== 'user' || m.kind !== 'user') continue
    const text = m.text.trim()
    if (text.length < 8 || /^You are |^你是 |^#|^##/u.test(text)) continue
    const answer = msgs.slice(i + 1).find((x) => x.role === 'assistant')
    if (answer === undefined) continue
    realQuestions.push({ time: m.time, question: text.slice(0, 500), actual: answer.text.slice(0, 1200) })
  }
  if (realQuestions.length === 0) { /* still feed below */ }

  // Ask each real question against the memory built so far.
  for (const q of realQuestions.slice(0, 2)) {
    const examSession = makeSession(`exam-${record.sid}-${q.time}`, projectRoot)
    const recent = msgs.filter((m) => m.time <= q.time).slice(-RECENT_TURNS)
    for (const m of recent) {
      if (m.role === 'user') examSession.appendUser(m.text.slice(0, 3000), m.kind)
      else examSession.appendAssistant(m.text.slice(0, 3000))
    }
    let summary, recall
    try {
      const examAgent = makeAgent(examSession)
      summary = await runtime.injectionFor(examAgent)
      examSession.appendUser(q.question)
      recall = await runtime.recallFor(examAgent)
    } catch (error) { summary = ''; recall = `ERR ${error.message}` }
    const projection = `${messageText(summary)}\n${messageText(recall)}`
    const answer = await deepseek([
      { role: 'user', content: `${projection}\n\n用户问题：${q.question}` },
    ], { system: '你是助手。只依据下面提供的资料回答问题。资料里没有的信息就回答「不知道」。问题问到的每件事都要答到。资料里没有说明原因、后续或结果时，要明确说「没有说明」，不要自己推测。只回答问题问到的内容，不要补充与问题无关的细节。简短直接。' })
    results.push({ sid: record.sid, time: q.time, question: q.question, actual: q.actual, recallAnswer: answer.text, projection: projection.slice(0, 4000), memoryCount: 0 })
  }

  // Now feed this session so the next one is tested against it.
  const feed = makeSession(record.sid, projectRoot)
  for (const m of msgs) {
    if (m.role === 'user') feed.appendUser(m.text.slice(0, 6000), m.kind === 'user' ? 'user' : 'agent-message')
    else feed.appendAssistant(m.text.slice(0, 6000))
  }
  if (reuse === false) { try { await runtime.mine(makeAgent(feed), { ignoreIdleWindow: true, ignorePeakHours: true }) } catch (error) { log.push({ tag: 'mine-error', sid: record.sid, error: String(error.message).slice(0, 200) }) } }
  fedSessions += 1
  if (fedSessions % 10 === 0) console.error(`fed ${fedSessions}/${sessions.length}, questions ${results.length}`)
}

writeFileSync(join(OUT, `real-${mode}.json`), JSON.stringify({ mode, projectRoot, fedSessions, results }, null, 2))
writeFileSync(join(OUT, `real-${mode}-extract-log.json`), JSON.stringify(log, null, 2))
console.log(`mode=${mode} fed=${fedSessions} questions=${results.length}`)
