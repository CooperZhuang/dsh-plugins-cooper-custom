#!/usr/bin/env node
/**
 * End-to-end evaluation of historical backfill and late injection.
 *
 * Runs the real runtime against a COPY of real session logs with a deterministic
 * fake model adapter, so the pass is measured without spending a single API
 * call. It prints one JSON object with the numbers a reader needs to judge the
 * two features:
 *
 * - `backfill`: how many logs were copied, how many windows the real planner
 *   produced, how many memories the real writer stored, and whether a second
 *   `--apply` run is a no-op (the watermark contract).
 * - `delta`: bytes of the once-per-conversation summary versus bytes of the
 *   block that announces a memory written after it (the cost argument).
 *
 * Usage:
 *   node scripts/eval-backfill.mjs                 # 2 logs, default home
 *   node scripts/eval-backfill.mjs --logs 4 --home C:/some/.dsh --json
 *
 * The source store and its state database are never opened: everything happens
 * under a temporary directory that is deleted at the end.
 *
 * @module dsh-cross-memory/scripts/eval-backfill
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { MemoriesRuntime } from '../lib/index.js'
import { decodeSessionLog, findSessionLogs, parseSessionLog } from '../lib/backfill.js'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}
const wanted = flag('--logs', 2)
const home = args.includes('--home') ? args[args.indexOf('--home') + 1] : (process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'))

/** Deterministic fake model: one well-formed extraction reply per call. */
function fakeLlm() {
  let calls = 0
  return {
    calls: () => calls,
    async *stream() {
      calls += 1
      const reply = JSON.stringify({
        memories: [{
          scope: 'global',
          kind: 'fact',
          title: `backfill sample ${calls}`,
          body: 'A canned memory written by the evaluation adapter.',
          tags: ['eval'],
          keys: ['backfill'],
          appliesTo: 'when evaluating the backfill path',
        }],
        summary: 'A synthetic session summary produced by the evaluation adapter.',
      })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

/** A session stand-in: the extractor only needs an id and a cwd. */
function stubSession(id, cwd) {
  return { id, header: { version: 0, id, createdAt: 0, cwd, isSeeded: false }, requestHeader: () => undefined, deriveMessages: () => [] }
}

/** An agent stand-in exposing only `session`. */
function stubAgent(session) {
  return { id: session.id, session, status: 'idle' }
}

const work = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-eval-backfill-'))
const memories = join(work, 'memories')
const sessionsDir = join(work, 'sessions')
try {
  // Pick the logs with the most prose, so a small sample still exercises
  // window cutting rather than a single one-message session.
  const candidates = []
  for (const entry of await findSessionLogs(join(home, 'sessions'))) {
    const raw = await readFile(entry.file).catch(() => null)
    if (raw === null) continue
    let text
    try {
      text = decodeSessionLog(raw)
    } catch {
      continue
    }
    const log = parseSessionLog(text, entry.file, entry.modifiedAt)
    if (log === undefined || log.messages.length < 2) continue
    candidates.push({ entry, log })
    if (candidates.length >= wanted * 20) break
  }
  candidates.sort((left, right) => right.log.messages.length - left.log.messages.length)
  const picked = candidates.slice(0, wanted)
  assert.ok(picked.length > 0, `no usable session logs under ${join(home, 'sessions')}`)
  for (const item of picked) {
    const target = join(sessionsDir, basename(dirname(item.entry.file)), 'session.jsonl.zstd')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(item.entry.file))
  }

  const llm = fakeLlm()
  const ctx = { get: (name) => (name === 'llm' ? llm : undefined), logger: { info: () => undefined, warn: () => undefined, debug: () => undefined } }
  const runtime = new MemoriesRuntime(ctx, { memoriesDir: memories, dshHome: work, autoExtract: false })
  const session = stubSession('session-eval', work)
  try {
    // Twelve entries first, so the summary is the size a real store produces
    // rather than the one-entry minimum.
    for (let index = 0; index < 12; index += 1) {
      await runtime.store.upsert({
        scope: 'global',
        kind: 'fact',
        title: `seed memory ${index}`,
        body: 'A seeded memory used to size the summary block.',
        tags: ['seed'],
        appliesTo: 'when measuring the summary',
      }, undefined, 'tool')
    }
    const summary = await runtime.injectionFor(stubAgent(session))
    assert.ok(summary !== undefined, 'a non-empty store must inject')
    const summaryBytes = Buffer.byteLength(JSON.stringify(summary.content), 'utf8')

    const first = await runtime.backfill(session, { apply: true, days: 3650, limit: wanted })
    const second = await runtime.backfill(session, { apply: true, days: 3650, limit: wanted })
    const windows = /Mined (\d+) window/u.exec(first)?.[1] ?? '0'
    const stored = /stored (\d+) memories/u.exec(first)?.[1] ?? '0'
    const secondWindows = /Mined (\d+) window/u.exec(second)?.[1] ?? '0'
    assert.equal(secondWindows, '0', 'a second apply must be a no-op (watermarks advanced)')

    // One memory written after the summary: the delta path's cost.
    await runtime.write(session, { scope: 'global', title: 'late write', body: 'Written after the summary was injected.', tags: [] }, 'tool')
    const delta = await runtime.deltaFor(stubAgent(session))
    assert.ok(delta !== undefined, 'a late write must be announced')
    const deltaBytes = Buffer.byteLength(JSON.stringify(delta.content), 'utf8')

    const global = await runtime.store.list('global', undefined, { fresh: true })
    const report = {
      sourceHome: home,
      logsCopied: picked.length,
      windows,
      memoriesStored: stored,
      secondRunWindows: secondWindows,
      entriesAfter: global.length,
      summaryBytes,
      deltaBytes,
      deltaVsSummary: summaryBytes === 0 ? null : Number((deltaBytes / summaryBytes).toFixed(2)),
      fakeModelCalls: llm.calls(),
    }
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
    else {
      for (const [key, value] of Object.entries(report)) console.log(`${key}: ${value}`)
    }
  } finally {
    runtime.dispose()
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
