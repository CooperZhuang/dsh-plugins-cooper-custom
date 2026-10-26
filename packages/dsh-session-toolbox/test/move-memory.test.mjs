/**
 * 记忆平面单测：slug 派生必须与 dsh-memories 逐字一致（用本机真实 project.json 向量），
 * 计划/执行只在临时目录里做，不碰真实记忆库。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMemoryFollow, findProjectByRoot, parseFrontmatter, planMemoryFollow, projectSlug, slugify } from '../lib/memory.js'

test('slugify 与 dsh-memories 规则一致', () => {
  assert.equal(slugify('Acme_Invoice-Insight'), 'acme-invoice-insight')
  assert.equal(slugify(".dsh"), 'dsh')
  assert.equal(slugify('Assassin\'s Creed Black Flag Resynced'), 'assassin-s-creed-black-flag-resynced')
  assert.equal(slugify('示例-对人工智能系统进行分类'), '示例-对人工智能系统进行分类')
  assert.equal(slugify('   '), 'memory')
})

test('projectSlug 复现 dsh-memories 的目录名规则', () => {
  // 向量与 dsh-memories 的派生规则逐字对齐（项目/客户名一律用占位，脱敏自真机向量）
  const vectors = [
    ['C:\\Users\\Cooper\\.dsh', 'dsh-08b16270'],
    ['C:\\CodeRepository\\Acme_Invoice-Insight', 'acme-invoice-insight-55e25e4d'],
    ['C:\\CodeRepository\\Acme_Document-Recognition-Service', 'acme-document-recognition-service-979b7374'],
    ['C:\\CodeRepository\\PP-OCRv6', 'pp-ocrv6-3f2dd5b6'],
    ['C:\\CodeRepository\\Acme_RPA-Posting-Pipeline', 'acme-rpa-posting-pipeline-250a630d'],
    ['C:\\CodeRepository\\dsh-memories', 'dsh-memories-714ebfcf'],
    ['C:\\Program Files (x86)\\Steam\\steamapps\\common\\Assassin\'s Creed Black Flag Resynced', 'assassin-s-creed-black-flag-resynced-ef0ed6e3'],
  ]
  for (const [root, expected] of vectors) assert.equal(projectSlug(root), expected, root)
})

test('parseFrontmatter 只吃单行 key: value', () => {
  const front = parseFrontmatter('---\nid: a-b\nscope: project\nsession: session-x\ntitle: 带 冒号: 的标题\n---\nbody\n')
  assert.equal(front.id, 'a-b')
  assert.equal(front.scope, 'project')
  assert.equal(front.session, 'session-x')
  assert.equal(front.title, '带 冒号: 的标题')
  assert.deepEqual(parseFrontmatter('no frontmatter'), {})
})

/** 造一个临时 $DSH_HOME，带两个项目的记忆目录。 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-move-mem-'))
  const projects = join(home, 'memories', 'projects')
  const sourceRoot = join(home, 'ws-from')
  const targetRoot = join(home, 'ws-to')
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(targetRoot, { recursive: true })
  const sourceSlug = projectSlug(sourceRoot)
  const sourceDir = join(projects, sourceSlug)
  mkdirSync(join(sourceDir, 'entries'), { recursive: true })
  writeFileSync(join(sourceDir, 'project.json'), JSON.stringify({ root: sourceRoot, name: 'ws-from', slug: sourceSlug, updatedAt: 1 }))
  const entry = (id, session) => `---\nid: ${id}\nscope: project\nkind: fact\ntitle: ${id} 标题\nsession: ${session}\n---\n正文\n`
  writeFileSync(join(sourceDir, 'entries', 'mine.md'), entry('mine', 'session-target-1'))
  writeFileSync(join(sourceDir, 'entries', 'other.md'), entry('other', 'session-someone-else'))
  writeFileSync(join(sourceDir, 'entries', 'anonymous.md'), '---\nid: anonymous\nscope: project\nkind: fact\ntitle: 无归属\n---\n正文\n')
  return { home, projects, sourceRoot, targetRoot, sourceSlug, sourceDir }
}

test('planMemoryFollow 只挑出该会话的条目', () => {
  const f = fixture()
  try {
    const plan = planMemoryFollow({ dshHome: f.home, sessionId: 'session-target-1', fromCwd: f.sourceRoot, toCwd: f.targetRoot })
    assert.equal(plan.source.slug, f.sourceSlug)
    assert.equal(plan.target.existed, false)
    assert.equal(plan.target.slug, projectSlug(f.targetRoot))
    assert.equal(plan.totalInSource, 3)
    assert.deepEqual(plan.matched.map((entry) => entry.id), ['mine'])
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('applyMemoryFollow copy 建目标项目并只复制匹配条目', () => {
  const f = fixture()
  try {
    const plan = planMemoryFollow({ dshHome: f.home, sessionId: 'target-1', fromCwd: f.sourceRoot, toCwd: f.targetRoot })
    assert.equal(plan.matched.length, 1)
    const outcome = applyMemoryFollow(plan, 'copy')
    assert.equal(outcome.copied, 1)
    assert.equal(outcome.removed, 0)
    const targetDir = join(f.projects, projectSlug(f.targetRoot))
    assert.equal(existsSync(join(targetDir, 'project.json')), true)
    assert.equal(existsSync(join(targetDir, 'entries', 'mine.md')), true)
    assert.equal(existsSync(join(targetDir, 'entries', 'other.md')), false)
    // copy 不动源。
    assert.equal(existsSync(join(f.sourceDir, 'entries', 'mine.md')), true)
    // 目标 project.json 形状与 dsh-memories 一致。
    const descriptor = JSON.parse(readFileSync(join(targetDir, 'project.json'), 'utf8'))
    assert.equal(descriptor.slug, projectSlug(f.targetRoot))
    assert.equal(typeof descriptor.root, 'string')
    assert.equal(typeof descriptor.updatedAt, 'number')
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('applyMemoryFollow move 复制后从源移除；目标已存在则跳过', () => {
  const f = fixture()
  try {
    const first = planMemoryFollow({ dshHome: f.home, sessionId: 'target-1', fromCwd: f.sourceRoot, toCwd: f.targetRoot })
    applyMemoryFollow(first, 'copy')
    // 第二次：目标已经有同名条目 → 跳过。
    const second = planMemoryFollow({ dshHome: f.home, sessionId: 'target-1', fromCwd: f.sourceRoot, toCwd: f.targetRoot })
    assert.equal(second.target.existed, true)
    assert.equal(second.matched[0].existsInTarget, true)
    const skipped = applyMemoryFollow(second, 'copy')
    assert.equal(skipped.copied, 0)
    assert.equal(skipped.skipped, 1)
    // move 模式：源条目被移走。
    const third = planMemoryFollow({ dshHome: f.home, sessionId: 'target-1', fromCwd: f.sourceRoot, toCwd: f.targetRoot })
    const moved = applyMemoryFollow(third, 'move')
    assert.equal(moved.skipped, 1)
    assert.equal(moved.copied, 0)
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('findProjectByRoot 命中已有 slug，避免算第二个目录', () => {
  const f = fixture()
  try {
    const found = findProjectByRoot(f.projects, f.sourceRoot)
    assert.equal(found.slug, f.sourceSlug)
    // 大小写不同的同一路径也算命中（Windows）。
    const again = findProjectByRoot(f.projects, f.sourceRoot.toUpperCase())
    if (process.platform === 'win32') assert.equal(again?.slug, f.sourceSlug)
    assert.equal(findProjectByRoot(f.projects, join(f.home, 'nope')), undefined)
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})
