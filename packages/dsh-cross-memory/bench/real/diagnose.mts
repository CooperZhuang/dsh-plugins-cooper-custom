/**
 * Diagnose the real-session memory failures without any model call.
 *
 * For each authored question the bank stores a verbatim evidence quote, so we can
 * locate the message that carries the fact and ask three cheap questions:
 *
 *   1. is that message inside the extraction window the plugin would read
 *      (`extractWindowMessages` = 60 newest prose messages)?
 *   2. does any linked memory entry mention a key term of a required point?
 *   3. which of the three buckets explains a memory-arm failure:
 *      window (fact outside the last window), selectivity (inside the window but
 *      no entry carries it), or answer (an entry carries it but the answer missed
 *      a point)?
 *
 * The token check is a heuristic (ASCII identifiers or >=2 shared CJK bigrams);
 * every count it prints is labeled with that limitation. `--llm` replaces it
 * with a model check against the actual memory-arm context and splits failures
 * into three sharper buckets: extraction (entries do not carry the fact),
 * presentation (an entry carries it but the block never showed it), and answer
 * (the block showed it but the answer missed a point).
 *
 * Usage:
 *   node bench/real/diagnose.mts
 *   node bench/real/diagnose.mts --llm --provider deepseek
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStore } from '../../lib/storage.js'
import { renderHit, renderMemorySummaryResult } from '../../lib/render.js'
import { searchMemories } from '../../lib/search.js'
import { createChat } from './chat.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')
const WINDOW = 60
const OUT = join(DATA, 'real-diagnosis.json')
const REEXTRACT_ROOT = join(DATA, 'real-reextract')

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** Collapse whitespace so a re-wrapped quote still matches. */
function squash(value) {
  return value.replace(/\s+/gu, '').length > 0 ? value.replace(/\s+/gu, ' ').trim() : ''
}

/** Tokens that make a required point findable in an entry body. */
function pointTokens(point) {
  const ascii = point.match(/[A-Za-z0-9_./:\\-]{3,}/gu) ?? []
  const cjk = point.match(/[\u3400-\u9fff]+/gu) ?? []
  const bigrams = new Set()
  for (const run of cjk) for (let index = 0; index < run.length - 1; index += 1) bigrams.add(run.slice(index, index + 2))
  return { ascii, bigrams: [...bigrams] }
}

/** Whether the entry text mentions at least one key term of the point. */
function pointMentioned(entryText, point) {
  const { ascii, bigrams } = pointTokens(point)
  const distinctive = ascii.filter((token) => token.length >= 4 || /[0-9]/u.test(token))
  if (distinctive.some((token) => entryText.includes(token))) return true
  const shared = bigrams.filter((bigram) => entryText.includes(bigram)).length
  return shared >= 2
}

/**
 * The entries the memory arm actually put in front of the model for one question.
 * Mirrors `bench/real/run.mts`: summary bullets plus on-demand recall hits.
 */
function shownEntries(entries, question) {
  const groups = [
    { scope: 'global', label: 'global', entries: entries.filter((entry) => entry.scope === 'global') },
    { scope: 'project', label: 'project', entries: entries.filter((entry) => entry.scope === 'project') },
  ].filter((group) => group.entries.length > 0)
  const summary = renderMemorySummaryResult(groups.map((group) => ({
    label: group.label,
    heading: group.label,
    entries: group.entries,
    total: group.entries.length,
  })), { maxBytes: 4096, maxEntriesPerScope: 12 })
  const hits = searchMemories(groups, question, { limit: 4 })
  return { ids: new Set([...(summary?.listed ?? []).map((entry) => entry.id), ...hits.map((hit) => hit.entry.id)]), hits }
}

/** Ask the model whether the linked entries carry enough to answer the question. */
async function coversByLlm(chat, question, entries) {
  const material = entries.map((entry) => `[${entry.title}] ${entry.body}`).join('\n\n').slice(0, 6000)
  const reply = await chat([
    { role: 'system', content: '你是诊断员，只返回 JSON。' },
    { role: 'user', content: JSON.stringify({
      问题: question.question,
      必需点: question.required,
      记忆条目: material,
      要求: '只依据这些记忆条目判断：其中是否有足以回答该问题（表达全部必需点）的信息？有就是 true，只有部分或没有就是 false。只返回 {"covers":true|false,"why":"一句话"}。',
    }) },
  ], { json: true, numPredict: 200 })
  try {
    const value = JSON.parse(reply)
    return { covers: value.covers === true, why: String(value.why ?? '') }
  } catch {
    return { covers: false, why: 'diagnosis reply was not JSON' }
  }
}

async function main() {
  const bank = JSON.parse(await readFile(join(DATA, 'real-bank.json'), 'utf8'))
  const candidates = JSON.parse(await readFile(join(DATA, 'real-candidates.json'), 'utf8'))
  const results = JSON.parse(await readFile(join(DATA, 'real-results.json'), 'utf8'))
  const bySession = new Map(candidates.sessions.map((session) => [session.sessionId, session]))
  const rows = new Map(results.rows.map((row) => [row.questionId, row]))
  // Diagnose a re-extracted store instead of the live one, when asked.
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

  const questions = []
  for (const session of bank.sessions) {
    const candidate = bySession.get(session.sessionId)
    if (candidate === undefined) continue
    const entryText = candidate.entries
      .map((entry) => `${entry.title}\n${entry.body}\n${(entry.keys ?? []).join(' ')}\n${(entry.tags ?? []).join(' ')}`)
      .join('\n')
    const squashedEntries = squash(entryText)
    for (const question of session.questions) {
      const quote = squash(question.quote)
      const index = candidate.transcript
        .split('\n\n')
        .findIndex((line) => squash(line).includes(quote))
      // Rebuild the message list to count from the end; transcript lines are the
      // rendered USER/ASSISTANT messages joined by a blank line.
      const lines = candidate.transcript.split('\n\n')
      const fromEnd = index < 0 ? null : lines.length - index
      const mentioned = question.required.map((point) => pointMentioned(squashedEntries, point))
      questions.push({
        questionId: question.id,
        sessionId: session.sessionId,
        fromEnd,
        inWindow: fromEnd === null ? null : fromEnd <= WINDOW,
        requiredMentioned: mentioned,
        anyMentioned: mentioned.some(Boolean),
        memoryPass: rows.get(question.id)?.memory.pass === true,
      })
    }
  }

  const failures = questions.filter((question) => !question.memoryPass)
  const llm = process.argv.includes('--llm')
  let llmUsage
  const buckets = { window: [], selectivity: [], answer: [], extraction: [], presentation: [], unknown: [] }
  if (llm) {
    const { chat, usage } = createChat({
      provider: argValue('--provider') ?? 'ollama',
      model: argValue('--model'),
      keyFile: argValue('--key-file'),
    })
    for (const questionId of failures.map((question) => question.questionId)) {
      const session = bank.sessions.find((item) => item.questions.some((candidate) => candidate.id === questionId))
      const candidate = bySession.get(session.sessionId)
      const detail = session.questions.find((candidate) => candidate.id === questionId)
      const verdict = await coversByLlm(chat, detail, candidate.entries)
      let bucket = 'extraction'
      let why = verdict.why
      if (verdict.covers) {
        // The store carries it; does the block the memory arm actually shows?
        const shown = shownEntries(candidate.entries, detail.question)
        const shownList = candidate.entries.filter((entry) => shown.ids.has(entry.id))
        const shownVerdict = await coversByLlm(chat, detail, shownList)
        bucket = shownVerdict.covers ? 'answer' : 'presentation'
        why = shownVerdict.why
      }
      buckets[bucket].push({ id: questionId, why })
      console.log(`  ${bucket.padEnd(12)} ${questionId.replace('real-', '')} — ${why.slice(0, 70)}`)
    }
    llmUsage = usage
  } else {
    for (const question of failures) {
      if (question.inWindow === null) buckets.unknown.push(question.questionId)
      else if (!question.inWindow) buckets.window.push(question.questionId)
      else if (!question.anyMentioned) buckets.selectivity.push(question.questionId)
      else buckets.answer.push(question.questionId)
    }
  }
  const inWindowPass = questions.filter((question) => question.inWindow).map((question) => question.memoryPass)
  const outWindowPass = questions.filter((question) => question.inWindow === false).map((question) => question.memoryPass)
  const rate = (list) => list.length === 0 ? '—' : `${(list.filter(Boolean).length / list.length * 100).toFixed(1)}% (${list.filter(Boolean).length}/${list.length})`

  const report = {
    at: new Date().toISOString(),
    windowMessages: WINDOW,
    questions: questions.length,
    memoryFailures: failures.length,
    ...llmUsage === undefined ? {} : { diagnosisUsage: llmUsage },
    buckets,
    passRate: {
      inWindow: rate(inWindowPass),
      outOfWindow: rate(outWindowPass),
    },
    reextract: reextract ?? null,
    note: 'token mention is a heuristic: ASCII identifiers (len>=4 or with digits) or >=2 shared CJK bigrams; it can over- or under-detect.',
    questionsDetail: questions,
  }
  await mkdir(DATA, { recursive: true })
  await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`questions ${questions.length} · memory failures ${failures.length}`)
  console.log(Object.entries(buckets).filter(([, value]) => value.length > 0).map(([name, value]) => `${name} ${value.length}`).join(' · '))
  console.log(`memory pass rate: in-window ${report.passRate.inWindow} · out-of-window ${report.passRate.outOfWindow}`)
  console.log(`details: ${OUT}`)
}

await main()
