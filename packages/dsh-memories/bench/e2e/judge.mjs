/**
 * Shared blind judge for the end-to-end benchmarks.
 *
 * The synthetic bank (`../e2e`) and the real-session harness (`../real`) both
 * grade answers here, so a judge rule changed for one is changed for both. The
 * judge is point-by-point (v5): a whole-answer pass/fail let the judge mix two
 * points, and one correct answer was failed because the forbidden point and the
 * answer shared words while saying opposite things.
 */

/** The rules sent with every grading request. */
export const JUDGE_RULES = '逐条判断，不要给整体印象分。必需点：回答是否表达了这个意思（意思对即可，不要求原词）。禁止点：回答是否在主张这条禁止的说法/做法成立？只有回答明确支持它才算违反；回答反对、劝阻、否定、说它不成立，或把它当例外/条件/对照提起，都不算违反；判断时只看回答的主张，不要因为出现相同词语就判违反。回答「不知道」时所有必需点 met=false。只返回 {"required":[{"index":0,"met":true|false}],"forbidden":[{"index":0,"violated":true|false}],"reason":"一句话"}，逐条覆盖每一个 index。'

/** Read a per-point flag the judge returned, by its index. */
function pointFlag(list, index, key) {
  const item = Array.isArray(list)
    ? list.find((entry) => entry !== null && typeof entry === 'object' && Number(entry.index) === index)
    : undefined
  return item?.[key] === true
}

/**
 * Build a judge bound to one chat function.
 *
 * @param {(messages: object[], options?: object) => Promise<string>} chat - provider call.
 * @returns {(scenario: {question: string, required: string[], forbidden: string[]}, answerText: string) => Promise<{pass: boolean, checks: object, reason: string}>} judge.
 */
export function createJudge(chat) {
  return async function judge(scenario, answerText) {
    const reply = await chat([
      { role: 'system', content: '你是判分员，只返回 JSON。' },
      { role: 'user', content: JSON.stringify({
        问题: scenario.question,
        回答: answerText,
        必需点: scenario.required.map((point, index) => ({ index, point })),
        禁止点: scenario.forbidden.map((point, index) => ({ index, point })),
        要求: JUDGE_RULES,
      }) },
    ], { json: true, numPredict: 300 })
    try {
      const value = JSON.parse(reply)
      const required = scenario.required.map((point, index) => ({ point, met: pointFlag(value.required, index, 'met') }))
      const forbidden = scenario.forbidden.map((point, index) => ({ point, violated: pointFlag(value.forbidden, index, 'violated') }))
      const pass = required.every((item) => item.met) && forbidden.every((item) => !item.violated)
      return { pass, checks: { required, forbidden }, reason: String(value.reason ?? '') }
    } catch {
      // A judge that cannot answer is not a pass: report it as a failure with why.
      return { pass: false, checks: { required: [], forbidden: [] }, reason: `judge reply was not JSON: ${reply.slice(0, 120)}` }
    }
  }
}

/**
 * Fixed anchors that pin the grading rules before any paid run.
 *
 * Each anchor is a case whose correct verdict is known: a correct answer with an
 * exception, a wrong answer, an answer stating the opposite of the forbidden
 * point, a partial answer, and a negated prohibition.
 *
 * @param {Function} judge - a judge from {@link createJudge}.
 * @returns {Promise<{pass: boolean, good: boolean, bad: boolean, opposite: boolean, partial: boolean, negated: boolean}>} per-anchor verdicts.
 */
export async function anchorGate(judge) {
  const question = '本地开发服务器该用哪个端口？'
  const good = await judge({ question, required: ['本地用 4567'], forbidden: ['本地必须用 3000'] },
    '本地开发固定用 4567，3000 会和其他项目冲突；CI 里仍可用 3000。')
  const bad = await judge({ question, required: ['本地用 4567'], forbidden: ['本地必须用 3000'] },
    '本地开发就用 3000。')
  const opposite = await judge({ question: '这些延迟数字是什么配置下测的？', required: ['旧限流配置'], forbidden: ['改限流后的配置'] },
    '这些数字是旧限流配置下测的。')
  const partial = await judge({ question: '本地起服务和跑测试分别用什么？', required: ['起服务用 4567', '测试用 pnpm test'], forbidden: [] },
    '起服务用 4567。')
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

/** Format a passed/total pair for a report. */
export function percentage(passed, total) {
  return total === 0 ? '—' : `${(passed / total * 100).toFixed(1)}% (${passed}/${total})`
}
