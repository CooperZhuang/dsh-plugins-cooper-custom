/**
 * Backfill tests.
 *
 * The pass must read a real session log without a host service, keep only the
 * prose the extractor wants, cut bounded windows, and never spend a model call
 * unless the caller explicitly asked for it.
 *
 * @module dsh-memories/test/backfill.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { MemoriesRuntime } from '../index.js'
import { decodeSessionLog, findSessionLogs, parseSessionLog, planWindows, zstdAvailable } from '../backfill.js'
import type { Session } from '@deepseek-ai/dsh-session'

/** A session stand-in for the runtime call. */
function stubSession(id: string): Session {
  return {
    id,
    header: { version: 0, id, createdAt: 0, isSeeded: false },
    requestHeader: () => undefined,
    deriveMessages: () => [],
  } as unknown as Session
}

/** One JSONL log line. */
function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`
}

/** A small synthetic session log with both kinds of message and one injected block. */
function sampleLog(sessionId = 'session-abc'): string {
  return [
    line({ type: 'session', seq: 1, id: sessionId, cwd: join('C:', 'work', 'alpha'), delegationDepth: 0 }),
    line({ type: 'request/header', seq: 2, data: { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'high' } } } }),
    line({ type: 'user/message', seq: 3, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ship it with pnpm' }] } }),
    // A plugin-injected block is a user message too and must never be mined.
    line({ type: 'user/message', seq: 4, data: { role: 'user', source: { kind: 'plugin:memories' }, content: [{ type: 'text', text: '<memory-context>old summary</memory-context>' }] } }),
    line({ type: 'assistant/message', seq: 5, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'use pnpm run ship' }] } } }),
    line({ type: 'tool/call', seq: 6, data: { name: 'pwsh', arguments: '{}' } }),
  ].join('')
}

test('decodeSessionLog joins concatenated zstd frames', () => {
  if (!zstdAvailable()) return
  const first = Buffer.from(line({ type: 'session', seq: 1, id: 'session-x' }), 'utf8')
  const second = Buffer.from(line({ type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } }), 'utf8')
  const buffer = Buffer.concat([zstdCompressSync(first), zstdCompressSync(second)])
  const text = decodeSessionLog(buffer)
  assert.match(text, /session-x/u)
  assert.match(text, /hello/u)
})

test('parseSessionLog keeps user/assistant prose, skips injected context and tool calls', () => {
  const parsed = parseSessionLog(sampleLog(), join('tmp', 'sessions', 'session-abc', 'session.jsonl.zstd'), 1000)
  assert.ok(parsed !== undefined)
  assert.equal(parsed.sessionId, 'session-abc')
  assert.equal(parsed.cwd, join('C:', 'work', 'alpha'))
  assert.deepEqual(parsed.route, { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(parsed.maxSeq, 6)
  assert.deepEqual(parsed.messages.map((message) => message.role), ['user', 'assistant'])
  assert.equal(parsed.messages[0]?.text, 'ship it with pnpm')
  assert.equal(parsed.messages[1]?.text, 'use pnpm run ship')
  assert.equal(parsed.modifiedAt, 1000)
})

test('planWindows respects both the message and the character budget', () => {
  const messages = [
    { seq: 1, role: 'user' as const, text: 'a'.repeat(50) },
    { seq: 2, role: 'assistant' as const, text: 'b'.repeat(50) },
    { seq: 3, role: 'user' as const, text: 'c'.repeat(50) },
  ]
  const byMessages = planWindows(messages, 2, 10_000)
  assert.equal(byMessages.length, 2)
  assert.equal(byMessages[0]?.messages, 2)
  assert.equal(byMessages[1]?.lastSeq, 3)

  const longMessages = [
    { seq: 1, role: 'user' as const, text: 'a'.repeat(120) },
    { seq: 2, role: 'assistant' as const, text: 'b'.repeat(120) },
    { seq: 3, role: 'user' as const, text: 'c'.repeat(120) },
  ]
  const byChars = planWindows(longMessages, 10, 200)
  assert.equal(byChars.length, 3, 'a line that no longer fits starts a new window')
  for (const window of byChars) {
    assert.equal(window.messages, 1)
    assert.ok(window.text.length > 0)
  }
})

test('findSessionLogs finds nested logs and ignores other files', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memories-backfill-logs-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const logDir = join(home, 'sessions', '--C-work-alpha--', 'session-abc')
  await mkdir(logDir, { recursive: true })
  await writeFile(join(logDir, 'session.jsonl.zstd'), 'not zstd')
  // DSH 0.2.x writes a versioned name; the finder must see both, or a whole
  // generation of sessions silently drops out of backfill.
  await writeFile(join(logDir, 'session.v4.jsonl.zstd'), 'not zstd either')
  await writeFile(join(logDir, 'other.txt'), 'ignore me')
  const found = await findSessionLogs(join(home, 'sessions'))
  assert.equal(found.length, 2)
  for (const log of found) assert.match(log.file, /session(\.v\d+)?\.jsonl\.zstd$/u)
})

test('backfill is a dry run unless --apply is given, and skips mined sessions', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memories-backfill-home-'))
  const memories = join(home, 'memories')
  const logDir = join(home, 'sessions', '--C-work-alpha--', 'session-abc')
  await mkdir(logDir, { recursive: true })
  const plain = Buffer.from(sampleLog('session-abc'), 'utf8')
  await writeFile(join(logDir, 'session.jsonl.zstd'), Buffer.concat([zstdCompressSync(plain)]))

  const runtime = new MemoriesRuntime(stubContext(), { memoriesDir: memories, dshHome: home, autoExtract: false })
  t.after(async () => {
    runtime.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const report = await runtime.backfill(stubSession('session-live'), { apply: false, days: 3650, limit: 3 })
  assert.match(report, /Backfill plan/u)
  assert.match(report, /Dry run/u)
  assert.match(report, /1 unmined/u)

  // A watermark past the log's last seq means the session was already mined.
  runtime.state.putSession('session-abc', { lastSeq: 99, at: Date.now(), activityAt: Date.now() })
  const skipped = await runtime.backfill(stubSession('session-live'), { apply: false, days: 3650, limit: 3 })
  assert.match(skipped, /0 unmined/u)
  assert.match(skipped, /Skipped 1 already mined/u)
})

test('apply without an llm route reports that nothing was mined', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memories-backfill-nollm-'))
  const memories = join(home, 'memories')
  const logDir = join(home, 'sessions', 'x', 'session-abc')
  await mkdir(logDir, { recursive: true })
  await writeFile(join(logDir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(sampleLog('session-abc'), 'utf8')))
  const runtime = new MemoriesRuntime(stubContext(), { memoriesDir: memories, dshHome: home, autoExtract: false })
  t.after(async () => {
    runtime.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const report = await runtime.backfill(stubSession('session-live'), { apply: true, days: 3650, limit: 1 })
  assert.match(report, /No llm route/u)
})

/** A context stand-in exposing only what the runtime touches. */
function stubContext() {
  return {
    get: () => undefined,
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
  } as never
}
