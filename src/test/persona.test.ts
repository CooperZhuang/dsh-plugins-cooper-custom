/**
 * Tests for the persona layer: the profile document and the voice that feeds it.
 *
 * Two rules are pinned here. The profile is a DOCUMENT, not a memory: it is
 * rendered whole, in its own frame, with the date it was taken — a profile is a
 * snapshot of a person, and one injected without a date reads as a permanent
 * fact. And the profile is built from the user's own words only, so the voice
 * flag has to survive the storage round trip.
 *
 * @module dsh-memories/test/persona.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PERSONA_FILE, readPersona, renderPersonaBlock, writePersona } from '../persona.js'
import { MemoryStore } from '../storage.js'
import { parsePlan } from '../consolidate.js'

test('a profile round-trips through the store directory', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-persona-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  assert.equal(await readPersona(dir), undefined, 'no profile before one is written')
  const path = await writePersona(dir, '他要求先确认再改代码。')
  assert.match(path, /persona\.md$/u)
  assert.equal(await readPersona(dir), '他要求先确认再改代码。')
  assert.match(await readFile(join(dir, PERSONA_FILE), 'utf8'), /先确认再改代码/u)
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-voice-'))
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
