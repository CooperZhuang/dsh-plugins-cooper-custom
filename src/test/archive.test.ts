/**
 * Tests for archival: retiring a memory without destroying it.
 *
 * Consolidation retires what it judges stale and the per-scope cap evicts what
 * it judges least valuable. Both judgements can be wrong, so the store moves an
 * entry to `archive/` and `restore` brings it back — these tests pin that the
 * round trip loses nothing.
 *
 * @module dsh-memories/test/archive.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryStore } from '../storage.js'

/** A store and its temporary directory. */
async function tempStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-archive-'))
  return { store: new MemoryStore(dir), dir }
}

test('archive moves an entry out of the live store and restore brings it back', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))

  await store.upsert({ scope: 'global', title: 'Retire me', body: 'An old fact.', tags: ['x'] }, undefined, 'auto', 1_000)
  assert.equal(await store.archive('global', undefined, 'retire-me', 2_000), true)
  assert.deepEqual(await store.list('global', undefined, { fresh: true }), [], 'the live store no longer lists it')
  assert.deepEqual((await store.listArchived('global', undefined)).map((entry) => entry.id), ['retire-me'])

  // The archived file records when it happened, so a reader can tell how long it
  // has been out of circulation.
  const archived = await readFile(join(dir, 'archive', 'retire-me.md'), 'utf8')
  assert.match(archived, /^archived: 1970-01-01T00:00:02\.000Z$/mu)
  assert.match(archived, /An old fact\./u)

  assert.equal(await store.restore('global', undefined, 'retire-me'), true)
  const restored = await store.list('global', undefined, { fresh: true })
  assert.deepEqual(restored.map((entry) => entry.id), ['retire-me'])
  assert.equal(restored[0]?.body, 'An old fact.')
  assert.equal(restored[0]?.tags[0], 'x')
  assert.deepEqual(await store.listArchived('global', undefined), [], 'the archive is empty again')
  assert.doesNotMatch(await readFile(join(dir, 'entries', 'retire-me.md'), 'utf8'), /archived:/u)
})

test('archiving something absent, and restoring twice, report the truth', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.equal(await store.archive('global', undefined, 'missing'), false)
  assert.equal(await store.restore('global', undefined, 'missing'), false)

  await store.upsert({ scope: 'global', title: 'Once', body: 'x', tags: [] }, undefined, 'tool', 1)
  await store.archive('global', undefined, 'once')
  assert.equal(await store.restore('global', undefined, 'once'), true)
  assert.equal(await store.restore('global', undefined, 'once'), false, 'the archive copy is gone')
})

test('restore refuses to overwrite a live entry that came back another way', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await store.upsert({ scope: 'global', title: 'Conflict', body: 'first', tags: [] }, undefined, 'tool', 1)
  await store.archive('global', undefined, 'conflict')
  await store.upsert({ scope: 'global', title: 'Conflict', body: 'rewritten while archived', tags: [] }, undefined, 'tool', 2)
  assert.equal(await store.restore('global', undefined, 'conflict'), false)
  assert.equal((await store.read('global', undefined, 'conflict'))?.body, 'rewritten while archived')
})

test('the per-scope cap archives the entries it evicts instead of deleting them', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  store.entryLimit = () => 2
  for (let index = 0; index < 4; index += 1) {
    await store.upsert({ scope: 'global', title: `Entry ${index}`, body: 'x', tags: [] }, undefined, 'tool', index + 1)
  }
  const listed = await store.list('global', undefined, { fresh: true })
  assert.deepEqual(listed.map((entry) => entry.title), ['Entry 3', 'Entry 2'])
  assert.deepEqual((await store.listArchived('global', undefined)).map((entry) => entry.id), ['entry-0', 'entry-1'])
})

test('an archived project entry stays inside its own workspace', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = 'C:\\Code\\alpha'
  await store.upsert({ scope: 'project', title: 'Only here', body: 'x', tags: [] }, root, 'auto', 1)
  assert.equal(await store.archive('project', root, 'only-here'), true)
  assert.deepEqual(await store.listArchived('project', 'C:\\Code\\beta'), [], 'another workspace sees no archive')
  assert.deepEqual((await store.listArchived('project', root)).map((entry) => entry.id), ['only-here'])
})
test('the cap never evicts a pinned entry, nor one a person wrote', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  // One slot, three entries: the naive cap would evict the two oldest, which are
  // exactly the two retention has always promised to protect.
  store.entryLimit = () => 1
  await store.upsert({ scope: 'global', title: 'Pinned rule', body: 'keep me', tags: [], pinned: true }, undefined, 'auto', 1)
  await store.upsert({ scope: 'global', title: 'Typed by a person', body: 'keep me too', tags: [] }, undefined, 'user', 2)
  await store.upsert({ scope: 'global', title: 'Extracted', body: 'guess', tags: [] }, undefined, 'auto', 3)

  const live = await store.list('global', undefined, { fresh: true })
  assert.deepEqual(live.map((entry) => entry.id).sort(), ['pinned-rule', 'typed-by-a-person'])
  assert.deepEqual((await store.listArchived('global', undefined)).map((entry) => entry.id), ['extracted'],
    'the cap spent its one eviction on the only entry it is allowed to take')
})

test('every retirement is reported with the reason it happened', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const retired: string[] = []
  store.onRetire = (info) => retired.push(info.reason + ':' + info.id)

  await store.upsert({ scope: 'global', title: 'Old fact', body: 'a', tags: [] }, undefined, 'auto', 1)
  await store.upsert({ scope: 'global', title: 'New fact', body: 'b', tags: [], supersedes: 'old-fact' }, undefined, 'tool', 2)
  await store.archive('global', undefined, 'new-fact', 3)

  assert.deepEqual(retired, ['superseded:old-fact', 'retention:new-fact'])
})

test('a retirement is reported when the cap causes it, not only when asked', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const retired: string[] = []
  store.onRetire = (info) => retired.push(info.reason + ':' + info.id)
  store.entryLimit = () => 1
  await store.upsert({ scope: 'global', title: 'First', body: 'a', tags: [] }, undefined, 'auto', 1)
  await store.upsert({ scope: 'global', title: 'Second', body: 'b', tags: [] }, undefined, 'auto', 2)
  assert.deepEqual(retired, ['evict:first'])
})

test('a broken reporter cannot undo the retirement it was told about', async (t) => {
  const { store, dir } = await tempStore()
  t.after(() => rm(dir, { recursive: true, force: true }))
  store.onRetire = () => { throw new Error('the log is gone') }
  await store.upsert({ scope: 'global', title: 'Doomed', body: 'x', tags: [] }, undefined, 'auto', 1)
  assert.equal(await store.archive('global', undefined, 'doomed', 2), true)
  assert.deepEqual((await store.listArchived('global', undefined)).map((entry) => entry.id), ['doomed'])
})
