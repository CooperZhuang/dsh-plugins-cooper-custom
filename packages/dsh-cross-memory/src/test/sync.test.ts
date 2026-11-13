/**
 * Tests for the store's git transport.
 *
 * The interesting behaviour is not "does git run" but the arbitration rules:
 * what stays out of the repository, which conflicts the module is allowed to
 * decide, and what happens when the AI resolver declines.
 *
 * @module dsh-cross-memory/test/sync.test
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemorySync, STORE_GITIGNORE, entryStamp, isEmptyCommitFailure, isEntryPath, isHostDescriptorPath, isPersonaPath, isSessionNotePath, mergeLoopLedgers, mergePersona, newerEntry, newerHostDescriptor, newerSessionNote, nextClockDelay } from '../sync.js'
import { applyConflictPlan, isArchivedEntryPath, projectRootOf } from '../sync-runtime.js'
import { slugify } from '../storage.js'
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
  const base = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-sync-'))
  const remote = join(base, 'remote.git')
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', remote])
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
  const base = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-ignore-'))
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

/** One loop-ledger body: the same shape `loops.ts` writes. */
function loopText(...loops: Array<{ id: string; text: string; openedAt: number; state?: string; remindedAt?: number }>): string {
  const rows = loops.map((loop) => ({
    id: loop.id,
    text: loop.text,
    openedAt: loop.openedAt,
    state: loop.state ?? 'open',
    ...(loop.remindedAt === undefined ? {} : { remindedAt: loop.remindedAt }),
  }))
  return JSON.stringify({ version: 1, loops: rows }, null, 2) + '\n'
}

test('the loop ledger merges as a union, and a closure survives a stale copy', () => {
  const ours = loopText(
    { id: 'loop-a', text: 'call Yoko', openedAt: 1 },
    { id: 'loop-b', text: 'send invoice', openedAt: 2, state: 'done' },
  )
  const theirs = loopText(
    { id: 'loop-a', text: 'call Yoko', openedAt: 1, remindedAt: 9 },
    { id: 'loop-c', text: 'book the room', openedAt: 3 },
  )
  const merged = mergeLoopLedgers(ours, theirs)
  assert.ok(merged !== undefined)
  const parsed = JSON.parse(merged) as { loops: Array<{ id: string; state: string; remindedAt?: number }> }
  assert.deepEqual(parsed.loops.map((loop) => loop.id), ['loop-a', 'loop-b', 'loop-c'], 'both sides keep their loops')
  assert.equal(parsed.loops[0]?.remindedAt, 9, 'the copy that was reminded wins')
  assert.equal(parsed.loops[1]?.state, 'done', 'a closed loop is not reopened by a stale open row')
  assert.equal(mergeLoopLedgers('not json', 'also not'), undefined, 'a non-ledger is still refused')
})

test('a committed conflict marker in loops.json is repaired instead of blocking the sync', () => {
  const clean = loopText({ id: 'loop-a', text: 'call Yoko', openedAt: 1 })
  const conflicted = clean.replace('      "state": "open"',
    '<<<<<<< HEAD\n      "state": "open"\n=======\n      "state": "done"\n>>>>>>> abc1234 (memory(host-a): 1 个文件)')
  const merged = mergeLoopLedgers(conflicted, loopText({ id: 'loop-b', text: 'second', openedAt: 2 })) ?? ''
  assert.match(merged, /"id": "loop-a"/u)
  assert.match(merged, /"id": "loop-b"/u)
  assert.doesNotMatch(merged, /^\s*(<<<<<<<|=======|>>>>>>>)/mu, 'no marker line survives')
  assert.doesNotThrow(() => JSON.parse(merged), 'the repaired ledger is valid JSON')
})

test('two machines opening different loops keep both and leave the store in sync', async () => {
  const { remote, left, right } = await twoWayFixture()
  await writeFile(join(left.dir, 'loops.json'), loopText({ id: 'loop-a', text: 'call Yoko', openedAt: 1 }))
  await left.sync.run('test')
  await writeFile(join(right.dir, 'loops.json'), loopText({ id: 'loop-b', text: 'send invoice', openedAt: 2 }))

  const outcome = await right.sync.run('test')

  assert.equal(outcome.pushed, true, 'the ledger no longer blocks the push')
  assert.equal(outcome.mergedByStructure, 1)
  const merged = JSON.parse(await readFile(join(right.dir, 'loops.json'), 'utf8')) as { loops: Array<{ id: string }> }
  assert.deepEqual(merged.loops.map((loop) => loop.id), ['loop-a', 'loop-b'])
  assert.match(execFileSync('git', ['-C', remote, 'show', 'main:loops.json'], { encoding: 'utf8' }), /loop-b/u)
  assert.equal(git(right.dir, 'status', '--porcelain').trim(), '', 'the store is not left mid-rebase')
})

/** One session-note body: the shape the extractor writes. */
function sessionNoteText(at: string, summary: string): string {
  return ['---', 'session: "session-test"', 'at: ' + at, 'memories: none', '---', '', summary, ''].join('\n')
}

test('a conflicting session note keeps the later reading', () => {
  const older = sessionNoteText('2026-11-01T03:13:53.263Z', 'first reading')
  const newer = sessionNoteText('2026-11-01T18:42:56.351Z', 'second reading')
  assert.equal(newerSessionNote(older, newer), newer)
  assert.equal(newerSessionNote(newer, older), newer, 'the order of the two sides does not matter')
  assert.equal(newerSessionNote('no stamps here', 'no stamps here'), undefined, 'an unstamped note is still refused')
  assert.equal(isSessionNotePath('sessions/session-a.md'), true)
  assert.equal(isSessionNotePath('projects/alpha/sessions/session-a.md'), true)
  assert.equal(isSessionNotePath('entries/one.md'), false)
})

test('two machines resummarising one session keep the later note and finish the sync', async () => {
  const { remote, left, right } = await twoWayFixture()
  await mkdir(join(left.dir, 'sessions'), { recursive: true })
  await writeFile(join(left.dir, 'sessions', 'session-same.md'), sessionNoteText('2026-11-01T03:13:53.263Z', 'first reading'))
  await left.sync.run('test')
  await mkdir(join(right.dir, 'sessions'), { recursive: true })
  await writeFile(join(right.dir, 'sessions', 'session-same.md'), sessionNoteText('2026-11-01T18:42:56.351Z', 'second reading'))

  const outcome = await right.sync.run('test')

  assert.equal(outcome.pushed, true, 'a session note no longer blocks the push')
  assert.equal(outcome.resolvedByTime, 1)
  const note = await readFile(join(right.dir, 'sessions', 'session-same.md'), 'utf8')
  assert.match(note, /second reading/u, 'the later summary won')
  assert.match(execFileSync('git', ['-C', remote, 'show', 'main:sessions/session-same.md'], { encoding: 'utf8' }), /second reading/u)
  assert.equal(git(right.dir, 'status', '--porcelain').trim(), '', 'the store is not left mid-rebase')
})

test('a conflicting host descriptor keeps the newer reading', () => {
  const older = JSON.stringify({ host: 'h', platform: 'darwin', root: '/p', firstSeen: 1, lastSeen: 10 })
  const newer = JSON.stringify({ host: 'h', platform: 'darwin', root: '/p', firstSeen: 1, lastSeen: 20, origin: 'github.com/a/b' })
  assert.equal(newerHostDescriptor(older, newer), newer)
  assert.equal(newerHostDescriptor(newer, older), newer, 'the order of the two sides does not matter')
  const noOrigin = JSON.stringify({ host: 'h', lastSeen: 20 })
  assert.equal(newerHostDescriptor(newer, noOrigin), newer, 'the side that knows the origin wins when lastSeen ties')
  assert.equal(newerHostDescriptor('{}', 'not json'), '{}', 'a side that is not JSON is ignored')
  assert.equal(isHostDescriptorPath('projects/a/hosts/example-host-local.json'), true)
  assert.equal(isHostDescriptorPath('projects/a/project.json'), false)
  assert.equal(isHostDescriptorPath('entries/hosts/note.md'), false)
})

test('git empty-commit wording is recognised, ordinary failures are not', () => {
  // real messages from git 2.5x
  assert.equal(isEmptyCommitFailure('The previous cherry-pick is now empty, possibly due to conflict resolution.'), true)
  assert.equal(isEmptyCommitFailure('nothing to commit, working tree clean'), true)
  assert.equal(isEmptyCommitFailure('CONFLICT (content): Merge conflict in entries/a.md'), false)
  assert.equal(isEmptyCommitFailure('fatal: could not read from remote repository'), false)
})

test('a pull that cannot start the rebase bails out instead of spinning', { timeout: 20_000 }, async () => {
  const { left, right } = await twoWayFixture()
  await writeFile(join(left.dir, 'entries', 'shared.md'), entryText('shared', 'left fact v2', '2026-03-01T00:00:00.000Z'))
  await left.sync.run('test')
  // A concurrent store write leaves the right tree dirty; git refuses to start a
  // rebase over it. Before the guard this spun the resolver to its 200-round cap.
  await writeFile(join(right.dir, 'entries', 'shared.md'), entryText('shared', 'uncommitted local edit', '2026-04-01T00:00:00.000Z'))
  const started = Date.now()
  const outcome = await (right.sync as unknown as { pull: () => Promise<{ pulled: number; stoppedBy?: string }> }).pull()
  const elapsed = Date.now() - started

  assert.ok(elapsed < 10_000, `pull took ${elapsed}ms, the guard should bail out immediately`)
  assert.equal(outcome.stoppedBy, 'rebase-not-started')
  assert.equal(existsSync(join(right.dir, '.git', 'rebase-merge')), false, 'no rebase left behind')
  assert.match(await readFile(join(right.dir, 'entries', 'shared.md'), 'utf8'), /uncommitted local edit/u, 'the local edit is untouched')
})

test('a resolver entered without a live rebase gives up immediately', async () => {
  const { right } = await twoWayFixture()
  const started = Date.now()
  const outcome = await (right.sync as unknown as { resolveRebase: () => Promise<{ stoppedBy?: string }> }).resolveRebase()
  const elapsed = Date.now() - started

  assert.ok(elapsed < 5_000, `resolveRebase took ${elapsed}ms without a rebase in progress`)
  assert.equal(outcome.stoppedBy, 'rebase-gone')
})

test('an identical change on both machines becomes an empty commit and the sync still finishes', async () => {
  const { remote, left, right } = await twoWayFixture()
  // right records the row locally first (no sync), then left lands the very same
  // content upstream: replaying right's commit onto it produces an empty commit.
  await mkdir(join(right.dir, 'entries'), { recursive: true })
  const text = entryText('same-row', 'the very same fact', '2026-04-01T00:00:00.000Z')
  await writeFile(join(right.dir, 'entries', 'same-row.md'), text)
  git(right.dir, 'add', '-A')
  git(right.dir, 'commit', '-q', '-m', 'memory(right): same row')
  await mkdir(join(left.dir, 'entries'), { recursive: true })
  await writeFile(join(left.dir, 'entries', 'same-row.md'), text)
  await left.sync.run('test')

  const outcome = await right.sync.run('test')

  assert.equal(outcome.stoppedBy, undefined, 'the empty commit no longer aborts the sync')
  assert.equal(git(right.dir, 'status', '--porcelain').trim(), '', 'no half-finished rebase left behind')
  assert.match(execFileSync('git', ['-C', remote, 'show', 'main:entries/same-row.md'], { encoding: 'utf8' }), /the very same fact/u)
})


test('a persona file merges as a bullet union, section by section', () => {
  const ours = ['## 他怎么工作', '- 中文交流', '- 改完自己验', '', '## 他的标准', '- 讨厌假动作', ''].join('\n')
  const theirs = ['## 他怎么工作', '- 中文交流', '- 一条只有 PC 记下的工作方式', '', '## 他的标准', '- 讨厌假动作', '- 一条只有 PC 记下的标准', ''].join('\n')
  const merged = mergePersona(ours, theirs)
  assert.match(merged, /中文交流/u)
  assert.match(merged, /一条只有 PC 记下的工作方式/u)
  assert.match(merged, /一条只有 PC 记下的标准/u)
  assert.equal((merged.match(/- 中文交流/gu) ?? []).length, 1, 'duplicates are dropped')
  assert.ok(merged.indexOf('一条只有 PC 记下的工作方式') < merged.indexOf('## 他的标准'), 'a bullet stays in its own section')
  assert.equal(isPersonaPath('persona/human.md'), true)
  assert.equal(isPersonaPath('entries/one.md'), false)
})

test('a modify/delete conflict keeps the edited file instead of aborting the sync', async () => {
  const { remote, left, right } = await twoWayFixture()
  await mkdir(join(left.dir, 'entries'), { recursive: true })
  await writeFile(join(left.dir, 'entries', 'doomed.md'), entryText('doomed', 'left version', '2026-02-01T00:00:00.000Z'))
  await left.sync.run('test')
  await right.sync.run('test')
  // left retires the row; right edits it in parallel
  await rm(join(left.dir, 'entries', 'doomed.md'))
  await left.sync.run('test')
  await writeFile(join(right.dir, 'entries', 'doomed.md'), entryText('doomed', 'right edit survives', '2026-03-01T00:00:00.000Z'))

  const outcome = await right.sync.run('test')

  assert.equal(outcome.pushed, true, 'the delete/modify conflict no longer blocks the push')
  assert.match(await readFile(join(right.dir, 'entries', 'doomed.md'), 'utf8'), /right edit survives/u)
  assert.match(execFileSync('git', ['-C', remote, 'show', 'main:entries/doomed.md'], { encoding: 'utf8' }), /right edit survives/u)
  assert.equal(git(right.dir, 'status', '--porcelain').trim(), '', 'the store is not left mid-rebase')
})

test('two machines appending persona bullets both survive the sync', async () => {
  const { remote, left, right } = await twoWayFixture()
  await mkdir(join(left.dir, 'persona'), { recursive: true })
  await writeFile(join(left.dir, 'persona', 'human.md'), ['## 他怎么工作', '- 中文交流', ''].join('\n'))
  await left.sync.run('test')
  await right.sync.run('test')
  await writeFile(join(left.dir, 'persona', 'human.md'), ['## 他怎么工作', '- 中文交流', '- 左机的规则', ''].join('\n'))
  await left.sync.run('test')
  await writeFile(join(right.dir, 'persona', 'human.md'), ['## 他怎么工作', '- 中文交流', '- 右机的规则', ''].join('\n'))

  const outcome = await right.sync.run('test')

  assert.equal(outcome.pushed, true)
  const persona = await readFile(join(right.dir, 'persona', 'human.md'), 'utf8')
  assert.match(persona, /左机的规则/u)
  assert.match(persona, /右机的规则/u)
  assert.match(execFileSync('git', ['-C', remote, 'show', 'main:persona/human.md'], { encoding: 'utf8' }), /右机的规则/u)
  assert.equal(git(right.dir, 'status', '--porcelain').trim(), '')
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

test('a merge keeps the scope of the file it merges even when the reply proposes another', () => {
  const ours = entryText('shared', 'left fact', '2026-02-01T00:00:00.000Z')
  const theirs = entryText('shared', 'right fact', '2026-03-01T00:00:00.000Z')
  // The two revisions are one file: the merge is written back to that path, so
  // the reply's "project" scope is not a decision the merge can take. Honouring
  // it would be a scope move, which is the one edit classifyPlan must ask about.
  const reply = JSON.stringify({ memories: [{ id: 'shared', scope: 'project', kind: 'fact', title: 'shared', body: 'left fact and right fact', tags: [] }], summary: 'merged both revisions' })
  const applied = applyConflictPlan(reply, ours, theirs)
  if (!('merged' in applied)) assert.fail('a scope guess must not turn a merge into a question')
  assert.match(applied.text, /scope: global/u, 'the merge stays where the file lives')
  assert.doesNotMatch(applied.text, /scope: project/u)
  assert.match(applied.text, /left fact and right fact/u)
})

test('a disputed merge still carries the fragment that would apply it', () => {
  const ours = entryText('shared', 'keeps src/app/main.ts as the anchor', '2026-02-01T00:00:00.000Z')
  const reply = JSON.stringify({ memories: [{ id: 'shared', scope: 'project', kind: 'fact', title: 'shared', body: 'no anchors at all', tags: [] }], summary: '' })
  const applied = applyConflictPlan(reply, ours, ours)
  if ('merged' in applied) assert.fail('dropping the cited path must not be written')
  assert.ok(applied.disputes.length > 0, 'the loss still shows up as a question')
  const fragment = applied.upserts ?? []
  assert.equal(fragment.length, 1, 'the row carries the rewrite that would apply it')
  assert.equal(fragment[0]?.scope, 'global', 'the stored fragment keeps the pinned scope')
  assert.equal(fragment[0]?.body, 'no anchors at all')
})

test('a project conflict path resolves the local checkout, preferring this host descriptor', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-root-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const entry = 'projects/alpha/entries/shared.md'
  // A global entry lives outside `projects/`, so there is no checkout to resolve.
  assert.equal(await projectRootOf(dir, 'entries/shared.md'), undefined)

  const projectDir = join(dir, 'projects', 'alpha')
  const hostFile = join(projectDir, 'hosts', `${slugify(hostname())}.json`)
  await mkdir(join(projectDir, 'hosts'), { recursive: true })
  // `project.json` is rewritten by whichever machine synced last; this machine's
  // host file is its own checkout and must win over it.
  await writeFile(join(projectDir, 'project.json'), JSON.stringify({ root: '/elsewhere/alpha', slug: 'alpha' }))
  await writeFile(hostFile, JSON.stringify({ host: hostname(), root: '/this/machine/alpha' }))
  assert.equal(await projectRootOf(dir, entry), '/this/machine/alpha', 'the host descriptor wins')

  // With no host file the canonical descriptor is the only honest fallback.
  await rm(hostFile)
  assert.equal(await projectRootOf(dir, entry), '/elsewhere/alpha')

  // Nothing recorded, or an unreadable record: no root rather than a guessed one.
  await rm(join(projectDir, 'project.json'))
  assert.equal(await projectRootOf(dir, entry), undefined)
  await writeFile(join(projectDir, 'project.json'), 'not json at all')
  assert.equal(await projectRootOf(dir, entry), undefined)
})

test('an archived conflict path is recognised, so it never becomes a waiting row', () => {
  // Applying a row writes into `entries/`; staging an archived file's conflict
  // would let "accept" bring a retired memory back, so the path is filtered out.
  assert.equal(isArchivedEntryPath('archive/shared.md'), true)
  assert.equal(isArchivedEntryPath('projects/alpha/archive/shared.md'), true)
  assert.equal(isArchivedEntryPath('entries/shared.md'), false)
  assert.equal(isArchivedEntryPath('projects/alpha/entries/shared.md'), false)
  // A live entry whose id merely contains the word is not an archive file.
  assert.equal(isArchivedEntryPath('entries/archive-cleanup.md'), false)
})
