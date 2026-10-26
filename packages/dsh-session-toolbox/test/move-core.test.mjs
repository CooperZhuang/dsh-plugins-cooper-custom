/**
 * 核心单测：路径命名、帧改写、搬迁计划/执行。
 *
 * 跑法：`npm test`（= `node --test test/`）。全部在临时目录里造合成日志，
 * 不碰任何真实会话。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import {
  CHECKSUM_OPTIONS,
  encodeSegment,
  projectKey,
  readHeaderFromBuffer,
  rewriteHeaderCwd,
  scanZstdFrames,
  sessionDir,
} from '../lib/sessionlog.js'
import { applyPlan, findGeneration, planMove, verifyStoredLog } from '../lib/engine.js'

// ---------------------------------------------------------------------------
// 路径命名：与 dsh-session-persistence-jsonl/format.js 一致
// ---------------------------------------------------------------------------

test('projectKey 与 DSH 的项目目录命名一致', () => {
  assert.equal(projectKey('C:\\Users\\Cooper\\.dsh'), '--C-Users-Cooper-.dsh--')
  assert.equal(projectKey('/Users/cooper/code/x'), '--Users-cooper-code-x--')
  // 非 ASCII：每个码位写成 ~XXXX（大写十六进制、四位）
  assert.equal(
    projectKey('C:\\Users\\Cooper\\Downloads\\慕贝尔-对人工智能系统进行分类'),
    '--C-Users-Cooper-Downloads-~6155~8D1D~5C14-~5BF9~4EBA~5DE5~667A~80FD~7CFB~7EDF~8FDB~884C~5206~7C7B--',
  )
  // 连续分隔符折叠成一个 '-'
  assert.equal(projectKey('C:\\\\a///b'), '--C-a-b--')
})

test('encodeSegment 只放行安全字符并转义其余码位', () => {
  assert.equal(encodeSegment('session-abc.1_2-3'), 'session-abc.1_2-3')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
})

// ---------------------------------------------------------------------------
// 帧读写
// ---------------------------------------------------------------------------

/** 造一份「帧 0 只含 header 行」的合成日志。 */
function syntheticLog(cwd, events) {
  const header = { type: 'session', version: 3, id: 'session-test-1', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd }
  const headerLine = `${JSON.stringify(header)}\n`
  const frames = [zlib.zstdCompressSync(Buffer.from(headerLine, 'utf8'), CHECKSUM_OPTIONS)]
  for (const event of events) frames.push(zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'), CHECKSUM_OPTIONS))
  return Buffer.concat(frames)
}

test('scanZstdFrames 数得清帧边界', () => {
  const log = syntheticLog('C:\\a', [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'turn/end' }])
  const scan = scanZstdFrames(log)
  assert.equal(scan.incomplete, false)
  assert.equal(scan.frames.length, 3)
  assert.equal(scan.frames[0].start, 0)
  assert.equal(scan.frames.at(-1).end, log.length)
})

test('rewriteHeaderCwd 只改 cwd，事件帧字节不变', () => {
  const log = syntheticLog('C:\\CodeRepository\\PP-OCRv6', [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'turn/end' }])
  const before = scanZstdFrames(log).frames
  const rewritten = rewriteHeaderCwd(log, 'C:\\CodeRepository\\dsh-memories')
  assert.equal(rewritten.rewritten, true)
  assert.equal(rewritten.header.cwd, 'C:\\CodeRepository\\dsh-memories')
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
  assert.equal(JSON.parse(plaintext.slice(0, -1)).cwd, 'C:\\CodeRepository\\dsh-memories')

  // 事件帧仍然解得出原事件。
  const event = JSON.parse(zlib.zstdDecompressSync(rewritten.buffer.subarray(after[1].start, after[1].end)).toString('utf8'))
  assert.deepEqual(event, { seq: 0, type: 'turn/start' })
})

test('rewriteHeaderCwd 对未压缩行式日志同样只动 cwd', () => {
  const header = { type: 'session', version: 3, id: 's', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: 'C:\\a' }
  const log = Buffer.from(`${JSON.stringify(header)}\n{"seq":0}\n`, 'utf8')
  const rewritten = rewriteHeaderCwd(log, 'C:\\b', { compressed: false })
  assert.equal(rewritten.rewritten, true)
  assert.equal(rewritten.buffer.toString('utf8'), `${JSON.stringify({ ...header, cwd: 'C:\\b' })}\n{"seq":0}\n`)
})

test('readHeaderFromBuffer 拒绝非法输入', () => {
  assert.equal(readHeaderFromBuffer(Buffer.from('not a log')), undefined)
  assert.equal(readHeaderFromBuffer(Buffer.alloc(0)), undefined)
})

// ---------------------------------------------------------------------------
// 搬迁
// ---------------------------------------------------------------------------

/** 造一个临时 session root，并在 fromCwd 下放一条合成会话。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-move-'))
  const fromCwd = 'C:\\CodeRepository\\from-ws'
  const toCwd = 'C:\\CodeRepository\\to-ws'
  const sessionId = 'session-test-1'
  const dir = sessionDir(root, fromCwd, sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), syntheticLog(fromCwd, [{ seq: 0, type: 'turn/start' }]))
  // 目标工作区的 project 目录（其他会话已在那儿）也建出来，模拟真实布局。
  mkdirSync(sessionDir(root, toCwd, 'session-other'), { recursive: true })
  return { root, fromCwd, toCwd, sessionId, dir }
}

test('planMove + applyPlan 完成搬迁且不残留源目录', () => {
  const f = fixture()
  try {
    const plan = planMove({ root: f.root, sessionId: f.sessionId, fromCwd: f.fromCwd, toCwd: f.toCwd, compression: 'zstd' })
    assert.equal(plan.generation.name, 'session.v3.jsonl.zstd')
    assert.equal(plan.frameCount, 2)
    const report = applyPlan(plan)
    assert.equal(report.ok, true)
    assert.equal(report.verifiedHeader.cwd, f.toCwd)
    assert.equal(report.removedSourceDir, true)
    assert.equal(existsSync(plan.sourcePath), false)
    assert.equal(existsSync(plan.targetPath), true)
    assert.equal(existsSync(f.dir), false)
    // 目标目录里没有临时名残留。
    const names = readdirSync(plan.targetDir)
    assert.deepEqual(names, ['session.v3.jsonl.zstd'])
    // 用只读校验再确认一次。
    const verified = verifyStoredLog({ root: f.root, sessionId: f.sessionId, cwd: f.toCwd, compression: 'zstd' })
    assert.equal(verified.ok, true)
    assert.equal(verified.magic, 'zstd')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('planMove 拒绝覆盖已存在的目标日志', () => {
  const f = fixture()
  try {
    const plan = planMove({ root: f.root, sessionId: f.sessionId, fromCwd: f.fromCwd, toCwd: f.toCwd, compression: 'zstd' })
    mkdirSync(plan.targetDir, { recursive: true })
    writeFileSync(plan.targetPath, readFileSync(plan.sourcePath))
    assert.throws(
      () => planMove({ root: f.root, sessionId: f.sessionId, fromCwd: f.fromCwd, toCwd: f.toCwd, compression: 'zstd' }),
      /target log already exists/,
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('planMove 拒绝缺源日志 / 同目录 / cwd 不符', () => {
  const f = fixture()
  try {
    assert.throws(
      () => planMove({ root: f.root, sessionId: 'session-missing', fromCwd: f.fromCwd, toCwd: f.toCwd, compression: 'zstd' }),
      /no canonical session log|cannot list session directory/,
    )
    assert.throws(
      () => planMove({ root: f.root, sessionId: f.sessionId, fromCwd: f.fromCwd, toCwd: f.fromCwd, compression: 'zstd' }),
      /identical/,
    )
    assert.throws(
      () => planMove({ root: f.root, sessionId: f.sessionId, fromCwd: 'C:\\elsewhere', toCwd: f.toCwd, compression: 'zstd' }),
      /no canonical session log|cannot list session directory/,
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('findGeneration 选中版本最高的规范名，忽略临时/备份名', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-move-gen-'))
  try {
    const dir = join(root, 'x')
    mkdirSync(dir, { recursive: true })
    for (const name of ['session.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v3.jsonl.zstd.session-move-tmp', 'notes.txt']) {
      writeFileSync(join(dir, name), Buffer.from('x'))
    }
    const found = findGeneration(dir)
    assert.equal(found.selected.name, 'session.v3.jsonl.zstd')
    assert.equal(found.all.length, 2)
    assert.deepEqual(found.others.sort(), ['notes.txt', 'session.v3.jsonl.zstd.session-move-tmp'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
