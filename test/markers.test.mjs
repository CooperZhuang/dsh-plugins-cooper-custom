import assert from 'node:assert/strict'
import test from 'node:test'
import { joinTailMarkers, splitTailMarkers } from '../lib/markers.js'

const cases = [
  'out\n[exit code: 1]',
  'out\n[stderr]\nboom\n[exit code: 2]',
  'out\n[timed out after 30000ms]',
  'out\n[stopped: user]\n[exit code: 130]',
  'out\n[killed by signal: SIGKILL]',
  'out\n[sandbox: file access denied under workspace-write mode]',
  'out\n[sandbox: file access denied under read-only mode]\n[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
  'out\n[still running after 15000ms; moved to background job job-1]\nThe command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.',
  '[exit code: 1]',
  'no markers at all',
  'out with\n\nblank line before marker\n[exit code: 3]',
]

test('split/join 往返逐字节一致', () => {
  for (const text of cases) {
    const { body, tail } = splitTailMarkers(text)
    assert.equal(joinTailMarkers(body, tail), text, `roundtrip failed: ${JSON.stringify(text)}`)
  }
})

test('尾部标记被正确拆出，正文不含标记', () => {
  const { body, tail } = splitTailMarkers('out\n[stderr]\nboom\n[exit code: 2]')
  assert.equal(body, 'out\n[stderr]\nboom')
  assert.equal(tail, '[exit code: 2]')
})

test('后台指引段落随 still-running 标记一起拆出', () => {
  const text = cases[7]
  const { body, tail } = splitTailMarkers(text)
  assert.equal(body, 'out')
  assert.ok(tail.startsWith('[still running after 15000ms; moved to background job job-1]'))
  assert.ok(tail.includes('The command keeps running in the background.'))
})

test('正文里形似标记的行不被拆（只处理末尾连续区段）', () => {
  const { body, tail } = splitTailMarkers('echoed [exit code: 1] in the middle\nreal output')
  assert.equal(body, 'echoed [exit code: 1] in the middle\nreal output')
  assert.equal(tail, '')
})

test('无标记时 tail 为空字符串', () => {
  assert.deepEqual(splitTailMarkers('plain'), { body: 'plain', tail: '' })
  assert.deepEqual(splitTailMarkers(''), { body: '', tail: '' })
})

test('孤立的后台指引（前面不是标记）不被拆', () => {
  const text =
    'The command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.'
  assert.deepEqual(splitTailMarkers(text), { body: text, tail: '' })
})
