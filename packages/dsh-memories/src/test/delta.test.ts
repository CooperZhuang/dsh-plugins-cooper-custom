/**
 * Late-injection tests for {@link MemoriesRuntime}.
 *
 * The summary is a snapshot, so a memory written after it must reach the model
 * without waiting for the next session — once per write burst, bounded, and
 * never repeating an entry the conversation already carries.
 *
 * @module dsh-memories/test/delta.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** A context stand-in exposing only what the runtime touches. */
const stubContext = {
  get: () => undefined,
  logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
} as never

/** A session stand-in: id, header cwd, and an empty history. */
function stubSession(cwd: string, id = 'session-delta'): Session {
  return {
    id,
    header: { version: 0, id, createdAt: 0, cwd, isSeeded: false },
    requestHeader: () => undefined,
    deriveMessages: () => [],
  } as unknown as Session
}

/** An agent stand-in exposing only `session`. */
function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

/** Text of one user message, for assertions on the injected block. */
function textOf(message: { content: unknown }): string {
  return JSON.stringify(message.content)
}

test('a memory written after the summary is announced once, and only once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-delta-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  const agent = stubAgent(stubSession(dir))

  await runtime.write(agent.session, { scope: 'global', title: 'Prefer pnpm', body: 'Use pnpm, not npm.', tags: [] }, 'tool')
  const summary = await runtime.injectionFor(agent)
  assert.ok(summary !== undefined)
  assert.equal(await runtime.deltaFor(agent), undefined, 'nothing was written after the summary yet')

  await runtime.write(agent.session, { scope: 'global', title: 'Node 24 required', body: 'This repo needs Node 24 or newer.', tags: [] }, 'tool')
  const first = await runtime.deltaFor(agent)
  assert.ok(first !== undefined, 'a late write is announced')
  assert.match(textOf(first), /Node 24 required/u)
  assert.doesNotMatch(textOf(first), /Prefer pnpm/u, 'the summary entries are not repeated')
  assert.equal(await runtime.deltaFor(agent), undefined, 'the same entry is not announced twice')

  await runtime.write(agent.session, { scope: 'global', title: 'Tests beside sources', body: 'Keep tests next to the code.', tags: [] }, 'tool')
  const second = await runtime.deltaFor(agent)
  assert.ok(second !== undefined, 'a second burst is allowed')
  assert.match(textOf(second), /Tests beside sources/u)

  await runtime.write(agent.session, { scope: 'global', title: 'Third late memory', body: 'Should not be announced.', tags: [] }, 'tool')
  assert.equal(await runtime.deltaFor(agent), undefined, 'the per-conversation cap holds')

  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('the delta baseline survives a restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-delta-restart-'))
  const first = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => first.dispose())
  const session = stubSession(dir, 'session-restart')
  await first.write(session, { scope: 'global', title: 'Alpha', body: 'First memory.', tags: [] }, 'tool')
  assert.ok(await first.injectionFor(stubAgent(session)) !== undefined)
  await first.write(session, { scope: 'global', title: 'Beta', body: 'Second memory.', tags: [] }, 'tool')
  assert.ok(await first.deltaFor(stubAgent(session)) !== undefined)

  // A fresh runtime models a restarted process: the durable record says Alpha
  // and Beta were already shown, so only Gamma may be announced.
  const second = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => second.dispose())
  const resumed = stubSession(dir, 'session-restart')
  await second.write(resumed, { scope: 'global', title: 'Gamma', body: 'Third memory.', tags: [] }, 'tool')
  const late = await second.deltaFor(stubAgent(resumed))
  assert.ok(late !== undefined)
  assert.match(textOf(late), /Gamma/u)
  assert.doesNotMatch(textOf(late), /Alpha/u)
  assert.doesNotMatch(textOf(late), /Beta/u)

  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('injectDelta: false keeps the summary the only automatic block', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-delta-off-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false, injectDelta: false })
  t.after(() => runtime.dispose())
  const agent = stubAgent(stubSession(dir))
  await runtime.write(agent.session, { scope: 'global', title: 'Alpha', body: 'First memory.', tags: [] }, 'tool')
  assert.ok(await runtime.injectionFor(agent) !== undefined)
  await runtime.write(agent.session, { scope: 'global', title: 'Beta', body: 'Second memory.', tags: [] }, 'tool')
  assert.equal(await runtime.deltaFor(agent), undefined)
  t.after(() => rm(dir, { recursive: true, force: true }))
})
