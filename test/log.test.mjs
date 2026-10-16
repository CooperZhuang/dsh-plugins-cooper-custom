import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { defaultLogPath, logStartup } from '../lib/log.js'

/** Run `fn` with DSH_HOME pointed at a throwaway directory. */
function withTempHome(fn) {
  const saved = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'rtk-slim-home-'))
  process.env.DSH_HOME = home
  try {
    return fn(home)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
}

test('defaultLogPath：尊重 DSH_HOME，缺失时回落 ~/.dsh', () => {
  withTempHome((home) => {
    assert.equal(defaultLogPath(), join(home, 'logs', 'dsh-rtk-slim.log'))
    const saved = process.env.DSH_HOME
    delete process.env.DSH_HOME
    assert.ok(defaultLogPath().endsWith('/.dsh/logs/dsh-rtk-slim.log'))
    process.env.DSH_HOME = saved
  })
})

test('logStartup：自动建目录并追加；写不进去时返回 false 而不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rtk-slim-log-'))
  const path = join(dir, 'nested', 'a.log')
  assert.equal(logStartup('first', path), true)
  assert.equal(logStartup('second', path), true)
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('first'))
  assert.ok(lines[1].includes('second'))
  // 父路径是文件时必须静默失败（绝不因为日志拖垮插件加载）
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  assert.equal(logStartup('nope', join(blocker, 'a.log')), false)
})

test('apply()：挂载即写下启动行（含生效配置）；enabled:false 也留痕但不注册监听器', () => {
  withTempHome((home) => {
    const listeners = []
    const live = {
      on: (event, listener) => listeners.push({ event, listener }),
      logger: { warn: () => {} },
      get: () => undefined,
    }
    apply(live, {})
    assert.equal(listeners.length, 1)
    assert.equal(listeners[0].event, 'tools/post-execute')

    const logPath = join(home, 'logs', 'dsh-rtk-slim.log')
    const first = readFileSync(logPath, 'utf8')
    assert.ok(first.includes('mounted'))
    assert.ok(first.includes('command=rtk'))
    assert.ok(first.includes('minBytes=2048'))
    assert.ok(first.includes('tools=bash,job_output'))

    const inert = {
      on: () => {
        throw new Error('enabled:false 时不得注册监听器')
      },
      logger: { warn: () => {} },
      get: () => undefined,
    }
    apply(inert, { enabled: false })
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.ok(lines[1].includes('enabled=false'))
  })
})
