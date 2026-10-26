import assert from 'node:assert/strict'
import { accessSync, constants, readFileSync } from 'node:fs'
import test from 'node:test'
import { Config, createPostExecuteHandler } from '../lib/index.js'

const RTK = '/opt/homebrew/bin/rtk'
const hasRtk = (() => {
  try {
    accessSync(RTK, constants.X_OK)
    return true
  } catch {
    return false
  }
})()

const fixture = (file) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
const bytes = (text) => Buffer.byteLength(text, 'utf8')

function realHarness(overrides = {}) {
  const spool = []
  const ctx = { logger: { warn: () => {} }, get: () => undefined }
  const handler = createPostExecuteHandler(
    ctx,
    { ...Config({}), command: RTK, ...overrides },
    {
      saveFullText: async (_ctx, _exec, text) => {
        spool.push(text)
        return {
          locator: '/tmp/spill/e2e.txt',
          bytes: bytes(text),
          retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
        }
      },
    },
  )
  const exec = { name: 'bash', callId: 'call-1', agent: { session: { header: { id: 's1' } } } }
  const run = async (text, toolName = 'bash') => {
    const decision = await handler(
      { ...exec, name: toolName },
      { content: [{ type: 'text', text }], isError: false },
      async () => ({ kind: 'accept' }),
    )
    const blocks = decision.content
    return { replaced: blocks !== undefined, text: blocks === undefined ? text : blocks.map((b) => b.text).join('') }
  }
  return { run, spool }
}

test('验收 1（rtk 基线，minBytes 512）：四类语料都被压缩', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  const cargo = await h.run(`${fixture('cargo-test-pass.txt')}[exit code: 0]`)
  assert.ok(cargo.replaced)
  assert.ok(bytes(cargo.text) < bytes(fixture('cargo-test-pass.txt')) / 2, `cargo 压缩不足: ${bytes(cargo.text)}`)

  const pytest = await h.run(`${fixture('pytest-pass.txt')}[exit code: 0]`)
  assert.ok(pytest.replaced)
  assert.ok(bytes(pytest.text) < bytes(fixture('pytest-pass.txt')) / 2)

  const grep = await h.run(`${fixture('grep-rn.txt')}[exit code: 0]`)
  assert.ok(grep.replaced)
  assert.ok(bytes(grep.text) < bytes(fixture('grep-rn.txt')))

  const gitLog = await h.run(`${fixture('git-log.txt')}[exit code: 0]`)
  assert.ok(gitLog.replaced)
  assert.ok(bytes(gitLog.text) < bytes(fixture('git-log.txt')) / 4, `git-log 未走 -f git-log: ${bytes(gitLog.text)}`)
})

test('验收 2（默认 minBytes 2048）：pytest/grep/git-log 替换，866B 的 cargo 不替换', { skip: !hasRtk }, async () => {
  const h = realHarness()
  const cargo = await h.run(`${fixture('cargo-test-pass.txt')}[exit code: 0]`)
  assert.equal(cargo.replaced, false)
  for (const name of ['pytest-pass.txt', 'grep-rn.txt', 'git-log.txt']) {
    const out = await h.run(`${fixture(name)}[exit code: 0]`)
    assert.equal(out.replaced, true, name)
  }
})

test('验收 3：失败行在压缩后逐字仍在', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  for (const [name, needle] of [
    ['cargo-test-fail.txt', 'test result: FAILED'],
    ['pytest-fail.txt', 'FAILED tests/test_x.py::test_4'],
  ]) {
    const out = await h.run(`${fixture(name)}[exit code: 1]`)
    assert.ok(out.text.includes(needle), `${name} 丢失失败行`)
  }
})

test('验收 4：exit code / timeout 标记逐字保留', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  const exit = await h.run(`${fixture('git-log.txt')}[exit code: 1]`)
  assert.ok(exit.text.endsWith('[exit code: 1]'))
  const timedOut = await h.run(`${fixture('git-log.txt')}\n[timed out after 30000ms]`)
  assert.ok(timedOut.text.endsWith('[timed out after 30000ms]'))
})

test('验收 5：每次替换都带 spill 指针，且取回的原文逐字节相同', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  const raw = `${fixture('git-log.txt')}[exit code: 0]`
  const out = await h.run(raw)
  assert.ok(out.text.includes('Full formatted result stored at: /tmp/spill/e2e.txt'))
  assert.equal(h.spool.length, 1)
  assert.equal(h.spool[0], raw)
})

test('验收 6：rtk 不可用时输出与未装插件完全一致', { skip: !hasRtk }, async () => {
  const h = realHarness({ command: '/definitely/not/rtk', minBytes: 512 })
  const raw = `${fixture('git-log.txt')}[exit code: 1]`
  const out = await h.run(raw)
  assert.equal(out.replaced, false)
  assert.equal(out.text, raw)
})

test('验收 8（job_output 路径）：后台输出被压缩，且 [status: …] 状态行逐字保留', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  // job_output renders "<body>\n[status: <status>, <detail>]" and the body can be
  // any tool output, so it is the one path where a sniffed -f filter could eat
  // the harness's own status line.
  const raw = `${fixture('git-log.txt')}[status: exited, code 0]`
  const out = await h.run(raw, 'job_output')
  assert.equal(out.replaced, true)
  assert.ok(out.text.endsWith('[status: exited, code 0]'), `状态行丢失: …${out.text.slice(-60)}`)
  assert.ok(out.text.includes('Full formatted result stored at:'))
  assert.equal(h.spool[0], raw)
})

test('验收 7：内容型输出（ls / 源码 / JSON）逐字节不变', { skip: !hasRtk }, async () => {
  const h = realHarness({ minBytes: 512 })
  for (const name of ['ls-la.txt', 'source.js.txt', 'json.txt']) {
    const raw = `${fixture(name)}[exit code: 0]`
    const out = await h.run(raw)
    assert.equal(out.text, raw, `${name} 不应被替换`)
  }
})
