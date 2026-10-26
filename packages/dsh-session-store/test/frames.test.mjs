/**
 * `dsh-session-store/frames` 的单测：帧扫描、两种头部读法、cwd 改写。
 *
 * 夹具照着 DSH 的真实形状造：**帧 0 只含一行 header**，之后每帧一个事件批次
 * （`assertIndependentHeaderFrame` 会强制这一点，夹具写错就只验证得了「我们的读取器宽松」）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'

import {
  CHECKSUM_OPTIONS,
  ZSTD_MAGIC,
  hasZstd,
  readHeaderFromBuffer,
  readSessionHeader,
  rewriteHeaderCwd,
  scanZstdFrames,
} from '../lib/frames.js'

/** 造一份「帧 0 只含 header 行」的合成日志。 */
function syntheticLog(cwd, events) {
  const header = { type: 'session', version: 3, id: 'session-test-1', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd }
  const headerLine = `${JSON.stringify(header)}\n`
  const frames = [zlib.zstdCompressSync(Buffer.from(headerLine, 'utf8'), CHECKSUM_OPTIONS)]
  for (const event of events) frames.push(zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'), CHECKSUM_OPTIONS))
  return Buffer.concat(frames)
}

test('ZSTD_MAGIC / CHECKSUM_OPTIONS / hasZstd 与 DSH 的压缩参数一致', () => {
  assert.equal(ZSTD_MAGIC, 0xfd2fb528)
  assert.equal(hasZstd, true, '本 Node 必须带 zstd 支持（Node ≥22.15）')
  // 带内容校验和：DSH 自己压的帧就是这么写的，重压帧 0 必须对齐。
  assert.equal(Array.isArray(CHECKSUM_OPTIONS.params), false)
  assert.equal(CHECKSUM_OPTIONS.params[zlib.constants.ZSTD_c_checksumFlag], 1)
  assert.equal(syntheticLog('C:\\a', []).readUInt32LE(0), ZSTD_MAGIC)
})

test('scanZstdFrames 数得清帧边界', () => {
  const log = syntheticLog('C:\\a', [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'turn/end' }])
  const scan = scanZstdFrames(log)
  assert.equal(scan.incomplete, false)
  assert.equal(scan.frames.length, 3)
  assert.equal(scan.frames[0].start, 0)
  assert.equal(scan.frames.at(-1).end, log.length)
  // 帧范围首尾相接、不成对/被截断时带 reason
  assert.equal(scan.frames[1].start, scan.frames[0].end)
  const broken = scanZstdFrames(log.subarray(0, log.length - 2))
  assert.equal(broken.incomplete, true)
  assert.equal(typeof broken.reason, 'string')
  const notZstd = scanZstdFrames(Buffer.from('hello'))
  assert.equal(notZstd.incomplete, true)
  assert.equal(notZstd.frames.length, 0)
})

test('readHeaderFromBuffer 只认 type=session 的头部', () => {
  const log = syntheticLog('C:\\a', [{ seq: 0 }])
  assert.equal(readHeaderFromBuffer(log).id, 'session-test-1')
  assert.equal(readHeaderFromBuffer(log).cwd, 'C:\\a')
  // 未压缩的行式日志
  const plain = Buffer.from(`${JSON.stringify({ type: 'session', id: 's', cwd: 'C:\\b' })}\n{"seq":0}\n`, 'utf8')
  assert.equal(readHeaderFromBuffer(plain, false).cwd, 'C:\\b')
  // 非法输入一律 undefined，不抛
  assert.equal(readHeaderFromBuffer(Buffer.from('not a log')), undefined)
  assert.equal(readHeaderFromBuffer(Buffer.alloc(0)), undefined)
  assert.equal(readHeaderFromBuffer(Buffer.from('{"type":"other"}'), false), undefined)
  assert.equal(readHeaderFromBuffer(Buffer.from('{oops'), false), undefined)
})

test('rewriteHeaderCwd 只改 cwd，事件帧字节不变', () => {
  const log = syntheticLog('C:\\CodeRepository\\from', [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'turn/end' }])
  const before = scanZstdFrames(log).frames
  const rewritten = rewriteHeaderCwd(log, 'C:\\CodeRepository\\to')
  assert.equal(rewritten.rewritten, true)
  assert.equal(rewritten.header.cwd, 'C:\\CodeRepository\\to')
  assert.equal(rewritten.header.id, 'session-test-1')
  assert.equal(rewritten.frames, 3)

  const after = scanZstdFrames(rewritten.buffer).frames
  assert.equal(after.length, 3)
  // 帧 0 之外一个字节都没动。
  assert.equal(rewritten.buffer.subarray(after[0].end).equals(log.subarray(before[0].end)), true)

  // 帧 0 解出来必须**恰好**一行 header（DSH 的 assertIndependentHeaderFrame 同款校验）。
  const plaintext = zlib.zstdDecompressSync(rewritten.buffer.subarray(after[0].start, after[0].end)).toString('utf8')
  assert.equal(plaintext.endsWith('\n'), true)
  assert.equal(plaintext.indexOf('\n'), plaintext.length - 1)
  assert.equal(JSON.parse(plaintext.slice(0, -1)).cwd, 'C:\\CodeRepository\\to')

  // 事件帧仍然解得出原事件。
  const event = JSON.parse(zlib.zstdDecompressSync(rewritten.buffer.subarray(after[1].start, after[1].end)).toString('utf8'))
  assert.deepEqual(event, { seq: 0, type: 'turn/start' })
})

test('rewriteHeaderCwd 对未压缩行式日志同样只动 cwd，并对无法改写的输入给出 reason', () => {
  const header = { type: 'session', version: 3, id: 's', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: 'C:\\a' }
  const log = Buffer.from(`${JSON.stringify(header)}\n{"seq":0}\n`, 'utf8')
  const rewritten = rewriteHeaderCwd(log, 'C:\\b', { compressed: false })
  assert.equal(rewritten.rewritten, true)
  assert.equal(rewritten.buffer.toString('utf8'), `${JSON.stringify({ ...header, cwd: 'C:\\b' })}\n{"seq":0}\n`)

  // cwd 已经一致 / 目标为空 / 头部没有 cwd / 不是 JSON：都不改写，原样返回并带 reason。
  assert.equal(rewriteHeaderCwd(log, 'C:\\a', { compressed: false }).rewritten, false)
  assert.equal(rewriteHeaderCwd(log, '', { compressed: false }).reason, 'empty target cwd')
  assert.equal(rewriteHeaderCwd(Buffer.from('{"type":"session"}'), 'C:\\b', { compressed: false }).reason, 'header has no cwd')
  assert.equal(rewriteHeaderCwd(Buffer.from('{oops'), 'C:\\b', { compressed: false }).reason, 'header line is not JSON')
  assert.equal(rewriteHeaderCwd(Buffer.alloc(0), 'C:\\b').rewritten, false)
})

test('readSessionHeader 扫目录取头部，并按 path:mtime:size 缓存', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-store-header-'))
  try {
    const dir = join(root, 'session-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), syntheticLog('C:\\work', [{ seq: 0 }]))

    const cache = new Map()
    const header = readSessionHeader(dir, cache)
    assert.equal(header.cwd, 'C:\\work')
    assert.equal(header.origin, undefined)
    assert.equal(cache.size, 1)
    // 第二次读命中缓存：返回的是同一个对象。
    assert.equal(readSessionHeader(dir, cache), header)
    // 不传缓存也能用（内部现建一个）。
    assert.equal(readSessionHeader(dir).id, 'session-test-1')

    // 宽松：手工改名 / 非规范名的日志照样读（删除路径要能处理它们）。
    const odd = join(root, 'odd')
    mkdirSync(odd, { recursive: true })
    writeFileSync(join(odd, 'notes.jsonl.zstd'), syntheticLog('C:\\odd', []))
    assert.equal(readSessionHeader(odd).cwd, 'C:\\odd')

    // 未压缩行式日志。
    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'session.jsonl'), Buffer.from('{"cwd":"C:\\\\plain"}\n', 'utf8'))
    assert.equal(readSessionHeader(plain).cwd, 'C:\\plain')

    // 目录不存在 / 没有日志文件 / 日志坏掉：一律 undefined，不抛。
    assert.equal(readSessionHeader(join(root, 'nope')), undefined)
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    assert.equal(readSessionHeader(empty), undefined)
    const broken = join(root, 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'session.v3.jsonl.zstd'), Buffer.from('not zstd at all'))
    assert.equal(readSessionHeader(broken), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
