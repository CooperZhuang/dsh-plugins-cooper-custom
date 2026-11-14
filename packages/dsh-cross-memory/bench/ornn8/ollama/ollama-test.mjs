/**
 * 本地 ollama vs DeepSeek 的抽取质量对比。
 *
 * 用真实会话做抽取，逐条核对三件事：JSON 是否合法、quote 是否逐字来自对话、
 * 以及和 DeepSeek 抽出的记忆差多少。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MemoriesRuntime } from '/Users/cooper/Documents/Code/Dsh/dsh-plugins-cooper-custom/packages/dsh-cross-memory/lib/index.js'

const SESSIONS = '/tmp/mii-sessions.json'
const WORK = '/tmp/ollama-work'
const OLLAMA = 'http://192.168.31.21:11434/v1/chat/completions'

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
const mode = arg('--model', 'qwen3.8:27b')

async function call(messages, { system, maxTokens = 4000 }) {
  const body = {
    model: mode,
    messages: [...(system === undefined ? [] : [{ role: 'system', content: system }]), ...messages],
    temperature: 0, max_tokens: maxTokens, stream: false,
  }
  const isOllama = mode !== 'deepseek-chat'
  const url = isOllama ? OLLAMA : 'https://api.deepseek.com/chat/completions'
  const headers = isOllama ? { 'content-type': 'application/json' } : { 'content-type': 'application/json', authorization: `Bearer ${DEEPSEEK_KEY}` }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const value = await response.json()
  const content = value.choices?.[0]?.message?.content ?? ''
  return { text: content, input: value.usage?.prompt_tokens ?? 0, output: value.usage?.completion_tokens ?? 0 }
}

const log = []
function makeLlm() {
  return {
    async *stream(options) {
      const messages = options.messages.map((m) => ({ role: m.role, content: m.content.filter((b) => b.type === 'text').map((b) => b.text).join('') }))
      const reply = await call(messages, { system: options.system, maxTokens: options.maxTokens ?? 4000 })
      log.push({ system: options.system, user: messages.map((m) => m.content).join('\n'), reply: reply.text })
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
    requestHeader: () => ({ config: { provider: 'ollama', model: mode } }),
    deriveMessages() {
      return events.map((event) => ({ id: `m${event.seq}`, role: event.role, content: [{ type: 'text', text: event.text }], source: event.role === 'user' ? { kind: event.sourceKind, form: 'recall' } : { kind: 'model' } }))
    },
    appendUser(text, sourceKind = 'user') { const seq = nextSeq++; events.push({ seq, role: 'user', text, sourceKind }); session.surface.nodes.push(seq); return seq },
    appendAssistant(text) { const seq = nextSeq++; events.push({ seq, role: 'assistant', text }); session.surface.nodes.push(seq); return seq },
  }
  return session
}
function makeAgent(session) { return { id: session.id, session, status: 'idle', async runMaintenance(fn) { return await fn() } } }

const RealDate = Date
let logicalNow = RealDate.now()
class HarnessDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(logicalNow); else super(...args) }
  static now() { return logicalNow }
}
globalThis.Date = HarnessDate
function setLogicalNow(ms) { logicalNow = ms }

const storeDir = join(WORK, 'store-' + mode.replace(/[:.]/gu, '_'))
rmSync(storeDir, { recursive: true, force: true })
mkdirSync(storeDir, { recursive: true })
const runtime = new MemoriesRuntime(makeContext(makeLlm()), {
  memoriesDir: storeDir, projectRootMarkers: ['.git'], autoExtract: true,
  extractWindowMessages: 200, extractMaxInputChars: 96000, extractMaxMemories: 8,
  extractMaxOutputTokens: 8192, extractTimeoutMs: 600000, extractIntervalMinutes: 30,
  minIdleHours: 0.5, peakHours: '', consolidate: false, sweepIntervalHours: 12,
  maxEntriesPerScope: 0, maxUnusedDays: 0, snapshotMaxAgeDays: 0, rawRecall: true,
  maxSummaryBytes: 8192, maxSummaryEntries: 20, globalSummaryEntries: 6, summaryFreshSlots: 3,
  recallMode: 'on-demand', recallMinScore: 6, recallMinTerms: 1, recallMaxPerConversation: 8, recallMaxBytes: 2400,
})
const projectRoot = '/Users/cooper/Documents/Code/Mubea/Mubea_Invoice-Insight'
const sessions = JSON.parse(readFileSync(SESSIONS, 'utf8'))
sessions.sort((a, b) => Math.min(...a.msgs.map((m) => m.time).filter(Boolean)) - Math.min(...b.msgs.map((m) => m.time).filter(Boolean)))
const pick = sessions.filter((s) => s.msgs.length >= 6).slice(0, 12)
const results = []
for (const s of pick) {
  setLogicalNow(Math.min(...s.msgs.map((m) => m.time).filter(Boolean)))
  const feed = makeSession(s.sid, projectRoot)
  for (const m of s.msgs) {
    if (m.role === 'user') feed.appendUser(m.text.slice(0, 6000), m.kind === 'user' ? 'user' : 'agent-message')
    else feed.appendAssistant(m.text.slice(0, 6000))
  }
  const started = RealDate.now()
  let outcome = null
  try { outcome = await runtime.mine(makeAgent(feed), { ignoreIdleWindow: true, ignorePeakHours: true }) } catch (error) { outcome = { error: String(error.message).slice(0, 200) } }
  const ms = RealDate.now() - started
  const entries = await runtime.store.list('project', projectRoot, { fresh: true }).catch(() => [])
  results.push({ sid: s.sid, ms, error: outcome?.error, stored: entries.length, titles: entries.map((e) => e.title), raw: (log[log.length - 1]?.reply ?? '').slice(0, 3000) })
  console.error(`${s.sid.slice(0, 8)} ${ms}ms stored=${entries.length}${outcome?.error ? ' ERR ' + outcome.error : ''}`)
}
writeFileSync(join(WORK, `extract-${mode.replace(/[:.]/gu, '_')}.json`), JSON.stringify(results, null, 2))
console.log('model', mode, 'sessions', results.length, 'total stored', results.reduce((a, r) => a + r.stored, 0), 'total ms', results.reduce((a, r) => a + r.ms, 0))
