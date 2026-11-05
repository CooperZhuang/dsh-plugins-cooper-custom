/**
 * Tests for raw-turn recall.
 *
 * The excerpt selector is the whole feature: it decides which original turn is
 * worth showing next to a memory, must scrub credentials, and must stay inside
 * the byte budget. Reading the transcript from the persisted logs is tested with
 * a synthetic zstd log, the same shape the backfill tests use.
 *
 * @module dsh-cross-memory/test/raw-recall.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { normalizeSettings } from '../config.js'
import { renderRecall } from '../render.js'
import { collectExcerpts, readTranscript, selectExcerpts, windowAroundQuote } from '../raw-recall.js'
import { MemoriesRuntime } from '../index.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { zstdAvailable } from '../backfill.js'
import type { BackfillMessage } from '../backfill.js'

/** One message, as the transcript reader yields it. */
function message(seq: number, role: 'user' | 'assistant', text: string): BackfillMessage {
  return { seq, role, text }
}

/** One JSONL log line. */
function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`
}

/** A synthetic session log with prose, an injected block and a tool call. */
function sampleLog(sessionId: string): string {
  return [
    line({ type: 'session', seq: 1, id: sessionId, cwd: '/tmp/work', delegationDepth: 0 }),
    line({ type: 'user/message', seq: 2, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '部署脚本的日志路径是 /var/log/deploy/app.log，出问题先看这个文件。' }] } }),
    line({ type: 'user/message', seq: 3, data: { role: 'user', source: { kind: 'plugin:memories' }, content: [{ type: 'text', text: '<memory-context>injected</memory-context>' }] } }),
    line({ type: 'assistant/message', seq: 4, data: { message: { role: 'assistant', content: [{ type: 'text', text: '收到，部署失败时优先检查 /var/log/deploy/app.log。' }] } } }),
    line({ type: 'tool/call', seq: 5, data: { name: 'bash', arguments: '{}' } }),
  ].join('')
}

test('raw recall is off by default and bounded by its own knobs', () => {
  const settings = normalizeSettings({})
  assert.equal(settings.rawRecall, false, 'injecting prose from other sessions is opt-in')
  assert.equal(settings.rawRecallBytes, 2_400)
  assert.equal(settings.rawRecallExcerpts, 3)
  const tuned = normalizeSettings({ rawRecall: true, rawRecallBytes: -10, rawRecallExcerpts: 0 })
  assert.equal(tuned.rawRecall, true)
  assert.equal(tuned.rawRecallBytes, 0)
  assert.equal(tuned.rawRecallExcerpts, 0)
})

test('selectExcerpts keeps the turn that shares real evidence and drops generic overlap', () => {
  const messages = [
    message(1, 'user', '今天天气不错，我们随便聊聊。'),
    message(2, 'user', '部署脚本的日志在 /var/log/deploy/app.log，部署失败先看它。'),
    message(3, 'assistant', '好的，部署失败先查 /var/log/deploy/app.log。'),
    message(4, 'user', '另外那个前端页面颜色不太对。'),
  ]
  const excerpts = selectExcerpts(messages, '部署失败了应该看哪个日志？')
  assert.ok(excerpts.length >= 1)
  assert.ok(excerpts.some((excerpt) => excerpt.text.includes('/var/log/deploy/app.log')))
  assert.ok(excerpts.every((excerpt) => !excerpt.text.includes('天气')))
})

test('selectExcerpts scrubs credentials and respects the count/character caps', () => {
  const messages = [
    message(1, 'user', '部署脚本里 api_key = "supersecretvalue" 别提交，日志看 /var/log/deploy/app.log。'),
    message(2, 'user', '部署日志路径 /var/log/deploy/app.log 出问题就看。'),
    message(3, 'user', '部署失败时也看 /var/log/deploy/worker.log。'),
  ]
  const excerpts = selectExcerpts(messages, '部署日志在哪里，api_key 怎么处理？', { maxExcerpts: 2, maxChars: 60 })
  assert.ok(excerpts.length <= 2)
  assert.ok(excerpts.every((excerpt) => excerpt.text.length <= 60))
  assert.ok(excerpts.every((excerpt) => !excerpt.text.includes('supersecretvalue')))
  assert.ok(excerpts.every((excerpt) => !excerpt.text.includes('[redacted]') || !excerpt.text.includes('sk-')))
})

test('selectExcerpts returns nothing for a query with no usable tokens', () => {
  assert.deepEqual(selectExcerpts([message(1, 'user', '部署日志在 /var/log/deploy/app.log')], '嗯'), [])
  assert.deepEqual(selectExcerpts([], '部署日志在哪里'), [])
})

test('windowAroundQuote reproduces the sentence a memory was written from', () => {
  const filler = '无关的背景说明。'.repeat(200)
  const quote = '部署脚本的日志路径是 /var/log/deploy/app.log，出问题先看这个文件。'
  const messages = [
    message(1, 'user', `${filler}${quote}${filler}`),
    message(2, 'assistant', '收到。'),
  ]
  const excerpt = windowAroundQuote(messages, quote, 600)
  assert.ok(excerpt !== undefined)
  assert.ok(excerpt.text.includes('var/log/deploy/app.log'), 'the quote is inside the window, not cut off')
  assert.ok(excerpt.text.length <= 600)
  assert.equal(windowAroundQuote(messages, '这段原文已经不在会话里了', 600), undefined)
})

test('readTranscript finds the session log by directory name and returns prose only', async (t) => {
  if (!zstdAvailable()) return
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-raw-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sessionId = 'session-raw-1'
  const logDir = join(dir, sessionId)
  await mkdir(logDir, { recursive: true })
  await writeFile(join(logDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(sampleLog(sessionId), 'utf8')))
  const messages = await readTranscript(dir, sessionId)
  assert.ok(messages !== undefined)
  assert.deepEqual(messages.map((item) => item.text), [
    '部署脚本的日志路径是 /var/log/deploy/app.log，出问题先看这个文件。',
    '收到，部署失败时优先检查 /var/log/deploy/app.log。',
  ])
  assert.equal(await readTranscript(dir, 'session-missing'), undefined)
})

test('collectExcerpts reads at most two source sessions and tags each excerpt', async (t) => {
  if (!zstdAvailable()) return
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-raw-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const sessionId of ['session-a', 'session-b']) {
    const logDir = join(dir, sessionId)
    await mkdir(logDir, { recursive: true })
    await writeFile(join(logDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(sampleLog(sessionId), 'utf8')))
  }
  const excerpts = await collectExcerpts(dir, [
    { sessionId: 'session-a' },
    { sessionId: 'session-b' },
    { sessionId: 'session-missing' },
  ], '部署日志在哪里', { maxExcerpts: 2 })
  assert.ok(excerpts.length >= 1)
  assert.ok(excerpts.every((excerpt) => excerpt.sessionId === 'session-a' || excerpt.sessionId === 'session-b'))
})

test('renderRecall puts raw excerpts inside the frame and keeps the byte budget', () => {
  const text = renderRecall([], 2_000, [], [
    { sessionId: 'session-a', seq: 2, role: 'user', text: '部署脚本的日志在 /var/log/deploy/app.log。' },
  ])
  assert.ok(text !== undefined)
  assert.match(text, /<memory-recall>/u)
  assert.match(text, /Original conversation excerpts/u)
  assert.match(text, /session-a/u)
  assert.ok(Buffer.byteLength(text, 'utf8') <= 2_000)
  // A block with only excerpts is still a block.
  assert.equal(renderRecall([], 100, [], []), undefined)
})

/** A minimal context the runtime can start under. */
const stubContext = { get: () => undefined, logger: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined } } as never

/** A session with one user turn, which is what the recall path reads. */
function recallSession(userText: string): Session {
  return {
    id: 'session-raw-int',
    header: { version: 0, id: 'session-raw-int', createdAt: 0, isSeeded: false },
    seq: 1,
    requestHeader: () => undefined,
    deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }],
  } as unknown as Session
}

function recallAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

test('an on-demand recall carries original excerpts when rawRecall is on', async (t) => {
  if (!zstdAvailable()) return
  const home = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-raw-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const memoriesDir = join(home, 'memories')
  const sessionId = 'session-raw-int'
  const logDir = join(home, 'sessions', sessionId)
  await mkdir(logDir, { recursive: true })
  await writeFile(join(logDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(sampleLog(sessionId), 'utf8')))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir, dshHome: home, autoExtract: false, rawRecall: true })
  t.after(() => runtime.dispose())
  const session = recallSession('部署失败了应该看哪个日志？')
  await runtime.write(session, {
    scope: 'global',
    title: '部署日志路径',
    body: '部署失败时先看 /var/log/deploy/app.log。',
    tags: ['部署'],
    sourceSession: sessionId,
    // The stored quote is what the excerpt is grounded on; it must come from the
    // same source session.
    quote: '部署脚本的日志路径是 /var/log/deploy/app.log，出问题先看这个文件。',
    evidenceSeq: 2,
  }, 'tool')
  const message = await runtime.recallFor(recallAgent(session))
  assert.ok(message !== undefined, 'the memory matches, so a recall block is emitted')
  const text = (message.content as readonly { type: string; text?: string }[])
    .filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
  assert.match(text, /<memory-recall>/u)
  assert.match(text, /Original conversation excerpts/u, 'the raw half rides with the memory')
  assert.match(text, /session-raw-int/u, 'each excerpt names its source session')
  assert.match(text, /var\/log\/deploy\/app\.log/u)
  assert.match(text, /出问题先看这个文件/u, 'the excerpt is the exact source sentence')
})
