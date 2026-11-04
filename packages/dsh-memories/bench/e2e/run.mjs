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
import { renderHit, renderMemorySummary, renderOpenLoops } from '../../lib/render.js'
import { searchMemories } from '../../lib/search.js'
import { mergeLoops, pruneLoops, readLoops, writeLoops } from '../../lib/loops.js'
import { SCENARIOS } from './scenarios.mjs'

// The extra bank is separate so the first 23 scenarios stay byte-identical to
// the run they were measured in; a missing file simply means "base bank only".
const SCENARIOS_EXTRA = await import('./scenarios-extra.mjs')
  .then((module) => module.SCENARIOS_EXTRA ?? [])
  .catch(() => [])
const BANK = [...SCENARIOS, ...SCENARIOS_EXTRA]

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')
const STORE_DIR = join(DATA, 'e2e-store')
const PROJECT_ROOT = join(DATA, 'e2e-project')
const RESULT_FILE = join(DATA, 'e2e-results.json')
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const DEEPSEEK = 'https://api.deepseek.com/chat/completions'
const PROVIDER = argValue('--provider') ?? 'ollama'
const MODEL = argValue('--model') ?? (PROVIDER === 'deepseek' ? 'deepseek-chat' : 'qwen3.5:latest')
const LIMIT = argValue('--limit') === undefined ? undefined : Number(argValue('--limit'))
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
  return { drafts: bound.drafts, unsupported: bound.unsupported, summary: parsed.summary, loops: parsed.loops }
}

/** Persist one scenario's verified drafts; returns the stored ids. */
async function storeScenario(scenario, root, drafts) {
  const dir = join(STORE_DIR, scenario.id)
  const store = new MemoryStore(dir)
  const stored = []
  for (const draft of drafts) {
    const projectRoot = draft.scope === 'project' ? root : undefined
    const result = await store.upsert(draft, projectRoot, 'auto')
    stored.push(result.entry.id)
  }
  return stored
}

/** The context the memory arm sees: the injected summary plus on-demand recall. */
function memoryContext(entries, loops, question) {
  const groups = [
    { scope: 'global', label: 'global', entries: entries.global },
    { scope: 'project', label: 'project:e2e', entries: entries.project },
  ]
  // The plugin puts open loops inside the same injected block as the memories;
  // this arm mirrors that, otherwise it measures a context the user never sees.
  const loopNote = renderOpenLoops(loops, { now: Date.now() })
  const summary = renderMemorySummary(groups.map((group) => ({
    label: group.label,
    heading: group.label,
    entries: group.entries,
    total: group.entries.length,
  })), { maxBytes: SUMMARY_BYTES, maxEntriesPerScope: 12, ...loopNote === undefined ? {} : { note: loopNote } })
  const hits = searchMemories(groups, question, { limit: RECALL_LIMIT }).map(renderHit)
  return [summary ?? loopNote ?? '', ...hits.length === 0 ? [] : ['', 'On-demand recall:', ...hits]].join('\n')
}

/** Ask one arm to answer, using only what that arm is given. */
async function answer(question, context) {
  const material = context.trim().length === 0 ? '（无资料）' : context
  return await chat([
    { role: 'system', content: '只依据下面提供的资料回答问题；资料里没有的信息就回答「不知道」。资料可能提到多个项目，问题里的「这个项目」指资料中与问题最相关的那个项目。回答要完整：问题问到的每件事都要答到，资料里与该问题相关的条件或替代做法也要一并说明；简短直接，不要复述资料。' },
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
      要求: '判通过的两条规则。一、必需点：回答必须表达每一条（意思对即可，不要求原词）。二、禁止点：只有回答把禁止点描述的做法/说法当作正确或当前事实来支持时，才算“表达禁止点”。回答明确反对、劝阻、否定它，或说它不成立，都不算违反；判断时只看回答的主张，不要因为出现相同词语就判违反。例如禁止点「可以直接 force-push」，回答「不要直接 force-push，先问我」不算违反；禁止点「双击结果可以当准」，回答「不要相信双击结果」不算违反。禁止点在回答里作为例外、条件或对照被提起（例如回答「CI 里仍可用 3000」并不违反「本地必须用 3000」）也不算违反。回答「不知道」不算通过。只返回 {"pass":true|false,"reason":"一句话"}。',
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

/**
 * Two fixed anchors that pin the judge's forbidden-point rule.
 *
 * The first run's one memory-arm failure was exactly this ambiguity: the answer
 * said "本地 4567，CI 仍可用 3000" and was graded as violating "本地用 3000".
 * An anchor pair makes that rule checkable before any paid grading: a correct
 * answer that mentions the exception must pass, a wrong answer must fail.
 */
async function anchorGate() {
  const question = '本地开发服务器该用哪个端口？'
  const good = await judge({ question, required: ['本地用 4567'], forbidden: ['本地必须用 3000'] },
    '本地开发固定用 4567，3000 会和其他项目冲突；CI 里仍可用 3000。')
  const bad = await judge({ question, required: ['本地用 4567'], forbidden: ['本地必须用 3000'] },
    '本地开发就用 3000。')
  // The second failure mode seen in a run: the forbidden point is the OPPOSITE
  // of what the answer says ("旧配置下测的"), and a judge that matches on shared
  // words fails a correct answer. This anchor pins the negation rule.
  const opposite = await judge({ question: '这些延迟数字是什么配置下测的？', required: ['旧限流配置'], forbidden: ['改限流后的配置'] },
    '这些数字是旧限流配置下测的。')
  // And a partial answer must fail: the round-3 open-plan row failed both arms
  // for omitting the second promise, and the judge has to be able to see that.
  const partial = await judge({ question: '本地起服务和跑测试分别用什么？', required: ['起服务用 4567', '测试用 pnpm test'], forbidden: [] },
    '起服务用 4567。')
  // A negated prohibition must pass. Round 4 failed two correct answers
  // ("不要相信双击结果", "禁止直接在 main 上改") because the judge only saw the
  // forbidden point's words; this anchor pins the rule the prompt states.
  const negated = await judge({ question: '可以直接 force-push 吗？', required: ['不能直接 force-push'], forbidden: ['可以直接 force-push'] },
    '不能，不要直接 force-push，推之前先问我。')
  return {
    pass: good.pass === true && bad.pass === false && opposite.pass === true && partial.pass === false && negated.pass === true,
    good: good.pass,
    bad: bad.pass,
    opposite: opposite.pass,
    partial: partial.pass,
    negated: negated.pass,
  }
}

/**
 * Re-grade a saved run's stored answers with the current judge — no new answers.
 *
 * A judge rule can be wrong without the answers being wrong: round 3 failed one
 * correct answer because the forbidden point was the opposite of what it said.
 * Re-grading keeps the answers and the bank frozen, so the only thing that
 * changes is the grading rule; the original scores stay in the source file.
 */
async function regrade(file) {
  const report = JSON.parse(await readFile(file, 'utf8'))
  const expected = bankHash(BANK.slice(0, report.scenarios))
  if (report.bankHash !== expected) throw new Error('bank changed since that run: hash mismatch, refusing to re-grade')
  const byId = new Map(BANK.map((scenario) => [scenario.id, scenario]))
  const anchor = await anchorGate()
  if (!anchor.pass) console.log(`  WARNING: judge anchor pair failed (good=${anchor.good}, bad=${anchor.bad}, opposite=${anchor.opposite}, partial=${anchor.partial}, negated=${anchor.negated}); grades are suspect`)
  console.log(`re-grade ${report.rows.length} rows from ${file}`)
  for (const row of report.rows) {
    const scenario = byId.get(row.id)
    if (scenario === undefined) throw new Error(`scenario ${row.id} is not in the current bank`)
    for (const arm of ['memory', 'rag', 'closed']) {
      const verdict = await judge(scenario, row[arm].answer)
      row[arm] = { ...row[arm], pass: verdict.pass, reason: verdict.reason }
    }
  }
  report.judge = { version: 'v4-negation-prohibition', anchor }
  report.regradedFrom = file
  for (const arm of ['memory', 'rag', 'closed']) {
    report.arms[arm] = percentage(report.rows.filter((row) => row[arm].pass).length, report.rows.length)
  }
  const pairs = (left, right) => {
    const gain = report.rows.filter((row) => row[left].pass && !row[right].pass).length
    const loss = report.rows.filter((row) => !row[left].pass && row[right].pass).length
    return `${left} 赢 ${gain} / 输 ${loss}`
  }
  report.paired = {
    memoryVsClosed: pairs('memory', 'closed'),
    memoryVsRag: pairs('memory', 'rag'),
    ragVsClosed: pairs('rag', 'closed'),
  }
  const target = file.replace(/\.json$/u, '-regraded.json')
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`memory  ${report.arms.memory}`)
  console.log(`rag     ${report.arms.rag}`)
  console.log(`closed  ${report.arms.closed}`)
  console.log(`paired: ${report.paired.memoryVsClosed}; ${report.paired.memoryVsRag}; ${report.paired.ragVsClosed}`)
  console.log(`results: ${target}`)
}

async function main() {
  const regradeFile = argValue('--regrade')
  if (regradeFile !== undefined) return await regrade(regradeFile)
  const only = argValue('--only')
  const slice = BANK.slice(0, Math.max(1, LIMIT ?? BANK.length))
  const scenarios = only === undefined ? slice : slice.filter((scenario) => only.split(',').includes(scenario.id))
  if (scenarios.length === 0) throw new Error('--only matched no scenario')
  const hash = bankHash(scenarios)
  await mkdir(DATA, { recursive: true })
  // `--reuse-store` keeps the extraction of a previous run and re-runs only the
  // answer and judge steps. Use it when the variable under test is the answer
  // prompt or the judge, so extraction sampling noise cannot move the numbers.
  const reuseStore = process.argv.includes('--reuse-store')
  if (!reuseStore) {
    // A fresh store per run: memory from a previous run would change the recipe.
    await rm(STORE_DIR, { recursive: true, force: true })
    await mkdir(STORE_DIR, { recursive: true })
  }

  // One store per scenario, the way a real workspace has its own project scope.
  // The previous run pooled all scenarios into one project scope, and the memory
  // arm then correctly refused to apply "松鼠记账的提交信息…" to "本项目" — a
  // harness artifact, not a memory failure. Per-scenario stores also keep each
  // scenario's loops together instead of hiding the newest ones behind the cap.
  const contexts = new Map()

  console.log(`bank ${hash.slice(0, 12)} · ${scenarios.length} scenarios · model ${MODEL}`)

  /* ---------------------------------------------------------- extraction --- */
  const extraction = { drafts: 0, stored: 0, unsupported: 0, empty: 0, loops: 0 }
  if (reuseStore) {
    extraction.drafts = null
    extraction.unsupported = null
    for (const [index, scenario] of scenarios.entries()) {
      const dir = join(STORE_DIR, scenario.id)
      const root = join(PROJECT_ROOT, scenario.id)
      const store = new MemoryStore(dir)
      let project
      try {
        project = await store.list('project', root, { fresh: true })
      } catch {
        throw new Error(`--reuse-store was requested but ${dir} is missing; run without it first`)
      }
      const global = await store.list('global', undefined, { fresh: true })
      const ledger = await readLoops(dir)
      const open = ledger.loops.filter((loop) => loop.state === 'open').length
      contexts.set(scenario.id, { store, root, loops: ledger.loops })
      extraction.stored += project.length + global.length
      extraction.empty += project.length + global.length === 0 ? 1 : 0
      extraction.loops += open
      console.log(`  reuse ${index + 1}/${scenarios.length} ${scenario.id}: ${project.length} project + ${global.length} global entries, ${open} loop(s)`)
    }
    console.log(`  reused store · ${extraction.stored} entries, ${extraction.loops} open loops (extraction counters n/a)`)
  } else for (const [index, scenario] of scenarios.entries()) {
    const dir = join(STORE_DIR, scenario.id)
    const root = join(PROJECT_ROOT, scenario.id)
    const store = new MemoryStore(dir)
    const result = await extractScenario(scenario)
    extraction.drafts += result.drafts.length + result.unsupported
    extraction.unsupported += result.unsupported
    extraction.empty += result.drafts.length === 0 && result.unsupported === 0 ? 1 : 0
    const stored = await storeScenario(scenario, root, result.drafts)
    extraction.stored += stored.length
    let ledger = await readLoops(dir)
    ledger = pruneLoops(mergeLoops(ledger, result.loops ?? [], Date.now(), scenario.id), Date.now())
    await writeLoops(dir, ledger)
    extraction.loops += ledger.loops.filter((loop) => loop.state === 'open').length
    contexts.set(scenario.id, { store, root, loops: ledger.loops })
    console.log(`  extract ${index + 1}/${scenarios.length} ${scenario.id}: ${stored.length} stored, ${result.unsupported} rejected, ${result.loops?.length ?? 0} loop(s)`)
  }
  console.log(`  loops: ${extraction.loops} open`)

  /* -------------------------------------------------------------- arms --- */
  const anchor = await anchorGate()
  if (!anchor.pass) console.log(`  WARNING: judge anchor pair failed (good=${anchor.good}, bad=${anchor.bad}); grades below are suspect`)
  const rows = []
  for (const [index, scenario] of scenarios.entries()) {
    const ragContext = scenario.turns.map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`).join('\n')
    const context = contexts.get(scenario.id)
    const entries = {
      project: await context.store.list('project', context.root, { fresh: true }),
      global: await context.store.list('global', undefined, { fresh: true }),
    }
    const arms = {
      memory: memoryContext(entries, context.loops, scenario.question),
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
    judge: { version: 'v4-negation-prohibition', anchor },
    store: 'per-scenario',
    reusedStore: reuseStore,
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
  console.log(extraction.drafts === null
    ? `extraction: reused store (${extraction.stored} entries, ${extraction.loops} open loops)`
    : `extraction: ${extraction.stored} stored / ${extraction.drafts} candidates, ${extraction.unsupported} rejected by the quote check, ${extraction.empty} scenarios stored nothing`)
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
    ...extraction.drafts === null
      ? [`抽取：复用上一轮 store（${extraction.stored} 条、${extraction.loops} 条 open loop），本轮没有重新抽取。`]
      : [`抽取：${extraction.stored} 条入库 / ${extraction.drafts} 个候选；引文校验拒绝 ${extraction.unsupported} 个；${extraction.empty} 个场景一条没存下；新开 ${extraction.loops} 条 open loop。`],
    `判分：judge v2（禁止点例外语义），锚点自检 ${anchor.pass ? '通过' : '未通过'}（good=${anchor.good}, bad=${anchor.bad}）。`,
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
