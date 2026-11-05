/**
 * Unit tests for git-origin and for the origin fields storage records.
 *
 * @module dsh-cross-memory/test/git-origin.test
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gitOrigin, normalizeGitUrl } from '../git-origin.js'
import { MemoryStore, projectSlug } from '../storage.js'

/** Write a git config holding one `origin` url into `<dir>`. */
async function writeConfig(dir: string, url: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "origin"]',
    `\turl = ${url}`,
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '',
  ].join('\n'), 'utf8')
}

/** Write the descriptor files one project slug has on disk. */
async function writeProjectFiles(
  memories: string,
  slug: string,
  projectOrigin: string | undefined,
  hosts: readonly { file: string; origin?: string }[],
): Promise<void> {
  const dir = join(memories, 'projects', slug)
  await mkdir(join(dir, 'hosts'), { recursive: true })
  await writeFile(join(dir, 'project.json'), JSON.stringify({
    root: join('/checkouts', slug),
    name: slug,
    slug,
    updatedAt: 1,
    ...projectOrigin === undefined ? {} : { origin: projectOrigin },
  }))
  for (const host of hosts) {
    await writeFile(join(dir, 'hosts', `${host.file}.json`), JSON.stringify({
      host: host.file,
      platform: 'linux',
      root: join('/checkouts', slug, host.file),
      firstSeen: 1,
      lastSeen: 2,
      ...host.origin === undefined ? {} : { origin: host.origin },
    }))
  }
}

test('normalizeGitUrl folds ssh, https, credentials and suffixes into one origin', () => {
  const expected = 'github.com/owner/repo'
  for (const raw of [
    'git@github.com:owner/repo.git',
    'github.com:owner/repo',
    'ssh://git@github.com/owner/repo.git',
    'ssh://git@github.com/owner/repo',
    'git://github.com/owner/repo.git',
    'http://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://user:secret@github.com/owner/repo.git',
    'https://github.com/owner/repo/',
    'https://github.com/owner/repo.git/',
    'https://GitHub.com/owner/repo.git',
    'https://github.com/owner/repo.git?ref=main#readme',
    '  git@github.com:owner/repo.git  ',
  ]) {
    assert.equal(normalizeGitUrl(raw), expected, raw)
  }
  // Different repositories, and a path's case, stay distinct.
  assert.notEqual(normalizeGitUrl('https://github.com/owner/other.git'), expected)
  assert.notEqual(normalizeGitUrl('https://github.com/Owner/Repo.git'), expected)
  // Credentials are gone, so a token rotation does not look like a new project.
  assert.equal(normalizeGitUrl('https://old-token@git.example.com:8443/team/svc.git'), 'git.example.com:8443/team/svc')
})

test('normalizeGitUrl rejects values that name no repository', () => {
  for (const raw of [
    '',
    '   ',
    'github.com',
    '/Users/you/Code/alpha',
    'C:\\Users\\you\\Code\\alpha',
    'file:///tmp/repo.git',
    'https://github.com',
    'git@github.com:',
    'not a url',
  ]) {
    assert.equal(normalizeGitUrl(raw), undefined, JSON.stringify(raw))
  }
})

test('gitOrigin reads the origin remote from a .git directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-origin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeConfig(join(root, '.git'), 'git@github.com:owner/repo.git')
  assert.equal(await gitOrigin(root), 'github.com/owner/repo')
})

test('gitOrigin follows a worktree .git file to the shared config through commondir', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-worktree-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const main = join(base, 'repo')
  const worktree = join(base, 'repo-branch')
  await writeConfig(join(main, '.git'), 'https://user:token@git.example.com/team/service.git')
  // The linked worktree's gitdir has no config of its own: `commondir` points
  // back at the main repository's `.git`, which holds the shared config.
  const linked = join(main, '.git', 'worktrees', 'branch')
  await mkdir(linked, { recursive: true })
  await writeFile(join(linked, 'commondir'), '../..\n', 'utf8')
  await mkdir(worktree, { recursive: true })
  await writeFile(join(worktree, '.git'), `gitdir: ${join('..', 'repo', '.git', 'worktrees', 'branch')}\n`, 'utf8')
  assert.equal(await gitOrigin(worktree), 'git.example.com/team/service')
})

test('gitOrigin falls back to the gitdir config when no commondir exists', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-submodule-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'sub')
  const gitDir = join(base, 'modules', 'sub')
  await writeConfig(gitDir, 'ssh://git@gitlab.example.com/group/sub.git')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, '.git'), `gitdir: ${gitDir}\n`, 'utf8')
  assert.equal(await gitOrigin(root), 'gitlab.example.com/group/sub')
})

test('gitOrigin returns undefined for a directory that is not a checkout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-plain-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await gitOrigin(root), undefined)
  // A `.git` file without the gitdir directive is not a checkout either.
  await writeFile(join(root, '.git'), 'not a gitdir\n', 'utf8')
  assert.equal(await gitOrigin(root), undefined)
})

test('a checkout without an origin remote has no project origin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-no-remote-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8')
  assert.equal(await gitOrigin(root), undefined)
})

test('writeProjectDescriptor records the checkout origin and omits it for a plain directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-origin-project-'))
  const plain = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-origin-plain-'))
  const memories = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-origin-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(plain, { recursive: true, force: true }))
  t.after(() => rm(memories, { recursive: true, force: true }))
  await writeConfig(join(root, '.git'), 'git@github.com:owner/alpha.git')
  const store = new MemoryStore(memories)

  await store.writeProjectDescriptor(root, 1000)
  const slug = projectSlug(root)
  assert.equal((await store.readProjectDescriptor(slug))?.origin, 'github.com/owner/alpha')
  const hosts = await store.listHostDescriptors(slug)
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0]?.origin, 'github.com/owner/alpha')

  // A directory that is not a git checkout records no origin at all, rather
  // than an empty one that a reader could mistake for a known identity.
  await store.writeProjectDescriptor(plain, 1000)
  const descriptor = await store.readProjectDescriptor(projectSlug(plain))
  assert.equal(descriptor?.origin, undefined)
  assert.equal(descriptor !== undefined && 'origin' in descriptor, false)
})

test('projectOrigins merges the descriptor and every host file without duplicates', async (t) => {
  const memories = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-origins-'))
  t.after(() => rm(memories, { recursive: true, force: true }))
  await writeProjectFiles(memories, 'alpha', 'github.com/owner/alpha', [
    { file: 'pc', origin: 'github.com/owner/alpha' },
    { file: 'mac', origin: 'github.com/other/alpha' },
    // A host file written before origins existed contributes nothing.
    { file: 'legacy' },
  ])
  await writeProjectFiles(memories, 'beta', undefined, [])
  const store = new MemoryStore(memories)

  assert.deepEqual(await store.projectOrigins('alpha'), ['github.com/other/alpha', 'github.com/owner/alpha'])
  assert.deepEqual(await store.projectOrigins('beta'), [])
  assert.deepEqual(await store.projectOrigins('never-written'), [])
})

test('originConflicts reports only a slug shared by two different origins', async (t) => {
  const memories = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-conflicts-'))
  t.after(() => rm(memories, { recursive: true, force: true }))
  await writeProjectFiles(memories, 'shared', 'github.com/owner/shared', [
    { file: 'pc', origin: 'github.com/owner/shared' },
    { file: 'mac', origin: 'github.com/other/shared' },
    { file: 'laptop', origin: 'github.com/other/shared' },
  ])
  // One repository checked out on two machines is the normal case, not a clash.
  await writeProjectFiles(memories, 'single', 'github.com/owner/single', [
    { file: 'pc', origin: 'github.com/owner/single' },
    { file: 'mac', origin: 'github.com/owner/single' },
  ])
  // A directory with no origin at all cannot prove a collision either.
  await writeProjectFiles(memories, 'none', undefined, [{ file: 'pc' }])
  const store = new MemoryStore(memories)

  assert.deepEqual(await store.originConflicts(), [
    { slug: 'shared', origins: ['github.com/other/shared', 'github.com/owner/shared'] },
  ])
})
