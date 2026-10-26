import assert from 'node:assert/strict'
import test from 'node:test'
import { singleText, textBlock } from '../lib/content.js'

test('singleText: 单个 text block 返回其文本', () => {
  assert.equal(singleText([{ type: 'text', text: 'hello' }]), 'hello')
})

test('singleText: 空文本也返回（不是 undefined）', () => {
  assert.equal(singleText([{ type: 'text', text: '' }]), '')
})

test('singleText: 多块 / 非文本块 / 空数组 一律 bail', () => {
  assert.equal(singleText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), undefined)
  assert.equal(singleText([{ type: 'image', attachment: {} }]), undefined)
  assert.equal(singleText([]), undefined)
  assert.equal(singleText(undefined), undefined)
})

test('textBlock: 回填为单个 text block', () => {
  assert.deepEqual(textBlock('x'), [{ type: 'text', text: 'x' }])
})
