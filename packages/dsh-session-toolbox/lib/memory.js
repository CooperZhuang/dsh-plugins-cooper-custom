/**
 * 项目作用域记忆的「随会话走」支持（**可选，默认关**）。
 *
 * 背景：`dsh-memories` 的项目作用域是**工作区级**的 —— 存到
 * `$DSH_HOME/memories/projects/<slug>/entries/<id>.md`，slug 由工作区根目录派生
 * （`slugify(basename)` + `sha1(resolve(root)).slice(0,8)`，见其 storage.js）。
 * 所以搬会话**不需要**搬记忆：会话换了 cwd，作用域自然跟到目标工作区。
 * 但"这条会话在源工作区下写下的条目"留在源工作区，如果这次搬迁属于**纠正错放**
 * （会话本来就该在目标工作区），那些条目也该一起过去。本模块只负责这一件事。
 *
 * 两条设计原则：
 *   1. **默认不做**。项目记忆是工作区共享的，把单条会话的条目拖过去会改变另一个
 *      工作区的记忆视图——这种事必须显式开启（`memoryFollow: 'copy' | 'move'`）。
 *   2. **文件级、可逆、可预演**。`dsh-memories` 的存储契约写明「条目文件才是真相源，
 *      索引是可重建的缓存，手改/删除索引会在下次读取时自愈」，所以复制 `.md` 文件
 *      就是受支持的写入方式，也不必依赖它的运行时。
 *
 * @module dsh-session-move/memory
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'

/** 与 dsh-memories/lib/storage.js 的 slugify 逐字一致。 */
export function slugify(value) {
  const slug = String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
  return slug.length > 0 ? slug : 'memory'
}

/** 与 dsh-memories/lib/storage.js 的 projectSlug 逐字一致。 */
export function projectSlug(root) {
  const name = slugify(resolve(root).replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? 'workspace')
  const digest = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 8)
  return `${name}-${digest}`
}

/** `$DSH_HOME/memories/projects`。 */
export function projectsDirOf(dshHome) {
  return join(dshHome, 'memories', 'projects')
}

/** Windows 上路径比较不区分大小写（其余平台按字面比较）。 */
function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 在 projects 目录里按 root 找已存在的项目（优先命中已有 slug，避免算出第二个目录）。
 * @param projectsDir - `…/memories/projects`。
 * @param root - 工作区根目录。
 * @returns `{slug, root, descriptorFile, dir}`，没有时 `undefined`。
 */
export function findProjectByRoot(projectsDir, root) {
  let entries
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const descriptorFile = join(projectsDir, entry.name, 'project.json')
    if (!existsSync(descriptorFile)) continue
    try {
      const descriptor = JSON.parse(readFileSync(descriptorFile, 'utf8'))
      if (typeof descriptor?.root === 'string' && samePath(descriptor.root, root)) {
        return { slug: entry.name, root: descriptor.root, descriptorFile, dir: join(projectsDir, entry.name) }
      }
    } catch {
      /* 坏的 project.json 跳过 */
    }
  }
  return undefined
}

/** 极简 frontmatter 解析：只认 `key: value` 单行（dsh-memories 的条目就是这种形状）。 */
export function parseFrontmatter(text) {
  const out = {}
  if (!text.startsWith('---')) return out
  const end = text.indexOf('\n---', 3)
  const head = end === -1 ? text.slice(3) : text.slice(3, end)
  for (const line of head.split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key.length === 0) continue
    out[key] = line.slice(at + 1).trim().replace(/^"(.*)"$/u, '$1')
  }
  return out
}

/**
 * 计算一次「记忆随会话走」的计划。**只读**。
 *
 * @param options - `{dshHome, sessionId, fromCwd, toCwd}`。
 * @returns 计划：源/目标项目、匹配到的条目（按 frontmatter 的 `session:` 归属过滤）。
 */
export function planMemoryFollow(options) {
  const { dshHome, sessionId, fromCwd, toCwd } = options
  const projectsDir = projectsDirOf(dshHome)
  const source = findProjectByRoot(projectsDir, fromCwd)
  const targetFound = findProjectByRoot(projectsDir, toCwd)
  const target = targetFound ?? {
    slug: projectSlug(toCwd),
    root: resolve(toCwd),
    descriptorFile: join(projectsDir, projectSlug(toCwd), 'project.json'),
    dir: join(projectsDir, projectSlug(toCwd)),
    planned: true,
  }
  const plan = {
    projectsDir,
    source: source === undefined ? null : { slug: source.slug, root: source.root, dir: source.dir },
    target: { slug: target.slug, root: target.root, dir: target.dir, descriptorFile: target.descriptorFile, existed: targetFound !== undefined },
    sessionId,
    totalInSource: 0,
    matched: [],
  }
  if (source === undefined) return plan
  const entriesDir = join(source.dir, 'entries')
  let files
  try {
    files = readdirSync(entriesDir)
  } catch {
    return plan
  }
  const wanted = String(sessionId).replace(/^session-/u, '')
  for (const name of files) {
    if (!name.endsWith('.md')) continue
    const file = join(entriesDir, name)
    let front
    try {
      front = parseFrontmatter(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    plan.totalInSource += 1
    const owner = typeof front.session === 'string' ? front.session.replace(/^session-/u, '') : undefined
    if (owner !== wanted) continue
    const targetFile = join(target.dir, 'entries', name)
    plan.matched.push({
      id: front.id ?? name.replace(/\.md$/u, ''),
      title: front.title ?? '',
      sourceFile: file,
      targetFile,
      existsInTarget: existsSync(targetFile),
    })
  }
  return plan
}

/** 建立目标项目目录（含 project.json 与 entries/）。 */
function ensureProject(target) {
  mkdirSync(join(target.dir, 'entries'), { recursive: true })
  if (!existsSync(target.descriptorFile)) {
    writeFileSync(target.descriptorFile, `${JSON.stringify({
      root: target.root,
      name: basename(target.root),
      slug: target.slug,
      updatedAt: Date.now(),
    }, null, 2)}\n`)
  }
}

/**
 * 执行计划。`copy` 只加不删；`move` 复制后从源项目移除（= 纠正错放）。
 * 目标已有同名条目时跳过（不覆盖、按名去重）。
 *
 * @param plan - {@link planMemoryFollow} 的返回值。
 * @param mode - `'copy'` 或 `'move'`。
 * @returns `{mode, copied, skipped, removed, files}`。
 */
export function applyMemoryFollow(plan, mode) {
  const outcome = { mode, copied: 0, skipped: 0, removed: 0, files: [] }
  if (plan.source === null || plan.matched.length === 0) return outcome
  ensureProject(plan.target)
  for (const entry of plan.matched) {
    if (entry.existsInTarget) {
      outcome.skipped += 1
      continue
    }
    copyFileSync(entry.sourceFile, entry.targetFile)
    outcome.copied += 1
    outcome.files.push(entry.id)
    if (mode === 'move') {
      try {
        unlinkSync(entry.sourceFile)
        outcome.removed += 1
      } catch (error) {
        outcome.removeError = String(error?.message ?? error)
      }
    }
  }
  return outcome
}
