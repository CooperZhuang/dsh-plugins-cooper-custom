/**
 * `dsh-session-store/paths` 的单测：命名规则逐条钉死。
 *
 * 断言值直接取自 DSH 的真实行为（`dsh-session-persistence-jsonl/format.js`），
 * 以及 dsh-session-move / dsh-session-admin 两边原有的测试——本包接管这些规则后，
 * 它们仍然是同一份事实。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  compressionSuffix,
  decodeProjectKey,
  encodeSegment,
  findGeneration,
  generationLogFilename,
  isSessionLogFile,
  logPath,
  parseGenerationName,
  projectKey,
  sessionDir,
} from '../lib/paths.js'

test('encodeSegment 只放行安全字符并转义其余码位', () => {
  assert.equal(encodeSegment('session-abc.1_2-3'), 'session-abc.1_2-3')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
  assert.throws(() => encodeSegment(''), /empty path segment/)
})

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
  assert.throws(() => projectKey(''), /empty project path/)
})

test('decodeProjectKey 还原路径分隔符与转义', () => {
  assert.equal(decodeProjectKey('--C-CodeRepository-dsh-memories--'), 'C:\\CodeRepository\\dsh\\memories')
  assert.equal(decodeProjectKey('--C-Program~0020Files~0020~0028x86~0029--'), 'C:\\Program Files (x86)')
  // 非盘符开头的键不做盘符补全
  assert.equal(decodeProjectKey('--var-log--'), 'var\\log')
})

test('projectKey / decodeProjectKey 是同一套规则的两个方向', () => {
  // 反解本身是**有损**的：分隔符在键里已全部退化成 `-`，所以目录名里本来就有 `-`
  // （例如 `dsh-session-store`）或原本是 `/` 分隔的路径都还原不回去——见
  // decodeProjectKey 的注释。这里只对无损形状断言往返一致。
  const cwd = 'C:\\CodeRepository\\DSH\\Store'
  assert.equal(decodeProjectKey(projectKey(cwd)), cwd)
  assert.equal(decodeProjectKey(projectKey('C:\\Program Files (x86)')), 'C:\\Program Files (x86)')
})

test('isSessionLogFile 是宽松判定，parseGenerationName 是规范名判定', () => {
  assert.equal(isSessionLogFile('session.v3.jsonl.zstd'), true)
  assert.equal(isSessionLogFile('session.jsonl'), true)
  // 宽松：任何形状的日志都算（删除路径要能清理手工改名/半截写入的文件）
  assert.equal(isSessionLogFile('notes.jsonl.zstd'), true)
  assert.equal(isSessionLogFile('session.txt'), false)
  // 规范：只认 generation
  assert.deepEqual(parseGenerationName('session.jsonl'), { version: 0, compressed: false })
  assert.deepEqual(parseGenerationName('session.v3.jsonl.zstd'), { version: 3, compressed: true })
  assert.equal(parseGenerationName('notes.jsonl.zstd'), undefined)
  assert.equal(parseGenerationName('session.v3.jsonl.zstd.session-move-tmp'), undefined)
})

test('compressionSuffix / generationLogFilename 只给规范名', () => {
  assert.equal(compressionSuffix('zstd'), '.zstd')
  assert.equal(compressionSuffix('plain'), '')
  assert.equal(generationLogFilename(0, 'zstd'), 'session.jsonl.zstd')
  assert.equal(generationLogFilename(3, 'zstd'), 'session.v3.jsonl.zstd')
  assert.equal(generationLogFilename(0, 'none'), 'session.jsonl')
})

test('sessionDir / logPath 拼出 <root>/<projectKey>/<encodeSegment(id)>/…', () => {
  assert.equal(
    sessionDir('C:\\root', 'C:\\work', 'session-1'),
    join('C:\\root', '--C-work--', 'session-1'),
  )
  // cwd 未知时用 _no-cwd 占位
  assert.equal(sessionDir('C:\\root', undefined, 'session-1'), join('C:\\root', '_no-cwd', 'session-1'))
  assert.equal(
    logPath('C:\\root', 'C:\\work', 'session-1', 3, 'zstd'),
    join('C:\\root', '--C-work--', 'session-1', 'session.v3.jsonl.zstd'),
  )
})

test('findGeneration 选中版本最高的规范名，忽略临时/备份名', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-store-gen-'))
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

test('findGeneration 的错误文案稳定（被两个插件的报告引用）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-store-gen2-'))
  try {
    const missing = join(root, 'nope')
    assert.match(findGeneration(missing).error, /^cannot list session directory /)
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    const found = findGeneration(empty)
    assert.equal(found.error, `no canonical session log in ${empty}`)
    assert.deepEqual(found.others, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
