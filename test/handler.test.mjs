import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Config, createPostExecuteHandler, name } from '../lib/index.js'

const fixture = (file) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')

const SPILL_REF = {
  locator: '/tmp/spill/x.txt',
  bytes: 1,
  retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
}

/**
 * The fixture corpora are deliberately small (866 B for cargo-test), so the
 * harness pins `minBytes` to 512; the *default* 2048 gate has its own test in
 * test/e2e-real-rtk.test.mjs (验收 2).
 */
function harness(overrides = {}) {
  const warnings = []
  const saved = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (key) => (key === 'spillStore' ? { saveText: async () => SPILL_REF } : undefined),
  }
  const calls = []
  const deps = {
    runRtk: async (input) => {
      calls.push(input)
      return { ok: true, text: 'CONDENSED' }
    },
    saveFullText: async (_ctx, _exec, text) => {
      saved.push({ content: text })
      return SPILL_REF
    },
  }
  const handler = createPostExecuteHandler(ctx, { ...Config({}), minBytes: 512, ...overrides }, deps)
  const exec = { name: 'bash', callId: 'call-1', signal: undefined, agent: { session: { header: { id: 'session-1' } } } }
  const result = (text, extra = {}) => ({ content: [{ type: 'text', text }], isError: false, ...extra })
  const next = async () => ({ kind: 'accept' })
  return { handler, exec, result, next, warnings, saved, calls }
}

const textOf = (decision) => decision.content.map((block) => block.text).join('')

test('name 与 Config 形状', () => {
  assert.equal(name, 'rtk-slim')
  const cfg = Config({})
  assert.equal(cfg.minBytes, 2048)
  assert.deepEqual(cfg.tools, ['bash', 'job_output'])
  assert.equal(cfg.requireSpill, true)
  assert.equal(cfg.ultraCompact, false)
})

test('命中：替换为 单个 text block（精简正文 + notice + 原标记），并把原文落盘', async () => {
  const h = harness()
  const raw = `${fixture('cargo-test-pass.txt')}[exit code: 1]`
  const decision = await h.handler(h.exec, h.result(raw), h.next)
  const text = textOf(decision)
  assert.ok(text.startsWith('CONDENSED'))
  assert.ok(text.includes('(rtk condensed '))
  assert.ok(text.endsWith('[exit code: 1]'))
  assert.equal(decision.content.length, 1)
  assert.equal(decision.kind, 'accept')
  assert.equal(h.saved.length, 1)
  assert.equal(h.saved[0].content, raw)
  assert.deepEqual(h.calls[0].args.slice(0, 3), ['pipe', '-f', 'cargo-test'])
})

test('低门槛/高门槛：低于 minBytes 或高于 maxInputBytes 直接放行', async () => {
  const h = harness({ minBytes: 2048 })
  const small = await h.handler(h.exec, h.result('tiny [exit code: 1]'), h.next)
  assert.equal(small.content, undefined) // accept 但没带 content => 未替换
  const h2 = harness({ maxInputBytes: 640 })
  const wide = await h2.handler(h2.exec, h2.result(`${fixture('cargo-test-pass.txt')}[exit code: 1]`), h2.next)
  assert.equal(wide.content, undefined)
  assert.equal(h2.calls.length, 0)
})

test('非目标工具 / 失败结果 / 非单文本块 / block 决策：一律原样放行', async () => {
  const h = harness()
  assert.equal((await h.handler({ ...h.exec, name: 'read' }, h.result('x'.repeat(9000)), h.next)).content, undefined)
  assert.equal((await h.handler(h.exec, h.result('x'.repeat(9000), { isError: true }), h.next)).content, undefined)
  assert.equal(
    (
      await h.handler(
        h.exec,
        { content: [{ type: 'text', text: 'a'.repeat(9000) }, { type: 'text', text: 'b' }], isError: false },
        h.next,
      )
    ).content,
    undefined,
  )
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
  assert.equal(await h.handler(h.exec, h.result('x'.repeat(9000)), async () => blocked), blocked)
  assert.equal(h.calls.length, 0)
})

test('rtk 失败：保留原文并按 reason 去重告警', async () => {
  const h = harness()
  const failing = createPostExecuteHandler(
    { logger: { warn: (m) => h.warnings.push(m) }, get: () => undefined },
    { ...Config({}), minBytes: 512 },
    { runRtk: async () => ({ ok: false, reason: 'timeout' }), saveFullText: async () => undefined },
  )
  const raw = `${fixture('cargo-test-pass.txt')}[exit code: 1]`
  assert.equal((await failing(h.exec, h.result(raw), h.next)).content, undefined)
  assert.equal((await failing(h.exec, h.result(raw), h.next)).content, undefined)
  assert.equal(h.warnings.filter((line) => line.includes('rtk:timeout')).length, 1, '同一 reason 只告警一次')
})

test('guard 不过：失败行丢失 / 变大 / 未变化 都保留原文', async () => {
  const raw = `${fixture('cargo-test-fail.txt')}[exit code: 1]`
  const cases = ['SUMMARY ONLY', `${raw}EXTRA`, raw]
  for (const condensed of cases) {
    const h = harness()
    const handler = createPostExecuteHandler(
      { logger: { warn: () => {} }, get: () => undefined },
      { ...Config({}), minBytes: 512 },
      { runRtk: async () => ({ ok: true, text: condensed }), saveFullText: async () => undefined },
    )
    assert.equal(
      (await handler(h.exec, h.result(raw), h.next)).content,
      undefined,
      JSON.stringify(condensed.slice(0, 20)),
    )
  }
})

test('requireSpill：落盘不可用时放弃替换；spill 关闭时可无指针替换', async () => {
  const raw = `${fixture('cargo-test-pass.txt')}[exit code: 1]`
  const strict = createPostExecuteHandler(
    { logger: { warn: () => {} }, get: () => undefined },
    { ...Config({}), minBytes: 512 },
    { runRtk: async () => ({ ok: true, text: 'CONDENSED' }), saveFullText: async () => undefined },
  )
  const strictDecision = await strict(
    { name: 'bash' },
    { content: [{ type: 'text', text: raw }], isError: false },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(strictDecision.content, undefined)

  const relaxed = createPostExecuteHandler(
    { logger: { warn: () => {} }, get: () => undefined },
    { ...Config({}), minBytes: 512, spill: false },
    { runRtk: async () => ({ ok: true, text: 'CONDENSED' }), saveFullText: async () => undefined },
  )
  const decision = await relaxed(
    { name: 'bash' },
    { content: [{ type: 'text', text: raw }], isError: false },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(textOf(decision), 'CONDENSED\n[exit code: 1]')
})

test('additionalContexts 与 exec.signal 透传', async () => {
  const h = harness()
  const signal = new AbortController().signal
  const ctxMessage = { role: 'user', content: [{ type: 'text', text: 'ctx' }] }
  const decision = await h.handler({ ...h.exec, signal }, h.result(`${fixture('git-log.txt')}[exit code: 0]`), async () => ({
    kind: 'accept',
    additionalContexts: [ctxMessage],
  }))
  assert.deepEqual(decision.additionalContexts, [ctxMessage])
  assert.equal(h.calls[0].signal, signal)
  assert.deepEqual(h.calls[0].args.slice(0, 3), ['pipe', '-f', 'git-log'])
})

test('默认走裸 pipe（认不出的家族）且 ultraCompact 可透传', async () => {
  const h = harness({ ultraCompact: true, minBytes: 512 })
  await h.handler(h.exec, h.result(`${fixture('source.js.txt')}[exit code: 1]`), h.next)
  assert.deepEqual(h.calls[0].args, ['pipe', '--ultra-compact'])
})
