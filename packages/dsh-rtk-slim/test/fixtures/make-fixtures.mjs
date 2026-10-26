#!/usr/bin/env node
// Deterministic corpora for sniff/guard/e2e tests. Run from the repo root:
//   node test/fixtures/make-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const write = (name, text) => writeFileSync(join(here, name), text)

const cargo = (result) => {
  const lines = [
    '   Compiling foo v0.1.0',
    '    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.2s',
    '     Running tests/lib.rs',
    'running 40 tests',
  ]
  for (let i = 1; i <= 40; i += 1) lines.push(`test t${i} ... ${result === 'FAILED' && i === 7 ? 'FAILED' : 'ok'}`)
  lines.push('')
  lines.push(
    result === 'FAILED'
      ? 'test result: FAILED. 39 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s'
      : 'test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s',
  )
  return `${lines.join('\n')}\n`
}

const pytest = (result) => {
  const lines = [
    '============================= test session starts ==============================',
    'platform darwin -- Python 3.11.0',
    'collected 30 items',
    '',
  ]
  for (let i = 1; i <= 30; i += 1) {
    const outcome = result === 'FAILED' && i === 4 ? 'FAILED' : 'PASSED'
    lines.push(`tests/test_x.py::test_${i} ${outcome}${' '.repeat(Math.max(1, 34 - String(i).length))}[ ${i * 3}%]`)
  }
  lines.push('')
  lines.push(
    result === 'FAILED'
      ? '=================================== FAILURES ===================================\n__________________________________ test_4 ______________________________________\n\n    assert 1 == 2\nE   AssertionError\n\n=========================== short test summary info ============================\nFAILED tests/test_x.py::test_4 - AssertionError\n========================= 1 failed, 29 passed in 1.44s ========================='
      : '============================== 30 passed in 1.44s ==============================',
  )
  return `${lines.join('\n')}\n`
}

const gitLog = () => {
  const subjects = [
    '可观测性：摘要脚本 + 三条事后确认检索效果的行',
    '搜索面按词法相关度排序，注入面保持按注意力',
    '检索评测分成两个承诺来量：排名与闸门；并把「中文改写」那条查清',
    '一跳的边加上稀有度规则，并用评测把 EXPAND_FACTOR 定在 0.4',
    '真实库离线检索评测：并修掉它当场暴露的三个一跳错误',
  ]
  const lines = []
  for (let i = 0; i < 74; i += 1) {
    const sha = (0x1000000 + i * 0x9e3779b1).toString(16).slice(0, 7)
    lines.push(`${sha} ${subjects[i % subjects.length]} #${i}`)
  }
  return `${lines.join('\n')}\n`
}

// Real `grep -rn` output is grouped by file (several matches per path); rtk's
// `grep` filter relies on that grouping, so the fixture must reproduce it
// rather than emitting one match per file.
const grepRn = () => {
  const files = [
    { path: '/Users/cooper/Documents/Code/some-repo/src/search/indexer.ts', lines: 24 },
    { path: '/Users/cooper/Documents/Code/some-repo/src/search/ranker.ts', lines: 19 },
    { path: '/Users/cooper/Documents/Code/some-repo/src/search/gate.ts', lines: 15 },
    { path: '/Users/cooper/Documents/Code/some-repo/src/search/lexical.ts', lines: 12 },
  ]
  const lines = []
  for (const [index, file] of files.entries()) {
    for (let i = 0; i < file.lines; i += 1) {
      const lineNo = 40 + i * 7 + index
      lines.push(`${file.path}:${lineNo}:  const hits = await search(query, { limit: ${i + 1}, mode: 'lexical' })`)
    }
  }
  return `${lines.join('\n')}\n`
}

const lsLa = () => {
  const lines = ['total 96']
  for (let i = 0; i < 40; i += 1) {
    lines.push(`drwx------@ ${String(i).padStart(3)} cooper  admin   ${String(96 + i).padStart(5)} Oct 16 12:0${i % 10} dir_${i}`)
  }
  return `${lines.join('\n')}\n`
}

const source = () => {
  const lines = ['/** A module. */', 'import { x } from "./x.js"', '']
  for (let i = 0; i < 120; i += 1) lines.push(`export function fn${i}(a, b) { return a + b + ${i} }`)
  return `${lines.join('\n')}\n`
}

const json = () => {
  const object = {}
  for (let i = 0; i < 120; i += 1) object[`key_${i}`] = `value_${i}`
  return `${JSON.stringify(object, null, 2)}\n`
}

const logTimestamps = () => {
  const lines = []
  for (let i = 0; i < 40; i += 1) {
    lines.push(`2024-01-0${(i % 9) + 1}:12:0${i % 10}:00: request handled in ${i}ms`)
  }
  return `${lines.join('\n')}\n`
}

mkdirSync(here, { recursive: true })
write('cargo-test-pass.txt', cargo('ok'))
write('cargo-test-fail.txt', cargo('FAILED'))
write('pytest-pass.txt', pytest('ok'))
write('pytest-fail.txt', pytest('FAILED'))
write('git-log.txt', gitLog())
write('grep-rn.txt', grepRn())
write('ls-la.txt', lsLa())
write('source.js.txt', source())
write('json.txt', json())
write('log-timestamps.txt', logTimestamps())
console.log('fixtures written:', here)
