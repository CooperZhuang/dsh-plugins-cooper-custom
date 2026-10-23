/**
 * The kernel contract the consolidation child is started under.
 *
 * Since 0.2.1-rc.2 a child is started through `subagents.startActivation`, which
 * folds the caller's fields into a continuable descriptor and validates that
 * descriptor with the kernel's lossless-JSON snapshot. The descriptor is built
 * with `label: input.label` written UNCONDITIONALLY, so a caller that omits the
 * label does not get "no label" — it gets a descriptor the snapshot rejects, and
 * the error surfaces as
 * `subagent descriptor is not losslessly JSON-serializable`.
 *
 * That is exactly how consolidation died on 2026-10-20: the pass kept retrying,
 * the job kept backing off, and every attempt failed before the child started.
 * The unit tests did not catch it because the fake seam in `consolidate.test.ts`
 * returns a canned reply and never builds a descriptor — the plugin's own
 * interface was tested instead of the kernel's contract.
 *
 * This file pins the contract without starting a kernel: it reproduces the two
 * steps that actually failed (fold the fields, then validate) and asserts the
 * spec this plugin builds survives both, including a mutation test proving the
 * assertion is not vacuous.
 *
 * @module dsh-memories/test/subagent-contract.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { buildActivationSpec, CONSOLIDATE_LABEL } from '../consolidate.js'
import type { ActivationSpec, ConsolidateRequest } from '../consolidate.js'

/**
 * Reject a value the kernel's descriptor snapshot would refuse.
 *
 * `dsh-util-values` detaches a value with `walkJsonValue`, which yields
 * `undefined` for any leaf JSON cannot express — `undefined`, functions,
 * symbols, bigints — and `snapshotSubagentDescriptor` turns that into a thrown
 * error. Note this is STRICTER than `JSON.stringify`, which silently drops an
 * `undefined`-valued property instead of failing: that difference is the whole
 * bug this file exists for.
 *
 * @param value - candidate value.
 * @param path - location used in the failure message.
 */
function assertLossless(value: unknown, path = '$'): void {
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return
  if (type === 'object') {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertLossless(item, `${path}[${index}]`))
      return
    }
    const proto = Object.getPrototypeOf(value) as unknown
    if (proto !== Object.prototype && proto !== null) throw new Error(`${path} is not a plain object`)
    const record = value as Record<string, unknown>
    for (const [key, item] of Object.entries(record)) assertLossless(item, `${path}.${key}`)
    return
  }
  throw new Error(`${path} is not losslessly JSON-serializable (${type})`)
}

/**
 * The subset of the spec that the kernel snapshots into a descriptor.
 *
 * The request (prompt blocks, a live Agent, an AbortSignal) is passed through,
 * never serialized, so it is deliberately absent here — a check over the whole
 * spec would fail for the wrong reason.
 *
 * @param spec - the seam spec this plugin builds.
 * @returns the candidate descriptor, shaped as the kernel shapes it.
 */
function descriptorOf(spec: ActivationSpec): Record<string, unknown> {
  return { version: 1, mode: 'continuable', provider: spec.provider, label: spec.label }
}

/** A request naming a route and a preset, i.e. the common production case. */
function routedRequest(): ConsolidateRequest {
  return {
    parent: {} as unknown as Agent,
    provider: 'test-provider',
    model: 'test-model',
    agentPreset: 'memories-consolidator',
    subagentProvider: 'spawn',
    entries: [],
    projectLabel: 'demo',
    maxUpserts: 3,
    denyTools: [],
    timeoutMs: 1000,
    signal: AbortSignal.timeout(1000),
  }
}

/** A request with no route and no preset: both optionals must be absent, not undefined. */
function bareRequest(): ConsolidateRequest {
  return {
    parent: {} as unknown as Agent,
    entries: [],
    projectLabel: 'demo',
    maxUpserts: 3,
    denyTools: [],
    timeoutMs: 1000,
    signal: AbortSignal.timeout(1000),
  }
}

const PROMPT = [{ type: 'text' as const, text: 'consolidate these memories' }]

test('the descriptor the kernel builds from our spec survives its lossless snapshot', () => {
  const spec = buildActivationSpec(routedRequest(), PROMPT, AbortSignal.timeout(1000))
  assert.doesNotThrow(() => assertLossless(descriptorOf(spec)))
})

test('the label is a non-empty string, so the kernel never sees undefined', () => {
  const spec = buildActivationSpec(routedRequest(), PROMPT, AbortSignal.timeout(1000))
  assert.equal(typeof spec.label, 'string')
  assert.ok(spec.label.length > 0)
  assert.equal(spec.label, CONSOLIDATE_LABEL)
})

test('a bare request omits optional fields instead of setting them to undefined', () => {
  const spec = buildActivationSpec(bareRequest(), PROMPT, AbortSignal.timeout(1000))
  assert.ok(!('agentOptions' in spec.request))
  assert.ok(!('agentPreset' in spec.request))
  for (const [key, value] of Object.entries(spec.request)) {
    assert.ok(value !== undefined, `request.${key} is present but undefined`)
  }
  assert.doesNotThrow(() => assertLossless(descriptorOf(spec)))
})

test('the check is not vacuous: a descriptor with an undefined label is rejected', () => {
  // This is the exact regression. If the plugin drops the label again, the first
  // test fails; if this checker stops catching undefined, this one does.
  assert.throws(
    () => assertLossless({ version: 1, mode: 'continuable', provider: 'spawn', label: undefined }),
    /not losslessly JSON-serializable/u,
  )
})
test('the spec carries the signal at the top level, where the kernel reads it', () => {
  // The kernel's continuable path calls `spec.signal.throwIfAborted()` and passes
  // `spec.signal` into prepareContinuable; it never looks at `spec.request.signal`.
  // A spec with the signal only inside the request reserved the child and then
  // crashed with "Cannot read properties of undefined (reading 'throwIfAborted')".
  const timeout = AbortSignal.timeout(1_000)
  const spec = buildActivationSpec(routedRequest(), PROMPT, timeout)
  assert.equal(spec.signal, timeout, 'the top-level signal is the one the caller passed')
  assert.equal(spec.request.signal, timeout, 'and the request kept its own copy')
  assert.equal(typeof spec.signal.throwIfAborted, 'function')
  assert.doesNotThrow(() => spec.signal.throwIfAborted())
})
