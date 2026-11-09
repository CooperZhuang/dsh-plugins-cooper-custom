/**
 * Background-extraction tests for {@link MemoriesRuntime}.
 *
 * The extractor is the one path that normally needs a live model, so these
 * tests drive it through a fake LLM runtime and a synthetic session surface.
 * They pin the parts that matter: only human/assistant prose is read, the
 * watermark advances so a session is never mined twice, secrets are redacted
 * before anything is written, and a failing call leaves the store untouched.
 *
 * @module dsh-cross-memory/test/extract.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoriesRuntime } from '../index.js'
import type { MemoryEntry } from '../types.js'
import { EXTRACT_JSON_SCHEMA, bindEvidence, collectExtractionWindow, collectWindow, mustCoverCandidates, parseExtraction, redactSecrets, renderMustCover, resolveRelativeTimes, runExtraction, selectKnownTitles } from '../extract.js'
import { normalizeSettings } from '../config.js'
import { peakDelayMs } from '../schedule.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * Project entries this session actually maps to.
 *
 * The scope root is resolved from the session cwd by walking up for project
 * markers (see resolveProjectRoot); inside the monorepo that walks past this
 * package to the workspace root, so a test that hard-coded process.cwd() asserted
 * against a directory the plugin never writes to.
 */
async function projectEntries(runtime: MemoriesRuntime, session: Session): Promise<readonly MemoryEntry[]> {
  return runtime.store.list('project', await runtime.projectRoot(session), { fresh: true })
}

/** A streaming text delta in the shape the assembler consumes. */
function textChunk(text: string, index = 0): StreamChunk {
  return { type: 'text-delta', index, text } as unknown as StreamChunk
}

/** The terminal chunk of a successful stream. */
function stopChunk(): StreamChunk {
  return { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk
}

/** A fake LLM runtime that replays one canned reply. */
function fakeLlm(reply: string, seen: { system?: string | undefined; user?: string | undefined } = {}) {
  return {
    stream: (options: { system?: string; messages: { content: { type: string; text?: string }[] }[] }) => {
      seen.system = options.system
      seen.user = options.messages.map((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')).join('\n')
      return (async function* chunks() {
        yield textChunk(withQuote(reply, transcriptQuote(options)))
        yield stopChunk()
      })()
    },
  }
}

/**
 * The first user line of the framed prompt, quoted the way a model would.
 *
 * The extractor is asked to copy a verbatim passage from the transcript, and
 * this fake copies the first user message so tests of other behaviour keep
 * their hand-written replies short. Evidence checks themselves get dedicated
 * tests with explicit quotes below.
 */
function transcriptQuote(options: { messages: { content: { type: string; text?: string }[] }[] }): string | undefined {
  const prompt = options.messages
    .map((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(''))
    .join('\n')
  const line = /(?:^|\n)(?:USER|ASSISTANT): (?:\[[^\]]*\] )?([^\n]+)/u.exec(prompt)?.[1]
  return line === undefined ? undefined : line.trim().slice(0, 160)
}

/** Add `quote` to every memory of a canned reply that does not already carry one. */
function withQuote(reply: string, quote: string | undefined): string {
  if (quote === undefined || quote.length === 0) return reply
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return reply
  try {
    const value = JSON.parse(reply.slice(start, end + 1)) as { memories?: unknown }
    if (!Array.isArray(value.memories)) return reply
    for (const item of value.memories) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      if (record['quote'] === undefined) record['quote'] = quote
    }
    return JSON.stringify(value)
  } catch {
    return reply
  }
}

/** A session stand-in with a controllable surface. */
function stubSession(
  cwd: string,
  events: { seq: number; role: 'user' | 'assistant'; text: string; source?: 'user' | 'plugin' }[],
  id = 'extract-session',
): Session {
  const nodes = events.map((event) => event.seq)
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return {
    id,
    header: { version: 0, id, createdAt: 0, cwd, isSeeded: false },
    surface: { nodes },
    eventAt: (seq: number) => {
      const event = bySeq.get(seq)
      if (event === undefined) return undefined
      if (event.role === 'user') {
        return {
          type: 'user/message',
          data: {
            content: [{ type: 'text', text: event.text }],
            source: event.source === 'plugin' ? { kind: 'plugin:other' } : { kind: 'user' },
          },
        }
      }
      return {
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [{ type: 'text', text: event.text }], source: { kind: 'model' } },
        },
      }
    },
    requestHeader: () => ({ config: { provider: 'fake-provider', model: 'fake-model' } }),
    /** Grow the surface mid-test, the way a conversation does. */
    append: (event: { seq: number; role: 'user' | 'assistant'; text: string }) => {
      bySeq.set(event.seq, event)
      nodes.push(event.seq)
    },
  } as unknown as Session
}

/**
 * Grow a stub session mid-test, the way a conversation does.
 *
 * The real `Session.append` demands surface placement metadata that a synthetic
 * event has no source for, so this reaches the stub's own appender — the one
 * boundary the test itself built.
 *
 * @param session - the stub to grow.
 * @param event - the message to add at the tail.
 */
function grow(session: Session, event: { seq: number; role: 'user' | 'assistant'; text: string }): void {
  const stub = session as unknown as { append: (event: { seq: number; role: 'user' | 'assistant'; text: string }) => void }
  stub.append(event)
}

/** A context whose only service is the fake LLM. */
function stubContext(llm: unknown) {
  return {
    get: (name: string) => (name === 'llm' ? llm : undefined),
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
  } as never
}

test('redactSecrets removes credential-shaped text and keeps prose', () => {
  assert.equal(redactSecrets('use key sk-abcdefghijklmnopqrstuvwx now'), 'use key [redacted] now')
  assert.equal(redactSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz01'), '[redacted]')
  assert.equal(redactSecrets('AWS AKIAABCDEFGHIJKLMNOP here'), 'AWS [redacted] here')
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: [redacted]')
  assert.equal(redactSecrets('api_key = "supersecretvalue"'), '[redacted]')
  assert.equal(redactSecrets('plain prose about pnpm'), 'plain prose about pnpm')
})

test('parseExtraction keeps the string keys and drops the rest', () => {
  const parsed = parseExtraction('{"memories":[{"scope":"global","title":"Prefer pnpm","body":"Use pnpm.","keys":["monorepo",7]}]}', 5, 'session-1')
  assert.deepEqual([...parsed.drafts[0]?.keys ?? []], ['monorepo'])
  // A reply that omits keys is normal: they are an optimization, not a contract.
  assert.deepEqual([...parseExtraction('{"memories":[{"scope":"global","title":"x","body":"y"}]}', 5, 's').drafts[0]?.keys ?? []], [])
})

test('mustCoverCandidates names the turns an extractor is most likely to skip', () => {
  const sources = [
    { seq: 1, text: '你好，今天天气不错。' },
    { seq: 2, text: '师傅说周五前把报价单发出去，人天按 35 算。' },
    { seq: 3, text: '行，那就这样。' },
    { seq: 4, text: '新来的同事叫沈知夏，负责 SAP 投递。' },
  ]
  const picked = mustCoverCandidates(sources)
  // The greeting scores nothing; the promise and the new person both make the cut.
  assert.deepEqual(picked.map((row) => row.seq), [2, 4])
  const rendered = renderMustCover(picked)
  assert.match(rendered ?? '', /本窗必写候选/u)
  assert.match(rendered ?? '', /\[2\]/u)
  assert.match(rendered ?? '', /要么写成一条记忆/u)
  assert.equal(renderMustCover([]), undefined)
})

test('resolveRelativeTimes names the absolute day for every relative time', () => {
  // 2026-05-27 is a Wednesday.
  const base = new Date(2026, 4, 27)
  assert.equal(resolveRelativeTimes('前天搬窗边', base), '前天（2026-05-25）搬窗边')
  assert.equal(resolveRelativeTimes('昨天替班', base), '昨天（2026-05-26）替班')
  assert.equal(resolveRelativeTimes('上周五是生日', base), '上周五（2026-05-22）是生日')
  assert.equal(resolveRelativeTimes('下周三交报告', base), '下周三（2026-06-03）交报告')
  // An absolute date is left alone, and an unresolvable word is left alone.
  assert.equal(resolveRelativeTimes('2026-05-25 已记下', base), '2026-05-25 已记下')
  assert.equal(resolveRelativeTimes('上周的事', base), '上周的事')
})

test('parseExtraction accepts a bare object, a fenced object, and rejects junk', () => {
  const payload = '{"summary":"The user set up a pnpm workflow.","memories":[{"scope":"global","title":"Prefer pnpm","body":"Use pnpm.","tags":["tooling"]}]}'
  const parsed = parseExtraction(payload, 5, 'session-1')
  assert.equal(parsed.drafts.length, 1)
  assert.equal(parsed.summary, 'The user set up a pnpm workflow.')
  assert.equal(parsed.drafts[0]?.sourceSession, 'session-1')
  assert.equal(parseExtraction(`\`\`\`json\n${payload}\n\`\`\``, 5, 'session-1').drafts.length, 1)
  assert.equal(parseExtraction('{"memories":[]}', 5, 'session-1').drafts.length, 0)
  // A reply without a summary still parses; the evidence note then says so.
  assert.equal(parseExtraction('{"memories":[]}', 5, 'session-1').summary, '')
  assert.equal(parseExtraction('not json at all', 5, 'session-1').drafts.length, 0)
  assert.equal(parseExtraction('{"memories":[{"scope":"elsewhere","title":"x","body":"y"}]}', 5, 'session-1').drafts.length, 0)
  assert.equal(parseExtraction('{"memories":[{"scope":"global","title":"","body":"y"}]}', 5, 'session-1').drafts.length, 0)
  const capped = parseExtraction(JSON.stringify({
    memories: [1, 2, 3, 4].map((index) => ({ scope: 'global', title: `t${index}`, body: `b${index}` })),
  }), 2, 'session-1')
  assert.equal(capped.drafts.length, 2)
  // What the cap threw away is reported, not silently lost: a pass that always
  // lands exactly on the cap is otherwise indistinguishable from one that found
  // exactly that many memories, which hides the knob that limits the store.
  assert.equal(capped.dropped, 2)
  assert.equal(parseExtraction('{"memories":[{"scope":"global","title":"only","body":"one"}]}', 5, 's').dropped, 0)
})

test('parseExtraction redacts secrets inside extracted memories and the summary', () => {
  const parsed = parseExtraction('{"summary":"they pasted sk-abcdefghijklmnopqrstuvwx","memories":[{"scope":"global","title":"API key","body":"the key is sk-abcdefghijklmnopqrstuvwx"}]}', 5, 'session-1')
  assert.equal(parsed.drafts[0]?.body, 'the key is [redacted]')
  assert.equal(parsed.summary, 'they pasted [redacted]')
  // A quote that is entirely a credential is dropped, not stored as "[redacted]":
  // an evidence field reading "[redacted]" proves nothing.
  const secretQuote = parseExtraction('{"memories":[{"scope":"global","title":"t","body":"b","appliesTo":"a","quote":"sk-abcdefghijklmnopqrstuvwx"}]}', 5, 'session-1')
  assert.equal(secretQuote.drafts[0]?.quote, undefined)
})

test('bindEvidence accepts only a quote that appears verbatim in one message', () => {
  const sources = [
    { seq: 3, text: 'I always deploy with pnpm run ship.' },
    { seq: 4, text: 'Also run tsc before publishing.' },
  ]
  const base = { scope: 'global' as const, title: 't', body: 'b', tags: [] }
  const bound = bindEvidence([
    { ...base, title: 'exact', quote: 'I always deploy with pnpm run ship.' },
    // Line wrapping changes whitespace, not the words; that still counts.
    { ...base, title: 'wrapped', quote: 'Also run tsc\nbefore publishing.' },
    { ...base, title: 'paraphrased', quote: 'I usually deploy with pnpm.' },
    { ...base, title: 'too short', quote: 'pnpm' },
    { ...base, title: 'missing' },
  ], sources)
  assert.deepEqual(bound.drafts.map((draft) => draft.title), ['exact', 'wrapped'])
  assert.equal(bound.drafts[0]?.evidenceSeq, 3)
  assert.equal(bound.drafts[1]?.evidenceSeq, 4)
  assert.equal(bound.unsupported, 3)
})

test('collectWindow reads only human/assistant prose after the watermark', () => {
  const session = stubSession('C:\\work', [
    { seq: 1, role: 'user', text: 'old question' },
    { seq: 2, role: 'assistant', text: 'old answer' },
    { seq: 3, role: 'user', text: 'new question' },
    { seq: 4, role: 'user', text: 'injected plugin context', source: 'plugin' },
    { seq: 5, role: 'assistant', text: 'new answer' },
  ])
  const window = collectWindow(session, 2, 10, 10_000)
  assert.equal(window.lastSeq, 5)
  assert.equal(window.messages, 2)
  assert.match(window.text, /new question/u)
  assert.match(window.text, /new answer/u)
  assert.doesNotMatch(window.text, /old question/u)
  assert.doesNotMatch(window.text, /injected plugin context/u)
})

test('collectWindow honours the message and character caps from the newest end', () => {
  const events = Array.from({ length: 12 }, (_, index) => ({ seq: index + 1, role: 'user' as const, text: `line ${index}` }))
  const session = stubSession('C:\\work', events)
  const byMessages = collectWindow(session, 0, 3, 100_000)
  assert.equal(byMessages.messages, 3)
  assert.match(byMessages.text, /line 11/u)
  const byChars = collectWindow(session, 0, 100, 30)
  assert.ok(byChars.text.length <= 30)
  assert.match(byChars.text, /line 11/u)
})

test('the extraction JSON schema is closed and requires the documented fields', () => {
  assert.equal(EXTRACT_JSON_SCHEMA.additionalProperties, false)
  // The summary is required too: it becomes the evidence note behind the drafts.
  // `memories` is declared first because a capped reply is only salvageable if
  // the array was written before the prose (see EXTRACT_SYSTEM).
  assert.deepEqual([...EXTRACT_JSON_SCHEMA.required], ['memories', 'summary'])
  // `appliesTo` is required because it is the field that lets a paraphrased turn
  // find the memory again; half the store was unsearchable without it.
  // `quote` is required because it is the only evidence the code can check.
  assert.deepEqual([...EXTRACT_JSON_SCHEMA.properties.memories.items.required], ['scope', 'title', 'body', 'appliesTo', 'quote'])
})

test('runExtraction sends the transcript and returns parsed drafts', async () => {
  const seen: { system?: string; user?: string } = {}
  const session = stubSession('C:\\work', [{ seq: 1, role: 'user', text: 'I always use pnpm here.' }])
  const outcome = await runExtraction(fakeLlm('{"memories":[{"scope":"project","title":"Use pnpm","body":"This repo uses pnpm.","tags":["tooling"]}]}', seen) as never, {
    session,
    window: collectWindow(session, 0, 10, 10_000),
    projectLabel: 'project:work',
    maxOutputTokens: 512,
    maxMemories: 5,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  })
  assert.equal(outcome.kind, 'memories')
  assert.equal(outcome.kind === 'memories' ? outcome.drafts.length : 0, 1)
  // The fake copied the user's line, so the draft carries the message it came from.
  assert.equal(outcome.kind === 'memories' ? outcome.drafts[0]?.evidenceSeq : undefined, 1)
  assert.match(seen.system ?? '', /durable, reusable facts/u)
  assert.match(seen.system ?? '', /"quote"/u)
  assert.match(seen.user ?? '', /I always use pnpm here/u)
  assert.match(seen.user ?? '', /project:work/u)
})

test('a candidate whose quote is not in the transcript is dropped, not stored', async () => {
  const session = stubSession('C:\\work', [
    { seq: 1, role: 'user', text: 'I always use pnpm here.' },
    { seq: 2, role: 'assistant', text: 'Then add a workspace file.' },
  ])
  const reply = (quote: string) => ({
    stream: () => (async function* chunks() {
      yield textChunk(JSON.stringify({ memories: [{ scope: 'project', title: 'Use pnpm', body: 'This repo uses pnpm.', appliesTo: 'installing', quote }] }))
      yield stopChunk()
    })(),
  })
  const request = {
    session,
    window: collectWindow(session, 0, 10, 10_000),
    projectLabel: 'project:work',
    maxOutputTokens: 512,
    maxMemories: 5,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  }
  // Paraphrasing the source is exactly the failure the check exists to catch.
  const paraphrased = await runExtraction(reply('I usually use pnpm.') as never, request)
  assert.deepEqual(paraphrased.kind === 'none' ? paraphrased.reason : paraphrased.kind, 'unsupported-evidence')
  // An assistant line is a valid source too; the seq tells the reader which turn.
  const fromAssistant = await runExtraction(reply('Then add a workspace file.') as never, request)
  assert.equal(fromAssistant.kind === 'memories' ? fromAssistant.drafts[0]?.evidenceSeq : undefined, 2)
})

test('runExtraction reports an empty window and a missing route without calling the model', async () => {
  const session = stubSession('C:\\work', [{ seq: 1, role: 'user', text: 'hi' }])
  const empty = await runExtraction(fakeLlm('{}') as never, {
    session,
    window: { text: '', lastSeq: undefined, messages: 0, sources: [], skipped: 0 },
    projectLabel: 'project:work',
    maxOutputTokens: 128,
    maxMemories: 1,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  })
  assert.deepEqual(empty, { kind: 'none', reason: 'empty-window' })

  const routeless = stubSession('C:\\work', [{ seq: 1, role: 'user', text: 'hi' }])
  ;(routeless as unknown as { requestHeader: () => undefined }).requestHeader = () => undefined
  const noRoute = await runExtraction(fakeLlm('{}') as never, {
    session: routeless,
    window: collectWindow(routeless, 0, 10, 1_000),
    projectLabel: 'project:work',
    maxOutputTokens: 128,
    maxMemories: 1,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  })
  assert.deepEqual(noRoute, { kind: 'none', reason: 'no-route' })
})

test('a reply the output cap cut short is salvaged, never thrown', async () => {
  const session = stubSession('C:\\work', [{ seq: 1, role: 'user', text: 'Hi, remember this workflow.' }])
  const truncated = {
    stream: () => (async function* chunks() {
      // Two complete memories, then the cut lands inside the third object.
      yield textChunk('{"summary":"The user set up a workflow.","memories":['
        + '{"scope":"project","title":"First fact","body":"Body one.","tags":["a"],"quote":"remember this workflow"},'
        + '{"scope":"global","title":"Second fact","body":"Body two.","tags":["b"],"quote":"remember this workflow"},'
        + '{"scope":"project","title":"Third fac')
      yield { type: 'finish', reason: { kind: 'max-tokens' } } as unknown as StreamChunk
    })(),
  }
  const salvaged = await runExtraction(truncated as never, {
    session,
    window: collectWindow(session, 0, 10, 1_000),
    projectLabel: 'project:work',
    maxOutputTokens: 8,
    maxMemories: 5,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  })
  assert.equal(salvaged.kind, 'memories')
  if (salvaged.kind !== 'memories') throw new Error('unreachable')
  assert.deepEqual(salvaged.drafts.map((draft) => draft.title), ['First fact', 'Second fact'])
  assert.equal(salvaged.summary, 'The user set up a workflow.')
  assert.equal(salvaged.truncated, true, 'the caller can tell the cap was the binding limit')
})

test('a capped reply with nothing usable reports the cap instead of throwing', async () => {
  const session = stubSession('C:\\work', [{ seq: 1, role: 'user', text: 'hi' }])
  const cutEarly = {
    stream: () => (async function* chunks() {
      yield textChunk('{"summary":"The user was just getting start')
      yield { type: 'finish', reason: { kind: 'max-tokens' } } as unknown as StreamChunk
    })(),
  }
  const outcome = await runExtraction(cutEarly as never, {
    session,
    window: collectWindow(session, 0, 10, 1_000),
    projectLabel: 'project:work',
    maxOutputTokens: 8,
    maxMemories: 1,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  })
  assert.deepEqual(outcome, { kind: 'none', reason: 'max-tokens', route: { provider: 'fake-provider', model: 'fake-model' } })

  // Any other non-stop finish is reported the same way: a background pass must
  // not turn a provider-side stop into an exception the user sees.
  const aborted = {
    stream: () => (async function* chunks() {
      yield textChunk('{"memories":[')
      yield { type: 'finish', reason: { kind: 'aborted' } } as unknown as StreamChunk
    })(),
  }
  assert.deepEqual(await runExtraction(aborted as never, {
    session,
    window: collectWindow(session, 0, 10, 1_000),
    projectLabel: 'project:work',
    maxOutputTokens: 8,
    maxMemories: 1,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  }), { kind: 'none', reason: 'incomplete', route: { provider: 'fake-provider', model: 'fake-model' } })
})

test('runExtraction stores drafts, advances the watermark, and never mines twice', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-extract-'))
      const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'I always deploy with pnpm run ship.' }])
    const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":["deploy"]}]}'
    const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), { memoriesDir: dir, autoExtract: true, extractTimeoutMs: 5_000 })
    t.after(() => runtime.dispose())
    const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent

    assert.equal((await runtime.runExtraction(agent)).stored, 1)
    const stored = await projectEntries(runtime, session)
    assert.equal(stored.length, 1)
    assert.equal(stored[0]?.source, 'auto')
    assert.match(stored[0]?.body ?? '', /pnpm run ship/u)

    const state = runtime.state.getSession('extract-session')
    assert.equal(state?.lastSeq, 1)
    assert.equal(state?.contributed, true)

    // Nothing new on the surface, so a second pass is a no-op.
    assert.equal((await runtime.runExtraction(agent)).stored, 0)
    assert.equal((await projectEntries(runtime, session)).length, 1)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('an llm service that arrives after activation is still used', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-late-llm-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'I always deploy with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship with `pnpm run ship`.","tags":["deploy"]}]}'
  let live: unknown
  const ctx = {
    get: (name: string) => (name === 'llm' ? live : undefined),
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
  } as never
  const runtime = new MemoriesRuntime(ctx, { memoriesDir: dir, autoExtract: true, extractTimeoutMs: 5_000 })
  t.after(() => runtime.dispose())
  const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent

  // In 0.1.7 the service can be provided by a row that runs after this plugin's,
  // so the activation snapshot is legitimately empty. Capturing it once — which
  // is what the plugin used to do — turned every later pass into a silent no-op
  // and left the watermark frozen for days.
  const before = await runtime.runExtraction(agent)
  assert.equal(before.stored, 0)
  assert.equal(before.reason, 'no-llm', 'the refusal names the missing service')

  live = fakeLlm(reply)
  assert.equal((await runtime.runExtraction(agent)).stored, 1, 'the pass picks the service up when it appears')
  assert.equal((await projectEntries(runtime, session)).length, 1)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a session the registry knows but this process never settled is still mined', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-registry-'))
  const lines: string[] = []
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'Always run the tests with npm test here.' }])
  const reply = '{"memories":[{"scope":"project","title":"Run npm test","body":"Use `npm test`.","tags":["test"]}]}'
  const agent = {
    id: 'extract-session',
    session,
    status: 'idle',
    runMaintenance: (job: (signal: AbortSignal) => Promise<unknown>) => job(new AbortController().signal),
  } as unknown as Agent
  const ctx = {
    get: (name: string) => {
      if (name === 'llm') return fakeLlm(reply)
      if (name === 'agents') return { roots: () => [agent] }
      return undefined
    },
    logger: {
      info: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      warn: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      debug: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
    },
  } as never
  const runtime = new MemoriesRuntime(ctx, { memoriesDir: dir, autoExtract: true, extractTimeoutMs: 5_000 })
  t.after(() => runtime.dispose())

  // `tracked` only holds agents that settled in THIS process, so a restored
  // window is invisible to it. The live registry is the second source.
  await runtime.runPeriodicPass()

  assert.equal((await projectEntries(runtime, session)).length, 1,
    'a registry session is mined without ever settling here')
  const pass = lines.find((line) => line.startsWith('dsh-cross-memory: extract pass:'))
  assert.ok(pass !== undefined, 'the pass reports itself')
  assert.match(pass, /%d live, %d considered/u, 'the line separates what was live from what was considered')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('one pass mines at most maxSessionsPerPass sessions, newest first', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-cap-'))
  const lines: string[] = []
  /** A session stub under its own id, so the pass has two candidates to choose from. */
  const sessionWithId = (id: string, text: string): Session => stubSession(process.cwd(), [{ seq: 1, role: 'user', text }], id)
  const older = sessionWithId('older-session', 'The older session said something worth remembering.')
  const newer = sessionWithId('newer-session', 'The newer session said something worth remembering.')
  const agents = [older, newer].map((session) => ({
    id: session.id,
    session,
    status: 'idle',
    runMaintenance: (job: (signal: AbortSignal) => Promise<unknown>) => job(new AbortController().signal),
  })) as unknown as Agent[]
  const reply = '{"memories":[{"scope":"project","title":"A fact","body":"A fact.","tags":["x"]}]}'
  const ctx = {
    get: (name: string) => {
      if (name === 'llm') return fakeLlm(reply)
      if (name === 'agents') return { roots: () => agents }
      return undefined
    },
    logger: {
      info: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      warn: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      debug: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
    },
  } as never
  const runtime = new MemoriesRuntime(ctx, {
    memoriesDir: dir,
    autoExtract: true,
    extractTimeoutMs: 5_000,
    maxSessionsPerPass: 1,
  })
  t.after(() => runtime.dispose())
  runtime.recordActivity(older, Date.now() - 60_000)
  runtime.recordActivity(newer, Date.now())

  await runtime.runPeriodicPass()

  assert.ok((runtime.state.getSession('newer-session')?.at ?? 0) > 0, 'the newest session is mined first')
  assert.equal(runtime.state.getSession('older-session')?.at, 0, 'the cap stops the pass after one model call')
  const pass = lines.find((line) => line.startsWith('dsh-cross-memory: extract pass:'))
  assert.match(pass ?? '', /pass-cap 1/u, 'a session held back by the cap is named as such, not as nothing-new')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a capped extraction is a reported outcome, not an error the command layer sees', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-cap-outcome-'))
  const lines: string[] = []
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'Something worth remembering.' }])
  let calls = 0
  const capped = {
    stream: () => (async function* chunks() {
      calls += 1
      yield textChunk('{"summary":"Cut off before the first memory.')
      yield { type: 'finish', reason: { kind: 'max-tokens' } } as unknown as StreamChunk
    })(),
  }
  const ctx = {
    get: (name: string) => (name === 'llm' ? capped : undefined),
    logger: {
      info: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      warn: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      debug: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
    },
  } as never
  const runtime = new MemoriesRuntime(ctx, {
    memoriesDir: dir,
    autoExtract: true,
    extractTimeoutMs: 5_000,
    extractMaxOutputTokens: 128,
  })
  t.after(() => runtime.dispose())
  const agent = {
    id: 'extract-session',
    session,
    status: 'idle',
    runMaintenance: (job: (signal: AbortSignal) => Promise<unknown>) => job(new AbortController().signal),
  } as unknown as Agent

  // This is the exact path `/memories mine` drives. It used to throw, and the
  // command layer reports a handler error verbatim to the user.
  assert.deepEqual(await runtime.runExtraction(agent), { stored: 0, reason: 'max-tokens' })
  // A capped reply is retryable. Consuming its window here would make every
  // later periodic pass say `nothing-new` and permanently lose the transcript.
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, undefined, 'the watermark stays put after a capped reply')
  assert.ok(lines.some((line) => line.includes('raise extractMaxOutputTokens')), 'the cap is reported at info, with the knob to raise')
  // The line also names the route: the ceiling alone does not explain a reply
  // that produced nothing, and the inherited reasoning level is the usual cause.
  assert.ok(lines.some((line) => line.includes('fake-provider/fake-model')), 'the capped line names the route it ran on')
  assert.equal(await runtime.mineNow(agent), 0, 'the forced path returns a count instead of throwing')
  assert.equal(calls, 2, 'a capped window is retried instead of being hidden behind the watermark')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a capped window cools down, and retries the moment the cap it blamed changes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-cap-cooldown-'))
  const lines: string[] = []
  const cooling = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'A cooling marker worth remembering.' }], 'cooling-session')
  const fresh = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'A fresh marker worth remembering.' }], 'fresh-session')
  const agentFor = (session: Session): Agent => ({
    id: session.id,
    session,
    status: 'idle',
    runMaintenance: (job: (signal: AbortSignal) => Promise<unknown>) => job(new AbortController().signal),
  }) as unknown as Agent
  const coolingAgent = agentFor(cooling)
  const freshAgent = agentFor(fresh)
  /** Which session each call was spent on, in order. The transcripts name it. */
  const asked: string[] = []
  let capTheCoolingOne = true
  const llm = {
    stream: (options: { messages: { content: { type: string; text?: string }[] }[] }) => {
      const transcript = options.messages
        .map((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(''))
        .join('\n')
      // The cooling session is mined more than once, and a later window no longer
      // holds the first message — so the fresh session is the one identified by
      // its text, and everything else is the session under test.
      const fromFresh = transcript.includes('A fresh marker')
      asked.push(fromFresh ? 'fresh' : 'cooling')
      const capped = capTheCoolingOne && !fromFresh
      return (async function* chunks() {
        if (capped) {
          yield textChunk('{"summary":"Cut off before the first memory.')
          yield { type: 'finish', reason: { kind: 'max-tokens' } } as unknown as StreamChunk
          return
        }
        yield textChunk('{"memories":[{"scope":"project","title":"A fact","body":"A fact.","tags":["x"],"quote":"worth remembering"}]}')
        yield stopChunk()
      })()
    },
  }
  const ctx = {
    get: (name: string) => {
      if (name === 'llm') return llm
      if (name === 'agents') return { roots: () => [coolingAgent, freshAgent] }
      return undefined
    },
    logger: {
      info: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      warn: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      debug: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
    },
  } as never
  // The tunables are read live, so this test can change the ceiling the way the
  // settings page does — no restart, which is the point of the cause field.
  const settings = normalizeSettings({
    autoExtract: true,
    extractMaxOutputTokens: 128,
    extractTimeoutMs: 5_000,
    maxSessionsPerPass: 1,
  })
  const runtime = new MemoriesRuntime(ctx, { memoriesDir: dir, autoExtract: true }, () => settings)
  t.after(() => runtime.dispose())
  // The cooling session is the newer one, so it is the pass's first candidate.
  runtime.recordActivity(fresh, Date.now() - 60_000)
  runtime.recordActivity(cooling, Date.now())

  await runtime.runPeriodicPass()
  assert.deepEqual(asked, ['cooling'], 'the first pass spends the call on the newest session')
  assert.equal(runtime.state.getSession('cooling-session')?.at ?? 0, 0, 'a capped reply writes no watermark')
  assert.ok(lines.some((line) => line.includes('the window stays unmined and the next attempt is in')),
    'the cooldown is announced, with the wait')

  // The per-pass budget is one call, and the capped session is still the first
  // candidate: if its cooldown did not resolve before the budget, this pass
  // would spend its only call on the request that just failed and stop.
  await runtime.runPeriodicPass()
  assert.deepEqual(asked, ['cooling', 'fresh'], 'the cooled-down session steps aside instead of eating the pass')
  const cooled = lines.filter((line) => line.startsWith('dsh-cross-memory: extract pass:')).at(-1) ?? ''
  assert.match(cooled, /capped 1/u, 'the skip is named in the pass line, not silent')
  assert.doesNotMatch(cooled, /pass-cap/u, 'a skip that costs no model call leaves the budget alone')
  assert.equal(runtime.state.getSession('cooling-session')?.at ?? 0, 0, 'and the capped window is still unmined')

  // `/memories mine` is a person asking for the call, so the wait does not apply.
  assert.equal(await runtime.mineNow(coolingAgent), 0, 'the forced path still runs while the window cools down')
  assert.deepEqual(asked, ['cooling', 'fresh', 'cooling'], 'the caller decided to spend it, so it was spent')

  // Raising the ceiling is the fix the log line asks for; it must end the
  // cooldown immediately rather than leave the user waiting out 4 hours.
  capTheCoolingOne = false
  settings.extractMaxOutputTokens = 8_192
  await runtime.runPeriodicPass()
  assert.deepEqual(asked.at(-1), 'cooling', 'a changed cap retires the cooldown')
  assert.equal(runtime.state.getSession('cooling-session')?.lastSeq, 1, 'and the retried window is mined for real')

  // A completed extraction clears it for good: the next window is mined at the
  // normal cadence, not held behind the cooldown this session had earned.
  grow(cooling, { seq: 2, role: 'user', text: 'More worth remembering.' })
  await runtime.runPeriodicPass()
  assert.deepEqual(asked.at(-1), 'cooling', 'the state does not outlive the extraction that resolved it')
  assert.equal(runtime.state.getSession('cooling-session')?.lastSeq, 2, 'and it mines the new window, not a stale one')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a reply capped mid-array keeps the memories that were already complete', async () => {
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'Something worth remembering.' }])
  // The reply order the contract asks for: `memories` first, `summary` last. A
  // cap that bites mid-array therefore leaves complete objects behind, which is
  // the shape `repairTruncatedJson` closes. With the summary written first, the
  // same truncation kept nothing — that is the case the test above pins.
  const capped = {
    stream: () => (async function* chunks() {
      yield textChunk('{"memories":[{"scope":"project","kind":"fact","title":"First fact","body":"Finished before the cap.","appliesTo":"任何时候","quote":"Something worth remembering."},{"scope":"project","kind":"fact","title":"Second fact","body":"cut off he')
      yield { type: 'finish', reason: { kind: 'max-tokens' } } as unknown as StreamChunk
    })(),
  }
  const outcome = await runExtraction(capped as never, {
    session,
    window: collectWindow(session, 0, 10, 10_000),
    projectLabel: 'project:work',
    maxOutputTokens: 128,
    maxMemories: 5,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  })
  assert.equal(outcome.kind, 'memories')
  assert.equal(outcome.kind === 'memories' ? outcome.truncated : undefined, true, 'the caller can tell it was salvaged')
  assert.deepEqual(outcome.kind === 'memories' ? outcome.drafts.map((draft) => draft.title) : [], ['First fact'])
})

test('the resolved route carries the reasoning level that spends the cap', async () => {
  const session = stubSession('C:\\work', [{ seq: 1, role: 'user', text: 'Remember this.' }])
  ;(session as unknown as { requestHeader: () => unknown }).requestHeader = () => ({
    config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  })
  const lined = {
    stream: () => (async function* chunks() {
      yield textChunk('{"memories":[{"scope":"project","kind":"fact","title":"T","body":"B","appliesTo":"A","quote":"Remember this."}],"summary":"s')
      yield { type: 'finish', reason: { kind: 'max-tokens' } } as unknown as StreamChunk
    })(),
  }
  const outcome = await runExtraction(lined as never, {
    session,
    window: collectWindow(session, 0, 10, 10_000),
    projectLabel: 'project:work',
    maxOutputTokens: 128,
    maxMemories: 5,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  })
  assert.equal(outcome.kind, 'memories')
  assert.equal(outcome.kind === 'memories' ? outcome.route.model : '', 'deepseek-flash')
  assert.equal(outcome.kind === 'memories' ? outcome.route.reasoningEffort : undefined, 'high', 'the level travels with the route')
})

test('a peak window refuses every session without spending the per-pass budget', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-peak-cap-'))
  const lines: string[] = []
  const sessionWithId = (id: string): Session => stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'Something worth remembering.' }], id)
  const sessions = [sessionWithId('peak-a'), sessionWithId('peak-b')]
  const agents = sessions.map((session) => ({
    id: session.id,
    session,
    status: 'idle',
    runMaintenance: (job: (signal: AbortSignal) => Promise<unknown>) => job(new AbortController().signal),
  })) as unknown as Agent[]
  const ctx = {
    get: (name: string) => {
      if (name === 'llm') return fakeLlm('{"memories":[]}')
      if (name === 'agents') return { roots: () => agents }
      return undefined
    },
    logger: {
      info: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      warn: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
      debug: (format: string, ...args: unknown[]) => lines.push(`${format} ${args.join(' ')}`),
    },
  } as never
  // A window that always contains "now": every day, midnight to midnight.
  const runtime = new MemoriesRuntime(ctx, {
    memoriesDir: dir,
    autoExtract: true,
    extractTimeoutMs: 5_000,
    maxSessionsPerPass: 1,
    peakHours: '* 00:00-24:00',
  })
  t.after(() => runtime.dispose())
  assert.ok(peakDelayMs('* 00:00-24:00', new Date()) > 0, 'the test window really covers now')

  await runtime.runPeriodicPass()

  // Nothing was mined, and the reason is the peak window — not the pass cap,
  // even though the cap is 1 and there were two candidates.
  assert.equal(runtime.state.getSession('peak-a')?.at ?? 0, 0)
  const pass = lines.find((line) => line.startsWith('dsh-cross-memory: extract pass:'))
  assert.match(pass ?? '', /peak 2/u)
  assert.doesNotMatch(pass ?? '', /pass-cap/u, 'a refusal that costs no model call leaves the budget alone')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a failing extraction call leaves the store and watermark untouched', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-extract-fail-'))
      const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'something memorable' }])
    const failing = { stream: () => { throw new Error('provider exploded') } }
    const runtime = new MemoriesRuntime(stubContext(failing), { memoriesDir: dir, autoExtract: true })
    t.after(() => runtime.dispose())
    const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent

    await assert.rejects(() => runtime.runExtraction(agent), /provider exploded/u)
    assert.equal((await projectEntries(runtime, session)).length, 0)
    assert.equal(runtime.state.getSession('extract-session'), undefined)
    // The watermark is only written on success.
    assert.equal(runtime.state.sessionCount(), 0)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('extraction is skipped for subagent sessions and when disabled', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-extract-skip-'))
      const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'x' }])
    ;(session.header as unknown as { delegationDepth?: number }).delegationDepth = 1
    const runtime = new MemoriesRuntime(stubContext(fakeLlm('{"memories":[]}')), { memoriesDir: dir, autoExtract: true })
    t.after(() => runtime.dispose())
    const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent
    runtime.scheduleExtraction(agent)
    assert.equal((await runtime.runExtraction(agent)).stored, 0)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a provider refusal pauses background passes and the pause survives a reopen', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-quota-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'I always deploy with pnpm run ship.' }])
  let calls = 0
  const refusing = {
    stream: () => {
      calls += 1
      const error = new Error('rate limit exceeded') as Error & { code?: string }
      error.code = 'RATE_LIMIT'
      throw error
    },
  }
  const runtime = new MemoriesRuntime(stubContext(refusing), {
    memoriesDir: dir,
    autoExtract: true,
    quotaCooldownMinutes: 30,
    quotaCooldownMaxMinutes: 120,
  })
  t.after(() => runtime.dispose())
  const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent

  await assert.rejects(() => runtime.runExtraction(agent), /rate limit/u)
  assert.equal(calls, 1)
  const first = runtime.state.getLimit()
  assert.ok(first !== undefined, 'a refusal is recorded')
  assert.equal(first.failures, 1)
  assert.equal(first.until - first.at, 30 * 60_000)

  // The next pass never reaches the provider, so the refusal costs one call per
  // cooldown instead of one per idle timer.
  assert.equal((await runtime.runExtraction(agent)).stored, 0)
  assert.equal(calls, 1)

  // A second refusal doubles the wait; consecutive refusals keep doubling to a cap.
  runtime.state.clearLimit()
  await assert.rejects(() => runtime.runExtraction(agent), /rate limit/u)
  const second = runtime.state.noteLimitFailure('again', 30 * 60_000, 120 * 60_000)
  assert.equal(second.failures, 2)
  assert.equal(second.until - second.at, 60 * 60_000)

  // The pause is durable state: a restarted process must not immediately retry.
  const reopened = new MemoriesRuntime(stubContext(refusing), { memoriesDir: dir, autoExtract: true })
  t.after(() => reopened.dispose())
  assert.equal(reopened.state.isLimited(), true)
  assert.equal((await reopened.runExtraction(agent)).stored, 0)
  assert.equal(calls, 2, 'a paused pass never calls the provider')

  // A successful pass forgets the pause.
  reopened.state.clearLimit()
  assert.equal(reopened.state.isLimited(), false)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('consolidation quotes the rate limit as its own refusal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-quota-consolidate-'))
  const runtime = new MemoriesRuntime(stubContext({ stream: async function* () {} }), { memoriesDir: dir, autoExtract: false })
  t.after(() => runtime.dispose())
  runtime.state.noteLimitFailure('quota exhausted', 1_000, 1_000)
  assert.equal(runtime.state.isLimited(), true)
  assert.match(await runtime.stats(stubSession(process.cwd(), [])), /background: paused until/u)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a successful pass writes the evidence note behind the drafts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-evidence-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"summary":"The user explained how this project ships.","memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":["deploy"]}]}'
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), { memoriesDir: dir, autoExtract: true, extractTimeoutMs: 5_000 })
  t.after(() => runtime.dispose())
  const agent = { id: 'extract-session', session, status: 'idle' } as unknown as Agent

  assert.equal((await runtime.runExtraction(agent)).stored, 1)
  const note = await runtime.store.readSessionNote('extract-session')
  assert.equal(note?.summary, 'The user explained how this project ships.')
  assert.deepEqual(note?.memories, ['deploy-with-pnpm-run-ship'])
  const stored = (await projectEntries(runtime, session))[0]
  assert.equal(stored?.sourceSession, 'extract-session')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('the settle timer actually runs a pass once its wait elapses', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-settle-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":["deploy"]}]}'
  // Short waits on both knobs: this is the whole settle path — timer, quiet-window
  // gate, pass, watermark — and it is what the shipped defaults could never reach
  // (a 5 minute timer guarded by a 6 hour window, with no re-arm). The idle delay
  // is clamped to a 1000 ms floor, so this is as short as the timer can be.
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), {
    memoriesDir: dir,
    autoExtract: true,
    minIdleHours: 0,
    autoExtractIdleMs: 1_000,
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  const agent = {
    id: 'settle-session',
    session,
    status: 'idle',
    runMaintenance: async (task: (signal: AbortSignal) => Promise<number>) => await task(new AbortController().signal),
  } as unknown as Agent

  runtime.scheduleExtraction(agent)
  await new Promise((settle) => setTimeout(settle, 1_400))
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 1, 'the settle timer mined the session')
  assert.equal((await projectEntries(runtime, session)).length, 1)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('the exit flush mines a session that never had its quiet window', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-flush-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":["deploy"]}]}'
  // A six-hour quiet window against an immediate exit: the timer cannot be what
  // saves this session, only the forced flush can.
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), { memoriesDir: dir, autoExtract: true, minIdleHours: 6, extractTimeoutMs: 5_000 })
  t.after(() => runtime.dispose())
  // `mine` claims the idle phase through `runMaintenance`, so the stub has to
  // provide it the way a real agent does.
  const agent = {
    id: 'flush-session',
    session,
    status: 'idle',
    runMaintenance: async (task: (signal: AbortSignal) => Promise<number>) => await task(new AbortController().signal),
  } as unknown as Agent
  runtime.scheduleExtraction(agent)

  assert.equal(await runtime.flushExit(5_000), 1, 'the exit boundary ignores the quiet window')
  // The watermark is keyed by the session, not by the agent id.
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 1)
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('peak hours hold back the automatic passes but not an explicit one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-peak-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":["deploy"]}]}'
  // `* 00:00-24:00` is peak forever, which makes the gate deterministic to test;
  // a real timetable would only be in or out depending on when the suite runs.
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), {
    memoriesDir: dir,
    autoExtract: true,
    minIdleHours: 0,
    peakHours: '* 00:00-24:00',
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  const agent = {
    id: 'peak-session',
    session,
    status: 'idle',
    runMaintenance: async (task: (signal: AbortSignal) => Promise<number>) => await task(new AbortController().signal),
  } as unknown as Agent

  runtime.scheduleExtraction(agent)
  await new Promise((settle) => setTimeout(settle, 1_300))
  assert.equal(runtime.state.getSession('extract-session'), undefined, 'the settle timer waits the window out')
  assert.equal(await runtime.flushExit(5_000), 0, 'the exit flush is an automatic spend, so it defers too')
  assert.equal(await runtime.mineNow(agent), 1, 'an explicit /memories mine ignores the window')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

/** The agent stub every periodic test needs: idle, and able to claim the idle phase. */
function idleAgent(session: Session, id = 'periodic-session'): Agent {
  return {
    id,
    session,
    status: 'idle',
    runMaintenance: async (task: (signal: AbortSignal) => Promise<number>) => await task(new AbortController().signal),
  } as unknown as Agent
}

test('a periodic pass mines new material and costs nothing when there is none', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-periodic-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship this project with `pnpm run ship`.","tags":[]}]}'
  const seen: { user?: string | undefined } = {}
  // The quiet window is six hours, so the settle path could not fire for hours:
  // the periodic check is what mines this session, and it must not consult that
  // window — the whole point is to capture while the session is still running.
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply, seen)), {
    memoriesDir: dir,
    autoExtract: true,
    minIdleHours: 6,
    extractIntervalMinutes: 30,
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  const agent = idleAgent(session)
  runtime.scheduleExtraction(agent)

  await runtime.runPeriodicPass()
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 1, 'the slice was mined')
  assert.ok(seen.user !== undefined, 'the first pass called the model')

  // Nothing new since the watermark: the next pass must not spend a call.
  seen.user = undefined
  await runtime.runPeriodicPass()
  assert.equal(seen.user, undefined, 'a session with nothing new costs no model call')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('a periodic pass respects the peak window', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-periodic-peak-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship it.","tags":[]}]}'
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), {
    memoriesDir: dir,
    autoExtract: true,
    extractIntervalMinutes: 30,
    peakHours: '* 00:00-24:00',
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  runtime.scheduleExtraction(idleAgent(session))

  await runtime.runPeriodicPass()
  assert.equal(runtime.state.getSession('extract-session'), undefined, 'spending waits for off-peak')
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('the periodic timer actually runs a pass', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-periodic-timer-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship it.","tags":[]}]}'
  // 0.01 minutes = 600ms: fractional intervals are kept, which is what makes this
  // testable without waiting half an hour. 2026-09-29 实测：原来的 0.02min(1200ms) 配
  // 1600ms 等待，在整套 259 个测试并发跑时会偶发不触发（单独跑 3/3 稳定通过）——
  // 属于负载敏感的 flake，不是功能回归。改成 600ms 周期 + 2400ms 等待（4 个周期），
  // 判定逻辑不变，只把余量从 400ms 拉到约 1.8s。
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), {
    memoriesDir: dir,
    autoExtract: true,
    extractIntervalMinutes: 0.01,
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  runtime.scheduleExtraction(idleAgent(session))
  runtime.startPeriodicExtraction()

  await new Promise((settle) => setTimeout(settle, 2_400))
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 1, 'the interval fired')
  runtime.stopPeriodicExtraction()
  t.after(() => rm(dir, { recursive: true, force: true }))
})

test('the exit flush still mines what arrived after a periodic pass', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-periodic-flush-'))
  const session = stubSession(process.cwd(), [{ seq: 1, role: 'user', text: 'We always ship with pnpm run ship.' }])
  const reply = '{"memories":[{"scope":"project","title":"Deploy with pnpm run ship","body":"Ship it.","tags":[]}]}'
  const runtime = new MemoriesRuntime(stubContext(fakeLlm(reply)), {
    memoriesDir: dir,
    autoExtract: true,
    minIdleHours: 6,
    extractIntervalMinutes: 30,
    extractTimeoutMs: 5_000,
  })
  t.after(() => runtime.dispose())
  const agent = idleAgent(session)
  runtime.scheduleExtraction(agent)

  await runtime.runPeriodicPass()
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 1)
  // The turn continues after the periodic pass, and then the process exits: the
  // flush must look at the content, not at "have we mined this session already".
  grow(session, { seq: 2, role: 'user', text: 'Also run tsc before publishing.' })
  assert.equal(await runtime.flushExit(5_000), 1, 'new material is not skipped by a per-process flag')
  assert.equal(runtime.state.getSession('extract-session')?.lastSeq, 2)
  t.after(() => rm(dir, { recursive: true, force: true }))
})
test('bindEvidence names what it dropped, not just how many', () => {
  const bound = bindEvidence([
    { scope: 'global', title: 'kept', body: 'b', tags: [], quote: 'I always deploy with pnpm run ship.' },
    { scope: 'global', title: 'no quote', body: 'b', tags: [] },
    { scope: 'global', title: 'too short', body: 'b', tags: [], quote: 'pnpm' },
    { scope: 'global', title: 'invented', body: 'b', tags: [], quote: 'The moon is made of cheese.' },
  ], [{ seq: 7, text: 'I always deploy with pnpm run ship.' }])
  assert.deepEqual(bound.drafts.map((draft) => draft.title), ['kept'])
  assert.equal(bound.unsupported, 3)
  // The reason is the actionable half: "no quote at all" is a prompt problem,
  // "quoted something the transcript does not contain" is an invention.
  assert.deepEqual(bound.dropped.map((item) => [item.title, item.reason]), [
    ['no quote', 'no-quote'],
    ['too short', 'quote-too-short'],
    ['invented', 'not-in-transcript'],
  ])
  assert.equal(bound.dropped[2]?.quotePreview, 'The moon is made of cheese.')
})

test('selectKnownTitles ranks the window over every stored title, not the newest 80', () => {
  // 120 titles, only the OLDEST one shares vocabulary with the window: a
  // time-ordered cut would hide exactly the title the extractor needs.
  const candidates = Array.from({ length: 120 }, (_, index) => ({
    title: index === 0 ? '日志轮转用 xz 归档' : `无关条目 ${index}`,
    updatedAt: 1_000 + index,
  }))
  const selected = selectKnownTitles(candidates, '那个日志轮转是怎么做的', 10)
  assert.equal(selected.length, 10)
  assert.equal(selected[0], '日志轮转用 xz 归档')
  // With nothing overlapping, the newest still win — a representative sample.
  const unrelated = selectKnownTitles(candidates, 'zzz', 2)
  assert.deepEqual(unrelated, ['无关条目 119', '无关条目 118'])
  // Under the cap the whole set passes through untouched.
  assert.deepEqual(selectKnownTitles(candidates.slice(0, 3), 'zzz', 10), ['日志轮转用 xz 归档', '无关条目 1', '无关条目 2'])
})

test('a backlog is mined from the oldest end, so no message can be skipped', () => {
  const events = Array.from({ length: 20 }, (_, index) => ({ seq: index + 1, role: 'user' as const, text: `line ${index}` }))
  const session = stubSession('C:\\work', events)
  // Newest-first steps over lines 2..17 and the watermark would jump past them.
  const newest = collectWindow(session, 0, 3, 100_000)
  assert.equal(newest.skipped, 17)
  const window = collectExtractionWindow(session, 0, 3, 100_000)
  assert.equal(window.skipped, 17)
  assert.equal(window.lastSeq, 3, 'a backlog window ends on the contiguous head')
  assert.match(window.text, /line 0/u)
  // Walking the watermark forward reaches every message exactly once.
  const seen: number[] = []
  let after = 0
  for (let pass = 0; pass < 20; pass += 1) {
    const next = collectExtractionWindow(session, after, 3, 100_000)
    if (next.lastSeq === undefined) break
    for (const source of next.sources) seen.push(source.seq)
    after = next.lastSeq
  }
  assert.deepEqual(seen, events.map((event) => event.seq))
})
