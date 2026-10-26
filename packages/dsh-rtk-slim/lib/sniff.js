/**
 * Family detection: decide whether `rtk pipe -f <filter>` is provably
 * applicable to this text. A wrong `-f` destroys content (measured: 751 B of
 * unrelated text collapsed to 4 lines), so anything unrecognised falls through
 * to a bare `rtk pipe`, which passes unrecognised text through byte-for-byte.
 *
 * @module dsh-rtk-slim/sniff
 */

const CARGO_RUNNING = /^running \d+ tests?$/m
const CARGO_RESULT = /^test result:/m
const PYTEST_HEADER = /^=+ .*test session starts.* =+$/m
const PYTEST_OUTCOME = /^\S+::\S+ (?:PASSED|FAILED|ERROR)/m
const GIT_ONELINE = /^[0-9a-f]{7,40} \S/
const GIT_COMMIT = /^commit [0-9a-f]{40}$/m
const GREP_LINE = /^[^\s:]*[/.][^\s:]*:\d+:/
const BARE_LINE = /^\S+$/

/**
 * @param {string} text
 * @param {RegExp} re
 * @returns {number}
 */
function countLines(text, re) {
  const global = new RegExp(re.source, 'gm')
  const found = text.match(global)
  return found === null ? 0 : found.length
}

/** @typedef {{ id: string, filter: string, test: (text: string) => boolean }} Family */

/** Ordered families; first match wins. */
export const FAMILIES = /** @type {Family[]} */ ([
  {
    id: 'cargo-test',
    filter: 'cargo-test',
    test: (text) => CARGO_RUNNING.test(text) && CARGO_RESULT.test(text),
  },
  {
    id: 'pytest',
    filter: 'pytest',
    test: (text) => PYTEST_HEADER.test(text) || PYTEST_OUTCOME.test(text),
  },
  {
    id: 'git-log',
    filter: 'git-log',
    test: (text) => countLines(text, GIT_ONELINE) >= 5 || GIT_COMMIT.test(text),
  },
  {
    id: 'grep',
    filter: 'grep',
    test: (text) => countLines(text, GREP_LINE) >= 5,
  },
  {
    id: 'find',
    filter: 'find',
    test: (text) => {
      const bare = text.split('\n').filter((line) => BARE_LINE.test(line))
      if (bare.length < 10) return false
      return bare.every((line) => line.includes('/')) && bare.every((line) => !line.includes(':'))
    },
  },
])

/**
 * @typedef {Record<string, string | false>} FilterOverrides
 */

/**
 * @param {string} text body text (trailing status markers already removed)
 * @param {FilterOverrides} [overrides] config `filters`
 * @returns {{ family: string, filter: string | undefined }} `auto` means "bare rtk pipe"
 */
export function chooseFilter(text, overrides = {}) {
  for (const family of FAMILIES) {
    const override = overrides[family.id]
    if (override === false) continue
    if (!family.test(text)) continue
    return { family: family.id, filter: typeof override === 'string' ? override : family.filter }
  }
  return { family: 'auto', filter: undefined }
}
