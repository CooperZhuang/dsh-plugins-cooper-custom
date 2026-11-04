/**
 * End-to-end memory benchmark: does the memory actually help answer?
 *
 * Three arms answer the same frozen questions:
 *   memory  — the conversation was mined by the real extractor, and the arm
 *             gets the same summary + recall context the plugin injects;
 *   rag     — the whole transcript is pasted in (the cheap upper bound);
 *   closed  — no context at all (guesses are not memory wins).
 *
 * The judge sees the question, the required/forbidden points and the answer —
 * never the arm — so a pass cannot depend on which arm produced it. Extraction
 * goes through the real `runExtraction` contract: the model must quote the
 * transcript verbatim, and a candidate whose quote is not found is dropped, so
 * this run also reports how often the evidence check rejected a candidate.
 *
 * Everything runs offline by default (`ollama`), or against the DeepSeek API with
 * `--provider deepseek` (the key is read from DEEPSEEK_API_KEY or from the DSH
 * credentials file; it is never printed). The bank is frozen by hash so editing
 * a scenario after a run invalidates its numbers.
 *
 * Usage:
 *   node bench/e2e/run.mjs                         # all scenarios, local ollama
 *   node bench/e2e/run.mjs --limit 4               # smoke run
 *   node bench/e2e/run.mjs --provider deepseek     # off-peak online run
 *   node bench/e2e/run.mjs --model qwen3.5:latest
 */
import { createHash } from 'node:crypto'
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXTRACT_SYSTEM, bindEvidence, parseExtraction } from '../../lib/extract.js'
import { MemoryStore } from '../../lib/storage.js'
import { renderHit, renderMemorySummary } from '../../lib/render.js'
import { searchMemories } from '../../lib/search.js'
import { SCENARIOS } from './scenarios.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')
const STORE_DIR = join(DATA, 'e2e-store')
const PROJECT_ROOT = join(DATA, 'e2e-project')
const RESULT_FILE = join(DATA, 'e2e-results.json')
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const DEEPSEEK = 'https://api.deepseek.com/chat/completions'
const PROVIDER = argValue('--provider') ?? 'ollama'
const MODEL = argValue('--model') ?? (PROVIDER === 'deepseek' ? 'deepseek-chat' : 'qwen3.5:latest')
const LIMIT = Number(argValue('--limit') ?? SCENARIOS.length)
const SUMMARY_BYTES = 4096
const RECALL_LIMIT = 4
// deepseek-chat list price, CNY per million tokens; the off-peak window is half.
const PRICE = { input: 2, output: 8 }

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

/** Read the DeepSeek key without echoing it: env first, then the DSH credentials file. */
async function apiKey() {
  const fromEnv = process.env['DEEPSEEK_API_KEY']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const file = argValue('--key-file') ?? join(homedir(), '.dsh', '.credentials.yaml')
  try {
    const text = await readFile(file, 'utf8')
    const match = /^\s+DEEPSEEK_API_KEY:\s*(\S+)\s*$/mu.exec(text)
    if (match !== null) return match[1]
  } catch {
    // Fall through to the error below: a missing key must be loud, not silent.
  }
  throw new Error('no DeepSeek API key: set DEEPSEEK_API_KEY or pass --key-file')
}

const usage = { input: 0, output: 0, calls: 0 }

/** One chat turn against the configured provider, with one retry on a transport error. */
async function chat(messages, { json = false, numPredict = 500 } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (PROVIDER === 'deepseek') {
        const response = await fetch(DEEPSEEK, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await apiKey()}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages,
            temperature: 0,
            max_tokens: numPredict,
            ...json ? { response_format: { type: 'json_object' } } : {},
          }),
        })
        if (!response.ok) throw new Error(`deepseek HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
        const value = await response.json()
        usage.calls += 1
        usage.input += value.usage?.prompt_tokens ?? 0
        usage.output += value.usage?.completion_tokens ?? 0
        return value.choices?.[0]?.message?.content ?? ''
      }
      const response = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages,
          stream: false,
          ...json ? { format: 'json' } : {},
          think: false,
          options: { temperature: 0, num_predict: numPredict },
        }),
      })
      if (!response.ok) throw new Error(`ollama HTTP ${response.status}`)
      const value = await response.json()
      usage.calls += 1
      return value.message?.content ?? ''
    } catch (error) {
      if (attempt === 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  return ''
}

/** Freeze identity of the bank: the exact scenarios a run was measured on. */
function bankHash(scenarios) {
  return createHash('sha256').update(JSON.stringify(scenarios)).digest('hex')
}

/** One extraction pass over one scenario, through the real contract. */
async function extractScenario(scenario) {
  const turns = scenario.turns
  const window = {
    text: turns.map((turn) => `${turn.role === 'user' ? 'USER' : 'ASSISTANT'}: ${turn.text}`).join('\n\n'),
    lastSeq: turns.length,
    messages: turns.length,
    sources: turns.map((turn, index) => ({ seq: index + 1, text: turn.text })),
  }
  const framed = [
    'Workspace scope label: project:e2e',
    'Extract at most 5 memories from this transcript.',
    '',
    window.text,
  ].join('\n')
  const reply = await chat([
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: framed },
  ], { json: true, numPredict: 1_200 })
  const parsed = parseExtraction(reply, 5, `e2e-${scenario.id}`)
  const bound = bindEvidence(parsed.drafts, window.sources)
  return { drafts: bound.drafts, unsupported: bound.unsupported, summary: parsed.summary }
}

/** Persist one scenario's verified drafts; returns the stored ids. */
async function storeScenario(store, scenario, drafts) {
  const stored = []
  for (const draft of drafts) {
    const projectRoot = draft.scope === 'project' ? PROJECT_ROOT : undefined
    const result = await store.upsert(draft, projectRoot, 'auto')
    stored.push(result.entry.id)
  }
  return stored
}

/** The context the memory arm sees: the injected summary plus on-demand recall. */
function memoryContext(entries, question) {
  const groups = [
    { scope: 'global', label: 'global', entries: entries.global },
    { scope: 'project', label: 'project:e2e', entries: entries.project },
  ]
  const summary = renderMemorySummary(groups.map((group) => ({
    label: group.label,
    heading: group.label,
    entries: group.entries,
    total: group.entries.length,
  })), { maxBytes: SUMMARY_BYTES, maxEntriesPerScope: 12 })
  const hits = searchMemories(groups, question, { limit: RECALL_LIMIT }).map(renderHit)
  return [summary ?? '', ...hits.length === 0 ? [] : ['', 'On-demand recall:', ...hits]].join('\n')
}

/** Ask one arm to answer, using only what that arm is given. */
async function answer(question, context) {
  const material = context.trim().length === 0 ? '（无资料）' : context
  return await chat([
    { role: 'system', content: '只依据下面提供的资料回答问题；资料里没有的信息就回答「不知道」。回答一两句话，不要复述资料。' },
    { role: 'user', content: `资料：\n${material}\n\n问题：${question}` },
  ], { numPredict: 200 })
}

/** Grade one answer blind: no arm label is sent, only the points to check. */
async function judge(scenario, answerText) {
  const reply = await chat([
    { role: 'system', content: '你是判分员，只返回 JSON。' },
    { role: 'user', content: JSON.stringify({
      问题: scenario.question,
      必需点: scenario.required,
      禁止点: scenario.forbidden,
      回答: answerText,
      要求: '回答表达了全部必需点（意思对即可，不要求原词）且没有表达禁止点，才算通过；回答「不知道」不算通过。只返回 {"pass":true|false,"reason":"一句话"}。',
    }) },
  ], { json: true, numPredict: 200 })
  try {
    const value = JSON.parse(reply)
    return { pass: value.pass === true, reason: String(value.reason ?? '') }
  } catch {
    // A judge that cannot answer is not a pass: report it as a failure with why.
    return { pass: false, reason: `judge reply was not JSON: ${reply.slice(0, 120)}` }
  }
}

function percentage(passed, total) {
  return total === 0 ? '—' : `${(passed / total * 100).toFixed(1)}% (${passed}/${total})`
}

async function main() {
  const scenarios = SCENARIOS.slice(0, Math.max(1, LIMIT))
  const hash = bankHash(scenarios)
  await mkdir(DATA, { recursive: true })
  // A fresh store per run: memory from a previous run would change the recipe.
  await rm(STORE_DIR, { recursive: true, force: true })
  await mkdir(STORE_DIR, { recursive: true })
  const store = new MemoryStore(STORE_DIR)

  console.log(`bank ${hash.slice(0, 12)} · ${scenarios.length} scenarios · model ${MODEL}`)

  /* ---------------------------------------------------------- extraction --- */
  const extraction = { drafts: 0, stored: 0, unsupported: 0, empty: 0 }
  const storedIds = new Map()
  for (const [index, scenario] of scenarios.entries()) {
    const result = await extractScenario(scenario)
    extraction.drafts += result.drafts.length + result.unsupported
    extraction.unsupported += result.unsupported
    extraction.empty += result.drafts.length === 0 && result.unsupported === 0 ? 1 : 0
    storedIds.set(scenario.id, await storeScenario(store, scenario, result.drafts))
    extraction.stored += storedIds.get(scenario.id).length
    console.log(`  extract ${index + 1}/${scenarios.length} ${scenario.id}: ${result.drafts.length} stored, ${result.unsupported} rejected`)
  }
  const entries = {
    project: await store.list('project', PROJECT_ROOT, { fresh: true }),
    global: await store.list('global', undefined, { fresh: true }),
  }

  /* -------------------------------------------------------------- arms --- */
  const rows = []
  for (const [index, scenario] of scenarios.entries()) {
    const ragContext = scenario.turns.map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`).join('\n')
    const arms = {
      memory: memoryContext(entries, scenario.question),
      rag: ragContext,
      closed: '',
    }
    const row = { id: scenario.id, category: scenario.category }
    for (const [arm, context] of Object.entries(arms)) {
      const reply = await answer(scenario.question, context)
      const verdict = await judge(scenario, reply)
      row[arm] = { pass: verdict.pass, answer: reply.trim(), reason: verdict.reason }
    }
    rows.push(row)
    console.log(`  ${index + 1}/${scenarios.length} ${scenario.id}: memory=${row.memory.pass ? 'P' : 'F'} rag=${row.rag.pass ? 'P' : 'F'} closed=${row.closed.pass ? 'P' : 'F'}`)
  }

  /* ------------------------------------------------------------ report --- */
  const cost = (usage.input / 1e6 * PRICE.input + usage.output / 1e6 * PRICE.output) * (offPeak() ? 0.5 : 1)
  const report = {
    at: new Date().toISOString(),
    provider: PROVIDER,
    model: MODEL,
    offPeak: offPeak(),
    usage: { ...usage, estimatedCny: Number(cost.toFixed(3)) },
    bankHash: hash,
    scenarios: scenarios.length,
    extraction,
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
  console.log(`extraction: ${extraction.stored} stored / ${extraction.drafts} candidates, ${extraction.unsupported} rejected by the quote check, ${extraction.empty} scenarios stored nothing`)
  const byCategory = new Map()
  for (const row of rows) {
    const bucket = byCategory.get(row.category) ?? { total: 0, memory: 0, rag: 0, closed: 0 }
    bucket.total += 1
    for (const arm of ['memory', 'rag', 'closed']) bucket[arm] += row[arm].pass ? 1 : 0
    byCategory.set(row.category, bucket)
  }
  for (const [category, bucket] of byCategory) {
    console.log(`  ${category}: memory ${bucket.memory}/${bucket.total}, rag ${bucket.rag}/${bucket.total}, closed ${bucket.closed}/${bucket.total}`)
  }

  console.log(`paid: ${usage.calls} calls, ${usage.input} in / ${usage.output} out tokens, ~¥${cost.toFixed(3)}${offPeak() ? ' (off-peak 半价)' : ' (非谷时)'}`)
  await writeFile(RESULT_FILE, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(`${RESULT_FILE.replace(/\.json$/u, '.md')}`, [
    `# 端到端记忆评测（${report.at}）`,
    '',
    `- 模型：\`${MODEL}\`（provider ${PROVIDER}${PROVIDER === 'ollama' ? '，零费用' : `，约 ¥${cost.toFixed(3)}${offPeak() ? '，谷时半价' : '，非谷时'}`}）`,
    `- 题库冻结哈希：\`${hash}\``,
    `- 场景数：${scenarios.length}`,
    '',
    '| 臂 | 通过 |',
    '| --- | --- |',
    `| memory（抽取+注入+补注） | ${report.arms.memory} |`,
    `| rag（整段对话原文） | ${report.arms.rag} |`,
    `| closed（无任何资料） | ${report.arms.closed} |`,
    '',
    `配对：${report.paired.memoryVsClosed}; ${report.paired.memoryVsRag}; ${report.paired.ragVsClosed}`,
    '',
    `抽取：${extraction.stored} 条入库 / ${extraction.drafts} 个候选；引文校验拒绝 ${extraction.unsupported} 个；${extraction.empty} 个场景一条没存下。`,
    '',
    '| 场景 | 类别 | memory | rag | closed |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.id} | ${row.category} | ${row.memory.pass ? 'P' : 'F'} | ${row.rag.pass ? 'P' : 'F'} | ${row.closed.pass ? 'P' : 'F'} |`),
    '',
    '> 判分由同一模型盲评（看不到臂名），样本量小，数字只用来看方向；逐题原始回答见同名 `.json`。',
  ].join('\n'))
  console.log(`results: ${RESULT_FILE}`)
}

await main()
