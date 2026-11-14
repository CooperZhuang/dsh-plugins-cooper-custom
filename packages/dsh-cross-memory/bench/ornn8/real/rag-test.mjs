/**
 * 词法 RAG 验证：把真实会话按轮切块，按词法召回原文，和「记忆摘要」对比。
 *
 * 不动插件架构，只在评测侧验证「RAG 能不能超过抽取」。召回打分用插件自己的
 * 词元化（bigram + 词），零模型调用。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SESSIONS = '/tmp/mii-sessions.json'
const OUT = '/tmp/real-work/out'
const REAL = join(OUT, 'real-opt.json')
const TOP_K = Number(process.argv[2] ?? 8)
const MAX_CHARS = 4000

/** 插件的词元化：CJK bigram + 拉丁词。 */
function tokenize(text) {
  const out = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9]+/gu)) out.push(m[0])
  const cjk = lower.match(/[\u4e00-\u9fff]/gu) ?? []
  for (let i = 0; i + 1 < cjk.length; i += 1) out.push(cjk[i] + cjk[i + 1])
  return out
}

function chunkTurns(msgs) {
  const chunks = []
  let current = null
  for (const m of msgs) {
    if (m.role === 'user') {
      if (current !== null) chunks.push(current)
      current = { role: 'user', text: m.text, lines: [m.text] }
    } else if (current !== null) {
      current.role = 'user+assistant'
      current.lines.push(m.text)
      current.text = current.lines.join('\n')
      chunks.push(current)
      current = null
    }
  }
  if (current !== null) chunks.push(current)
  return chunks.filter((chunk) => chunk.text.trim().length > 0)
}

const sessions = JSON.parse(readFileSync(SESSIONS, 'utf8'))
const chunks = []
for (const s of sessions) {
  for (const [i, chunk] of chunkTurns(s.msgs).entries()) {
    chunks.push({ sid: s.sid, i, text: chunk.text.slice(0, 8000), tokens: tokenize(chunk.text) })
  }
}
// 文档频率
const df = new Map()
for (const chunk of chunks) for (const token of new Set(chunk.tokens)) df.set(token, (df.get(token) ?? 0) + 1)
const N = chunks.length
function scoreChunk(queryTokens, chunkTokens) {
  const index = new Map()
  for (const token of chunkTokens) index.set(token, (index.get(token) ?? 0) + 1)
  let score = 0
  for (const token of queryTokens) {
    const tf = index.get(token) ?? 0
    if (tf === 0) continue
    const idf = Math.log(1 + N / (df.get(token) ?? 1))
    score += (tf * (idf + 1)) / (tf + 1.5)
  }
  return score
}

const real = JSON.parse(readFileSync(REAL, 'utf8'))
const results = []
for (const q of real.results) {
  const queryTokens = tokenize(q.question)
  const ranked = chunks
    .map((chunk) => ({ chunk, score: scoreChunk(queryTokens, chunk.tokens) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, TOP_K)
  let text = ''
  for (const { chunk } of ranked) {
    if (text.length + chunk.text.length > MAX_CHARS) break
    text += `\n--- ${chunk.sid.slice(0, 8)} #${chunk.i} ---\n${chunk.text}\n`
  }
  results.push({ question: q.question, actual: q.actual, rag: text.slice(0, 6000), memory: (q.projection ?? '').slice(0, 2000) })
}
writeFileSync(join(OUT, 'rag-chunks.json'), JSON.stringify(results, null, 2))
console.log('chunks', chunks.length, 'questions', results.length)
