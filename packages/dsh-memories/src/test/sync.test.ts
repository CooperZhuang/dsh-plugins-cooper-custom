/**
 * Tests for the store's git transport.
 *
 * The interesting behaviour is not "does git run" but the arbitration rules:
 * what stays out of the repository, which conflicts the module is allowed to
 * decide, and what happens when the AI resolver declines.
 *
 * @module dsh-memories/test/sync.test
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemorySync, STORE_GITIGNORE, entryStamp, isEntryPath, newerEntry, nextClockDelay } from '../sync.js'
import { applyConflictPlan } from '../sync-runtime.js'
import type { EntryConflict } from '../sync.js'

/** A logger that swallows everything; tests assert on git state, not log text. */
const quietLog = { info: () => undefined, warn: () => undefined, decision: () => undefined }

/** Run one git command in a fixture directory. */
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

/** Give one fixture repository an identity so commits do not need a global one. */
function identify(dir: string): void {
  git(dir, 'config', 'user.email', 'memories@test')
  git(dir, 'config', 'user.name', 'Memories Test')
}

/** One entry file body with the given id and revision. */
function entryText(id: string, body: string, updated: string): string {
  return [
    '---',
    'id: ' + id,
    'scope: global',
    'kind: fact',
    'title: ' + id,
    'tags:',
    'created: 2026-01-01T00:00:00.000Z',
    'updated: ' + updated,
    '---',
    '',
    body,
    '',
  ].join('\n')
}

/**
 * Two clones of one bare remote, each with a store the module can drive.
 *
 * Returned rather than built inside each test because the conflict tests need
 * both sides to have pushed before they diverge.
 */
async function twoWayFixture(): Promise<{
  remote: string
  left: { dir: string; sync: MemorySync }
  right: { dir: string; sync: MemorySync }
  resolver: { calls: EntryConflict[]; answer: string | undefined; run: (conflict: EntryConflict) => Promise<string | undefined> }
}> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-memories-sync-'))
  const remote = join(base, 'remote.git')
  execFileSync('git', ['init', '--bare', '--quiet', remote])
  const left = join(base, 'left')
  const right = join(base, 'right')
  await mkdir(join(left, 'entries'), { recursive: true })
  execFileSync('git', ['init', '--quiet', '-b', 'main', left])
  identify(left)
  git(left, 'remote', 'add', 'origin', remote)
  const resolver = { calls: [] as EntryConflict[], answer: undefined as string | undefined, run: async (conflict: EntryConflict) => { resolver.calls.push(conflict); return resolver.answer } }
  const makeLeft = new MemorySync({ memoriesDir: left, remote, intervalMs: 0, debounceMs: 0, gitTimeoutMs: 20_000, networkTimeoutMs: 20_000, log: quietLog, host: 'left', resolveConflict: resolver.run })
  await makeLeft.init()
  await writeFile(join(left, 'entries', 'shared.md'), entryText('shared', 'left fact', '2026-02-01T00:00:00.000Z'))
  await makeLeft.run('test')
  execFileSync('git', ['clone', '--quiet', remote, right])
  identify(right)
  const makeRight = new MemorySync({ memoriesDir: right, remote, intervalMs: 0, debounceMs: 0, gitTimeoutMs: 20_000, networkTimeoutMs: 20_000, log: quietLog, host: 'right', resolveConflict: resolver.run })
  return { remote, left: { dir: left, sync: makeLeft }, right: { dir: right, sync: makeRight }, resolver }
}

test('machine state is kept out of the repository', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-memories-ignore-'))
  await mkdir(join(base, 'entries'), { recursive: true })
  await writeFile(join(base, 'state.db'), 'binary')
  await writeFile(join(base, 'index.json'), '{}')
  await writeFile(join(base, 'entries', 'one.md'), entryText('one', 'kept', '2026-02-01T00:00:00.000Z'))
  const sync = new MemorySync({ memoriesDir: base, remote: '', intervalMs: 0, debounceMs: 0, gitTimeoutMs: 20_000, networkTimeoutMs: 20_000, log: quietLog, host: 'test' })
  await sync.init()
  const tracked = git(base, 'ls-files').split('\n')
  assert.ok(tracked.includes('entries/one.md'), 'an entry is tracked')
  assert.ok(!tracked.includes('state.db'), 'the database is not tracked')
  assert.ok(!tracked.includes('index.json'), 'the index cache is not tracked')
  assert.equal(await readFile(join(base, '.gitignore'), 'utf8'), STORE_GITIGNORE)
})

test('only entry paths are auto-resolved, and the newer revision wins without a resolver', () => {
  assert.equal(isEntryPath('entries/shared.md'), true)
  assert.equal(isEntryPath('projects/alpha/entries/shared.md'), true)
  assert.equal(isEntryPath('archive/old-fact.md'), true)
  assert.equal(isEntryPath('projects/alpha/archive/old-fact.md'), true)
  assert.equal(isEntryPath('persona.md'), false)
  assert.equal(isEntryPath('sessions/note.md'), false)
  assert.equal(isEntryPath('projects/alpha/project.json'), false)
  assert.equal(isEntryPath('persona.md'), false)
  const older = entryText('shared', 'old', '2026-01-01T00:00:00.000Z')
  const newer = entryText('shared', 'new', '2026-03-01T00:00:00.000Z')
  assert.ok(entryStamp(newer) > entryStamp(older))
  assert.equal(newerEntry(older, newer).text, newer)
  assert.equal(newerEntry(newer, older).text, newer, 'the order of the two sides does not matter')
})

test('a conflicting entry is handed to the resolver and its answer is committed', async () => {
  const { remote, left, right, resolver } = await twoWayFixture()
  // left moves the entry forward and publishes it
  await writeFile(join(left.dir, 'entries', 'shared.md'), entryText('shared', 'left fact v2', '2026-03-01T00:00:00.000Z'))
  await left.sync.run('test')
  // right edits the same entry from the older revision, so the rebase conflicts
  await writeFile(join(right.dir, 'entries', 'shared.md'), entryText('shared', 'right fact', '2026-02-10T00:00:00.000Z'))
  resolver.answer = entryText('shared', 'left fact v2 AND right fact', '2026-03-02T00:00:00.000Z')

  const outcome = await right.sync.run('test')

  assert.equal(resolver.calls.length, 1, 'the resolver saw exactly the one conflict')
  assert.equal(outcome.conflicts, 1)
  assert.equal(outcome.resolvedByResolver, 1)
  assert.match(await readFile(join(right.dir, 'entries', 'shared.md'), 'utf8'), /left fact v2 AND right fact/u)
  assert.match(execFileSync('git', ['-C', remote, 'show', 'main:entries/shared.md'], { encoding: 'utf8' }), /left fact v2 AND right fact/u)
  assert.equal(git(right.dir, 'status', '--porcelain').trim(), '', 'the store is not left mid-rebase')
})

test('a resolver that declines falls back to the newer revision', async () => {
  const { left, right, resolver } = await twoWayFixture()
  await writeFile(join(left.dir, 'entries', 'shared.md'), entryText('shared', 'left newer', '2026-03-01T00:00:00.000Z'))
  await left.sync.run('test')
  await writeFile(join(right.dir, 'entries', 'shared.md'), entryText('shared', 'right older', '2026-02-10T00:00:00.000Z'))
  resolver.answer = undefined

  const outcome = await right.sync.run('test')

  assert.equal(outcome.conflicts, 1)
  assert.equal(outcome.resolvedByResolver, 0)
  assert.equal(outcome.resolvedByTime, 1)
  assert.match(await readFile(join(right.dir, 'entries', 'shared.md'), 'utf8'), /left newer/u)
})

test('an unparsable resolver answer is discarded rather than written', async () => {
  const { left, right, resolver } = await twoWayFixture()
  await writeFile(join(left.dir, 'entries', 'shared.md'), entryText('shared', 'left newer', '2026-03-01T00:00:00.000Z'))
  await left.sync.run('test')
  await writeFile(join(right.dir, 'entries', 'shared.md'), entryText('shared', 'right older', '2026-02-10T00:00:00.000Z'))
  resolver.answer = 'not an entry file at all'

  const outcome = await right.sync.run('test')

  assert.equal(outcome.resolvedByTime, 1, 'the timestamp rule took over')
  assert.match(await readFile(join(right.dir, 'entries', 'shared.md'), 'utf8'), /left newer/u)
})

test('the clock schedule picks the next local time, and wraps to tomorrow', () => {
  const noon = new Date(2026, 9, 26, 12, 0, 0).getTime()
  assert.equal(nextClockDelay(['12:05'], noon), 5 * 60_000, 'five minutes after noon')
  const past = new Date(2026, 9, 26, 12, 6, 0).getTime()
  assert.equal(nextClockDelay(['12:05'], past), 86_400_000 - 60_000, 'the same time tomorrow')
  const afternoon = new Date(2026, 9, 26, 13, 0, 0).getTime()
  assert.equal(nextClockDelay(['18:05', '12:05'], afternoon), (18 * 60 + 5 - 13 * 60) * 60_000)
  assert.equal(nextClockDelay(['nope'], noon), undefined, 'an unparsable clock arms nothing')
})

test('a conflict merge is accepted only through the consolidation plan rules', () => {
  const ours = entryText('shared', 'left fact', '2026-02-01T00:00:00.000Z')
  const theirs = entryText('shared', 'right fact', '2026-03-01T00:00:00.000Z')
  const reply = JSON.stringify({ memories: [{ id: 'shared', scope: 'global', kind: 'fact', title: 'shared', body: 'left fact and right fact', tags: [] }], summary: 'merged both revisions' })
  const applied = applyConflictPlan(reply, ours, theirs)
  assert.ok('merged' in applied, 'the plan was accepted')
  assert.match(applied.text, /left fact and right fact/u)
  assert.match(applied.text, /updated: 2026-03-01/u, 'the newer revision stamps the merge')
})

test('a merge that drops an anchor is returned as a dispute instead of written', () => {
  const ours = entryText('shared', 'keeps src/app/main.ts as the anchor', '2026-02-01T00:00:00.000Z')
  const reply = JSON.stringify({ memories: [{ id: 'shared', scope: 'global', kind: 'fact', title: 'shared', body: 'no anchors at all', tags: [] }], summary: '' })
  const applied = applyConflictPlan(reply, ours, ours)
  assert.ok(!('merged' in applied), 'nothing is written')
  assert.ok((applied as { disputes: unknown[] }).disputes.length > 0, 'the loss shows up as a question')
})

test('a reply that is not a plan leaves the timestamp rule in charge', () => {
  const ours = entryText('shared', 'x', '2026-02-01T00:00:00.000Z')
  const applied = applyConflictPlan('not json at all', ours, ours)
  assert.ok(!('merged' in applied))
  assert.deepEqual((applied as { disputes: unknown[] }).disputes, [])
})
