import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runRtk } from '../lib/rtk.js'

const stub = fileURLToPath(new URL('./bin/rtk-stub.mjs', import.meta.url))

const call = (mode, overrides = {}) => {
  process.env.RTK_STUB_MODE = mode
  return runRtk({
    command: process.execPath,
    args: [stub],
    input: 'hello world',
    timeoutMs: 2000,
    maxOutputBytes: 1024 * 1024,
    ...overrides,
  })
}

test('正常：拿到 stdout 文本', async () => {
  assert.deepEqual(await call('ok'), { ok: true, text: 'CONDENSED 11' })
})

test('非零退出：reason=exit', async () => {
  assert.deepEqual(await call('exit'), { ok: false, reason: 'exit' })
})

test('空输出：成功但文本为空（由 guards 判 empty）', async () => {
  assert.deepEqual(await call('empty'), { ok: true, text: '' })
})

test('超时：整组击杀并回退', async () => {
  const started = Date.now()
  const result = await call('hang', { timeoutMs: 300 })
  assert.deepEqual(result, { ok: false, reason: 'timeout' })
  assert.ok(Date.now() - started < 3000, '超时后必须及时返回，不能等子进程自然结束')
})

test('超过 maxOutputBytes：reason=too-large', async () => {
  assert.deepEqual(await call('big', { maxOutputBytes: 4096 }), { ok: false, reason: 'too-large' })
})

test('调用方取消：reason=aborted', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  assert.deepEqual(await call('hang', { signal: controller.signal, timeoutMs: 5000 }), {
    ok: false,
    reason: 'aborted',
  })
})

test('可执行文件不存在：reason=spawn', async () => {
  assert.deepEqual(
    await runRtk({
      command: '/definitely/not/a/binary',
      args: [],
      input: 'x',
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    }),
    { ok: false, reason: 'spawn' },
  )
})
