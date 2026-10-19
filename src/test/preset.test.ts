/**
 * The consolidation child's composition.
 *
 * Since 0.2.1-rc.2 a subagent takes its tool set from the Agent Preset it
 * names, and a child that names none inherits the parent's composition — the
 * parent's tools, which is the one thing the consolidation pass must never
 * have. This test pins the two halves of that contract: the plugin registers a
 * preset of its own, and that preset carries no tool rows at all.
 *
 * @module dsh-memories/test/preset.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'
import { CONSOLIDATE_PRESET_ID } from '../consolidate.js'
import { MEMORIES_SETTINGS_DEFAULTS } from '../config.js'

/**
 * Remove a test's temp directory.
 *
 * The plugin holds its SQLite state store open until its fiber is disposed,
 * and Windows refuses to unlink an open file (`EBUSY`) where POSIX does not —
 * so the fibers are disposed first, and the removal retries anyway.
 *
 * @param ctx - the context the plugin was mounted under.
 * @param dir - the directory to remove.
 */
async function removeDir(ctx: Context, dir: string): Promise<void> {
  for (const fiber of [...(ctx.registry.get(plugin)?.fibers ?? [])]) await fiber.dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** A preset registry stand-in recording what the plugin registers. */
interface RegisteredPreset {
  id: string
  name?: string
  description?: string
  plugins: readonly unknown[]
}

test('the plugin registers a tool-free preset for the consolidation child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-preset-'))
  const root = new Context()
  const ctx = root.extend({ name: 'preset-test' })
  const registered: RegisteredPreset[] = []
  ctx.provide('tools', { register: () => () => undefined, schemas: () => [] })
  ctx.provide('commands', { register: () => () => undefined })
  ctx.provide('llm', { stream: async function* () {} })
  ctx.provide('agentPresets', {
    register: async (definition: RegisteredPreset) => {
      registered.push(definition)
      return async () => { registered.splice(registered.indexOf(definition), 1) }
    },
  })

  const config = { memoriesDir: dir, logFile: '', ...MEMORIES_SETTINGS_DEFAULTS, autoExtract: false }
  ctx.plugin(plugin, config)
  // The preset is registered through an injection, so it lands a tick after the
  // plugin is mounted.
  await new Promise((settle) => setTimeout(settle, 50))

  assert.equal(registered.length, 1, 'exactly one preset is registered')
  assert.equal(registered[0]?.id, CONSOLIDATE_PRESET_ID)
  // No plugin rows at all: the child gets no tools, so it can only answer.
  assert.deepEqual(registered[0]?.plugins, [], 'the preset must carry no tool rows')
  assert.ok((registered[0]?.name ?? '').length > 0, 'the preset names itself for the settings surface')

  await removeDir(ctx, dir)
})

test('a deployment without a preset registry still loads the plugin', async () => {
  // The preset registry is optional: a headless deployment composes no
  // browser plane and no roster, and the plugin must keep every other surface
  // and simply run its consolidation pass as a plain model call.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memories-preset-'))
  const root = new Context()
  const ctx = root.extend({ name: 'preset-test-no-registry' })
  ctx.provide('tools', { register: () => () => undefined, schemas: () => [] })
  ctx.provide('commands', { register: () => () => undefined })

  const config = { memoriesDir: dir, logFile: '', ...MEMORIES_SETTINGS_DEFAULTS, autoExtract: false }
  ctx.plugin(plugin, config)
  await new Promise((settle) => setTimeout(settle, 50))

  const fibers = [...(ctx.registry.get(plugin)?.fibers ?? [])]
  assert.equal(fibers.length, 1, 'the plugin is mounted')

  await removeDir(ctx, dir)
})
