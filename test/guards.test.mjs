import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { checkInvariants, collectFailureLines } from '../lib/guards.js'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('I2 陷阱回归：全通过的测试输出里 "0 failed" 不得恒假', () => {
  const raw = fixture('cargo-test-pass.txt')
  assert.deepEqual(collectFailureLines(raw), [])
  assert.deepEqual(checkInvariants({ raw, condensed: 'cargo test: 40 passed (1 suite, 0.31s)' }), { ok: true })
})

test('I2：失败的测试输出一旦丢掉失败行就回退', () => {
  const raw = fixture('cargo-test-fail.txt')
  assert.ok(collectFailureLines(raw).some((line) => line.startsWith('test result: FAILED')))
  assert.deepEqual(checkInvariants({ raw, condensed: 'cargo test: 39 passed, 1 failed' }), {
    ok: false,
    reason: 'failures',
  })
})

test('I2：pytest 失败行同理', () => {
  const raw = fixture('pytest-fail.txt')
  const condensed = raw.split('\n').filter((line) => line.includes('FAILED')).join('\n')
  assert.deepEqual(checkInvariants({ raw, condensed }), { ok: true })
  assert.deepEqual(checkInvariants({ raw, condensed: '1 failed, 29 passed in 1.44s' }), {
    ok: false,
    reason: 'failures',
  })
})

test('共同前置：空 / 未变化 / 变大 三种闸门', () => {
  assert.deepEqual(checkInvariants({ raw: 'abc', condensed: '' }), { ok: false, reason: 'empty' })
  assert.deepEqual(checkInvariants({ raw: 'abc', condensed: 'abc' }), { ok: false, reason: 'unchanged' })
  assert.deepEqual(checkInvariants({ raw: 'abc', condensed: 'abcd' }), { ok: false, reason: 'expanded' })
  assert.deepEqual(checkInvariants({ raw: 'abc\n', condensed: 'abc' }), { ok: false, reason: 'unchanged' })
})

test('I3：极端压缩比且无省略标记 -> ratio 回退；带省略标记 -> 放行', () => {
  const raw = `${Array.from({ length: 900 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')}\n`
  assert.ok(Buffer.byteLength(raw, 'utf8') >= 32 * 1024)
  assert.deepEqual(checkInvariants({ raw, condensed: 'stub' }), { ok: false, reason: 'ratio' })
  assert.deepEqual(checkInvariants({ raw, condensed: 'first\n[+899 lines omitted]' }), { ok: true })
  assert.deepEqual(checkInvariants({ raw, condensed: 'first\nFull formatted result stored at: /tmp/x.txt' }), { ok: true })
})

test('字节单位：多字节 UTF-8 文本下比值按字节算', () => {
  const raw = '中文'.repeat(20) // 120 chars, 360 bytes
  assert.deepEqual(checkInvariants({ raw, condensed: '中文' }), { ok: true }) // 6 bytes < 360
})
