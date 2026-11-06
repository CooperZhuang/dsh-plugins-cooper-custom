/**
 * 复算 bench 三份文档里的数字（只读）。
 *
 * 用途：把 README 里记录的数字分成三类，逐项判定并打印——
 *   PASS         现在还能从 bench/data 或题库源码复算，结果与文档一致；
 *   MISMATCH     能复算，但复算结果与文档不一致；
 *   UNVERIFIABLE 对应结果文件已被后续运行覆盖或从未留存，无法复算（不是失败）。
 * 脚本只读 bench/data/ 与同目录下的 scenarios / 预算常量，不写文件、不联网、不跑评测。
 *
 * 用法（在 packages/dsh-cross-memory 下）：
 *   node bench/verify-doc.mts
 *
 * 退出码：有 MISMATCH 时为 1；只有 UNVERIFIABLE 时为 0。
 *
 * 文档对应位置：bench/README.md、bench/e2e/README.md、bench/real/README.md 的
 *「数字来源与复算」一节。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS } from './e2e/scenarios.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, 'data')

/* ------------------------------------------------------------ 判定与输出 --- */

let passed = 0
let mismatched = 0
let skipped = 0

const emit = (status, label) => console.log(`${status}  ${label}`)

function pass(label) {
  passed += 1
  emit('PASS', label)
}

function mismatch(label, expected, actual) {
  mismatched += 1
  emit('MISMATCH', `${label}：文档 ${expected}，复算 ${actual}`)
}

function unverifiable(label, reason) {
  skipped += 1
  emit('UNVERIFIABLE', `${label}，${reason}`)
}

/** 与文档值精确比对；拿不到复算值时降级为 UNVERIFIABLE，而不是判错。 */
function check(label, expected, actual) {
  if (actual === undefined || actual === null) return unverifiable(label, '复算所需数据缺失')
  if (String(actual) === String(expected)) return pass(label)
  return mismatch(label, expected, actual)
}

/** 按指定小数位比对，用于「¥0.127」「约 ¥0.10」这类四舍五入后的数字。 */
function checkNumber(label, expected, actual, digits = 3) {
  if (typeof actual !== 'number' || Number.isNaN(actual)) return unverifiable(label, '复算所需数据缺失')
  const rounded = Number(actual.toFixed(digits))
  if (rounded === expected) return pass(label)
  return mismatch(label, expected, rounded)
}

/* ---------------------------------------------------------------- 读数 --- */

/** 读 bench/data 下的 JSON；缺失或损坏时返回 undefined，由调用方降级。 */
function readJson(name) {
  const file = join(DATA, name)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function readLineCount(name) {
  const file = join(DATA, name)
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8').trim()
  return text.length === 0 ? 0 : text.split('\n').length
}

/** 从 .mts 源码读一个数字常量，用来核对文档引用的预算与上限。 */
function sourceConstant(relativePath, name) {
  const file = join(HERE, relativePath)
  if (!existsSync(file)) return undefined
  const match = readFileSync(file, 'utf8').match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)`))
  return match === undefined ? undefined : Number(match[1].replaceAll('_', ''))
}

/** 与 e2e/run.mts 同一口径：sha256(JSON.stringify(scenarios))。 */
const bankHash = (scenarios) => createHash('sha256').update(JSON.stringify(scenarios)).digest('hex')

/** 一臂在留存 rows 里的通过数；没有 rows 时返回 undefined。 */
function armPasses(report, arm) {
  if (!Array.isArray(report?.rows)) return undefined
  return report.rows.filter((row) => row[arm]?.pass === true).length
}

/** 「通过数/总数」，直接与文档里的 50/53 这种写法比对。 */
function armRatio(report, arm) {
  const hit = armPasses(report, arm)
  if (hit === undefined || !Array.isArray(report?.rows)) return undefined
  return `${hit}/${report.rows.length}`
}

/** 失败题 id；用于「唯一失败是 X」这类断言。 */
function failedIds(report, arm, key = 'id') {
  if (!Array.isArray(report?.rows)) return undefined
  const ids = report.rows.filter((row) => row[arm]?.pass !== true).map((row) => row[key])
  return ids.length === 0 ? '无' : ids.join('、')
}

/** 汇总费用；任一分项缺失则返回 undefined。 */
function sumCosts(...values) {
  if (values.some((value) => typeof value !== 'number')) return undefined
  return values.reduce((sum, value) => sum + value, 0)
}

/* ------------------------------------------------------------ 题库与文档 --- */

const SCENARIOS_EXTRA = await import('./e2e/scenarios-extra.mts')
  .then((module) => module.SCENARIOS_EXTRA ?? [])
  .catch(() => [])
const BANK = [...SCENARIOS, ...SCENARIOS_EXTRA]
const BANK_HASH = bankHash(BANK)

const corpus = readJson('corpus.json')
const results = readJson('results.json')
const embQueries = readJson('emb-queries.json')

const e2eBankV1 = readJson('e2e-results-bankv1.json')
const e2eBankV1Regraded = readJson('e2e-results-bankv1-regraded.json')
const e2eV2Regraded = readJson('e2e-results-regraded.json')
const e2eSmoke = readJson('e2e-results.json')

const realBankV1 = readJson('real-bank-v1.json')
const realBankV2 = readJson('real-bank.json')
const realV1 = readJson('real-results-v1.json')
const realV2 = readJson('real-results-live-v2.json')
const candidates = readJson('real-candidates.json')
const reextractBase5 = readJson('real-results-reextract-base5.json')
const reextractMore10 = readJson('real-results-reextract-more10.json')
const reextractMore20 = readJson('real-results-reextract-more20.json')
const reextractCommit = readJson('real-results-reextract-more20-commit.json')
const reextractBase5Summary = readJson('real-reextract/base5/summary.json')
const reextractMore10Summary = readJson('real-reextract/more10/summary.json')
const reextractMore20Summary = readJson('real-reextract/more20/summary.json')
const diagV1 = readJson('real-diagnosis-v1.json')
const diagCommit = readJson('real-diagnosis.json')
const joint = readJson('real-joint-results.json')

console.log('bench 文档数字复算（只读；口径见脚本头部注释）')
console.log('')

/* ------------------------------------------------------ bench/README.md --- */

// 「语料是 global 作用域 732 条」。
check('bench corpus 732 条', 732, Array.isArray(corpus) ? corpus.length : undefined)

// 查询集两批；R@1 的基数就是这两批的条数。
check('bench queries-a 75 条', 75, readLineCount('queries-a.jsonl'))
check('bench queries-b 75 条', 75, readLineCount('queries-b.jsonl'))

// 「出厂打分在这批（queries-a）上是 100% R@1」。按 run-bench.mts 的
// firstBatch = queries-a 条数、rankings 顺序相同的口径，取前 75 条重算。
function batchTopOne(arm, size) {
  if (!Array.isArray(results?.rankings) || results.rankings.length < size) return undefined
  let hits = 0
  for (let index = 0; index < size; index += 1) {
    if (results.rankings[index][arm]?.[0] === results.rankings[index].id) hits += 1
  }
  return hits
}

check('bench queries-a 上 current 臂 R@1 75/75', 75, batchTopOne('current', 75))

// 「dense 臂用 qwen3-embedding:0.6b（1024 维）」，缓存以 base64 float32 存盘。
function embeddingShape(cache) {
  if (cache === undefined) return undefined
  const first = Object.entries(cache.vectors ?? {})[0]
  if (first === undefined || typeof first[1] !== 'string') return undefined
  return { model: cache.model, dimensions: Buffer.from(first[1], 'base64').length / 4 }
}

const queryEmbeddings = embeddingShape(embQueries)
check('bench dense 模型 qwen3-embedding:0.6b', 'qwen3-embedding:0.6b', queryEmbeddings?.model)
check('bench dense 维度 1024', 1024, queryEmbeddings?.dimensions)

unverifiable(
  'bench 项目作用域 150 个目标只命中 2 条',
  '对应的命中比对没有留存产物（sample.json 只有 150 条抽样，不含比对结果）',
)

/* --------------------------------------------------- bench/e2e/README.md --- */

// 「两个文件合计 53 条」「扩充 30 条，10 个类别各 3 条」。
check('e2e 题库 scenarios.mts 23 条', 23, SCENARIOS.length)
check('e2e 题库 scenarios-extra.mts 30 条', 30, SCENARIOS_EXTRA.length)
check('e2e 题库合计 53 条', 53, BANK.length)

function categoryCounts(scenarios) {
  const counts = new Map()
  for (const scenario of scenarios) counts.set(scenario.category, (counts.get(scenario.category) ?? 0) + 1)
  return [...counts.values()]
}

const extraCategories = categoryCounts(SCENARIOS_EXTRA)
check(
  'e2e 扩充 30 条按 10 类各 3 条',
  '10 类各 3 条',
  extraCategories.length === 10 && extraCategories.every((count) => count === 3) ? '10 类各 3 条' : extraCategories.join('/'),
)

// 「当前是 bank v2（23876acceb0e…）」，按 run.mts 的拼接顺序与哈希口径重算。
check('e2e bank v2 哈希前缀 23876acceb0e', '23876acceb0e', BANK_HASH.slice(0, 12))

// bank v1 的哈希只能核对结果文件里的记录值：题面已被 v2 改过，无法重算。
check('e2e bank v1 哈希前缀 9cece6602e01（结果文件记录值）', '9cece6602e01', e2eBankV1?.bankHash?.slice(0, 12))

// 「冒烟只跑 2 个场景」：e2e-results.json 现在的哈希应等于题库前 2 题的哈希。
check('e2e 冒烟结果只含 2 个场景', 2, e2eSmoke?.scenarios)
check('e2e 冒烟结果哈希对应题库前 2 题', bankHash(BANK.slice(0, 2)).slice(0, 12), e2eSmoke?.bankHash?.slice(0, 12))

// 第 1–3 轮与 3′ 的结果文件已被冒烟与重判覆盖。
unverifiable('e2e 轮 1 memory/rag/closed 21/23、22/23、0/23 与费用 ¥0.117', '首轮结果文件没有留存')
unverifiable('e2e 轮 2 memory/rag/closed 50/53、51/53、0/53 与费用 ¥0.319', '第 2 轮结果文件没有留存')
unverifiable('e2e 轮 3 memory/rag/closed 50/53、52/53、0/53 与费用 ¥0.269', '第 3 轮结果文件没有留存')
unverifiable('e2e 轮 3′ memory/rag/closed 51/53、52/53、0/53', '第 3 轮重判结果没有留存')
unverifiable('e2e 轮 3′ 重判费用约 ¥0.10', '重判不单独记账，对应文件也没有留存')

// 轮 4：bank v1 + 判分器 v3，留存为 e2e-results-bankv1.json。
check('e2e 轮 4 memory 50/53', '50/53', armRatio(e2eBankV1, 'memory'))
check('e2e 轮 4 rag 53/53', '53/53', armRatio(e2eBankV1, 'rag'))
check('e2e 轮 4 closed 0/53', '0/53', armRatio(e2eBankV1, 'closed'))
check('e2e 轮 4 费用 ¥0.127', 0.127, e2eBankV1?.usage?.estimatedCny)
check('e2e 轮 4 判分器 v3', 'v3-negation', e2eBankV1?.judge?.version)
check('e2e 轮 4 题库 bank v1', '9cece6602e01', e2eBankV1?.bankHash?.slice(0, 12))
check('e2e 轮 4 复用上一轮 store（--reuse-store）', true, e2eBankV1?.reusedStore)

// 轮 4′：同一批答案用判分器 v4 重判。
check('e2e 轮 4′ memory 52/53', '52/53', armRatio(e2eBankV1Regraded, 'memory'))
check('e2e 轮 4′ rag 53/53', '53/53', armRatio(e2eBankV1Regraded, 'rag'))
check('e2e 轮 4′ closed 0/53', '0/53', armRatio(e2eBankV1Regraded, 'closed'))
check('e2e 轮 4′ 判分器 v4', 'v4-negation-prohibition', e2eBankV1Regraded?.judge?.version)
unverifiable('e2e 轮 4′ 重判费用约 ¥0.10', '重判沿用原 usage，重判调用量没有单独记账')

// 轮 5 与 5′：bank v2。留存文件是 5′ 的 v5 逐点重判。
check('e2e 轮 5 题库 bank v2', '23876acceb0e', e2eV2Regraded?.bankHash?.slice(0, 12))
check('e2e 轮 5 费用 ¥0.138', 0.138, e2eV2Regraded?.usage?.estimatedCny)
unverifiable('e2e 轮 5（判分器 v4 整体判分）三臂 53/53、52/53、0/53', '该原件已被 5′ 重判覆盖，现存 e2e-results-regraded.json 是 v5 口径')
check('e2e 5′ 判分器 v5 逐点', 'v5-per-point', e2eV2Regraded?.judge?.version)
check('e2e 5′ memory 53/53', '53/53', armRatio(e2eV2Regraded, 'memory'))
check('e2e 5′ rag 52/53', '52/53', armRatio(e2eV2Regraded, 'rag'))
check('e2e 5′ closed 0/53', '0/53', armRatio(e2eV2Regraded, 'closed'))
unverifiable('e2e 5′ 重判费用约 ¥0.10', '重判沿用原 usage，重判调用量没有单独记账')

// 第五轮逐题复核的三条结论。
check('e2e 5′ rag 唯一失败是 branch-strategy', 'branch-strategy', failedIds(e2eV2Regraded, 'rag'))
check('e2e 5′ memory 臂无失败', '无', failedIds(e2eV2Regraded, 'memory'))

const v2Rows = Array.isArray(e2eV2Regraded?.rows) ? e2eV2Regraded.rows : []
const rabbitmq = v2Rows.find((row) => row.id === 'rabbitmq-vhost-queue')
const snapshot = v2Rows.find((row) => row.id === 'snapshot-latency')
check('e2e 5′ rabbitmq-vhost-queue memory 与 rag 都通过', 'pass/pass', rabbitmq === undefined ? undefined : `${rabbitmq.memory?.pass === true ? 'pass' : 'fail'}/${rabbitmq.rag?.pass === true ? 'pass' : 'fail'}`)
check('e2e 5′ snapshot-latency rag 判为通过', true, snapshot?.rag?.pass)
unverifiable('e2e 轮 5 与 5′ 有两处单题判决相反', '需要 bank v2 的 v4 原件做对照，该文件已被 5′ 覆盖')

unverifiable('e2e 53 个场景全量抽取约 ¥0.27', '抽取账目没有留存（现存结果都是 --reuse-store 或重判）')
checkNumber('e2e 只重跑答案约 ¥0.13', 0.13, e2eBankV1?.usage?.estimatedCny, 2)

// 「上下文约 4KB」= run.mts 的 SUMMARY_BYTES。
check('e2e memory 臂上下文上限 4096B（约 4KB）', 4096, sourceConstant('e2e/run.mts', 'SUMMARY_BYTES'))

// 「谷时」：留存结果都应记录 offPeak=true。
const e2eReports = [e2eBankV1, e2eBankV1Regraded, e2eV2Regraded, e2eSmoke].filter((report) => report !== undefined)
check('e2e 留存结果均记录谷时（offPeak=true）', true, e2eReports.length === 0 ? undefined : e2eReports.every((report) => report.offPeak === true))
unverifiable('e2e 第 1 轮那 23 题与当前 scenarios.mts 逐字节一致', '改动前的题库没有留存，无法做字节比对')

/* -------------------------------------------------- bench/real/README.md --- */

// 「390 个日志、389 个可解析、66 场满足条件、取 20 场」。
check('real 采样 390 个日志', 390, candidates?.counts?.logs)
check('real 采样 389 个可解析', 389, candidates?.counts?.parsed)
check('real 采样 66 场满足条件', 66, candidates?.counts?.eligible)
check('real 采样取 20 场', 20, candidates?.counts?.selected)
check('real 候选会话 20 场', 20, Array.isArray(candidates?.sessions) ? candidates.sessions.length : undefined)

// 「每场关联记忆 3–32 条」。
function relatedRange() {
  if (!Array.isArray(candidates?.sessions)) return undefined
  const counts = candidates.sessions.map((session) => session.entries?.length)
  if (counts.some((count) => typeof count !== 'number')) return undefined
  return `${Math.min(...counts)}–${Math.max(...counts)}`
}

check('real 每场关联记忆 3–32 条', '3–32', relatedRange())

// 「转录再截到 12k 字符」：源码上限 12000，实际最长也不超过它。
function transcriptWithinCap() {
  if (!Array.isArray(candidates?.sessions) || candidates.sessions.some((session) => typeof session.transcript !== 'string')) return undefined
  return candidates.sessions.every((session) => session.transcript.length <= 12000)
}

check('real 转录截断上限 12000 字符', 12000, sourceConstant('real/sample.mts', 'TRANSCRIPT_CAP'))
check('real 候选转录均不超过 12000 字符', true, transcriptWithinCap())

// 题库哈希：与 author.mts 同口径 sha256(JSON.stringify(sessions)) 重算。
check('real v1 bankHash b042f0a0（重算 sessions）', 'b042f0a0', typeof realBankV1?.sessions === 'undefined' ? undefined : bankHash(realBankV1.sessions).slice(0, 8))
check('real v2 bankHash acb35abc（重算 sessions）', 'acb35abc', typeof realBankV2?.sessions === 'undefined' ? undefined : bankHash(realBankV2.sessions).slice(0, 8))
check('real 两轮题库不同', true, realBankV1?.bankHash === undefined || realBankV2?.bankHash === undefined ? undefined : realBankV1.bankHash !== realBankV2.bankHash)

// 两轮取样相同：candidates 的会话 id 哈希应与结果文件记录一致。
function candidatesHash() {
  if (!Array.isArray(candidates?.sessions)) return undefined
  return createHash('sha256').update(JSON.stringify(candidates.sessions.map((session) => session.sessionId))).digest('hex')
}

check('real 候选会话哈希 33227ef7（两轮相同）', '33227ef7', candidatesHash()?.slice(0, 8))
check('real v2 记录的同批取样哈希一致', '33227ef7', realV2?.candidatesHash?.slice(0, 8))

// v1：38 题删 5 留 33、17 场；三臂 20/33、31/33、0/33。
function education(counts) {
  if (counts?.questions === undefined || counts?.droppedByVerifier === undefined) return undefined
  return `${counts.questions + counts.droppedByVerifier} → ${counts.questions}`
}

check('real v1 题库 38 题删 5 留 33', '38 → 33', education(realBankV1?.counts))

check('real v1 17 场 33 题', '17 场/33 题', realV1?.sessions === undefined || realV1?.questions === undefined ? undefined : `${realV1.sessions} 场/${realV1.questions} 题`)
check('real v1 memory 20/33', '20/33', armRatio(realV1, 'memory'))
check('real v1 rag 31/33', '31/33', armRatio(realV1, 'rag'))
check('real v1 closed 0/33', '0/33', armRatio(realV1, 'closed'))
checkNumber('real v1 费用约 ¥0.64', 0.64, sumCosts(realBankV1?.usage?.estimatedCny, realBankV1?.verifyUsage?.estimatedCny, realV1?.usage?.estimatedCny), 2)

// v2：19 场 33 题；三臂 22/33、32/33、0/33；配对 0 赢 / 10 输 / 23 平。
check('real v2 19 场 33 题', '19 场/33 题', realV2?.sessions === undefined || realV2?.questions === undefined ? undefined : `${realV2.sessions} 场/${realV2.questions} 题`)
check('real v2 memory 22/33', '22/33', armRatio(realV2, 'memory'))
check('real v2 rag 32/33', '32/33', armRatio(realV2, 'rag'))
check('real v2 closed 0/33', '0/33', armRatio(realV2, 'closed'))

function pairing(report, left, right) {
  if (!Array.isArray(report?.rows)) return undefined
  const win = report.rows.filter((row) => row[left]?.pass === true && row[right]?.pass !== true).length
  const loss = report.rows.filter((row) => row[left]?.pass !== true && row[right]?.pass === true).length
  return `赢 ${win}/输 ${loss}/平 ${report.rows.length - win - loss}`
}

check('real v2 配对 memory 对 rag 赢 0/输 10/平 23', '赢 0/输 10/平 23', pairing(realV2, 'memory', 'rag'))

// v2 费用分项与合计。
check('real v2 出题 ¥0.129', 0.129, realBankV2?.usage?.estimatedCny)
check('real v2 核题 ¥0.255', 0.255, realBankV2?.verifyUsage?.estimatedCny)
check('real v2 作答/判分 ¥0.302', 0.302, realV2?.usage?.estimatedCny)

// 诊断费用：结果文件不写 estimatedCny，按 deepseek 谷时价（输入 2、输出 8，半价）折算。
function tokenCost(usage) {
  if (usage?.input === undefined || usage?.output === undefined) return undefined
  return ((usage.input / 1e6) * 2 + (usage.output / 1e6) * 8) * 0.5
}

checkNumber('real 诊断约 ¥0.02（按留存归因文件 token 折算）', 0.02, tokenCost(diagCommit?.diagnosisUsage), 2)
checkNumber('real v2 费用约 ¥0.71（含诊断 ¥0.02）', 0.71, sumCosts(realBankV2?.usage?.estimatedCny, realBankV2?.verifyUsage?.estimatedCny, realV2?.usage?.estimatedCny, 0.02), 2)

// 首轮实测：出题约 ¥0.13、核题 38 题约 ¥0.22。
checkNumber('real 首轮出题约 ¥0.13', 0.13, realBankV1?.usage?.estimatedCny, 2)
checkNumber('real 首轮核题 38 题约 ¥0.22', 0.22, realBankV1?.verifyUsage?.estimatedCny, 2)

// v1 缺口诊断：13 题失败 = 抽取 10 + 回答 3（展示、窗口均 0）。
function diagBuckets(diagnosis) {
  const buckets = diagnosis?.buckets
  if (buckets === undefined) return undefined
  const extraction = buckets.extraction?.length
  const answer = buckets.answer?.length
  const presentation = buckets.presentation?.length
  const window = buckets.window?.length
  const total = diagnosis.memoryFailures
  if ([extraction, answer, presentation, window, total].some((value) => typeof value !== 'number')) return undefined
  if (extraction + answer + presentation + window !== total) return `归因合计 ${extraction + answer + presentation + window} ≠ 失败 ${total}`
  return `抽取 ${extraction} + 回答 ${answer}，失败 ${total}`
}

check('real v1 失败 13 = 抽取 10 + 回答 3', '抽取 10 + 回答 3，失败 13', diagBuckets(diagV1))
unverifiable('real v2 失败 11 = 抽取 6 + 回答 5', 'v2 的归因文件已被 more20 的归因覆盖，没有留存')

// 抽取预算实验：条目数与 memory 臂分数。
check('real reextract base5 条目数 98', 98, reextractBase5Summary?.counts?.stored)
check('real reextract more10 条目数 175', 175, reextractMore10Summary?.counts?.stored)
check('real reextract more20 条目数 236', 236, reextractMore20Summary?.counts?.stored)
check('real reextract base5 memory 19/33', '19/33', armRatio(reextractBase5, 'memory'))
check('real reextract more10 memory 22/33', '22/33', armRatio(reextractMore10, 'memory'))
check('real reextract more20 memory 24/33', '24/33', armRatio(reextractMore20, 'memory'))

// 三次重放费用与三次 memory 打分费用。
checkNumber('real 重放 base5 费用 ¥0.249', 0.249, reextractBase5Summary?.usage?.estimatedCny)
checkNumber('real 重放 more10 费用 ¥0.605', 0.605, reextractMore10Summary?.usage?.estimatedCny)
checkNumber('real 重放 more20 费用 ¥0.688', 0.688, reextractMore20Summary?.usage?.estimatedCny)
checkNumber(
  'real 三次 memory 打分约 ¥0.49',
  0.49,
  sumCosts(reextractBase5?.usage?.estimatedCny, reextractMore10?.usage?.estimatedCny, reextractMore20?.usage?.estimatedCny),
  2,
)

// 三个 replay 的抽取上限与输出预算：base5 没有 max-output-tokens，more10/more20 为 8000。
check('real replay base5 无 max-output-tokens', true, reextractBase5Summary === undefined ? undefined : reextractBase5Summary.maxOutputTokens === undefined)
check('real replay more10 输出预算 8000', 8000, reextractMore10Summary?.maxOutputTokens)
check('real replay more20 输出预算 8000', 8000, reextractMore20Summary?.maxOutputTokens)

unverifiable('real 归因费用约 ¥0.03', '诊断结果文件不写费用，more20 那次归因又已被 commit 归因覆盖，无法凑出 ¥0.03')
unverifiable('real more20 失败 9 = 抽取 4 + 回答 5', 'more20（complete 答案变体）的归因已被 commit 变体覆盖')

// 线上 store 条目数与 memory 分数。
unverifiable('real 线上 store 约 170 条', '线上记忆库不随 bench/data 留存，条目数没有快照')
check('real 线上 memory 22/33', '22/33', armRatio(realV2, 'memory'))

// commit 答案变体。
check('real more20-commit memory 26/33', '26/33', armRatio(reextractCommit, 'memory'))
check('real more20-commit 失败 7 = 抽取 3 + 回答 4', '抽取 3 + 回答 4，失败 7', diagBuckets(diagCommit))
check('real 答案侧变体 +2 题（24 → 26）', 2, (armPasses(reextractCommit, 'memory') === undefined || armPasses(reextractMore20, 'memory') === undefined) ? undefined : armPasses(reextractCommit, 'memory') - armPasses(reextractMore20, 'memory'))

// 联合召回：留存 run 是生产路径（引文定位 + 词面回退）。
check('real joint 留存 run 为生产检索路径', 'production', joint?.retrieval)
check('real joint production memory+raw 30/33', '30/33', armRatio(joint, 'memory+raw'))
check('real joint rag 33/33', '33/33', armRatio(joint, 'rag'))
check('real joint memory 臂 26/33（more20 + commit）', '26/33', armRatio(reextractCommit, 'memory'))

// 留存 run 的 paired / usage 字段：memory 臂不在这一次 run 里，所以配对是占位符；
// usage 是该次生产路径 run 的实账（文档里的 269 次是多个变体的累计）。
check('real joint 留存 run 的配对字段为占位（memory 臂不在该次 run）', '—', joint?.paired?.memoryRawVsMemory)
check('real joint 留存 run usage ¥0.646 / 137 次调用', '¥0.646/137 次', joint?.usage === undefined ? undefined : `¥${joint.usage.estimatedCny}/${joint.usage.calls} 次`)

// 联合召回的 dense 混合、纯 raw、纯词面三个变体都没有留存文件。
unverifiable('real joint dense 混合 memory+raw 32/33', 'dense 混合那次 run 的结果已被生产路径 run 覆盖')
unverifiable('real joint 纯 raw 27/33', 'raw 单臂结果没有留存')
unverifiable('real joint 纯词面窗口 28–31/33（三次）', '三次纯词面 run 的结果没有留存')
unverifiable('real joint 配对：memory+raw 对 memory 赢 6/输 0', '配对数来自 dense 混合那次 run，该文件没有留存')
unverifiable('real joint 配对：memory+raw 对 rag 赢 0/输 1', '配对数来自 dense 混合那次 run，该文件没有留存')
unverifiable('real joint 269 次调用 ≈ ¥0.93', `留存的生产路径 run 是 ${joint?.usage?.calls ?? '未知'} 次调用、¥${joint?.usage?.estimatedCny ?? '未知'}，269 次是多个变体的累计，无法复算`)
unverifiable('real joint quote 覆盖率 33/33', 'joint 结果文件不记录引文定位的命中情况')

// 分块与检索预算：留存文件记录了 chunkChars 与 topK，原文预算是源码常量。
check('real joint 分块 900 字符', 900, joint?.chunkChars)
check('real joint 取 top-3', 3, joint?.topK)
check('real joint 原文预算 2200B', 2200, sourceConstant('real/joint.mts', 'RAW_BYTES'))
unverifiable('real v2 核题器有 2 题因回复不是 JSON 被误删', '核题只留了删除数量，被删题目与原因没有留存')

/* ------------------------------------ 文档里记录的统计与本次输出一致 --- */

// 三份文档都写了「当前 N 项里 PASS P 项、UNVERIFIABLE U 项」，这一组自检让那三个数
// 不能悄悄漂移：加检查项后忘了同步文档，这里会 MISMATCH。算期望值时要把本组自检
// 自己也计进去（每份文档一条），否则永远差 DOC_FILES.length。
const DOC_FILES = ['README.md', 'e2e/README.md', 'real/README.md']
const DOC_STATS = /当前 (\d+) 项里 PASS (\d+) 项、UNVERIFIABLE (\d+) 项/u
const expectedTotal = passed + mismatched + skipped + DOC_FILES.length
const expectedPass = passed + DOC_FILES.length
const expectedSkipped = skipped
for (const relative of DOC_FILES) {
  const path = join(HERE, relative)
  if (!existsSync(path)) {
    mismatch(`文档统计 bench/${relative}`, '文件存在', '缺失')
    continue
  }
  const found = DOC_STATS.exec(readFileSync(path, 'utf8'))
  if (found === null) {
    mismatch(`文档统计 bench/${relative}`, '没有这段统计', `当前 ${expectedTotal} 项里 PASS ${expectedPass} 项、UNVERIFIABLE ${expectedSkipped} 项`)
    continue
  }
  const actual = `当前 ${found[1]} 项里 PASS ${found[2]} 项、UNVERIFIABLE ${found[3]} 项`
  const expected = `当前 ${expectedTotal} 项里 PASS ${expectedPass} 项、UNVERIFIABLE ${expectedSkipped} 项`
  if (actual === expected) pass(`文档统计 bench/${relative} 与本次输出一致`)
  else mismatch(`文档统计 bench/${relative}`, actual, expected)
}

/* -------------------------------------------------------------- 统计 --- */

const total = passed + mismatched + skipped
console.log('')
console.log(`合计 ${total} 项：PASS ${passed} · MISMATCH ${mismatched} · UNVERIFIABLE ${skipped}`)
if (mismatched > 0) {
  console.log('退出码 1：存在 MISMATCH，需要按上面的行去核文档或数据。')
  process.exitCode = 1
} else {
  console.log(`退出码 0：无 MISMATCH；${skipped} 项 UNVERIFIABLE 均为源文件被后续运行覆盖或从未留存。`)
}
