/**
 * The periodic pass must not walk a caught-up session's surface.
 *
 * `hasNothingNew` runs once per open session every `extractIntervalMinutes`
 * tick. Before the cheap gate it built a full extraction window (a pass over
 * every surface node, one `eventAt` call per seq) just to discover that the
 * watermark was already at the tail; measured with 29 live sessions on the
 * host, that walk held the event loop for 5.6-8.3 s every 30 minutes and the
 * host logged `Host event loop stalled` each time.
 *
 * What the gate must not do is change the answer. This file pins both sides:
 * a last node at or below the watermark is "nothing new" without one `eventAt`
 * call, and anything newer still goes through the window walk.
 *
 * @module dsh-cross-memory/test/caught-up.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import type { Session } from '@deepseek-ai/dsh-session'

/** A context stand-in. */
const stubContext = {
  get: () => undefined,
  logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
} as never

interface Probe {
  hasNothingNew(session: Session): boolean
}

/** A runtime over a temp store, disposed after the test. */
async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-caught-up-'))
  const runtime = new MemoriesRuntime(stubContext, { memoriesDir: dir, autoExtract: true })
  t.after(() => {
    runtime.dispose()
    return rm(dir, { recursive: true, force: true })
  })
  return { runtime }
}

/** A session whose surface is the given seqs and whose events are all probes. */
function stubSession(id: string, nodes: number[], probes: number[]): Session {
  return {
    id,
    header: { version: 0, id, createdAt: 0, cwd: process.cwd(), isSeeded: false },
    surface: { nodes },
    eventAt: (seq: number) => {
      probes.push(seq)
      return undefined
    },
  } as unknown as Session
}

/** The runtime method under test, at its private face. */
const gate = (runtime: MemoriesRuntime): Probe => runtime as unknown as Probe

test('a session whose last surface node is at the watermark skips the walk', async (t) => {
  const { runtime } = await fixture(t)
  runtime.state.putSession('caught-up', { lastSeq: 7, at: 0 })
  const probes: number[] = []
  const session = stubSession('caught-up', [1, 2, 7], probes)

  assert.equal(gate(runtime).hasNothingNew(session), true)
  assert.deepEqual(probes, [], 'the gate answered without one eventAt call')
})

test('the gate opens for any node past the watermark', async (t) => {
  const { runtime } = await fixture(t)
  runtime.state.putSession('behind', { lastSeq: 6, at: 0 })
  const probes: number[] = []
  const session = stubSession('behind', [1, 2, 7], probes)

  // The walk runs (it can see node 7) and still reports "nothing new" because
  // the probe yields no message — which is the behaviour the gate must keep.
  assert.equal(gate(runtime).hasNothingNew(session), true)
  assert.deepEqual(probes, [7], 'the walk started at the first node past the floor')
})

test('an empty surface still takes the window path', async (t) => {
  const { runtime } = await fixture(t)
  runtime.state.putSession('empty', { lastSeq: 0, at: 0 })
  const probes: number[] = []
  const session = stubSession('empty', [], probes)

  assert.equal(gate(runtime).hasNothingNew(session), true)
  assert.deepEqual(probes, [])
})

test('a session with no recorded watermark is walked, not short-circuited', async (t) => {
  const { runtime } = await fixture(t)
  const probes: number[] = []
  const session = stubSession('fresh', [1, 2], probes)

  assert.equal(gate(runtime).hasNothingNew(session), true)
  assert.deepEqual(probes, [1, 2], 'with no watermark every node is newer')
})
