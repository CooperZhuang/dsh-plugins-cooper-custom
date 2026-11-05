import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCondenseNotice, saveFullText } from '../lib/spill.js'

const exec = { name: 'bash', callId: 'call-1', agent: { session: { header: { id: 'session-1' } } } }
const ctxWith = (spillStore) => ({ get: (name) => (name === 'spillStore' ? spillStore : undefined) })

test('saveFullText：把原文与 owner/source 交给 spillStore', async () => {
  const calls = []
  const store = {
    saveText: async (input) => {
      calls.push(input)
      return {
        locator: '/tmp/spill/session-1/abc-bash.txt',
        bytes: 42,
        retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
      }
    },
  }
  const ref = await saveFullText(ctxWith(store), exec, 'RAW TEXT')
  assert.equal(ref.locator, '/tmp/spill/session-1/abc-bash.txt')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].owner, { sessionId: 'session-1' })
  assert.equal(calls[0].content, 'RAW TEXT')
  assert.equal(calls[0].suggestedName, 'bash.txt')
  assert.deepEqual(calls[0].source, { kind: 'tool', toolName: 'bash', callId: 'call-1', label: 'result' })
})

test('saveFullText：后端缺失 / 无会话 id / 抛错 / 返回值畸形 一律返回 undefined', async () => {
  assert.equal(await saveFullText(ctxWith(undefined), exec, 'x'), undefined)
  assert.equal(await saveFullText(ctxWith({ saveText: async () => ({ locator: '/x' }) }), { name: 'bash' }, 'x'), undefined)
  assert.equal(
    await saveFullText(
      ctxWith({
        saveText: async () => {
          throw new Error('disk full')
        },
      }),
      exec,
      'x',
    ),
    undefined,
  )
  assert.equal(await saveFullText(ctxWith({ saveText: async () => ({}) }), exec, 'x'), undefined)
})

test('formatCondenseNotice：与 spill-policy 同款措辞，含字节数与 hint', () => {
  const notice = formatCondenseNotice({
    beforeBytes: 6202,
    afterBytes: 184,
    ref: { locator: '/tmp/x.txt', retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' },
  })
  assert.equal(
    notice,
    '(rtk condensed 6202 → 184 bytes. Full formatted result stored at: /tmp/x.txt. Use read with offset/limit, or grep this path to search within it.)',
  )
})

test('formatCondenseNotice：hint 缺失时用兜底措辞', () => {
  const notice = formatCondenseNotice({ beforeBytes: 10, afterBytes: 2, ref: { locator: '/tmp/y.txt' } })
  assert.ok(notice.includes('Full formatted result stored at: /tmp/y.txt.'))
  assert.ok(notice.includes('Use read with offset/limit'))
  assert.ok(notice.startsWith('(rtk condensed 10 → 2 bytes.'))
})
