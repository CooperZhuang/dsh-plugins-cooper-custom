/**
 * Resolve a checkout's `origin` remote by reading its git files.
 *
 * Project memory is keyed by the project *name* ({@link projectSlug}), so two
 * unrelated repositories that share a basename share one memory directory. The
 * remote URL is an identity both machines agree on and a basename cannot forge,
 * so it is recorded beside every project and used to notice a collision.
 *
 * Everything here is a plain file read: spawning `git` for every descriptor
 * write would cost a process per memory write and would fail wherever git is
 * not installed. Both a normal `.git` directory and a worktree's `.git` file are
 * understood, including the `commondir` indirection a worktree uses to keep one
 * shared config.
 *
 * @module dsh-memories/git-origin
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/** URL schemes whose normalized form is a comparable repository identity. */
const URL_SCHEMES = new Set(['http', 'https', 'ssh', 'git', 'git+ssh'])

/** Trailing `.git` suffix, which every transport spells the same way. */
const DOT_GIT = /\.git$/iu

/** Read a UTF-8 file, or `undefined` when it cannot be read at all. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Whether one path is a directory (a missing or unreadable path is not). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Normalize one remote URL into `<host>/<owner>/<repo>`.
 *
 * Two machines that cloned the same repository with different transports must
 * agree here, or the origin adds no identity at all: `git@host:o/r.git`,
 * `ssh://git@host/o/r.git` and `https://token@host/o/r` are one repository.
 * Credentials, scheme, host case, a trailing slash and the `.git` suffix are
 * therefore dropped; the owner/repo path keeps its case because forges (and
 * self-hosted servers) treat paths case-sensitively.
 *
 * @param value - a `url` value from a git config, or anything else.
 * @returns the normalized origin, or `undefined` when it names no repository.
 */
export function normalizeGitUrl(value: string): string | undefined {
  const text = value.trim().replace(/[?#].*$/u, '')
  if (text.length === 0) return undefined
  let host: string
  let path: string
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(text)
  if (scheme !== null) {
    if (!URL_SCHEMES.has((scheme[1] ?? '').toLowerCase())) return undefined
    const rest = text.slice(scheme[0].length)
    const slash = rest.indexOf('/')
    const authority = slash < 0 ? rest : rest.slice(0, slash)
    // User and password are credentials, not identity: take what follows the
    // last `@` so a password containing one cannot break the split.
    host = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase()
    path = slash < 0 ? '' : rest.slice(slash + 1)
  } else {
    // scp-like syntax `[user@]host:path`, which git treats exactly like ssh.
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.*)$/u.exec(text)
    if (scp === null) return undefined
    const rawHost = scp[1] ?? ''
    const rawPath = scp[2] ?? ''
    // `C:\repo` also matches the scp shape, but a drive letter names a local
    // path, not a remote. A remote path never contains whitespace.
    if (/^[A-Za-z]$/u.test(rawHost) && /^[\\/]/u.test(rawPath)) return undefined
    if (/\s/u.test(rawPath)) return undefined
    host = rawHost.toLowerCase()
    path = rawPath
  }
  const trimmedPath = path
    .replace(/^\/+/u, '')
    .replace(/\/+$/u, '')
    .replace(DOT_GIT, '')
    .replace(/\/+$/u, '')
  if (host.length === 0 || trimmedPath.length === 0) return undefined
  return `${host}/${trimmedPath}`
}

/** One config section header: `[name]` or `[name "subsection"]`. */
interface ConfigSection {
  readonly name: string
  readonly subsection?: string
}

/**
 * Parse the inside of one config section header.
 * @param header - text between the brackets.
 * @returns the section, or `undefined` for a header git itself would reject.
 */
function sectionOf(header: string): ConfigSection | undefined {
  const quoted = /^([A-Za-z0-9.-]+)\s+"([^"]*)"$/u.exec(header)
  if (quoted !== null) {
    return { name: (quoted[1] ?? '').toLowerCase(), subsection: quoted[2] ?? '' }
  }
  // The pre-1.5 spelling `[remote.origin]`; git still reads it.
  const dotted = /^([A-Za-z0-9-]+)\.(.+)$/u.exec(header)
  if (dotted !== null) {
    return { name: (dotted[1] ?? '').toLowerCase(), subsection: dotted[2] ?? '' }
  }
  if (/^[A-Za-z0-9.-]+$/u.test(header)) return { name: header.toLowerCase() }
  return undefined
}

/**
 * Read one config value: strip a comment, unquote a quoted scalar.
 * @param raw - text after the `=`.
 * @returns the value git would read.
 */
function configValue(raw: string): string {
  const trimmed = raw.trim()
  const quoted = /^"((?:[^"\\]|\\.)*)"/u.exec(trimmed)
  if (quoted !== null) return (quoted[1] ?? '').replace(/\\(["\\])/gu, '$1')
  return trimmed.replace(/\s[#;].*$/u, '').trim()
}

/**
 * Find the `url` of the `[remote "origin"]` section in one config file.
 * @param config - the config file's text.
 * @returns the raw url, or `undefined` when the section or key is absent.
 */
function originUrlOf(config: string): string | undefined {
  let section: ConfigSection | undefined
  let url: string | undefined
  for (const raw of config.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[(.+)\]$/u.exec(line)
    if (header !== null) {
      section = sectionOf(header[1] ?? '')
      continue
    }
    if (section === undefined || section.name !== 'remote') continue
    if ((section.subsection ?? '').toLowerCase() !== 'origin') continue
    const separator = line.indexOf('=')
    if (separator < 0) continue
    if (line.slice(0, separator).trim().toLowerCase() !== 'url') continue
    const value = configValue(line.slice(separator + 1))
    // A remote may carry several urls; the first is the one it fetches from.
    if (value.length > 0 && url === undefined) url = value
  }
  return url
}

/**
 * Read the config that owns one git directory, following a worktree's
 * `commondir` indirection first.
 *
 * A linked worktree's `.git` file points at `.git/worktrees/<name>`, and that
 * directory has no `config` of its own: a `commondir` file names the real git
 * directory (normally `../..`) whose config every worktree shares. A submodule
 * keeps its config in the gitdir itself, with no `commondir`, so that is the
 * fallback.
 *
 * @param gitDir - resolved git directory of the checkout.
 * @returns the config text, or `undefined` when neither location has one.
 */
async function readConfig(gitDir: string): Promise<string | undefined> {
  const common = (await readText(join(gitDir, 'commondir')))?.trim()
  if (common !== undefined && common.length > 0) {
    const dir = isAbsolute(common) ? common : resolve(gitDir, common)
    const text = await readText(join(dir, 'config'))
    if (text !== undefined) return text
  }
  return readText(join(gitDir, 'config'))
}

/**
 * Resolve the git directory a worktree's `.git` file points at.
 * @param marker - path of the `.git` file.
 * @param root - checkout root, which relative gitdir paths resolve against.
 * @returns the absolute git directory, or `undefined` when the file is not one.
 */
async function gitDirOfFile(marker: string, root: string): Promise<string | undefined> {
  const text = await readText(marker)
  if (text === undefined) return undefined
  const first = text.split(/\r?\n/u).find((line) => line.trim().length > 0)
  if (first === undefined) return undefined
  const match = /^gitdir:\s*(.+)$/u.exec(first.trim())
  if (match === null) return undefined
  const target = (match[1] ?? '').trim()
  if (target.length === 0) return undefined
  return isAbsolute(target) ? target : resolve(root, target)
}

/**
 * Read one checkout's `origin` remote as a normalized project origin.
 *
 * @param root - absolute workspace root, which must be a checkout for any
 *   origin to exist.
 * @returns the normalized origin, or `undefined` when the directory is not a
 *   git checkout, has no `origin` remote, or its git files cannot be read.
 */
export async function gitOrigin(root: string): Promise<string | undefined> {
  const base = resolve(root)
  const marker = join(base, '.git')
  const gitDir = await isDirectory(marker) ? marker : await gitDirOfFile(marker, base)
  if (gitDir === undefined) return undefined
  const config = await readConfig(gitDir)
  if (config === undefined) return undefined
  const url = originUrlOf(config)
  return url === undefined ? undefined : normalizeGitUrl(url)
}
