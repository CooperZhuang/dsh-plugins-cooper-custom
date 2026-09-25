/**
 * `dsh-session-store/host` 的单测：`$DSH_HOME`、文件日志（两种行格式）、volatile 配置解包。
 *
 * 日志测试把 `DSH_HOME` 指到临时目录，绝不碰真机的 `~/.dsh/logs`。
 * `node --test` 每个测试文件跑在独立进程里，改环境变量不会影响别的文件。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  LOG_LINE_LEVEL_FIRST,
  LOG_LINE_TIME_FIRST,
  createFileLogger,
  dshHome,
  plainConfig,
  resolveVolatileConfig,
} from '../lib/host.js'

let home
const previousHome = process.env.DSH_HOME

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-session-store-home-'))
  process.env.DSH_HOME = home
})

after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

test('dshHome 环境变量优先，否则 ~/.dsh', () => {
  assert.equal(dshHome(), home)
  delete process.env.DSH_HOME
  assert.match(dshHome(), /[\\/]\.dsh$/)
  // 空串等同于没设（宿主有时会导出空值）
  process.env.DSH_HOME = ''
  assert.match(dshHome(), /[\\/]\.dsh$/)
  process.env.DSH_HOME = home
})

test('LOG_LINE_* 两种行格式逐字固定', () => {
  const entry = { iso: '2026-09-25T00:00:00.000Z', level: 'info', message: 'mounted: prefix=/x/api' }
  assert.equal(LOG_LINE_LEVEL_FIRST(entry), '[2026-09-25T00:00:00.000Z] info mounted: prefix=/x/api\n')
  assert.equal(LOG_LINE_TIME_FIRST(entry), '2026-09-25T00:00:00.000Z [info] mounted: prefix=/x/api\n')
})

test('createFileLogger 写 $DSH_HOME/logs/<name>.log，并转发给宿主 logger', () => {
  const seen = []
  const ctx = { logger: { info: (m) => seen.push(['info', m]), warn: (m) => seen.push(['warn', m]) } }
  const log = createFileLogger(ctx, { name: 'dsh-session-store-test', formatLine: LOG_LINE_TIME_FIRST })
  log('info', 'mounted: prefix=/a/api')
  log('warn', 'boom')

  const file = join(home, 'logs', 'dsh-session-store-test.log')
  assert.equal(existsSync(file), true)
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[info\] mounted: prefix=\/a\/api$/)
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[warn\] boom$/)
  assert.deepEqual(seen, [['info', 'mounted: prefix=/a/api'], ['warn', 'boom']])

  // 默认名字与默认行格式（admin 那套）。
  const defaultLog = createFileLogger(ctx)
  defaultLog('info', 'plain')
  assert.match(readFileSync(join(home, 'logs', 'dsh-session-store.log'), 'utf8'), /^\[[\d:.TZ-]+\] info plain\n$/)

  // 宿主 logger 不可用 / 缺级别时不影响文件日志。
  assert.doesNotThrow(() => createFileLogger(undefined)('debug', 'no ctx'))
  assert.doesNotThrow(() => createFileLogger({ logger: { info() { throw new Error('host logger is broken') } } })('info', 'still written'))
  assert.match(readFileSync(join(home, 'logs', 'dsh-session-store.log'), 'utf8'), /still written/)
})

test('plainConfig 解包活引用，其它值原样通过', () => {
  assert.deepEqual(plainConfig({ a: 1, b: { get: () => true } }), { a: 1, b: true })
  assert.deepEqual(plainConfig({}), {})
  assert.deepEqual(plainConfig(null), {})
  assert.deepEqual(plainConfig('nope'), {})
  // 普通对象（没有 get）不当作活引用
  assert.deepEqual(plainConfig({ c: { value: 1 } }), { c: { value: 1 } })
})

test('resolveVolatileConfig：进 schema 前解包一次，出 schema 后再解包一次', () => {
  // 桩 schema：模拟 schemastery —— 收普通对象、补默认值，并对 volatile 字段**输出活引用**。
  let live = false
  const schema = (raw) => ({
    enabled: raw.enabled ?? true,
    allowLiveSessions: { get: () => live },
    maxBatch: raw.maxBatch ?? 200,
  })

  const config = resolveVolatileConfig(schema, { allowLiveSessions: { get: () => live }, maxBatch: { get: () => 7 } })
  // volatile 字段收敛成普通值（否则 HTTP 面上会变成一个空对象）
  assert.equal(config.allowLiveSessions, false)
  assert.equal(config.maxBatch, 7)
  assert.equal(config.enabled, true)
  // 每次解析都现取活引用的值：Loader 写盘后原地更新活引用、再补发一次
  // `loader/volatile-update`，插件重新调用本函数就该看到新值。
  live = true
  assert.equal(resolveVolatileConfig(schema, {}).allowLiveSessions, true)
  // 没有配置也能用（补默认值）
  assert.equal(resolveVolatileConfig(schema).maxBatch, 200)
})
