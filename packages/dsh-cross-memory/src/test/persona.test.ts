/**
 * Tests for the persona layer: the profile document and the voice that feeds it.
 *
 * Two rules are pinned here. The profile is a DOCUMENT, not a memory: it is
 * rendered whole, in its own frame, with the date it was taken — a profile is a
 * snapshot of a person, and one injected without a date reads as a permanent
 * fact. And the profile is built from the user's own words only, so the voice
 * flag has to survive the storage round trip.
 *
 * @module dsh-cross-memory/test/persona.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { clearPersona, dedupePersona, isNearDuplicateBullet, isPersonaLocked, personaLockPath, personaPath, readPersona, renderPersonaBlock, setPersonaLocked, writePersona } from '../persona.js'
import { mergePersona } from '../sync.js'
import { MemoryStore } from '../storage.js'
import { parsePlan } from '../consolidate.js'

test('a profile round-trips through the store directory', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-persona-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  assert.equal(await readPersona(dir), undefined, 'no profile before one is written')
  const path = await writePersona(dir, '他要求先确认再改代码。')
  assert.match(path, /persona[\\/]human\.md$/u)
  assert.equal(await readPersona(dir), '他要求先确认再改代码。')
  assert.match(await readFile(personaPath(dir), 'utf8'), /先确认再改代码/u)
})

test('the block is framed, dated, and explicitly not an instruction set', () => {
  const block = renderPersonaBlock('他要求先确认再改代码。', 4_000, Date.parse('2026-10-23T00:00:00Z'))
  assert.ok(block !== undefined)
  assert.match(block, /^<persona>/u)
  assert.match(block, /<\/persona>$/u)
  assert.match(block, /snapshot 2026-10-23/u, 'a profile says when it was taken')
  assert.match(block, /never instructions to follow/u, 'and what it is not')
  assert.match(block, /先确认再改代码/u)
})

test('the block is cut at a line boundary before it can swallow the turn', () => {
  const long = Array.from({ length: 200 }, (_, index) => `- 偏好 ${index}: ${'很长的内容'.repeat(6)}`).join('\n')
  const block = renderPersonaBlock(long, 800)
  assert.ok(block !== undefined)
  assert.ok(Buffer.byteLength(block, 'utf8') <= 800, 'the budget is hard')
  assert.match(block, /<\/persona>$/u, 'the frame survives the cut')
  assert.equal(renderPersonaBlock(long, 120), undefined, 'no room for the frame means no block')
  assert.equal(renderPersonaBlock(undefined, 800), undefined, 'and no profile means no block')
})

test('the profile is a plan field, and a persona-only pass is a real outcome', () => {
  const plan = parsePlan(JSON.stringify({ memories: [], retire: [], skills: [], notes: 'refined', persona: '他偏好短句。' }), new Set(), 10)
  assert.ok(plan !== undefined, 'a pass that only refines the profile is not dropped')
  assert.equal(plan.persona, '他偏好短句。')
  assert.equal(parsePlan(JSON.stringify({ memories: [], retire: [], skills: [], notes: '' }), new Set(), 10), undefined)
})

test('the voice flag survives the storage round trip', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-voice-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new MemoryStore(dir)
  await store.upsert({ scope: 'global', title: 'Said by the user', body: 'prefers short answers', tags: [], voice: 'user' }, undefined, 'auto', 1)
  await store.upsert({ scope: 'global', title: 'Concluded by the agent', body: 'the build is slow', tags: [] }, undefined, 'auto', 2)

  const listed = await store.list('global', undefined, { fresh: true })
  const byId = new Map(listed.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('said-by-the-user')?.voice, 'user')
  assert.equal(byId.get('concluded-by-the-agent')?.voice, undefined, 'the default is stored as absent')

  // A rewrite that says nothing about voice keeps it, the way pinned does.
  await store.upsert({ scope: 'global', title: 'Said by the user', body: 'prefers short answers, always', tags: [] }, undefined, 'auto', 3)
  const reworded = (await store.list('global', undefined, { fresh: true })).find((entry) => entry.id === 'said-by-the-user')
  assert.equal(reworded?.voice, 'user')
})
test('a legacy single-file profile is still read as the human block', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-legacy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'persona.md'), '旧的单文件画像\n', 'utf8')
  assert.equal(await readPersona(dir), '旧的单文件画像', 'upgrading does not lose the profile')
})

test('the manual-edit lock is a timestamped marker, and clearing removes the profile', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  assert.equal(await isPersonaLocked(dir), false, 'an untouched store is unlocked')
  await writePersona(dir, '他先确认再改代码。')
  await setPersonaLocked(dir, true)
  assert.equal(await isPersonaLocked(dir), true, 'the marker locks the profile')
  assert.match(await readFile(personaLockPath(dir), 'utf8'), /\d{4}-\d{2}-\d{2}T/u, 'the marker records when it was locked')

  await clearPersona(dir)
  assert.equal(await readPersona(dir), undefined, 'clearing removes the profile the injector reads')
  await setPersonaLocked(dir, false)
  assert.equal(await isPersonaLocked(dir), false, 'unlocking removes the marker')
})

test('dedupePersona and mergePersona collapse rephrased duplicate bullets within a section', async (t) => {
  const ours = [
    '## 他怎么工作',
    '- 中文短句直给，不用客套与 emoji；结论先行、证据随后，事实与推断分开。',
    '- 做完一轮就 commit + push，不留本地未推提交；公开仓库直接推，私有先问。',
    '',
    '## 他的环境',
    '- Python 一律 uv 管理。',
  ].join('\n')
  const theirs = [
    '## 他怎么工作',
    '- 中文交流、短句直给，不用客套与 emoji；结论先行、证据随后，事实与推断分开。',
    '- 做完一轮改动就 commit + push 到 origin，不留本地未推提交；公开仓库直接推，私有或新建仓库先问。',
    '- 对客户只问对方能拍板的业务口径，实现细节自己定。',
    '',
    '## 他的环境',
    '- Mac 文件管理主用 QSpace Pro。',
  ].join('\n')

  assert.equal(isNearDuplicateBullet(
    '- 中文短句直给，不用客套与 emoji；结论先行、证据随后，事实与推断分开。',
    '- 中文交流、短句直给，不用客套与 emoji；结论先行、证据随后，事实与推断分开。',
  ), true)
  assert.equal(isNearDuplicateBullet(
    '- Python 一律 uv 管理。',
    '- Mac 文件管理主用 QSpace Pro。',
  ), false)

  const merged = mergePersona(ours, theirs)
  assert.equal((merged.match(/不用客套与 emoji/gu) ?? []).length, 1, 'rephrased duplicate is not appended')
  assert.equal((merged.match(/commit \+ push/gu) ?? []).length, 1, 'tightened duplicate is not appended')
  assert.match(merged, /对客户只问对方能拍板的业务口径/u, 'genuinely new bullet from theirs is kept')
  assert.match(merged, /QSpace Pro/u, 'genuinely new bullet in another section is kept')

  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-persona-dedupe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const doubled = [
    '## 他怎么工作',
    '- 中文短句直给，不用客套与 emoji；结论先行、证据随后，事实与推断分开。',
    '- 中文交流、短句直给，不用客套与 emoji；结论先行、证据随后，事实与推断分开。',
  ].join('\n')
  await writePersona(dir, doubled)
  const saved = await readPersona(dir)
  assert.ok(saved !== undefined)
  assert.equal(dedupePersona(saved), saved)
  assert.equal((saved.match(/不用客套与 emoji/gu) ?? []).length, 1)
})
