#!/usr/bin/env node
/**
 * Propose skills from the procedure- and preference-shaped memories in the store.
 *
 * PROCEDURE-SHAPED MEMORIES ARE THE WRONG SHAPE FOR MEMORY
 * --------------------------------------------------------
 * A memory is injected (or recall-ranked) into every session, so a memory that
 * says "发版怎么走" spends injection budget on a checklist. That is a skill: it
 * loads only when a task needs it. This script does the read-only half of the
 * conversion — it finds the entries that describe one repeatable procedure or
 * one settled rule, groups them by shared vocabulary, and prints a proposal for
 * each group. It never writes, never calls a model, and never touches
 * $DSH_HOME/skills; promoting a proposal stays an explicit human action.
 *
 * WHAT IT READS
 * -------------
 * Live entries only — every markdown file directly under <store>/entries/
 * (global scope) and <store>/projects/<slug>/entries/ (project scope).
 * Frontmatter is the line-oriented subset the plugin writes: "key: value", with
 * tags and keys comma-separated. Entries whose frontmatter cannot be parsed are
 * counted and reported, never guessed at. Archived entries live in
 * <store>/archive/ and are not live, so they are not read.
 *
 * CLUSTERING
 * ----------
 * Tokens come from the normalised title, tags, and keys:
 *
 * - Latin/digit words ([a-z0-9_]+, lowercased, length >= 2, digits-only
 *   dropped) keep whole-word identity.
 * - CJK runs contribute character bigrams (a one-character run contributes
 *   itself), the same unit src/search.ts uses, because Chinese has no spaces.
 *
 * A match is scored as a weighted Jaccard over the two token bags:
 *
 *     sim(A, B) = sum over shared terms min(wA, wB)
 *                 -------------------------------
 *                 sum over union  terms max(wA, wB)
 *
 * where a term's weight is its best field weight (title 1.0, tags 0.7,
 * keys 0.7) times its term weight (Latin 1.0, CJK bigram 0.5 — a bigram is a
 * much weaker claim than a word, as src/search.ts already argues). The weights
 * are capped, not summed, so a token repeated across fields cannot inflate one
 * entry.
 *
 * Clusters are single-link at a fixed threshold: every pair at or above the
 * threshold becomes an edge, edges are considered in descending similarity, and
 * union-find yields the connected components. Single-link is deliberate — the
 * question "is this one skill?" is transitive, and the failure mode of the
 * alternative (average-link) is two halves of one procedure that never merge
 * because their centroids differ. The cost is chaining, which is why the
 * threshold is visible (--threshold) and reported in the output rather than
 * hidden.
 *
 * A term that appears in too many entries is dropped before scoring (more than
 * max(8, 5% of eligible) entries; on a 126-eligible store that is 8). Without
 * this, single-link chains through hub words: "pc" links an email procedure, a
 * repo-sync procedure, and the Mac/PC workflow rule into one 11-member cluster
 * that is three skills, not one. Dropping hub terms splits that cluster without
 * touching the topic terms a real group shares.
 *
 * DEFAULT THRESHOLD: 0.10. Calibrated on a real store (491 live entries, 126
 * eligible): 0.08 chains the email procedures to an unrelated SSH-preference
 * entry; 0.09 adds two pairs that share only a filesystem path; 0.10 yields 11
 * clusters over 29 entries, each readable as one topic, while the iPhone and
 * Python families stay intact. 0.12 starts dropping real groups (the iPhone
 * four and the production-upgrade pair), so the default stays at 0.10 and
 * --threshold is printed with every proposal.
 *
 * PROPOSAL SHAPE
 * --------------
 * For each cluster of at least --min members this prints a kebab-case ASCII
 * skill name (<= 40 chars, harness grammar [a-z0-9]+(-[a-z0-9]+)*), a one-line
 * "Use when ..." description (<= 140 chars), the member ids and titles, and a
 * bullet outline whose lines are the member titles — the outline is the
 * skeleton a human edits into real steps. Clusters of one are reported as "left
 * out" with the nearest neighbour and its score, so a too-high threshold is
 * inspectable rather than silently quiet.
 *
 * Usage (run from the repository root):
 *
 *   node scripts/draft-skills.mjs
 *   node scripts/draft-skills.mjs --min 3
 *   node scripts/draft-skills.mjs --kinds=procedure,preference,knowledge
 *   node scripts/draft-skills.mjs --home /path/to/.dsh --json
 *
 * @module dsh-memories/scripts/draft-skills
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Kinds the store understands; the default selection is the skill-shaped pair. */
const ALL_KINDS = ['preference', 'failure', 'procedure', 'knowledge', 'fact']

/** Kinds that are usually a procedure or a rule rather than a fact. */
const DEFAULT_KINDS = ['procedure', 'preference']

/** Minimum cluster size printed as a proposal. */
const DEFAULT_MIN = 2

/** Similarity at or above which two entries are single-linked. See the header. */
const DEFAULT_THRESHOLD = 0.1

/** A term in more entries than this is a hub word, not a topic. See the header. */
const MIN_DF_CUTOFF = 8

/** The hub cutoff is also at least this share of the eligible entries. */
const DF_CUTOFF_FRACTION = 0.05

/** Longest skill name the harness accepts, per the task contract. */
const MAX_NAME_LENGTH = 40

/** Longest skill description this script will emit. */
const MAX_DESCRIPTION_LENGTH = 140

/** Flags this script understands. An unknown --flag is an error, not a no-op. */
const KNOWN_FLAGS = new Set(['home', 'min', 'kinds', 'threshold', 'json', 'help'])

/** Flags that take a value; --json and --help must not. */
const VALUED_FLAGS = new Set(['home', 'min', 'kinds', 'threshold'])

/** Parse --flag=value and --flag value; --json and --help are booleans. */
function parseFlags(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      flags.set('help', 'true')
      continue
    }
    if (!arg.startsWith('--')) throw new Error('unexpected argument: ' + arg)
    const separator = arg.indexOf('=')
    if (separator >= 0) {
      flags.set(arg.slice(2, separator), arg.slice(separator + 1))
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(arg.slice(2), next)
      index += 1
    } else {
      flags.set(arg.slice(2), 'true')
    }
  }
  for (const [name, value] of flags) {
    if (!KNOWN_FLAGS.has(name)) throw new Error('unknown option --' + name)
    if (!VALUED_FLAGS.has(name) && value !== 'true') throw new Error('--' + name + ' does not take a value')
  }
  return flags
}

/** Read a positive integer flag, or fall back to a default. */
function integerFlag(flags, name, fallback) {
  const raw = flags.get(name)
  if (raw === undefined) return fallback
  if (raw === '') throw new Error('--' + name + ' needs a number')
  if (!/^[0-9]+$/u.test(raw)) throw new Error('--' + name + ' must be a whole number, got ' + JSON.stringify(raw))
  return Number(raw)
}

/** Read a unit-interval float flag, or fall back to a default. */
function floatFlag(flags, name, fallback) {
  const raw = flags.get(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('--' + name + ' must be between 0 and 1, got ' + JSON.stringify(raw))
  }
  return value
}

/** Read and validate --kinds, defaulting to procedure,preference. */
function kindsFlag(flags) {
  const raw = flags.get('kinds')
  if (raw === undefined) return DEFAULT_KINDS.slice()
  const kinds = raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
  if (kinds.length === 0) throw new Error('--kinds needs at least one of: ' + ALL_KINDS.join(', '))
  for (const kind of kinds) {
    if (!ALL_KINDS.includes(kind)) {
      throw new Error('unknown kind ' + JSON.stringify(kind) + '; known kinds: ' + ALL_KINDS.join(', '))
    }
  }
  return [...new Set(kinds)]
}

const HELP = [
  'Usage: node scripts/draft-skills.mjs [options]',
  '',
  'Read-only: prints skill proposals from procedure/preference memories. Writes nothing.',
  '',
  'Options:',
  '  --home <path>       DSH home (default $DSH_HOME or ~/.dsh); a path that',
  '                      already contains entries/ is treated as the store itself',
  '  --min <n>           smallest cluster to propose (default 2)',
  '  --kinds <a,b>       memory kinds to cluster (default procedure,preference)',
  '  --threshold <0..1>  weighted Jaccard cut for single-link clustering (default 0.1)',
  '  --json              emit the same proposal as JSON',
  '  -h, --help          show this text',
].join('\n')

// ---------------------------------------------------------------------------
// Reading the store
// ---------------------------------------------------------------------------

/** The frontmatter fence the plugin writes. */
const FENCE = '---'

/** Whether one directory looks like a memory store, not a DSH home. */
function looksLikeStore(dir) {
  return existsSync(join(dir, 'entries')) || existsSync(join(dir, 'projects'))
}

/**
 * Resolve the memory store.
 *
 * --home follows the same meaning as scripts/report.mjs (a DSH home), but a
 * caller who points it straight at ~/.dsh/memories is doing something
 * reasonable, so that shape is accepted too.
 * @param {string | undefined} homeFlag - raw --home value.
 * @returns {string} absolute-ish store directory.
 */
function resolveStore(homeFlag) {
  const home = homeFlag ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return looksLikeStore(home) ? home : join(home, 'memories')
}

/** Split a comma-separated frontmatter list into trimmed non-empty values. */
function splitList(value) {
  if (value === undefined) return []
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

/**
 * Parse one entry file in the line-oriented frontmatter shape the plugin writes.
 *
 * This is deliberately independent of src/storage.ts (which is TypeScript and
 * needs the build): the tool must run from a checkout with no build step. The
 * parse rules match it: strip a BOM, require the opening fence, stop at the next
 * fence, split each header line on its first colon, require a non-empty title.
 *
 * @param {string} path - entry file.
 * @param {'global' | 'project'} scope - scope implied by the directory.
 * @param {string | undefined} project - project display name for project scope.
 * @returns {{entry: object} | {error: string}} parsed entry or a reason.
 */
function readEntryFile(path, scope, project) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { error: 'unreadable: ' + error.message }
  }
  const normalized = text.replace(/^\uFEFF/u, '')
  if (!normalized.startsWith(FENCE)) return { error: 'no frontmatter fence' }
  const end = normalized.indexOf('\n' + FENCE, FENCE.length)
  if (end < 0) return { error: 'unterminated frontmatter' }
  const header = normalized.slice(FENCE.length, end)
  const fields = new Map()
  for (const line of header.split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
  }
  const title = fields.get('title')
  if (title === undefined || title.length === 0) return { error: 'no title' }
  const id = fields.get('id') ?? basename(path, '.md')
  const kind = fields.get('kind') ?? 'fact'
  if (!ALL_KINDS.includes(kind)) return { error: 'unknown kind ' + JSON.stringify(kind) }
  return {
    entry: {
      id,
      kind,
      title,
      tags: splitList(fields.get('tags')),
      keys: splitList(fields.get('keys')),
      appliesTo: fields.get('appliesto') ?? '',
      uses: Number(fields.get('uses') ?? '0') || 0,
      scope,
      project,
      path,
    },
  }
}

/** Read every .md file directly inside one entries directory. */
function readEntriesDir(dir, scope, project, result) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const parsed = readEntryFile(join(dir, name), scope, project)
    if ('error' in parsed) {
      result.skipped.push({ path: join(dir, name), reason: parsed.error })
      continue
    }
    result.entries.push(parsed.entry)
  }
}

/** Project display name for a project slug, or the slug when project.json is absent. */
function projectName(projectDir, slug) {
  try {
    const descriptor = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'))
    if (typeof descriptor.name === 'string' && descriptor.name.length > 0) return descriptor.name
  } catch {
    // A project without a readable descriptor is still a real scope; the slug names it.
  }
  return slug
}

/** Read every live entry in the store: global first, then projects. */
export function readStore(store) {
  const result = { entries: [], skipped: [] }
  readEntriesDir(join(store, 'entries'), 'global', undefined, result)
  const projectsDir = join(store, 'projects')
  if (existsSync(projectsDir)) {
    for (const slug of readdirSync(projectsDir).sort()) {
      const projectDir = join(projectsDir, slug)
      readEntriesDir(join(projectDir, 'entries'), 'project', projectName(projectDir, slug), result)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Tokens and similarity
// ---------------------------------------------------------------------------

/** CJK code points treated as Chinese/Japanese runs (same ranges as src/search.ts). */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu

/** A Latin or digit word. */
const LATIN_WORD = /[a-z0-9_]+/gu

/**
 * Terms that describe the memory store itself rather than a topic.
 *
 * Without this every preference would share "preference" and every procedure
 * "procedure", which is exactly the signal that makes a cluster look real while
 * carrying no meaning.
 */
const STOP_TERMS = new Set([
  'preference', 'procedure', 'knowledge', 'fact', 'memory', 'memories',
  'skill', 'entry', 'entries', 'workflow', 'working-style',
  '偏好', '流程', '知识', '事实', '记忆', '技能', '记录', '工作方式',
])

/** Field weights: a title token says more about the entry than a tag. */
const FIELD_WEIGHT = { title: 1, tags: 0.7, keys: 0.7 }

/** Term weight: a CJK bigram is a weaker claim than a Latin word. */
const LATIN_TERM_WEIGHT = 1

/** See LATIN_TERM_WEIGHT. */
const CJK_TERM_WEIGHT = 0.5

/** Raise (never lower) a term's weight in one entry's bag. */
function bump(bag, term, weight) {
  const previous = bag.get(term)
  if (previous === undefined || weight > previous) bag.set(term, weight)
}

/** Turn one field into weighted terms. */
function addFieldTerms(bag, text, fieldWeight) {
  const lower = text.normalize('NFKC').toLowerCase()
  for (const word of lower.match(LATIN_WORD) ?? []) {
    if (word.length < 2 || /^[0-9]+$/u.test(word) || STOP_TERMS.has(word)) continue
    bump(bag, word, fieldWeight * LATIN_TERM_WEIGHT)
  }
  const runs = lower.match(CJK_RUN) ?? []
  for (const run of runs) {
    const chars = [...run]
    if (chars.length === 1) {
      if (!STOP_TERMS.has(chars[0])) bump(bag, chars[0], fieldWeight * CJK_TERM_WEIGHT)
      continue
    }
    for (let index = 0; index + 1 < chars.length; index += 1) {
      const bigram = chars[index] + chars[index + 1]
      if (STOP_TERMS.has(bigram)) continue
      bump(bag, bigram, fieldWeight * CJK_TERM_WEIGHT)
    }
  }
}

/** Build one entry's weighted token bag from its title, tags, and keys. */
export function tokenBag(entry) {
  const bag = new Map()
  addFieldTerms(bag, entry.title, FIELD_WEIGHT.title)
  addFieldTerms(bag, entry.tags.join(' '), FIELD_WEIGHT.tags)
  addFieldTerms(bag, entry.keys.join(' '), FIELD_WEIGHT.keys)
  return bag
}

/**
 * Weighted Jaccard similarity of two token bags.
 * @param {Map<string, number>} left - one bag.
 * @param {Map<string, number>} right - the other bag.
 * @returns {number} similarity in [0, 1].
 */
function similarity(left, right) {
  let shared = 0
  let union = 0
  for (const [term, leftWeight] of left) {
    const rightWeight = right.get(term)
    if (rightWeight === undefined) {
      union += leftWeight
      continue
    }
    shared += Math.min(leftWeight, rightWeight)
    union += Math.max(leftWeight, rightWeight)
  }
  for (const [term, rightWeight] of right) {
    if (!left.has(term)) union += rightWeight
  }
  return union === 0 ? 0 : shared / union
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * Greedy single-link clustering.
 *
 * Every pair at or above the threshold is an edge; edges are visited from most
 * to least similar and union-find merges their endpoints. At a fixed threshold
 * the component structure is order-independent, but visiting the strongest
 * edges first keeps the documented "greedy" behaviour honest and makes a trace
 * when debugging easy to reason about.
 *
 * @param {{entry: object, bag: Map<string, number>}[]} items - eligible entries.
 * @param {number} threshold - similarity cut.
 * @returns {number[][]} index groups.
 */
function clusterItems(items, threshold) {
  const parent = items.map((_, index) => index)
  /** Find with path compression. */
  function find(value) {
    let index = value
    let root = index
    while (parent[root] !== root) root = parent[root]
    while (parent[index] !== root) {
      const next = parent[index]
      parent[index] = root
      index = next
    }
    return root
  }
  /** Union two roots; the smaller index wins so output stays deterministic. */
  function union(left, right) {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot === rightRoot) return
    if (leftRoot < rightRoot) parent[rightRoot] = leftRoot
    else parent[leftRoot] = rightRoot
  }

  const edges = []
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const score = similarity(items[left].bag, items[right].bag)
      if (score >= threshold) edges.push({ left, right, score })
    }
  }
  edges.sort((a, b) => b.score - a.score || a.left - b.left || a.right - b.right)
  for (const edge of edges) union(edge.left, edge.right)

  const groups = new Map()
  for (let index = 0; index < items.length; index += 1) {
    const root = find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(index)
  }
  return [...groups.values()]
}

/** Highest-scoring pair similarity inside one group (for reporting). */
function internalSimilarity(group, items) {
  let best = 0
  for (let left = 0; left < group.length; left += 1) {
    for (let right = left + 1; right < group.length; right += 1) {
      const score = similarity(items[group[left]].bag, items[group[right]].bag)
      if (score > best) best = score
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Naming a cluster
// ---------------------------------------------------------------------------

/**
 * Chinese topic words that name a skill better than their bigrams do.
 *
 * Only names use this table; clustering never does. It covers the recurring
 * subjects in a real store (mail, release, invoice, ...) and is intentionally
 * small: an unknown subject still gets a name from its shared Latin tokens, and
 * only a cluster with no shared Latin at all falls back to the generated
 * memory-skill-N placeholder that a human is expected to rename.
 */
const CONCEPT_WORDS = new Map([
  ['邮件', 'mail'], ['邮箱', 'mail'], ['回信', 'mail-reply'], ['草稿', 'draft'],
  ['写作', 'writing'], ['风格', 'style'], ['周报', 'weekly-report'], ['简历', 'resume'],
  ['发版', 'release'], ['版本', 'version'], ['部署', 'deploy'], ['升级', 'upgrade'],
  ['回归', 'regression'], ['测试', 'test'], ['验收', 'acceptance'], ['冒烟', 'smoke'],
  ['发票', 'invoice'], ['报价', 'quote'], ['合同', 'contract'], ['对账', 'reconciliation'],
  ['客户', 'customer'], ['售前', 'presales'], ['交付', 'delivery'], ['生产', 'production'],
  ['备份', 'backup'], ['恢复', 'restore'], ['清理', 'cleanup'], ['卸载', 'uninstall'],
  ['重命名', 'rename'], ['批量', 'batch'], ['压缩', 'compress'], ['相册', 'photos'],
  ['视频', 'video'], ['截图', 'screenshot'], ['抽签', 'draw'], ['赛事', 'tournament'],
  ['性能', 'performance'], ['排查', 'troubleshoot'], ['发热', 'thermals'], ['重启', 'reboot'],
  ['内存', 'ram'], ['索引', 'index'], ['日志', 'log'], ['授权', 'auth'], ['权限', 'permission'],
  ['同步', 'sync'], ['远程', 'remote'], ['手机', 'iphone'], ['镜像', 'mirroring'],
  ['隧道', 'tunnel'], ['导航', 'routing'], ['依赖', 'dependencies'], ['插件', 'plugin'],
  ['内核', 'kernel'], ['项目', 'project'], ['目录', 'directory'], ['文档', 'docs'],
  ['资料', 'materials'], ['审计', 'audit'], ['复核', 'review'], ['报告', 'report'],
  ['配置', 'config'], ['数据库', 'database'], ['前端', 'frontend'], ['页面', 'page'],
  ['皮肤', 'theme'], ['水印', 'watermark'], ['脱敏', 'redaction'], ['编码', 'encoding'],
  ['中国', 'cn'], ['合作', 'collaboration'], ['快捷', 'shortcut'], ['指令', 'shortcut'],
  ['动作', 'action'], ['样本', 'sample'], ['换算', 'convert'], ['聚合', 'aggregate'],
  ['替换', 'replace'], ['校验', 'validate'], ['验证', 'validate'], ['回传', 'handback'],
  ['外发', 'outbound'], ['台账', 'ledger'], ['标色', 'color'], ['搜索', 'search'],
])

/** Tokens that make a weak skill name even though they are real words. */
const WEAK_NAME_TOKENS = new Set([
  'use', 'using', 'check', 'new', 'old', 'first', 'last', 'one', 'two',
  'py', 'txt', 'md', 'sh',
])

/**
 * Candidate name concepts for one cluster, strongest first.
 *
 * A concept must appear in at least two members (or a majority, for larger
 * clusters). Latin tokens outrank bigrams because they are the words a skill
 * name can actually be built from; CJK bigrams are translated through
 * CONCEPT_WORDS. Ties prefer title tokens, then longer tokens, then alpha order.
 * @param {object[]} members - cluster members, with bags.
 * @returns {string[]} ASCII kebab concepts.
 */
function nameConcepts(members) {
  const counts = new Map()
  const titleCounts = new Map()
  for (const member of members) {
    for (const [term, weight] of member.bag) {
      if (term.match(CJK_RUN) !== null) continue
      counts.set(term, (counts.get(term) ?? 0) + 1)
      if (weight >= FIELD_WEIGHT.title) titleCounts.set(term, (titleCounts.get(term) ?? 0) + 1)
    }
  }
  const minimum = Math.max(2, Math.ceil(members.length * 0.5))
  const latin = [...counts.entries()]
    .filter(([term, count]) => count >= minimum && count > 1 && !WEAK_NAME_TOKENS.has(term))
    .sort((a, b) =>
      b[1] - a[1]
      || (titleCounts.get(b[0]) ?? 0) - (titleCounts.get(a[0]) ?? 0)
      || b[0].length - a[0].length
      || a[0].localeCompare(b[0]))
    .map(([term]) => term)

  const cjkCounts = new Map()
  for (const member of members) {
    for (const term of member.bag.keys()) {
      if (term.match(CJK_RUN) === null) continue
      cjkCounts.set(term, (cjkCounts.get(term) ?? 0) + 1)
    }
  }
  const translated = [...cjkCounts.entries()]
    .filter(([term, count]) => count > 1 && count >= minimum && CONCEPT_WORDS.has(term))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([term]) => CONCEPT_WORDS.get(term))

  return [...new Set([...latin, ...translated])]
}

/** Normalize a proposed name into the harness skill grammar, or '' when empty. */
function normalizeName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/u, '')
}

/** Build a kebab-case ASCII name from concepts, fitting MAX_NAME_LENGTH. */
function composeName(concepts, index) {
  if (concepts.length === 0) return 'memory-skill-' + (index + 1)
  const parts = []
  let length = 0
  for (const concept of concepts) {
    const part = normalizeName(concept)
    if (part.length === 0) continue
    const next = parts.length === 0 ? part.length : length + 1 + part.length
    if (next > MAX_NAME_LENGTH) continue
    parts.push(part)
    length = next
    if (parts.length >= 4) break
  }
  const name = parts.join('-')
  return name.length > 0 ? name : 'memory-skill-' + (index + 1)
}

/** Make names unique within one report, keeping the first occurrence. */
function uniqueNames(names) {
  const used = new Map()
  return names.map((name) => {
    const seen = used.get(name) ?? 0
    used.set(name, seen + 1)
    if (seen === 0) return name
    const suffix = '-' + (seen + 1)
    return name.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/-+$/u, '') + suffix
  })
}

// ---------------------------------------------------------------------------
// Describing a cluster
// ---------------------------------------------------------------------------

/** One-line whitespace-collapsed text. */
function oneLine(value) {
  return value.replace(/\s+/gu, ' ').trim()
}

/** Cut text to at most limit characters, marking the cut. */
function truncate(value, limit) {
  if (value.length <= limit) return value
  return value.slice(0, Math.max(0, limit - 1)).replace(/\s+\S*$/u, '') + '…'
}

/**
 * Pick the member whose appliesTo best says WHEN this cluster is used.
 *
 * appliesTo is the store's own "when does this matter" field, so it beats a
 * synthesized trigger. The most-used member wins, with global scope preferred
 * on a tie because a global rule is the one that would leave the store.
 * @param {object[]} members - cluster members.
 * @returns {string} a trigger clause, possibly empty.
 */
function triggerFor(members) {
  const ranked = members.slice().sort((a, b) =>
    b.entry.uses - a.entry.uses
    || (b.entry.scope === 'global' ? 1 : 0) - (a.entry.scope === 'global' ? 1 : 0)
    || a.entry.id.localeCompare(b.entry.id))
  for (const member of ranked) {
    const appliesTo = oneLine(member.entry.appliesTo)
    if (appliesTo.length > 0) return appliesTo
  }
  return oneLine(ranked[0].entry.title)
}

/**
 * Build the "Use when ..." description for one cluster.
 *
 * The description must be one line, <= 140 characters, imperative, and say when
 * to load the skill. The trigger comes from the representative's appliesTo (or
 * its title), and the memory count is appended only when it fits.
 * @param {object[]} members - cluster members.
 * @param {string} name - proposed skill name.
 * @returns {string} description within MAX_DESCRIPTION_LENGTH.
 */
function describe(members, name) {
  const trigger = triggerFor(members)
  const prefix = 'Use when '
  const count = members.length
  const kinds = [...new Set(members.map((member) => member.entry.kind))].join('/')
  const suffix = ' (' + count + ' ' + kinds + ' memories merged into ' + name + ')'
  const room = MAX_DESCRIPTION_LENGTH - prefix.length
  const plain = prefix + trigger + '.'
  if (plain.length <= MAX_DESCRIPTION_LENGTH) {
    const withCount = plain + suffix
    return withCount.length <= MAX_DESCRIPTION_LENGTH ? withCount : plain
  }
  return prefix + truncate(trigger, room - 1) + '.'
}

// ---------------------------------------------------------------------------
// Building the report
// ---------------------------------------------------------------------------

/** Stable JSON-safe projection of one entry. */
function publicEntry(entry) {
  const projected = {
    id: entry.id,
    title: entry.title,
    kind: entry.kind,
    scope: entry.scope,
  }
  if (entry.project !== undefined) projected.project = entry.project
  return projected
}

/**
 * Build the proposal report from a store directory.
 * @param {string} store - memory store root.
 * @param {object} options - kinds, min, threshold.
 * @returns {object} the report consumed by both printers.
 */
function buildReport(store, options) {
  const kinds = new Set(options.kinds)
  const reading = readStore(store)
  const eligible = reading.entries
    .filter((entry) => kinds.has(entry.kind))
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id))
  const rawItems = eligible.map((entry) => ({ entry, bag: tokenBag(entry) }))

  // Hub words are dropped by document frequency over the eligible set, for the
  // reason in the header: single-link turns one shared "pc" into an 11-member
  // chain. The cutoff scales with the store so a tiny store does not lose its
  // whole vocabulary.
  const dfCutoff = Math.max(MIN_DF_CUTOFF, Math.round(eligible.length * DF_CUTOFF_FRACTION))
  const documentFrequency = new Map()
  for (const item of rawItems) {
    for (const term of item.bag.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  }
  const prunedTerms = [...documentFrequency].filter(([, count]) => count > dfCutoff).map(([term]) => term).sort()
  const items = rawItems.map((item) => {
    const bag = new Map()
    for (const [term, weight] of item.bag) {
      if ((documentFrequency.get(term) ?? 0) <= dfCutoff) bag.set(term, weight)
    }
    return { entry: item.entry, bag }
  })
  const groups = clusterItems(items, options.threshold)

  const clusters = []
  const leftOut = []
  for (const group of groups) {
    const members = group.map((index) => items[index])
    if (members.length >= options.min) {
      clusters.push({ members, best: internalSimilarity(group, items) })
      continue
    }
    // A pair rejected only because --min is 3 is not a singleton, and saying
    // "no overlap" about it would be false; keep the group so the reason can
    // say which entries did overlap.
    for (const member of members) leftOut.push({ member, group: members })
  }
  clusters.sort((a, b) => b.members.length - a.members.length || a.members[0].entry.id.localeCompare(b.members[0].entry.id))

  const names = uniqueNames(clusters.map((cluster, index) => composeName(nameConcepts(cluster.members), index)))

  const reportedClusters = clusters.map((cluster, index) => {
    const name = names[index]
    const members = cluster.members
      .map((member) => member.entry)
      .sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id))
    return {
      name,
      description: describe(cluster.members, name),
      memberCount: members.length,
      globalCount: members.filter((entry) => entry.scope === 'global').length,
      projectCount: members.filter((entry) => entry.scope === 'project').length,
      bestSimilarity: Number(cluster.best.toFixed(3)),
      members: members.map(publicEntry),
      outline: members.map((entry) => entry.title),
    }
  })

  // A singleton's "why" is the nearest entry it failed to reach, so a threshold
  // that is too high is inspectable instead of merely quiet.
  const reportedLeftOut = leftOut.map(({ member, group }) => {
    let closest = null
    for (const other of items) {
      if (other === member) continue
      const score = similarity(member.bag, other.bag)
      if (closest === null || score > closest.similarity) {
        closest = { id: other.entry.id, title: other.entry.title, similarity: score }
      }
    }
    const mates = group.filter((other) => other !== member).map((other) => other.entry.id)
    const reason = mates.length > 0
      ? 'clustered with ' + mates.length + ' other entr' + (mates.length === 1 ? 'y' : 'ies')
        + ' at the threshold, but that group has only ' + group.length + ' members (--min ' + options.min + ')'
      : 'no other eligible entry reached the ' + options.threshold + ' single-link threshold'
        + (closest === null ? '' : '; closest was ' + closest.id + ' at ' + closest.similarity.toFixed(3))
    return {
      ...publicEntry(member.entry),
      clusterSize: group.length,
      clusteredWith: mates,
      reason,
      closest: closest === null ? null : { id: closest.id, similarity: Number(closest.similarity.toFixed(3)) },
    }
  })

  const covered = reportedClusters.reduce((total, cluster) => total + cluster.memberCount, 0)
  return {
    store,
    options: {
      kinds: options.kinds,
      min: options.min,
      threshold: options.threshold,
      dfCutoff,
    },
    prunedTerms,
    totals: {
      liveEntries: reading.entries.length,
      eligibleEntries: eligible.length,
      skippedEntries: reading.skipped.length,
      clusters: reportedClusters.length,
      coveredEntries: covered,
      leftOutEntries: reportedLeftOut.length,
    },
    skipped: reading.skipped.map((skip) => ({ path: skip.path, reason: skip.reason })),
    clusters: reportedClusters,
    leftOut: reportedLeftOut,
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** Render the human-readable report. */
function printReport(report) {
  const options = report.options
  const totals = report.totals
  console.log('dsh-memories · skill proposals from procedure/preference-shaped memories')
  console.log('store:      ' + report.store)
  console.log('kinds:      ' + options.kinds.join(', '))
  console.log('clustering: weighted token Jaccard >= ' + options.threshold + ', single-link, min ' + options.min + ' members')
  console.log('hub filter: drop terms in more than ' + options.dfCutoff + ' entries'
    + (report.prunedTerms.length > 0 ? ' (' + report.prunedTerms.join(', ') + ')' : ''))
  const globalEligible = report.clusters.reduce((total, cluster) => total + cluster.globalCount, 0)
    + report.leftOut.filter((entry) => entry.scope === 'global').length
  const projectEligible = report.leftOut.filter((entry) => entry.scope === 'project').length
    + report.clusters.reduce((total, cluster) => total + cluster.projectCount, 0)
  console.log('read:       ' + totals.liveEntries + ' live entries -> ' + totals.eligibleEntries + ' eligible ('
    + globalEligible + ' global, ' + projectEligible + ' project)'
    + (totals.skippedEntries > 0 ? ' (' + totals.skippedEntries + ' unparseable, skipped)' : ''))
  console.log('result:     ' + totals.clusters + ' clusters covering ' + totals.coveredEntries
    + ' entries; ' + totals.leftOutEntries + ' entries left out')
  console.log('            creating these skills would remove ' + totals.coveredEntries + ' entries from the live store')
  console.log('')

  for (const [index, cluster] of report.clusters.entries()) {
    console.log('#' + (index + 1) + '  ' + cluster.name + '  (' + cluster.memberCount + ' entries: '
      + cluster.globalCount + ' global, ' + cluster.projectCount + ' project)')
    console.log('    ' + cluster.description)
    console.log('    members:')
    for (const member of cluster.members) {
      const where = member.scope === 'global' ? 'global' : 'project ' + member.project
      console.log('      - ' + member.id + '  [' + member.kind + ', ' + where + ']  ' + member.title)
    }
    console.log('    outline:')
    for (const line of cluster.outline) console.log('      - ' + oneLine(line))
    console.log('')
  }

  if (report.leftOut.length > 0) {
    console.log('Left out (' + report.leftOut.length + ' entries with no proposal at --min ' + options.min + '):')
    for (const entry of report.leftOut) {
      console.log('  - ' + entry.id + '  [' + entry.kind + ', ' + entry.scope + ']  ' + entry.title)
      console.log('    ' + entry.reason)
    }
    console.log('')
  }

  if (report.skipped.length > 0) {
    console.log('Unparseable files (' + report.skipped.length + '):')
    for (const skip of report.skipped) console.log('  - ' + skip.path + ': ' + skip.reason)
    console.log('')
  }
}

/** Main entry: parse options, build one report, print it in the requested form. */
function main(argv) {
  const flags = parseFlags(argv)
  if (flags.get('help') === 'true') {
    console.log(HELP)
    return 0
  }
  const options = {
    kinds: kindsFlag(flags),
    min: integerFlag(flags, 'min', DEFAULT_MIN),
    threshold: floatFlag(flags, 'threshold', DEFAULT_THRESHOLD),
  }
  if (options.min < 1) throw new Error('--min must be at least 1')
  const store = resolveStore(flags.get('home'))
  if (!existsSync(store)) throw new Error('memory store not found: ' + store)
  if (!existsSync(join(store, 'entries'))) throw new Error('no entries/ directory under ' + store)

  const report = buildReport(store, options)
  if (flags.get('json') === 'true') {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2))
  } else {
    printReport(report)
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error('draft-skills: ' + error.message)
    console.error('Try: node scripts/draft-skills.mjs --help')
    process.exitCode = 1
  }
}

