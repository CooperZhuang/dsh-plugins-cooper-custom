/**
 * Rotation-block tests for {@link MemoriesRuntime}.
 *
 * The summary can name only a dozen entries; the rest of a large store used to
 * be invisible forever. The rotation block spends about a kilobyte on titles
 * so each conversation surfaces a different slice, once, without repeating what
 * the summary already listed.
 *
 * @module dsh-cross-memory/test/rotation.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import { DEFAULT_ROTATION_ENTRIES } from '../config.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** A context stand-in exposing only what the runtime touches. */
const stubContext = {
  get: () => undefined,
  logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
} as never

/** A session stand-in with an optional restored history. */
function stubSession(cwd: string, id = 'session-rotation', history: readonly unknown[] = []): Session {
  let seq = 1
  return {
    id,
    header: { version: 0, id, createdAt: 0, cwd, isSeeded: false },
    get seq() { return seq += 1 },
    requestHeader: () => undefined,
    deriveMessages: () => [...history],
  } as unknown as Session
}

/** An agent stand-in exposing only `session`. */
function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

/** The model-visible text of one message. */
function textOf(message: { content: unknown }): string {
  const blocks = message.content as readonly { type: string; text?: string }[]
  return blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
}

/** Titles listed by a rotation block, in order. */
function titlesOf(text: string): string[] {
  return text.split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^- (?:\[project\] )?\[[a-z]+\] /u, '').trim())
}

/** Seed `count` distinct global memories. */
async function seed(runtime: MemoriesRuntime, session: Session, count: number, prefix = 'memory'): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await runtime.write(session, {
      scope: 'global',
      title: `${prefix} ${index}`,
      body: `Body for ${prefix} ${index}; this body must never appear in the rotation block.`,
      tags: [],
    }, 'tool')
  }
}

test('the rotation block lists titles the summary had no room for, once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-rot-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(async () => {
    runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const agent = stubAgent(stubSession(dir))
  await seed(runtime, agent.session, 30)

  const summary = await runtime.injectionFor(agent)
  assert.ok(summary !== undefined)
  const summaryText = textOf(summary)
  const rotation = await runtime.rotationFor(agent)
  assert.ok(rotation !== undefined, 'the summary left entries for the rotation block')
  const rotationText = textOf(rotation)
  assert.match(rotationText, /memory-index/u)
  assert.ok(titlesOf(rotationText).length > 0, 'at least one title is listed')

  // Titles only: bodies cost 3-4x and belong behind the memory tool.
  assert.doesNotMatch(rotationText, /this body must never appear/u)

  const listed = titlesOf(rotationText)
  assert.ok(listed.length <= DEFAULT_ROTATION_ENTRIES, `at most the configured count (got ${listed.length})`)
  const summaryTitles = new Set(summaryText.split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^- (?:📌 )?/u, '').replace(/ \(\d{4}-\d{2}-\d{2}.*$/u, '').trim()))
  for (const title of listed) {
    assert.ok(!summaryTitles.has(title), `the rotation block must not repeat ${title}, which the summary already listed`)
  }

  assert.equal(await runtime.rotationFor(agent), undefined, 'once per conversation')
  t.after(() => runtime.dispose())
})

test('a later conversation rotates to different entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-rot2-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  await seed(runtime, stubAgent(stubSession(dir)).session, 60)

  const first = stubAgent(stubSession(dir, 'session-a'))
  assert.ok(await runtime.injectionFor(first) !== undefined)
  const firstRotation = await runtime.rotationFor(first)
  assert.ok(firstRotation !== undefined)
  const firstTitles = new Set(titlesOf(textOf(firstRotation)))

  const second = stubAgent(stubSession(dir, 'session-b'))
  assert.ok(await runtime.injectionFor(second) !== undefined)
  const secondRotation = await runtime.rotationFor(second)
  assert.ok(secondRotation !== undefined, '40 entries leave material for a second conversation')
  const secondTitles = titlesOf(textOf(secondRotation))
  assert.ok(secondTitles.length > 0)
  for (const title of secondTitles) {
    assert.ok(!firstTitles.has(title), `${title} was already rotated in the first conversation`)
  }
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('the surfaced clock comes from state.db, not the entry mirror', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-rot-clock-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(async () => {
    runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const session = stubSession(dir, 'session-clock')
  await runtime.write(session, { scope: 'global', title: 'mirror only', body: 'The mirror claims it was shown.', tags: [] }, 'tool')
  // A stale mirror: the file says surfaced, the usage table has no row for it.
  // This is the legacy shape measured on the real store (files claimed 85.8%
  // surfaced while state.db had far fewer rows), so selection must not trust it.
  const [stored] = await runtime.store.list('global', undefined, { fresh: true })
  assert.ok(stored !== undefined)
  await runtime.store.writeCounters(stored, undefined, { uses: 0, lastUsedAt: 0, surfacedAt: Date.now() })
  const before = (await runtime.allScopes(stubSession(dir, 'session-clock')))[0]?.entries.find((entry) => entry.id === stored.id)
  assert.equal(before?.lastSurfacedAt, 0, 'the state database is authoritative')

  // A real surfacing writes a usage row, and from then on the entry counts as seen.
  runtime.state.bumpSurfaced('global', stored.id)
  const after = (await runtime.allScopes(stubSession(dir, 'session-clock')))[0]?.entries.find((entry) => entry.id === stored.id)
  assert.ok((after?.lastSurfacedAt ?? 0) > 0, 'a usage row surfaces the entry again')
})

test('the rotation block gives both scopes a share', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-rot-scopes-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(async () => {
    runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const agent = stubAgent(stubSession(dir))
  await seed(runtime, agent.session, 30, 'global memory')
  for (let index = 0; index < 20; index += 1) {
    await runtime.write(agent.session, {
      scope: 'project',
      title: `project memory ${index}`,
      body: `Body for project memory ${index}.`,
      tags: [],
    }, 'tool')
  }
  assert.ok(await runtime.injectionFor(agent) !== undefined)
  const rotation = await runtime.rotationFor(agent)
  assert.ok(rotation !== undefined)
  const text = textOf(rotation)
  assert.match(text, /\[project\] \[fact\] project memory/u, 'the project scope is represented')
  assert.match(text, /^- \[fact\] global memory/mu, 'and so is the global scope')
})

test('/memories stats reports per-scope coverage', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-rot-stats-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(async () => {
    runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const session = stubSession(dir, 'session-stats')
  await seed(runtime, session, 4, 'stat memory')
  const stats = await runtime.stats(session)
  assert.match(stats, /exposure: global 0\/4 \(0\.0%\)/u)
})

/** One user-authored message, as the runtime counts it. */
function userMessage(index: number): unknown {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `turn ${index}` }] }
}

/** One rotation block already present in the durable history. */
function rotationMessage(): unknown {
  return {
    role: 'user',
    source: { kind: 'plugin:memories', form: 'recall' },
    content: [{ type: 'text', text: '<memory-index>\n- [fact] memory 0\n</memory-index>' }],
  }
}

test('a long conversation re-arms the rotation block on its cadence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-rot-cadence-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false, rotationEveryTurns: 10 })
  t.after(async () => {
    runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await seed(runtime, stubAgent(stubSession(dir, 'session-cadence')).session, 60)

  // Turn 5: the first block is due, and only once on this turn.
  const first = stubAgent(stubSession(dir, 'session-cadence', [1, 2, 3, 4, 5].map(userMessage)))
  assert.ok(await runtime.injectionFor(first) !== undefined)
  const blockOne = await runtime.rotationFor(first)
  assert.ok(blockOne !== undefined)
  assert.equal(await runtime.rotationFor(first), undefined, 'the same turn does not emit twice')

  // Turn 10 with one block already in the history: the cadence has not passed.
  const atTen = stubAgent(stubSession(dir, 'session-cadence', [...[1, 2, 3, 4, 5].map(userMessage), rotationMessage(), ...[6, 7, 8, 9, 10].map(userMessage)]))
  assert.equal(await runtime.rotationFor(atTen), undefined, 'the second block is not due until turn 20')

  // Turn 20 with one block: the second is due and differs from the first.
  const atTwenty = stubAgent(stubSession(dir, 'session-cadence', [...[1, 2, 3, 4, 5].map(userMessage), rotationMessage(), ...[6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(userMessage)]))
  const blockTwo = await runtime.rotationFor(atTwenty)
  assert.ok(blockTwo !== undefined, 'turn 20 earns a second block')
  assert.notEqual(textOf(blockTwo), textOf(blockOne))
})

test('rotationEntries: 0 disables the block', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-rot-off-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false, rotationEntries: 0 })
  t.after(() => runtime.dispose())
  const agent = stubAgent(stubSession(dir))
  await seed(runtime, agent.session, 20)
  assert.ok(await runtime.injectionFor(agent) !== undefined)
  assert.equal(await runtime.rotationFor(agent), undefined)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a restored conversation that already carries the block does not get another', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-rot-restart-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  await seed(runtime, stubAgent(stubSession(dir)).session, 20)
  const carried = {
    role: 'user',
    source: { kind: 'plugin:memories', form: 'recall' },
    content: [{ type: 'text', text: '<memory-index>\n- [fact] memory 0\n</memory-index>' }],
  }
  const resumed = stubAgent(stubSession(dir, 'session-restored', [carried]))
  assert.ok(await runtime.injectionFor(resumed) !== undefined, 'the summary is still owed')
  assert.equal(await runtime.rotationFor(resumed), undefined, 'the restored history already has the block')
  t.after(() => rm(dir, { recursive: true, force: true }))
})
