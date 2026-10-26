import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { chooseFilter } from '../lib/sniff.js'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('正例：四个家族各自命中', () => {
  assert.equal(chooseFilter(fixture('cargo-test-pass.txt')).filter, 'cargo-test')
  assert.equal(chooseFilter(fixture('pytest-pass.txt')).filter, 'pytest')
  assert.equal(chooseFilter(fixture('git-log.txt')).filter, 'git-log')
  assert.equal(chooseFilter(fixture('grep-rn.txt')).filter, 'grep')
})

test('负例：五类内容一律落 auto（不猜 filter）', () => {
  for (const name of ['ls-la.txt', 'source.js.txt', 'json.txt', 'log-timestamps.txt']) {
    assert.deepEqual(chooseFilter(fixture(name)), { family: 'auto', filter: undefined }, name)
  }
  assert.deepEqual(chooseFilter('plain unstructured text\n'.repeat(20)), { family: 'auto', filter: undefined })
})

test('边界：只有 running N tests 而没有 test result 不算 cargo-test', () => {
  const text = 'running 40 tests\ntest a ... ok\n'
  assert.equal(chooseFilter(text).family, 'auto')
})

test('边界：含 :: 但没有结果词不算 pytest', () => {
  const text = 'src/a.ts::handler\nsrc/b.ts::other\n'.repeat(10)
  assert.equal(chooseFilter(text).family, 'auto')
})

test('边界：3 行 grep 形态不触发（阈值 5）', () => {
  const text = 'a/x.ts:1:one\nb/y.ts:2:two\nc/z.ts:3:three\n'
  assert.equal(chooseFilter(text).family, 'auto')
})

test('边界：find 形态（裸路径、无冒号）命中 find', () => {
  const text = Array.from({ length: 12 }, (_, i) => `src/deep/dir_${i}/file.ts`).join('\n') + '\n'
  assert.equal(chooseFilter(text).filter, 'find')
})

test('overrides：字符串覆盖 filter 名，false 停用该家族', () => {
  const text = fixture('git-log.txt')
  assert.equal(chooseFilter(text, { 'git-log': 'log' }).filter, 'log')
  assert.equal(chooseFilter(text, { 'git-log': false }).family, 'auto')
})
