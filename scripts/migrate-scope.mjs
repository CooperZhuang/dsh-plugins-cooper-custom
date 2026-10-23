#!/usr/bin/env node
/**
 * One-off, reviewable migration of global memory entries into an existing
 * project scope.
 *
 * The scope split on a real store is not something a classifier should decide:
 * a global memory that cites exactly one workspace is a candidate, but whether
 * it belongs there is a human call. This tool therefore defaults to a dry run,
 * groups candidates for review (--candidates), and only moves files when both
 * --apply and --yes are given, --to names an existing project scope, and a
 * manifest has been written first.
 *
 * What it writes, and only this:
 *   <store>/projects/<slug>/entries/<id>.md     (new file)
 *   <store>/entries/<id>.md                     (removed after the copy)
 *   /tmp/dsh-memories-migrate-<timestamp>.json  (the manifest)
 *
 * It never touches <store>/archive/, <store>/index.json, any project index, or
 * <store>/state.db. The index is a rebuildable cache and is rewritten by the
 * plugin on its next store refresh.
 *
 * Zero dependencies beyond Node builtins. Frontmatter is read with the same
 * simple "key: value" rule the plugin itself uses; no YAML library.
 *
 * @module dsh-memories/scripts/migrate-scope
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const FENCE = '---'
const TOOL = 'scripts/migrate-scope.mjs'
const TOOL_NAME = 'dsh-memories/scope-migration'
const MANIFEST_KIND = 'dsh-memories-scope-migration'
const MANIFEST_PREFIX = 'dsh-memories-migrate'
const VERSION = 1

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function fail(message, code = 2) {
  console.error('error: ' + message)
  process.exit(code)
}

function note(message) {
  console.log(message)
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function shellQuote(value) {
  return "'" + value.replace(/'/gu, "'\\''") + "'"
}

function formatBytes(bytes) {
  return bytes.toLocaleString('en-US') + ' B'
}

function formatDate(epochMs) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '-'
  return new Date(epochMs).toISOString().slice(0, 10)
}

function parseTimestamp(raw) {
  if (raw === undefined) return 0
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u

function charWidth(char) {
  if (/\p{Extended_Pictographic}/u.test(char)) return 2
  return WIDE_CHAR.test(char) ? 2 : 1
}

function displayWidth(value) {
  let width = 0
  for (const char of value) width += charWidth(char)
  return width
}

/** Pad with spaces to a display width (CJK counts as two columns). */
function padDisplay(value, width) {
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)))
}

/** Truncate to a display width, marking the cut with an ellipsis. */
function fitDisplay(value, width) {
  if (width <= 1) return '…'
  if (displayWidth(value) <= width) return padDisplay(value, width)
  let out = ''
  let used = 0
  for (const char of value) {
    const next = used + charWidth(char)
    if (next > width - 1) break
    out += char
    used = next
  }
  return padDisplay(out + '…', width)
}

/** Wrap text to a display width, preferring word breaks for Latin text. */
function wrapDisplay(value, width) {
  const tokens = value.match(/[A-Za-z0-9_@.\/:;%#?=&+\-]+|\s+|./gu) ?? []
  const lines = []
  let line = ''
  let used = 0
  const flush = () => {
    lines.push(line.trimEnd())
    line = ''
    used = 0
  }
  for (const token of tokens) {
    const tokenWidth = displayWidth(token)
    if (used + tokenWidth > width && used > 0) flush()
    if (/^\s+$/u.test(token)) {
      if (used > 0) {
        line += token
        used += tokenWidth
      }
      continue
    }
    if (tokenWidth > width) {
      for (const char of token) {
        const next = used + charWidth(char)
        if (next > width && used > 0) flush()
        line += char
        used += charWidth(char)
      }
      continue
    }
    line += token
    used += tokenWidth
  }
  if (line.length > 0) flush()
  return lines
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const HELP_LINES = [
  "dsh-memories scope migration — move global memories into a project scope",
  "",
  "Usage:",
  "  node " + TOOL + " --match <substring-or-regex> [--to <slug>] [--home <path>]",
  "  node " + TOOL + " --match <substring-or-regex> --to <slug> --apply --yes [--home <path>]",
  "  node " + TOOL + " --candidates [--home <path>]",
  "  node " + TOOL + " --undo <manifest.json> --yes",
  "  node " + TOOL + " --help",
  "",
  "Modes:",
  "  (default)         Dry run. Print every matching global entry (id, title,",
  "                    updated date, uses, file size), the proposed destination,",
  "                    and the summary counts. Writes nothing.",
  "  --candidates      Read-only proposal. Group every global entry by inferred",
  "                    project keyword (mubea / 上汽 / insavlo / 发票 / 微信 /",
  "                    iphone / surge / spotlight / ...), count each group, and",
  "                    show which existing project scopes match. Never writes",
  "                    and never acts on its own.",
  "  --apply           Move the matched entries. Requires --to and --yes, and the",
  "                    destination scope must already exist under",
  "                    <store>/projects/<slug>/. Refuses entries whose id already",
  "                    exists at the destination. Writes a JSON manifest to",
  "                    /tmp/dsh-memories-migrate-<timestamp>.json before touching",
  "                    the store, then copies each entry and removes the global",
  "                    file. Prints a copy-pasteable undo line per moved entry.",
  "  --undo            Restore a previous --apply from its manifest: puts the",
  "                    original file text back under <store>/entries/ and removes",
  "                    the project copy. Requires --yes.",
  "",
  "Flags:",
  "  --match <text>    Substring or regular expression matched (case-insensitively)",
  "                    against title, tags, keys, and body. Plain text is a",
  "                    substring; text containing regex metacharacters, or wrapped",
  "                    as /pattern/flags, is compiled as a regex. Body-only",
  "                    mentions count here; only --candidates requires the keyword",
  "                    to appear in title/tags/keys.",
  "  --to <slug>       Destination project scope directory name under",
  "                    <store>/projects/. Required with --apply; the directory must",
  "                    already exist (creating a new scope is a separate decision).",
  "                    In a dry run it is optional and only displayed/validated.",
  "  --candidates      Print the keyword-grouped, read-only proposal (see Modes).",
  "  --apply           Perform the move. Refuses to run without --yes.",
  "  --yes             Second confirmation flag for --apply and --undo.",
  "  --home <path>     DSH home (default $DSH_HOME or ~/.dsh); the store is",
  "                    <home>/memories. If <path> is itself a memory store (it has",
  "                    entries/), it is used directly.",
  "  --undo <file>     Manifest written by a previous --apply.",
  "  --help, -h        This help.",
  "",
  "Matching:",
  "  Substring (default):    --match surge",
  "  Regex (metacharacters): --match 'mubea|慕贝尔'",
  "  Explicit regex form:    --match '/iphone|\\bwda\\b/i'",
  "",
  "Examples:",
  "  # Review candidates grouped by inferred project; nothing is written.",
  "  node " + TOOL + " --candidates",
  "",
  "  # Dry run: what would move into an existing scope.",
  "  node " + TOOL + " --match 'surge' --to surge-helper-fix-4b1da1ff",
  "",
  "  # Apply (two flags + existing destination scope).",
  "  node " + TOOL + " --match 'quyundong|趣运动' --to quyundong-probe-7ae0a538 --apply --yes",
  "",
  "  # Undo a previous apply from its manifest.",
  "  node " + TOOL + " --undo /tmp/dsh-memories-migrate-2026-10-23T04-00-00-000Z.json --yes",
  "",
  "Safety:",
  "  --apply is the only mode that changes the store. It never overwrites an",
  "  existing destination id, never creates a project scope, never removes a global",
  "  file before its destination copy is durable, and never touches archive/,",
  "  index.json, any project index, or state.db. The on-disk index is a rebuildable",
  "  cache; the plugin rewrites it at the next store refresh, so a running plugin",
  "  keeps serving the pre-move view until then.",
]
const HELP = HELP_LINES.join('\n') + '\n'

function parseArguments(argv) {
  const options = {
    match: undefined,
    to: undefined,
    home: undefined,
    undo: undefined,
    apply: false,
    yes: false,
    candidates: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (!argument.startsWith('-')) fail('unexpected argument "' + argument + '" (see --help)')
    const equals = argument.indexOf('=')
    const flag = equals >= 0 ? argument.slice(0, equals) : argument
    const inline = equals >= 0 ? argument.slice(equals + 1) : undefined
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) fail('missing value for ' + flag)
      index += 1
      return next
    }
    switch (flag) {
      case '--match':
        options.match = value()
        break
      case '--to':
        options.to = value()
        break
      case '--home':
        options.home = value()
        break
      case '--undo':
        options.undo = value()
        break
      case '--apply':
        options.apply = true
        break
      case '--yes':
        options.yes = true
        break
      case '--candidates':
        options.candidates = true
        break
      default:
        fail('unknown flag ' + flag + ' (see --help)')
    }
  }
  validateArguments(options)
  return options
}

function validateArguments(options) {
  if (options.help) return
  if (options.undo !== undefined) {
    if (options.apply || options.candidates || options.match !== undefined || options.to !== undefined) {
      fail('--undo cannot be combined with --apply, --candidates, --match, or --to')
    }
    if (!options.yes) fail('--undo rewrites files and needs --yes as confirmation')
    return
  }
  if (options.candidates) {
    if (options.apply) fail('--candidates is read-only and cannot be combined with --apply')
    if (options.match !== undefined) fail('--candidates and --match are separate modes; pick one')
    if (options.to !== undefined) fail('--to has no effect in --candidates mode')
    if (options.yes) fail('--yes has no effect in --candidates mode')
    return
  }
  if (options.match === undefined || options.match.trim() === '') {
    fail('one mode is required: --match <substring-or-regex> or --candidates (see --help)')
  }
  if (options.apply) {
    if (!options.yes) fail('--apply requires --yes as a second confirmation flag')
    if (options.to === undefined || options.to.trim() === '') {
      fail('--apply requires --to <slug>; the destination is never guessed')
    }
  } else if (options.yes) {
    fail('--yes only has meaning with --apply or --undo')
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function resolvePaths(options) {
  const rawHome = options.home !== undefined && options.home.trim() !== ''
    ? options.home
    : (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh'))
  const home = resolve(rawHome)
  if (!existsSync(home)) fail('DSH home does not exist: ' + home)
  const store = isDirectory(join(home, 'entries')) ? home : join(home, 'memories')
  if (!isDirectory(join(store, 'entries'))) {
    fail('not a memory store: ' + store + ' (expected entries/); pass --home <DSH_HOME> or the store directory')
  }
  return { home, store }
}

function isInside(child, parent) {
  const base = resolve(parent)
  const target = resolve(child)
  return target === base || target.startsWith(base + sep)
}

function listProjectScopes(store) {
  const projectsDir = join(store, 'projects')
  if (!isDirectory(projectsDir)) return []
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => {
      const dir = join(projectsDir, dirent.name)
      let descriptor
      try {
        descriptor = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
      } catch {
        descriptor = undefined
      }
      return {
        slug: dirent.name,
        dir,
        name: typeof descriptor?.name === 'string' ? descriptor.name : dirent.name,
        root: typeof descriptor?.root === 'string' ? descriptor.root : '',
      }
    })
    .sort((left, right) => left.slug.localeCompare(right.slug))
}

function describeAvailableScopes(store) {
  const scopes = listProjectScopes(store)
  if (scopes.length === 0) return '  (no project scopes exist; a scope is created by opening a session in a workspace)'
  return scopes
    .map((scope) => '  ' + scope.slug + (scope.root.length > 0 ? '   <- ' + scope.root : ''))
    .join('\n')
}

function requireDestination(store, slug) {
  if (!/^[^/\\\u0000]+$/u.test(slug) || slug === '.' || slug === '..') {
    fail('invalid --to slug "' + slug + '": expected one directory name under projects/')
  }
  if (!isInside(join(store, 'projects', slug), join(store, 'projects'))) {
    fail('invalid --to slug "' + slug + '": resolves outside <store>/projects/')
  }
  const dir = join(store, 'projects', slug)
  if (!isDirectory(dir)) {
    console.error('error: destination scope does not exist: ' + dir)
    console.error('--apply refuses to create a new scope; creating one is a separate decision.')
    console.error('available project scopes (use the exact directory name):')
    console.error(describeAvailableScopes(store))
    process.exit(1)
  }
  return dir
}

// ---------------------------------------------------------------------------
// Frontmatter (no YAML library; the store's own "key: value" format)
// ---------------------------------------------------------------------------

/**
 * Split one entry file into frontmatter fields and body.
 * @param {string} text - raw file content.
 * @returns {{fields: Map<string, string>, body: string, newline: string, bom: string} | undefined}
 */
function splitEntry(text) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const content = bom.length > 0 ? text.slice(1) : text
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/u)
  if (lines[0]?.trim() !== FENCE) return undefined
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === FENCE) {
      close = index
      break
    }
  }
  if (close < 0) return undefined
  const fields = new Map()
  for (const line of lines.slice(1, close)) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
  }
  const body = lines.slice(close + 1).join(newline).replace(/^\n+/u, '').trimEnd()
  return { fields, body, newline, bom }
}

function fieldList(fields, name) {
  return (fields.get(name) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

/**
 * Rewrite only the "scope:" line (or insert one) without re-serializing the
 * frontmatter. Everything else stays byte-identical, which keeps the diff a
 * human has to review down to one line.
 */
function rewriteScopeToProject(text) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const content = bom.length > 0 ? text.slice(1) : text
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/u)
  if (lines[0]?.trim() !== FENCE) throw new Error('entry does not start with a frontmatter fence')
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === FENCE) {
      close = index
      break
    }
  }
  if (close < 0) throw new Error('entry frontmatter is not terminated')
  let scopeIndex = -1
  for (let index = 1; index < close; index += 1) {
    if (/^\s*scope\s*:/iu.test(lines[index])) {
      scopeIndex = index
      break
    }
  }
  if (scopeIndex >= 0) {
    lines[scopeIndex] = 'scope: project'
  } else {
    let insertAt = 1
    for (let index = 1; index < close; index += 1) {
      if (/^\s*id\s*:/iu.test(lines[index])) {
        insertAt = index + 1
        break
      }
    }
    lines.splice(insertAt, 0, 'scope: project')
  }
  return bom + lines.join(newline)
}

/**
 * Read one entry file into the shape the tool needs.
 * @param {string} file - absolute entry path.
 * @returns {object} parsed entry, with an "error" when it is not usable.
 */
function loadEntry(file) {
  const stats = statSync(file)
  const idFromName = basename(file, '.md')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { file, id: idFromName, title: '(unreadable)', error: 'cannot read: ' + error.message, size: stats.size }
  }
  const parts = splitEntry(text)
  if (parts === undefined) {
    return { file, id: idFromName, title: '(unparseable)', error: 'missing or unterminated frontmatter', size: stats.size }
  }
  const title = parts.fields.get('title') ?? ''
  if (title.length === 0) {
    return { file, id: idFromName, title: '(no title)', error: 'frontmatter has no title', size: stats.size }
  }
  return {
    file,
    id: parts.fields.get('id') ?? idFromName,
    idFromName,
    title,
    tags: fieldList(parts.fields, 'tags'),
    keys: fieldList(parts.fields, 'keys'),
    appliesTo: parts.fields.get('appliesto') ?? '',
    scopeField: parts.fields.get('scope') ?? '',
    updatedAt: parseTimestamp(parts.fields.get('updated')),
    createdAt: parseTimestamp(parts.fields.get('created')),
    uses: Number.parseInt(parts.fields.get('uses') ?? '0', 10) || 0,
    body: parts.body,
    text,
    size: stats.size,
    mode: stats.mode & 0o777,
    mtimeMs: stats.mtimeMs,
    atimeMs: stats.atimeMs,
  }
}

function loadGlobalEntries(store) {
  const entriesDir = join(store, 'entries')
  const names = readdirSync(entriesDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.md'))
    .map((dirent) => dirent.name)
    .sort()
  return names.map((name) => loadEntry(join(entriesDir, name)))
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function parseMatcher(spec) {
  if (spec.length > 2 && spec.startsWith('/') && spec.lastIndexOf('/') > 0) {
    const end = spec.lastIndexOf('/')
    const source = spec.slice(1, end)
    const flags = spec.slice(end + 1)
    if (source.length > 0 && /^[a-z]*$/iu.test(flags)) {
      const effective = flags.includes('i') ? flags : flags + 'i'
      try {
        const regex = new RegExp(source, effective)
        return { kind: 'regex', label: '/' + source + '/' + effective, test: (text) => regex.test(text) }
      } catch (error) {
        fail('invalid regular expression ' + spec + ': ' + error.message)
      }
    }
  }
  if (/[\^$|()[\]{}\\*+?]/u.test(spec)) {
    try {
      const regex = new RegExp(spec, 'i')
      return { kind: 'regex', label: '/' + spec + '/i', test: (text) => regex.test(text) }
    } catch (error) {
      fail('invalid regular expression "' + spec + '": ' + error.message + ' (plain text is matched as a substring)')
    }
  }
  const needle = spec.toLowerCase()
  return { kind: 'substring', label: '"' + spec + '"', test: (text) => text.toLowerCase().includes(needle) }
}

function matchesEntry(entry, matcher) {
  if (entry.error !== undefined) return false
  return matcher.test(entry.title)
    || matcher.test(entry.tags.join(' '))
    || matcher.test(entry.keys.join(' '))
    || matcher.test(entry.body)
}

function matchEntries(entries, matcher) {
  return entries.filter((entry) => matchesEntry(entry, matcher))
}

// ---------------------------------------------------------------------------
// Candidate keyword groups (a proposal, not a classifier)
// ---------------------------------------------------------------------------

/**
 * Deterministic keyword groups. Each entry is assigned to at most one group:
 * a hit in title (weight 3), tags/keys (weight 2), or body (weight 1); body-only
 * mentions do not qualify, because a memory that merely cites a project in its
 * body is usually general knowledge. Ties keep rule order (more specific first).
 */
const GROUPS = [
  {
    label: 'mubea / 慕贝尔',
    kind: 'project',
    re: /mubea|慕贝尔/iu,
    note: 'Mubea work spans six scopes (invoice-insight, mailbox, document-recognition, pm-weekly-report, the 慕贝尔 workspace, and the sales-forecast demo); the keyword alone cannot pick one.',
  },
  {
    label: '上汽 / SGM',
    kind: 'project',
    re: /上汽|\bsgm\b/iu,
  },
  {
    label: 'insavlo',
    kind: 'project',
    re: /insavlo/iu,
    note: 'Insavlo is a platform used by several projects (21 project entries sit in Mubea_Document-Recognition-Service); platform knowledge may be genuinely global.',
  },
  {
    label: '发票 / invoice',
    kind: 'project',
    re: /发票|invoice|票据|开票|查验/iu,
    note: 'Invoice work spans four project scopes (invoice-insight, 上汽合同, mailbox, 仁宝); the one global title-level match is a generic working-style note.',
  },
  {
    label: '微信 / wechat',
    kind: 'project',
    re: /微信|wechat/iu,
    note: 'Both global matches are WeChat tweak/UI-automation notes; the wechat-export scope is about exporting chat data, so this is not a clean destination.',
  },
  {
    label: 'iphone / iOS / 镜像',
    kind: 'project',
    re: /iphone|\biph\b|iphone-mirroring|\bios\b|\bwda\b|pymobiledevice|\bhid\b|镜像会话|镜像画面|镜像解锁|镜像连不上|镜像工作时/iu,
    note: 'No existing scope; iphone-control is a global skill and these are mostly skill capability/boundary notes, so a global copy may be right.',
  },
  {
    label: 'surge',
    kind: 'project',
    re: /surge/iu,
    note: 'Only the helper-fix entry is about the surge-helper-fix repo; the speedtest/proxy entries are machine-environment knowledge that belongs global.',
  },
  {
    label: 'health-report',
    kind: 'project',
    re: /health-report|健康报告|healthkit|健康数据/iu,
    note: 'Three global entries mention it, but only the pipeline-location entry is clearly project-specific; the others are iOS export and demo-data caveats.',
  },
  {
    label: 'photosvideoslim / 相册',
    kind: 'project',
    re: /photosvideoslim|相册视频|\bpvs\b|live-photo|zasset|zkind/iu,
    note: 'The pipeline-location entry is clearly scoped; the ZKIND note is PhotosVideoSlim knowledge, but the iCloud swap caveat is broader.',
  },
  {
    label: 'quyundong / 趣运动',
    kind: 'project',
    re: /quyundong|趣运动|抢场|订场/iu,
  },
  {
    label: 'hzb-cup / 花枝招展杯',
    kind: 'project',
    re: /hzb-cup|花枝招展杯/iu,
    note: 'The hzb-cup build lives inside the quyundong-probe workspace (huahuabei-build), so its destination evidence points at that scope.',
  },
  {
    label: 'heybox / 小黑盒',
    kind: 'project',
    re: /heybox|小黑盒/iu,
    note: 'No existing scope; this is a web reverse-engineering project the store has never seen as a workspace.',
  },
  {
    label: '油价看板',
    kind: 'project',
    re: /油价|oil-price|cngold|qt\.gtimg/iu,
    note: 'No existing scope; the oil-price dashboard repo is only mentioned as a repository name.',
  },
  {
    label: '简历 / Linker',
    kind: 'project',
    re: /简历|resume|linker/iu,
    note: 'No existing scope; two of the three entries are resume-writing technique, which may be global on purpose.',
  },
  {
    label: '飞书 / feishu',
    kind: 'project',
    re: /飞书|feishu|cozi/iu,
    note: 'The ai-recognition-service entry belongs to an archived project; the cozi scope only weakly matches.',
  },
  {
    label: 'aliyun-mail / 邮件技能',
    kind: 'platform',
    re: /aliyun-mail|阿里邮箱|阿里企业邮箱|qiye\.aliyun|\bimap\b|\bsmtp\b|outlook|邮件/iu,
    note: 'Skill-level email knowledge, deliberately cross-project; keep global.',
  },
  {
    label: 'dsh-memories 插件',
    kind: 'platform',
    re: /dsh-memories|记忆库|memory store|记忆数据/iu,
    note: 'Plugin-development notes; the plugin repo itself has no project scope.',
  },
  {
    label: 'pc / windows / ssh 运维',
    kind: 'platform',
    re: /\bpc\b|windows|\bssh\b|向日葵|awesun|\bwol\b|唤醒|powercfg|远程|小米11|termux/iu,
    note: 'Machine/remote-access environment knowledge. The only related scope is ssh-22290546 (~/.ssh), which is not a real project.',
  },
  {
    label: 'dsh / 插件 / 内核开发',
    kind: 'platform',
    re: /\bdsh\b|\bdsha\b|插件|plugin|cordis|内核|kernel|mcp|\brea\b/iu,
    note: 'The DSH/plugin-development bucket; keep global.',
  },
  {
    label: 'spotlight',
    kind: 'system',
    re: /spotlight|mdutil|\bmds\b/iu,
    note: 'macOS indexing knowledge, not project-specific despite appearing in the keyword example list.',
  },
  {
    label: 'mac / 系统环境',
    kind: 'system',
    re: /macos|\bmac\b|索引|内存|swap|发热|\bwifi\b|网卡|launchd|edge|屏幕|刷新率|电池|代理/iu,
    note: 'Machine-environment knowledge; keep global.',
  },
  {
    label: '工作方式 / 工具链偏好',
    kind: 'system',
    re: /工作方式|偏好|preference|审阅|写作|风格|需求|客户|确认|emoji|推断|依据|工具链|\buv\b|python|git push|dry-run/iu,
    note: 'Cross-project preferences; keep global.',
  },
]

function groupScore(entry, group) {
  const titleHit = group.re.test(entry.title) ? 3 : 0
  const tagHit = group.re.test(entry.tags.join(' ')) || group.re.test(entry.keys.join(' ')) ? 2 : 0
  const bodyHit = group.re.test(entry.body) ? 1 : 0
  return { titleHit, tagHit, bodyHit, score: titleHit + tagHit + bodyHit }
}

/** Assign one entry to its strongest group; body-only mentions do not qualify. */
function classifyEntry(entry) {
  let best
  for (const group of GROUPS) {
    const { titleHit, tagHit, score } = groupScore(entry, group)
    if (titleHit === 0 && tagHit === 0) continue
    if (best === undefined || score > best.score) best = { group, score }
  }
  return best
}

function loadProjectCatalog(store) {
  return listProjectScopes(store).map((scope) => {
    const entriesDir = join(scope.dir, 'entries')
    const entries = []
    if (isDirectory(entriesDir)) {
      for (const name of readdirSync(entriesDir).filter((entry) => entry.endsWith('.md')).sort()) {
        try {
          const entry = loadEntry(join(entriesDir, name))
          if (entry.error === undefined) entries.push(entry)
        } catch {
          // A file another process is rewriting is skipped, not fatal.
        }
      }
    }
    return { ...scope, entries }
  })
}

/**
 * Which existing project scopes does one keyword group point at?
 * Evidence = project entries whose title/tags/keys (or tag+body) mention the
 * keyword; a slug/name match counts even with no textual evidence.
 */
function groupDestinations(group, catalog) {
  const destinations = []
  for (const scope of catalog) {
    let evidence = 0
    for (const entry of scope.entries) {
      const score = groupScore(entry, group)
      if (score.score >= 3) evidence += 1
    }
    const nameMatch = group.re.test(scope.slug) || group.re.test(scope.name) || group.re.test(scope.root)
    // A slug/name match is enough to name a destination, but textual evidence
    // needs three project entries before it counts: one or two body mentions are
    // usually incidental (health-report entries mention iPhone, for example).
    if (evidence >= 3 || nameMatch) destinations.push({ slug: scope.slug, evidence, nameMatch, root: scope.root })
  }
  destinations.sort((left, right) => right.evidence - left.evidence
    || Number(right.nameMatch) - Number(left.nameMatch)
    || left.slug.localeCompare(right.slug))
  return destinations
}

function formatDestinations(destinations) {
  if (destinations.length === 0) return 'none of the existing project scopes match this keyword'
  const shown = destinations.slice(0, 3).map((destination) => {
    const count = destination.evidence > 0
      ? ' (' + destination.evidence + ' project ' + (destination.evidence === 1 ? 'entry' : 'entries') + ')'
      : ' (slug name match)'
    return destination.slug + count
  })
  const extra = destinations.length - shown.length
  return shown.join(', ') + (extra > 0 ? ', +' + extra + ' more' : '')
}

// ---------------------------------------------------------------------------
// Running-plugin detection and shared reporting
// ---------------------------------------------------------------------------

function findDshProcesses() {
  let output
  try {
    output = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' })
  } catch {
    return []
  }
  const hits = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const args = match[2]
    if (/migrate-scope|dsh-approve|chrome_crashpad_handler|Helper(?: \(Renderer\))?\.app/iu.test(args)) continue
    if (/DSH Desktop(?: Beta)?\.app\/Contents\/MacOS\//u.test(args)
      || /(?:^|\/)(?:dsh|dsh\.exe)(?:\s|$)/u.test(args)
      || /DeepSeek Harness/u.test(args)) {
      hits.push({ pid, args })
    }
  }
  return hits.slice(0, 5)
}

function printRuntimeWarning(applying) {
  const processes = findDshProcesses()
  if (processes.length === 0) {
    note('runtime: no DSH process detected; changes (if any) still take effect at the next store refresh.')
    return
  }
  console.log('WARNING: a DSH process looks active (pid ' + processes.map((process) => process.pid).join(', ') + ').')
  console.log('         The memories plugin may have the store cached and could be writing to it.')
  if (applying) {
    console.log('         Changes take effect at the next store refresh; the on-disk index.json is a')
    console.log('         rebuildable cache and the plugin rescans entries/ then rewrites it.')
  } else {
    console.log('         This mode is read-only and does not touch the store.')
  }
}

// ---------------------------------------------------------------------------
// --candidates
// ---------------------------------------------------------------------------

function commandCandidates(options) {
  const { home, store } = resolvePaths(options)
  const entries = loadGlobalEntries(store)
  const catalog = loadProjectCatalog(store)
  const total = entries.length

  const counts = new Map()
  const classified = new Map()
  let unclassified = 0
  for (const entry of entries) {
    const assignment = classifyEntry(entry)
    if (assignment === undefined) {
      unclassified += 1
      continue
    }
    counts.set(assignment.group.label, (counts.get(assignment.group.label) ?? 0) + 1)
    if (!classified.has(assignment.group.label)) classified.set(assignment.group.label, [])
    classified.get(assignment.group.label).push(entry)
  }

  const projectGroups = GROUPS.filter((group) => group.kind === 'project')
  const withScope = projectGroups.filter((group) => (counts.get(group.label) ?? 0) > 0 && groupDestinations(group, catalog).length > 0)
  const noScope = projectGroups.filter((group) => (counts.get(group.label) ?? 0) > 0 && groupDestinations(group, catalog).length === 0)
  const platformGroups = GROUPS.filter((group) => group.kind === 'platform' && (counts.get(group.label) ?? 0) > 0)
  const systemGroups = GROUPS.filter((group) => group.kind === 'system' && (counts.get(group.label) ?? 0) > 0)

  const width = Math.max(100, Math.min(Number(process.stdout.columns) || 160, 220))
  const labelWidth = Math.min(40, Math.max(...GROUPS.map((group) => displayWidth(group.label))) + 3)

  console.log('dsh-memories scope migration — candidates (read-only)')
  console.log('store: ' + store + '   (home: ' + home + ')')
  console.log('global entries: ' + total)
  console.log('Each entry is assigned to at most one keyword group; title/tags/keys beat body-only mentions.')
  printRuntimeWarning(false)

  const printGroup = (group, showEntries) => {
    const count = counts.get(group.label) ?? 0
    console.log('\n  ' + padDisplay(group.label, labelWidth) + String(count).padStart(4))
    const destinations = groupDestinations(group, catalog)
    console.log('      dest hints: ' + formatDestinations(destinations))
    console.log('      match: --match ' + shellQuote(group.re.source))
    if (group.note !== undefined) {
      const noteLines = wrapDisplay(group.note, width - 8)
      noteLines.forEach((line, index) => console.log(index === 0 ? '      note: ' + line : '            ' + line))
    }
    if (showEntries) {
      const sample = (classified.get(group.label) ?? []).slice(0, 5)
      for (const entry of sample) {
        const suffix = '  [' + formatDate(entry.updatedAt) + ', uses ' + entry.uses + ']'
        console.log('        - ' + fitDisplay(entry.title, Math.max(30, width - 12 - displayWidth(suffix))).trimEnd() + suffix)
      }
      const extra = count - sample.length
      if (extra > 0) console.log('        ... +' + extra + ' more')
    }
  }

  console.log('\nPROJECT-SPECIFIC — an existing project scope matches (verify the semantics before moving)')
  if (withScope.length === 0) console.log('  (none)')
  for (const group of withScope) printGroup(group, true)

  console.log('\nPROJECT-SPECIFIC — no existing project scope (--apply would refuse --to; creating a scope is a separate decision)')
  if (noScope.length === 0) console.log('  (none)')
  for (const group of noScope) printGroup(group, true)

  console.log('\nNOT PROJECT-SPECIFIC — keep global (listed for review, not as migration candidates)')
  if (platformGroups.length === 0 && systemGroups.length === 0) console.log('  (none)')
  for (const group of [...platformGroups, ...systemGroups]) {
    const count = counts.get(group.label) ?? 0
    console.log('\n  ' + padDisplay(group.label, labelWidth) + String(count).padStart(4))
    if (group.note !== undefined) {
      const noteLines = wrapDisplay(group.note, width - 8)
      noteLines.forEach((line, index) => console.log(index === 0 ? '      note: ' + line : '            ' + line))
    }
  }

  console.log('\nUNCLASSIFIED — no keyword group matched title/tags/keys: ' + unclassified)
  const unclassifiedEntries = entries.filter((entry) => classifyEntry(entry) === undefined).slice(0, 6)
  for (const entry of unclassifiedEntries) console.log('  - ' + fitDisplay(entry.title, width - 4).trimEnd())

  const emptyGroups = GROUPS.filter((group) => group.kind === 'project' && (counts.get(group.label) ?? 0) === 0)
  if (emptyGroups.length > 0) {
    console.log('\nPROJECT KEYWORDS WITH NO GLOBAL MATCH (already correctly scoped, or never used)')
    for (const group of emptyGroups) console.log('  ' + padDisplay(group.label, labelWidth) + '   0    dest hints: ' + formatDestinations(groupDestinations(group, catalog)))
  }

  console.log('\nRead-only: --candidates wrote nothing and never acts on its own. Pick one group, dry-run it, then apply:')
  console.log('  node ' + TOOL + " --match '<pattern>' --to <slug>")
  console.log('  node ' + TOOL + " --match '<pattern>' --to <slug> --apply --yes")
  console.log('The destination scope must already exist; this tool never creates one and never guesses one.')
}

// ---------------------------------------------------------------------------
// --match (dry run) and --apply
// ---------------------------------------------------------------------------

function describeDestination(store, slug) {
  const dir = join(store, 'projects', slug)
  const project = listProjectScopes(store).find((candidate) => candidate.slug === slug)
  return { dir, name: project?.name ?? slug, root: project?.root ?? '' }
}

function destinationConflicts(store, slug, entries) {
  const entriesDir = join(store, 'projects', slug, 'entries')
  const existing = new Set(isDirectory(entriesDir)
    ? readdirSync(entriesDir).filter((name) => name.endsWith('.md')).map((name) => name.replace(/\.md$/u, ''))
    : [])
  return entries.filter((entry) => existing.has(entry.id))
}

function printDryRunTable(entries) {
  const columns = Math.max(100, Math.min(Number(process.stdout.columns) || 160, 220))
  const idWidth = Math.max(28, Math.floor(columns * 0.32))
  const titleWidth = Math.max(30, columns - idWidth - 32)
  console.log(
    padDisplay('#', 4)
    + ' ' + padDisplay('id', idWidth)
    + ' ' + padDisplay('title', titleWidth)
    + ' ' + padDisplay('updated', 10)
    + ' ' + padDisplay('uses', 5)
    + ' ' + padDisplay('size', 10).trimEnd(),
  )
  entries.forEach((entry, index) => {
    console.log(
      String(index + 1).padStart(3) + ' '
      + fitDisplay(entry.id, idWidth) + ' '
      + fitDisplay(entry.title, titleWidth) + ' '
      + padDisplay(formatDate(entry.updatedAt), 10) + ' '
      + String(entry.uses).padStart(5) + ' '
      + formatBytes(entry.size).padStart(10),
    )
  })
}

function destinationHintsForEntries(matched, catalog) {
  const groups = new Map()
  for (const entry of matched) {
    const assignment = classifyEntry(entry)
    // Platform/system groups are "keep global" proposals; their destination
    // hints would point at unrelated projects, so only project groups count.
    if (assignment === undefined || assignment.group.kind !== 'project') continue
    groups.set(assignment.group.label, (groups.get(assignment.group.label) ?? 0) + 1)
  }
  const hints = []
  for (const group of GROUPS) {
    const count = groups.get(group.label)
    if (count === undefined) continue
    hints.push({ group, count, destinations: groupDestinations(group, catalog) })
  }
  return hints
}

function commandMatch(options, { applying }) {
  const { home, store } = resolvePaths(options)
  const matcher = parseMatcher(options.match)
  const allEntries = loadGlobalEntries(store)
  const matched = matchEntries(allEntries, matcher)
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))

  let destination
  if (options.to !== undefined) {
    requireDestination(store, options.to)
    destination = describeDestination(store, options.to)
  }

  console.log('dsh-memories scope migration — ' + (applying ? 'APPLY' : 'DRY RUN') + (applying ? '' : ' (no files will be written)'))
  console.log('store: ' + store + '   (home: ' + home + ')')
  console.log('match: ' + matcher.kind + ' ' + matcher.label + '   (fields: title, tags, keys, body)')
  console.log('global entries scanned: ' + allEntries.length)
  console.log('matched: ' + matched.length)
  console.log('')
  if (matched.length > 0) {
    printDryRunTable(matched)
    const bodyOnly = matched.filter((entry) => !matcher.test(entry.title)
      && !matcher.test(entry.tags.join(' '))
      && !matcher.test(entry.keys.join(' ')))
    if (bodyOnly.length > 0) {
      console.log('')
      console.log('note: ' + bodyOnly.length + ' of these matched only in the body (not title/tags/keys), so they are')
      console.log('      weaker migration candidates; review them before applying:')
      for (const entry of bodyOnly.slice(0, 8)) console.log('      - ' + entry.id)
      if (bodyOnly.length > 8) console.log('      ... +' + (bodyOnly.length - 8) + ' more')
    }
  } else {
    console.log('  (no global entry matched)')
  }
  console.log('')

  if (destination !== undefined) {
    console.log('proposed destination: ' + destination.dir)
    console.log('  scope exists: yes' + (destination.root.length > 0 ? '   (project root: ' + destination.root + ')' : '') + '   name: ' + destination.name)
  } else {
    const catalog = loadProjectCatalog(store)
    const hints = destinationHintsForEntries(matched, catalog)
    const destinationSlugs = [...new Set(hints.flatMap((hint) => hint.destinations.map((destination) => destination.slug)))]
    if (destinationSlugs.length === 1) {
      const slug = destinationSlugs[0]
      console.log('proposed destination: ' + join(store, 'projects', slug) + '  (informational; pass --to ' + slug + ' to confirm)')
    } else {
      console.log('proposed destination: (none — --to <slug> is required with --apply; no destination is guessed)')
    }
    if (hints.length > 0) {
      for (const hint of hints.slice(0, 4)) {
        console.log('  hint: ' + hint.group.label + ' (' + hint.count + ' matched) -> ' + formatDestinations(hint.destinations))
      }
    } else {
      console.log('  hint: none of the keyword groups matched; run --candidates to browse proposals.')
    }
  }

  const conflicts = destination !== undefined ? destinationConflicts(store, options.to, matched) : []
  const totalBytes = matched.reduce((sum, entry) => sum + entry.size, 0)
  console.log('')
  console.log('summary')
  console.log('  global entries     : ' + allEntries.length)
  console.log('  matched            : ' + matched.length)
  console.log('  matched size       : ' + formatBytes(totalBytes))
  if (destination !== undefined) {
    console.log('  destination scope  : ' + options.to + (destination.root.length > 0 ? '  (' + destination.root + ')' : ''))
    console.log('  id conflicts       : ' + conflicts.length + (conflicts.length > 0 ? ' (already at destination; --apply will refuse these)' : ''))
    for (const entry of conflicts.slice(0, 10)) console.log('    - ' + entry.id)
    if (conflicts.length > 10) console.log('    ... +' + (conflicts.length - 10) + ' more')
    console.log('  would move         : ' + (matched.length - conflicts.length) + (conflicts.length > 0 ? ' (would refuse: ' + conflicts.length + ')' : ''))
  } else {
    console.log('  destination scope  : (none selected — --to is required for --apply)')
    console.log('  would move         : ' + matched.length + ' if a destination were selected')
  }

  printRuntimeWarning(applying)

  if (!applying) {
    if (destination === undefined) {
      console.log('')
      console.log('Next: pick a destination scope, then re-run this exact command with --to <slug>.')
      console.log('      --apply additionally needs --yes and never creates a scope.')
    } else {
      console.log('')
      console.log('Next: node ' + TOOL + ' --match ' + shellQuote(options.match) + ' --to ' + shellQuote(options.to) + ' --apply --yes')
    }
    console.log('DRY RUN: no files were written.')
    return
  }

  runApply(options, { home, store, matched, destination, conflicts, matcher })
}

function writeManifest({ home, store, slug, destination, matcher, planned, refused }) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  let manifestPath = join('/tmp', MANIFEST_PREFIX + '-' + stamp + '.json')
  let attempt = 1
  while (existsSync(manifestPath)) manifestPath = join('/tmp', MANIFEST_PREFIX + '-' + stamp + '-' + attempt++ + '.json')
  const document = {
    kind: MANIFEST_KIND,
    version: VERSION,
    tool: TOOL_NAME,
    createdAt: new Date().toISOString(),
    home,
    store,
    from: 'global',
    to: slug,
    destination,
    match: matcher.label,
    matchKind: matcher.kind,
    plannedCount: planned.length,
    refusedCount: refused.length,
    planned: planned.map((item) => ({
      id: item.entry.id,
      title: item.entry.title,
      from: item.from,
      to: item.to,
      bytes: item.entry.size,
      uses: item.entry.uses,
      updated: item.entry.updatedAt,
      sourceSha256: item.sourceSha256,
      writtenSha256: item.writtenSha256,
      originalContent: item.entry.text,
    })),
    refused,
    results: null,
  }
  writeFileSync(manifestPath, JSON.stringify(document, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  return manifestPath
}

function updateManifest(manifestPath, results) {
  const document = JSON.parse(readFileSync(manifestPath, 'utf8'))
  document.results = results
  const temp = manifestPath + '.' + process.pid + '.tmp'
  writeFileSync(temp, JSON.stringify(document, null, 2) + '\n', 'utf8')
  renameSync(temp, manifestPath)
}

function writeAtomic(file, content, mode) {
  const temp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
  writeFileSync(temp, content, { encoding: 'utf8', mode })
  try {
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function runApply(options, context) {
  const { home, store, matched, destination, conflicts, matcher } = context
  const slug = options.to
  const destinationEntries = join(destination.dir, 'entries')
  const refused = conflicts.map((entry) => ({ id: entry.id, reason: 'destination already has id ' + entry.id + '; refusing to overwrite' }))

  const planned = []
  for (const entry of matched) {
    if (conflicts.some((conflict) => conflict.id === entry.id)) continue
    if (entry.error !== undefined) {
      refused.push({ id: entry.id, reason: entry.error })
      continue
    }
    if (!/^[^/\\\u0000]+$/u.test(entry.id) || entry.id === '.' || entry.id === '..') {
      refused.push({ id: entry.id, reason: 'id is not a safe file name' })
      continue
    }
    const sourcePath = join(store, 'entries', basename(entry.file))
    const destinationPath = join(destinationEntries, entry.id + '.md')
    let plannedText
    try {
      plannedText = rewriteScopeToProject(entry.text)
      const reparsed = splitEntry(plannedText)
      if (reparsed === undefined || reparsed.fields.get('scope') !== 'project') throw new Error('rewritten frontmatter does not parse as scope project')
      if (reparsed.fields.get('title') !== entry.title) throw new Error('rewritten frontmatter changed the title')
      if (reparsed.body !== entry.body) throw new Error('rewritten file changed the body')
    } catch (error) {
      refused.push({ id: entry.id, reason: 'could not rewrite scope: ' + error.message })
      continue
    }
    planned.push({
      entry,
      from: sourcePath,
      to: destinationPath,
      sourceSha256: sha256(entry.text),
      writtenSha256: sha256(plannedText),
      plannedText,
    })
  }

  if (planned.length === 0) {
    console.error('error: nothing to move; all ' + matched.length + ' matched entries were refused')
    for (const item of refused) console.error('  ' + item.id + ': ' + item.reason)
    process.exit(1)
  }

  const manifestPath = writeManifest({ home, store, slug, destination: destination.dir, matcher, planned, refused })
  console.log('manifest written before any move: ' + manifestPath)
  console.log('  planned: ' + planned.length + '   refused: ' + refused.length)
  note('')

  mkdirSync(destinationEntries, { recursive: true })
  const moved = []
  const failed = []
  for (const item of planned) {
    try {
      if (existsSync(item.to)) throw new Error('destination file appeared during apply; refusing to overwrite')
      writeAtomic(item.to, item.plannedText, item.entry.mode)
      try {
        utimesSync(item.to, new Date(item.entry.atimeMs), new Date(item.entry.mtimeMs))
      } catch {
        // Timestamp preservation is cosmetic; the content is already durable.
      }
      try {
        unlinkSync(item.from)
      } catch (error) {
        rmSync(item.to, { force: true })
        throw new Error('destination written but the global file could not be removed: ' + error.message + ' (destination copy rolled back)')
      }
      moved.push({ id: item.entry.id, from: item.from, to: item.to, sha256: item.writtenSha256, bytes: item.entry.size })
      console.log('moved: ' + item.entry.id + '  ->  ' + item.to)
    } catch (error) {
      failed.push({ id: item.entry.id, reason: error.message })
      console.error('FAILED: ' + item.entry.id + ': ' + error.message)
    }
  }

  updateManifest(manifestPath, {
    completedAt: new Date().toISOString(),
    moved,
    failed,
    refused,
  })

  const movedBytes = moved.reduce((sum, item) => sum + item.bytes, 0)
  console.log('')
  console.log('summary')
  console.log('  matched            : ' + matched.length)
  console.log('  moved              : ' + moved.length + '  (' + formatBytes(movedBytes) + ')')
  console.log('  refused            : ' + refused.length)
  console.log('  failed             : ' + failed.length)
  if (refused.length > 0) {
    console.log('  refused entries:')
    for (const item of refused) console.log('    - ' + item.id + ': ' + item.reason)
  }
  if (failed.length > 0) {
    console.log('  failed entries:')
    for (const item of failed) console.log('    - ' + item.id + ': ' + item.reason)
  }
  console.log('  untouched          : archive/, index.json, project index.json, state.db')
  console.log('  refresh            : the plugin rescans entries/ and rewrites index.json at the next store refresh.')

  if (moved.length > 0) {
    console.log('')
    console.log('undo — one line per moved entry:')
    for (const item of moved) console.log('  mv -n ' + shellQuote(item.to) + ' ' + shellQuote(item.from))
    console.log('  # The manifest keeps each original file verbatim (planned[].originalContent).')
    console.log('  # Byte-exact rollback of every moved entry:')
    console.log('  node ' + TOOL + ' --undo ' + shellQuote(manifestPath) + ' --yes')
    console.log('  # archive/ is global-only and was not touched; it cannot be rewound automatically.')
  }

  if (refused.length > 0 || failed.length > 0) process.exit(1)
}

// ---------------------------------------------------------------------------
// --undo
// ---------------------------------------------------------------------------

function commandUndo(options) {
  const manifestPath = resolve(options.undo)
  if (!existsSync(manifestPath)) fail('manifest not found: ' + manifestPath)
  let document
  try {
    document = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail('cannot read manifest ' + manifestPath + ': ' + error.message)
  }
  if (document.kind !== MANIFEST_KIND) fail('not a ' + MANIFEST_KIND + ' manifest: ' + manifestPath)
  if (!Array.isArray(document.planned)) fail('manifest has no planned entries: ' + manifestPath)
  const store = resolve(String(document.store))
  if (!isDirectory(join(store, 'entries'))) fail('store recorded in the manifest no longer looks like a memory store: ' + store)
  const resultsById = new Map((document.results?.moved ?? []).map((item) => [item.id, item]))

  const restored = []
  const refused = []
  for (const item of document.planned) {
    const destination = resolve(String(item.to))
    const original = resolve(String(item.from))
    if (!isInside(destination, join(store, 'projects'))) {
      refused.push({ id: item.id, reason: 'destination path in manifest is outside <store>/projects/: ' + destination })
      continue
    }
    if (!isInside(original, join(store, 'entries'))) {
      refused.push({ id: item.id, reason: 'original path in manifest is outside <store>/entries/: ' + original })
      continue
    }
    if (!existsSync(destination)) {
      refused.push({ id: item.id, reason: 'destination file is gone: ' + destination })
      continue
    }
    if (existsSync(original)) {
      refused.push({ id: item.id, reason: 'global file already exists; refusing to overwrite: ' + original })
      continue
    }
    const expected = resultsById.get(item.id)?.sha256 ?? item.writtenSha256
    const current = readFileSync(destination, 'utf8')
    if (expected !== undefined && sha256(current) !== expected) {
      console.log('warning: ' + item.id + ' changed since the move (usage counters or a hand edit); restoring the original content anyway.')
    }
    try {
      const mode = statSync(destination).mode & 0o777
      writeAtomic(original, String(item.originalContent), mode)
      unlinkSync(destination)
      restored.push({ id: item.id, from: destination, to: original })
      console.log('restored: ' + item.id + '  ->  ' + original)
    } catch (error) {
      refused.push({ id: item.id, reason: error.message })
    }
  }

  console.log('')
  console.log('undo summary')
  console.log('  manifest : ' + manifestPath)
  console.log('  store    : ' + store)
  console.log('  restored : ' + restored.length)
  console.log('  refused  : ' + refused.length)
  for (const item of refused) console.log('    - ' + item.id + ': ' + item.reason)
  console.log('  untouched: archive/, index.json, project index.json, state.db')
  console.log('  refresh  : the plugin rescans entries/ and rewrites index.json at the next store refresh.')
  if (refused.length > 0) process.exit(1)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return
  }
  if (options.undo !== undefined) {
    commandUndo(options)
    return
  }
  if (options.candidates) {
    commandCandidates(options)
    return
  }
  commandMatch(options, { applying: options.apply })
}

main()
