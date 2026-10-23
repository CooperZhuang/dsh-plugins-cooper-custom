/**
 * The prefilter must never lose a memory the full scan would have recalled.
 *
 * That is the whole contract: the index may make recall cheaper, it may return a
 * superset of candidates, but the set of entries that pass `matchCredit` has to
 * be identical to what an unfiltered scan finds. The property is checked directly
 * here rather than inferred from the eval probes, because the eval only covers
 * ten hand-picked queries and this is a correctness boundary.
 *
 * @module dsh-memories/test/prefilter
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { matchCredit, prefilterEntries, termIndex } from '../search.js'
import type { MemoryEntry } from '../types.js'

const base = {
  id: 'x',
  scope: 'global' as const,
  kind: 'fact' as const,
  tags: [] as string[],
  keys: [] as string[],
  uses: 0,
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: 0,
  lastSurfacedAt: 0,
  source: 'auto' as const,
}

const entries: MemoryEntry[] = [
  { ...base, id: 'a', title: '合并任务需要会话 idle 才会跑', body: '抽取收尾触发 consolidateIfDue。', appliesTo: '排查合并不跑的时候' },
  { ...base, id: 'b', title: '桌宠气泡需要 surface 参数', body: '不传 surface 会回 bad-request。', tags: ['dsh-pet'] },
  { ...base, id: 'c', title: 'Python 项目一律用 uv', body: '不用 pyenv 或 conda。', tags: ['python'] },
  { ...base, id: 'd', title: '重启 DSH 必须 quit 进程', body: '关窗口不算重启，pgrep 确认。', keys: ['restart'] },
  { ...base, id: 'e', title: '花枝招展杯看板发布流程', body: '构建后推到 gh-pages。', tags: ['hzb-cup'] },
  { ...base, id: 'f', title: '日志轮转脚本', body: 'logging 目录按天切分。', tags: ['logging'] },
  { ...base, id: 'g', title: '邮箱签名用顺颂商祺', body: '对外邮件结尾。', tags: ['mail'] },
  { ...base, id: 'h', title: '内存数据库用 WAL', body: 'state.db 开启 WAL 模式。', tags: ['sqlite'] },
  { ...base, id: 'i', title: '合并策略：保留更新的那条', body: '冲突时看 updatedAt。', tags: ['merge'] },
  { ...base, id: 'j', title: '桌宠配置在 main-config.jsonc', body: 'whisperPrompt 是替换语义。', tags: ['dsh-pet'] },
  { ...base, id: 'k', title: 'uv 安装后不必再建 venv', body: 'uv sync 即可。', tags: ['python', 'uv'] },
  { ...base, id: 'l', title: 'pgrep 用来确认进程真的退了', body: 'osascript quit 之后检查。', tags: ['mac'] },
  { ...base, id: 'm', title: 'bad-request 要看 message', body: 'surface 必填藏在失败分支。', tags: ['dsh-pet'] },
]

test('the index is a superset of every entry the full scan accepts', () => {
  const queries = [
    '重启后会话为什么没加载',
    '桌宠气泡不回话 bad-request',
    'python 环境用 uv 还是 pyenv',
    '合并任务不跑',
    'logging 按天切分',
    '顺颂商祺 邮件结尾',
    'WAL 模式',
    '单字：退',
  ]
  for (const query of queries) {
    const accepted = entries.filter((entry) => matchCredit(entry, query, 9, 2).about)
    const candidates = new Set(prefilterEntries(entries, query).map((entry) => entry.id))
    for (const entry of accepted) {
      assert.ok(candidates.has(entry.id), `prefilter lost "${entry.id}" for query "${query}"`)
    }
  }
})

test('a narrow candidate set falls back to the full scan instead of guessing', () => {
  // Two entries share one rare bigram; the floor is higher than that, so the
  // prefilter must decline to narrow at all.
  const narrowed = prefilterEntries(entries, '顺颂商祺')
  assert.equal(narrowed.length, entries.length, 'below the floor the full list is returned')
})

test('the index maps terms to every entry that contains them', () => {
  const index = termIndex(entries)
  const python = index.get('python') ?? []
  const ids = python.map((at) => entries[at]?.id)
  assert.deepEqual(ids.sort(), ['c', 'k'])
})
