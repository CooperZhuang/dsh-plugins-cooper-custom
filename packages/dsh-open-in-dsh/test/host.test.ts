/**
 * Host-half unit tests: the request sequence and the path canonicalization.
 *
 * The route handlers themselves are one policy check plus one hub call; what
 * can actually be wrong is the sequence bookkeeping (a replay window that
 * forgets a cold-start request, a rewind that swallows later ones) and the
 * `%V` forms Explorer hands over.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { createHub, directoryPath, expectsPage } from '../lib/index.js'

/** A fake SSE response: records frames and can be closed like a socket. */
function fakeStream() {
  const frames = []
  return {
    frames,
    write: (text) => frames.push(text),
    on: () => {},
  }
}

test('a published request reaches a subscribed page and the replay window', () => {
  const hub = createHub({ alwaysNewSession: true, now: () => 1000 })
  const stream = fakeStream()
  hub.subscribe(stream)

  const entry = hub.publish('C:\\work')
  assert.equal(entry.seq, 1)
  assert.deepEqual(stream.frames, ['event: request\ndata: {"seq":1,"path":"C:\\\\work","at":1000}\n\n'])
  assert.deepEqual(hub.pending(0), [entry])
})

test('a page that already handled a request is not handed it again', () => {
  const hub = createHub({ now: () => 1000 })
  hub.publish('C:\\one')
  hub.publish('C:\\two')

  assert.deepEqual(
    hub.pending(1).map((entry) => entry.path),
    ['C:\\two'],
  )
  assert.deepEqual(hub.pending(2), [])
})

test('the replay window expires, so a later window does not resurrect old requests', () => {
  let clock = 1000
  const hub = createHub({ now: () => clock, backlogTtlMs: 500 })
  hub.publish('C:\\old')

  clock = 1600
  assert.deepEqual(hub.pending(0), [])

  clock = 1400
  assert.equal(hub.pending(0).length, 1)
})

test('the backlog is bounded, keeping the newest requests', () => {
  const hub = createHub({ now: () => 1000 })
  for (let index = 0; index < 40; index += 1) hub.publish(`C:\\p${index}`)

  const pending = hub.pending(0)
  assert.equal(pending.length, 32)
  assert.equal(pending[0].path, 'C:\\p8')
  assert.equal(pending.at(-1).path, 'C:\\p39')
})

test('closing detaches every follower', () => {
  const hub = createHub({ now: () => 1000 })
  hub.subscribe(fakeStream())
  assert.equal(hub.clients(), 1)
  hub.close()
  assert.equal(hub.clients(), 0)
})

test('the sequence is exposed for the hello frame that detects a host restart', () => {
  const hub = createHub({ now: () => 1000 })
  assert.equal(hub.seq, 0)
  hub.publish('C:\\work')
  assert.equal(hub.seq, 1)
})

test('a page that just left still counts as expected, a long-gone one does not', () => {
  let clock = 1000
  const hub = createHub({ now: () => clock })
  // Never followed: a true cold start, and the launcher should open a window.
  assert.equal(expectsPage(hub, clock), false)

  const stop = hub.subscribe(fakeStream())
  assert.equal(expectsPage(hub, clock), true)

  clock = 5000
  stop()
  // Mid-reconnect is indistinguishable from closed except by how recently a
  // page was seen; opening a browser here is the window nobody asked for.
  assert.equal(expectsPage(hub, clock), true)

  clock = 5000 + 16_000
  assert.equal(expectsPage(hub, clock), false)
})

test('directoryPath accepts the %V forms Explorer passes and rejects the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-open-in-'))
  const nested = join(root, 'sub')
  mkdirSync(nested)
  const file = join(root, 'file.txt')
  writeFileSync(file, 'x')

  assert.equal(directoryPath(nested), nested)
  assert.equal(directoryPath(`${nested}\\`), nested)
  assert.equal(directoryPath(`"${nested}"`), nested)
  assert.equal(directoryPath('  '), null)
  assert.equal(directoryPath(undefined), null)
  assert.equal(directoryPath(file), null)
  assert.equal(directoryPath(join(root, 'missing')), null)
})
