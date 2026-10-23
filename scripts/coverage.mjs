#!/usr/bin/env node
/**
 * One-command coverage report for the memory store.
 *
 * The plugin injects a bounded summary once per conversation and recalls a
 * handful of memories per turn, but nothing measures what that actually costs
 * or who never gets seen. This script answers that with four comparable
 * numbers, read-only, zero dependencies beyond Node itself:
 *
 * 1. `exposureCoverage` — share of LIVE entries whose title ever appeared in an
 *    injected summary block or in an on-demand recall block.
 * 2. `deadEntries` — share of LIVE entries with no row in `state.db`'s `usage`
 *    table (`usage` is keyed by `(scope, id)`), i.e. never injected or read.
 * 3. `topConcentration` — share of all injected entry-slots taken by the two
 *    most frequently injected titles, as a percentage. Also prints the top five.
 * 4. `archivedAfterExposure` — how many distinct titles that were ever injected
 *    now live in `archive/*.md` and are no longer live.
 *
 * Usage:
 *
 * ```bash
 * node scripts/coverage.mjs                     # ~/.dsh (or $DSH_HOME)
 * node scripts/coverage.mjs --json              # exactly the four numbers
 * node scripts/coverage.mjs --home=C:/some/.dsh
 * ```
 *
 * Both inputs that can be absent are tolerated: a missing session-log tree or
 * state database prints a clear line, leaves the dependent numbers `null`, and
 * the script keeps going. Only a missing store directory turns into exit 1.
 *
 * What a bullet looks like, and why the parse is deliberately narrow:
 *
 * - The injected summary renders `- 📌 Title [tags] (YYYY-MM-DD) — body` (the
 *   pin emoji and its space only for pinned entries) and the recall block
 *   renders `- [kind] Title [tags] — body`. The title is everything up to the
 *   LAST ` [tags] (date)` group, because titles themselves may contain ` [`.
 *   Do NOT put a `(?:\\S+ )?` group in front of the title: it eats the first
 *   word of every title that does not start with the pin emoji.
 * - An entry with an EMPTY tag list has no bracket group at all, because the
 *   renderer omits it: the bullet is `- 📌 Title (YYYY-MM-DD) — body` (same
 *   with ` (YYYY-MM-DD 快照)` for a snapshot). That shape is accepted too —
 *   otherwise every tagless entry silently vanishes from coverage and slots.
 *   `- … N more not shown` is the truncated-tail sentinel, never an entry.
 * - Session logs are append-only series of concatenated zstd frames, and the
 *   summary text inside a JSONL line carries its newlines as the two-character
 *   escape `\\n`. The documented parser therefore unescapes those before
 *   splitting lines (see {@link unescapeNewlines}).
 * - Only user messages carrying a plugin memory source are true injections.
 *   A block quoted back by a tool result or an assistant message is an echo of
 *   the logs under audit, not an injection, and counting it would make every
 *   measurement depend on how much the logs themselves get discussed.
 *
 * @module dsh-memories/scripts/coverage
 */
import { access, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Opening frame of the injected summary block (mirrors src/render.ts). */
const SUMMARY_OPEN = '<memory-context>'
/** Closing frame of the injected summary block. */
const SUMMARY_CLOSE = '</memory-context>'
/** Opening frame of the on-demand recall block. */
const RECALL_OPEN = '<memory-recall>'
/** Closing frame of the on-demand recall block. */
const RECALL_CLOSE = '</memory-recall>'
/** Pin marker the summary renderer prefixes to a pinned entry's bullet. */
const PIN = '📌 '
/**
 * One injected summary bullet, up to the trailing tag list + date stamp.
 *
 * Greedy `(.*)` is what makes this pick the LAST ` [tags] (date)` pair, which
 * is the documented rule; a title may itself contain ` [`.
 */
const TAGGED_SUMMARY = /^(.*) \[[^\]]+\] \((\d{4}-\d{2}-\d{2})(?: 快照)?\) — /u
/**
 * The same bullet for an entry with an EMPTY tag list: the renderer then emits
 * no bracket group at all, so the date stamp follows the title directly
 * (`- Title (YYYY-MM-DD) — body`). Skipping these would silently drop real,
 * tagless entries from both exposure coverage and the concentration slots.
 */
const UNTAGGED_SUMMARY = /^(.*) \((\d{4}-\d{2}-\d{2})(?: 快照)?\) — /u
/** The block's truncated-tail sentinel, e.g. `- … 196 more not shown`. */
const ELLIPSIS_BULLET = /^- … /u
/** One recall bullet, up to the trailing tag list before `— body`. */
const TAGGED_RECALL = /^(.*) \[[^\]]+\] — /u
/** The kind prefix recall bullets carry, e.g. `[failure]`. */
const RECALL_KIND = /^\[[a-z]+\] /u
/** A session log file, whatever the DSH version called the log. */
const SESSION_LOG = /^session.*\.jsonl\.zstd$/u
/** Zstd frame magic number, used only for the per-frame fallback decode. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Parse `--flag` / `--flag=value`. */
function parseArgs(argv) {
  const flags = {}
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/u.exec(arg)
    if (match !== null) flags[match[1]] = match[2] ?? 'true'
  }
  return flags
}

/** `readdir` that reports a missing directory as `null` instead of throwing. */
async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

/** `readFile` that reports a missing/unreadable file as `null`. */
async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Whether one path exists. */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Human-readable form of an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The comparison key for a title: the store's own identity is the title minus
 * all whitespace, so a title re-wrapped by the renderer still matches its file.
 */
function titleKey(title) {
  return title.normalize('NFC').replace(/\s+/gu, '')
}

/** Strip one pair of surrounding YAML quotes. */
function unquote(value) {
  const match = /^(['"])(.*)\1$/u.exec(value)
  return match === null ? value : match[2]
}

/**
 * Parse the minimal YAML frontmatter the store writes: `key: value` lines
 * between the opening `---` and the next `---`. Anything fancier (lists,
 * block scalars) is not needed for `title`, `id`, `scope`.
 */
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return null
  const fields = {}
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '---') return fields
    const match = /^([A-Za-z_][\w-]*):\s?(.*)$/u.exec(line)
    if (match !== null) fields[match[1]] = match[2]
  }
  return null
}

/**
 * Every live entry: `<memories>/entries/*.md` (global) and one
 * `<memories>/projects/<project>/entries/*.md` tree per project scope.
 *
 * @returns entries, per-scope counts, the directories that were missing, and
 * whether the store itself exists.
 */
async function readLiveEntries(storeDir) {
  const entries = []
  const groups = []
  const missing = []

  const globalDir = join(storeDir, 'entries')
  const globalFiles = await listDir(globalDir)
  if (globalFiles === null) missing.push(globalDir)
  else groups.push({ scope: 'global', dir: globalDir, files: globalFiles })

  const projectsDir = join(storeDir, 'projects')
  const projects = await listDir(projectsDir)
  if (projects === null) missing.push(projectsDir)
  else {
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const dir = join(projectsDir, project.name, 'entries')
      const files = await listDir(dir)
      if (files === null) continue
      groups.push({ scope: 'project', dir, files })
    }
  }

  for (const group of groups) {
    for (const file of group.files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue
      const path = join(group.dir, file.name)
      const text = await readText(path)
      const fields = text === null ? null : parseFrontmatter(text)
      const scope = fields?.scope === 'global' || fields?.scope === 'project' ? fields.scope : group.scope
      entries.push({
        file: path,
        scope,
        id: fields?.id === undefined ? file.name.replace(/\.md$/u, '') : unquote(fields.id),
        title: fields?.title === undefined ? null : unquote(fields.title),
      })
    }
  }
  const global = entries.filter((entry) => entry.scope === 'global').length
  return { entries, global, project: entries.length - global, missing }
}

/** Normalized titles of every archived entry: `<memories>/archive/*.md`. */
async function readArchivedTitles(storeDir) {
  const dir = join(storeDir, 'archive')
  const files = await listDir(dir)
  if (files === null) return { files: 0, titles: new Set(), missing: true }
  const titles = new Set()
  let count = 0
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.md')) continue
    count += 1
    const text = await readText(join(dir, file.name))
    const fields = text === null ? null : parseFrontmatter(text)
    if (fields?.title === undefined) continue
    titles.add(titleKey(unquote(fields.title)))
  }
  return { files: count, titles, missing: false }
}

/**
 * Which `(scope, id)` pairs the state database has a usage row for.
 *
 * `node:sqlite` is imported defensively: on a runtime without it the caller
 * prints a warning, skips section 2, and the rest of the report still works.
 */
async function readUsageKeys(storeDir, warn) {
  const dbPath = join(storeDir, 'state.db')
  if (!(await exists(dbPath))) {
    warn(`state db not found: ${dbPath} — deadEntries skipped`)
    return null
  }
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    warn('node:sqlite is unavailable on this runtime — deadEntries skipped')
    return null
  }
  let db
  try {
    // READ-ONLY on purpose: the report must never touch the live store.
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    warn(`state db could not be opened read-only: ${messageOf(error)} — deadEntries skipped`)
    return null
  }
  try {
    const rows = db.prepare('select scope, id from usage').all()
    const keys = new Set()
    for (const row of rows) keys.add(`${String(row.scope)}\u0000${String(row.id)}`)
    return { keys, rows: rows.length }
  } catch (error) {
    warn(`state.db has no readable usage table: ${messageOf(error)} — deadEntries skipped`)
    return null
  } finally {
    try {
      db.close()
    } catch {
      // A failed close on a read-only handle must not hide the numbers.
    }
  }
}

/**
 * Decompress one session log.
 *
 * Logs are successive concatenated zstd frames; current Node decodes the whole
 * chain in one call, but a hand-merged or repaired log can still need the frame
 * walk, so that stays as the fallback.
 */
function decodeLog(buffer) {
  try {
    return zstdDecompressSync(buffer).toString('utf8')
  } catch {
    // Fall through to the per-frame walk.
  }
  const offsets = []
  let index = buffer.indexOf(ZSTD_MAGIC)
  while (index >= 0) {
    offsets.push(index)
    index = buffer.indexOf(ZSTD_MAGIC, index + 4)
  }
  const parts = []
  for (let frame = 0; frame < offsets.length; frame += 1) {
    const start = offsets[frame]
    const end = frame + 1 < offsets.length ? offsets[frame + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      // Not a standalone frame boundary; skip.
    }
  }
  return parts.join('')
}

/** Every session log under `<home>/sessions`, recursively. */
async function findSessionLogs(sessionsDir) {
  const out = []
  const stack = [sessionsDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    const entries = await listDir(dir)
    if (entries === null) continue
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && SESSION_LOG.test(entry.name)) out.push(path)
    }
  }
  return out.sort()
}

/** The text of one message event's content parts. */
function contentText(event) {
  const content = event?.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (typeof part?.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * Whether one event is a real memory injection.
 *
 * The plugin labels its messages with its own source kind; older kernels used
 * the shared `plugin` kind, which is why both are accepted.
 */
function isMemoryInjection(event) {
  if (event?.type !== 'user/message') return false
  const kind = event?.data?.source?.kind
  return kind === 'plugin:memories' || kind === 'plugin'
}

/** Every framed block in one text, opening and closing frame included. */
function matchBlocks(text, open, close) {
  const blocks = []
  let from = 0
  for (;;) {
    const start = text.indexOf(open, from)
    if (start < 0) break
    const end = text.indexOf(close, start + open.length)
    if (end < 0) break
    blocks.push(text.slice(start, end + close.length))
    from = end + close.length
  }
  return blocks
}

/**
 * The literal two-character `\n` escape inside a JSONL line is a real newline
 * once decoded. The documented block format is line-based, so the unescape is
 * what the parsers operate on.
 */
function unescapeNewlines(text) {
  return text.split('\\n').join('\n')
}

/**
 * Titles of the entries listed in one injected summary block.
 *
 * @returns the titles plus the number of `- ` lines seen and parsed.
 */
function summaryTitles(block) {
  const titles = []
  let lines = 0
  let sentinels = 0
  let untagged = 0
  for (const raw of block.split('\n')) {
    if (!raw.startsWith('- ')) continue
    lines += 1
    if (ELLIPSIS_BULLET.test(raw)) {
      sentinels += 1
      continue
    }
    let line = raw.slice(2)
    if (line.startsWith(PIN)) line = line.slice(PIN.length)
    let match = TAGGED_SUMMARY.exec(line)
    if (match === null) {
      match = UNTAGGED_SUMMARY.exec(line)
      if (match === null) continue
      untagged += 1
    }
    const title = match[1].trim()
    if (title.length > 0) titles.push(title)
  }
  return { titles, lines, sentinels, untagged }
}

/** Titles of the entries listed in one recall block. */
function recallTitles(block) {
  const titles = []
  let lines = 0
  for (const raw of block.split('\n')) {
    if (!raw.startsWith('- ')) continue
    lines += 1
    const line = raw.slice(2).replace(RECALL_KIND, '')
    const match = TAGGED_RECALL.exec(line)
    if (match === null) continue
    const title = match[1].trim()
    if (title.length > 0) titles.push(title)
  }
  return { titles, lines }
}

/**
 * Read every session log and collect what was ever injected and recalled.
 *
 * Primary source: real injections (plugin messages). When no log yields one —
 * an older log format, or a store that was never injected this way — fall back
 * to the documented raw-text scan, unescape and frame walk only.
 */
async function scanSessionLogs(sessionsDir, warn) {
  const logs = await findSessionLogs(sessionsDir)
  const injected = new Map() // titleKey -> { title, count }
  const recalled = new Set() // titleKey
  const stats = {
    logs: logs.length,
    skippedLogs: 0,
    injectedBlocks: 0,
    recallBlocks: 0,
    summaryLines: 0,
    summaryParsed: 0,
    summarySentinels: 0,
    summaryUntagged: 0,
    recallLines: 0,
    recallParsed: 0,
    fallback: false,
  }
  for (const path of logs) {
    const raw = await readFile(path).catch(() => null)
    if (raw === null) {
      stats.skippedLogs += 1
      continue
    }
    let text
    try {
      text = decodeLog(raw)
    } catch {
      stats.skippedLogs += 1
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes(SUMMARY_OPEN) && !line.includes(RECALL_OPEN)) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!isMemoryInjection(event)) continue
      const body = contentText(event)
      if (!body.includes(SUMMARY_OPEN) && !body.includes(RECALL_OPEN)) continue
      for (const block of matchBlocks(body, SUMMARY_OPEN, SUMMARY_CLOSE)) {
        stats.injectedBlocks += 1
        const parsed = summaryTitles(block)
        stats.summaryLines += parsed.lines
        stats.summaryParsed += parsed.titles.length
        stats.summarySentinels += parsed.sentinels
        stats.summaryUntagged += parsed.untagged
        for (const title of parsed.titles) {
          const key = titleKey(title)
          const record = injected.get(key)
          if (record === undefined) injected.set(key, { title, count: 1 })
          else record.count += 1
        }
      }
      for (const block of matchBlocks(body, RECALL_OPEN, RECALL_CLOSE)) {
        stats.recallBlocks += 1
        const parsed = recallTitles(block)
        stats.recallLines += parsed.lines
        stats.recallParsed += parsed.titles.length
        for (const title of parsed.titles) recalled.add(titleKey(title))
      }
    }
  }
  if (injected.size === 0 && stats.recallBlocks === 0 && logs.length > 0 && !stats.fallback) {
    stats.fallback = true
    warn('no plugin-labeled injection found in the session logs; falling back to the documented raw-text scan')
    for (const path of logs) {
      const raw = await readFile(path).catch(() => null)
      if (raw === null) continue
      let text
      try {
        text = unescapeNewlines(decodeLog(raw))
      } catch {
        continue
      }
      for (const block of matchBlocks(text, SUMMARY_OPEN, SUMMARY_CLOSE)) {
        stats.injectedBlocks += 1
        const parsed = summaryTitles(block)
        stats.summaryLines += parsed.lines
        stats.summaryParsed += parsed.titles.length
        stats.summarySentinels += parsed.sentinels
        stats.summaryUntagged += parsed.untagged
        for (const title of parsed.titles) {
          const key = titleKey(title)
          const record = injected.get(key)
          if (record === undefined) injected.set(key, { title, count: 1 })
          else record.count += 1
        }
      }
      for (const block of matchBlocks(text, RECALL_OPEN, RECALL_CLOSE)) {
        stats.recallBlocks += 1
        const parsed = recallTitles(block)
        stats.recallLines += parsed.lines
        stats.recallParsed += parsed.titles.length
        for (const title of parsed.titles) recalled.add(titleKey(title))
      }
    }
  }
  return { injected, recalled, stats }
}

/** Compact counts for the plugin log, when it exists (context only). */
async function readLogInfo(logPath) {
  const text = await readText(logPath)
  if (text === null) return null
  const lines = text.split(/\r?\n/u)
  let injections = 0
  let recalls = 0
  for (const line of lines) {
    if (line.includes('injected the summary into session')) injections += 1
    else if (/session \S+ recalled /u.test(line)) recalls += 1
  }
  return { lines: lines.length, injections, recalls }
}

/** Round to a fixed number of decimals, preserving `null`. */
function round(value, decimals) {
  if (value === null || !Number.isFinite(value)) return null
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** Share of `part` in `whole`, as a 0..1 ratio or `null`. */
function ratio(part, whole) {
  return whole === 0 ? null : part / whole
}

/** One-line status of a title against the store. */
function titleStatus(key, liveTitles, archivedTitles) {
  if (liveTitles.has(key)) return 'LIVE'
  if (archivedTitles.has(key)) return 'ARCHIVED'
  return 'unknown'
}

/** Assemble every number and the lines the human report prints. */
function buildReport(options) {
  const { home, storeDir, live, archived, usage, scan } = options
  const liveTitles = new Set()
  const liveEntries = live.entries
  for (const entry of liveEntries) if (entry.title !== null) liveTitles.add(titleKey(entry.title))

  const injectedKeys = new Set(scan.injected.keys())
  const recalled = scan.recalled
  const union = new Set([...injectedKeys, ...recalled])

  // Per-entry coverage: an entry is covered when its (normalized) title has
  // been seen, so the two files that happen to share one title both count.
  const coveredEntries = liveEntries.filter((entry) => entry.title !== null && union.has(titleKey(entry.title))).length
  // Raw ratios here; each output mode rounds to its own precision.
  const exposureCoverage = ratio(coveredEntries, liveEntries.length)

  let deadEntries = null
  let deadCount = null
  if (usage !== null) {
    const dead = liveEntries.filter((entry) => !usage.keys.has(`${entry.scope}\u0000${entry.id}`))
    deadCount = dead.length
    deadEntries = ratio(dead.length, liveEntries.length)
  }

  const ranked = [...scan.injected.entries()]
    .map(([key, record]) => ({ key, title: record.title, count: record.count }))
    .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title))
  const slots = ranked.reduce((sum, item) => sum + item.count, 0)
  const top = ranked.slice(0, 2)
  const topTwo = top.reduce((sum, item) => sum + item.count, 0)
  const topConcentration = ratio(topTwo, slots) === null ? null : (topTwo / slots) * 100

  const archivedAfterExposure = [...injectedKeys].filter((key) => archived.titles.has(key) && !liveTitles.has(key)).length

  const topFive = ranked.slice(0, 5).map((item) => ({
    count: item.count,
    status: titleStatus(item.key, liveTitles, archived.titles),
    title: item.title,
  }))

  return {
    home,
    storeDir,
    live,
    archived,
    scan,
    usage,
    liveTitles,
    union,
    injectedKeys,
    recalled,
    coveredEntries,
    exposureCoverage,
    deadEntries,
    deadCount,
    slots,
    top,
    topTwo,
    topConcentration,
    archivedAfterExposure,
    topFive,
  }
}

/** The four numbers, rounded for both output modes. */
function numbers(report) {
  return {
    exposureCoverage: round(report.exposureCoverage, 4),
    deadEntries: round(report.deadEntries, 3),
    topConcentration: round(report.topConcentration, 1),
    archivedAfterExposure: report.archivedAfterExposure,
  }
}

/** Human-readable report. */
function printReport(report, warnings, logPath, logInfo) {
  const stamp = new Date().toLocaleString('sv-SE').replace('T', ' ')
  console.log(`dsh-memories coverage  ${stamp}`)
  console.log(`home    ${report.home}`)
  console.log(`store   ${report.storeDir}`)
  if (report.live.missing.length > 0) console.log(`  missing: ${report.live.missing.join(', ')}`)
  console.log(
    `  live entries ${report.live.entries.length}` +
      ` (global ${report.live.global}, project ${report.live.project})` +
      `  archive ${report.archived.files} files / ${report.archived.titles.size} titles`,
  )
  console.log(
    `logs    ${report.scan.stats.logs} session logs` +
      ` (${report.scan.stats.injectedBlocks} injected blocks, ${report.scan.stats.recallBlocks} recall blocks)` +
      (report.scan.stats.skippedLogs > 0 ? `, ${report.scan.stats.skippedLogs} unreadable` : '') +
      (report.scan.stats.fallback ? ' [raw-text fallback]' : ''),
  )
  console.log(logInfo === null ? `plugin log missing: ${logPath} (the four numbers do not depend on it)` : `plugin log ${logPath} (${logInfo.lines} lines, ${logInfo.injections} injections, ${logInfo.recalls} recalls)`)
  for (const warning of warnings) console.log(`warning: ${warning}`)

  const pct = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`)
  console.log('')
  console.log(
    `1 exposureCoverage      ${pct(report.exposureCoverage).padStart(6)}` +
      `  ${report.coveredEntries} / ${report.live.entries.length} live entries have a title ever injected or recalled`,
  )
  console.log(
    `   components: injected distinct ${report.injectedKeys.size}` +
      ` · recalled distinct ${report.recalled.size}` +
      ` · union ${report.union.size} (${[...report.union].filter((key) => report.liveTitles.has(key)).length} live titles)`,
  )
  console.log(
    `2 deadEntries           ${pct(report.deadEntries).padStart(6)}` +
      `  ${report.deadCount === null ? 'n/a' : `${report.deadCount} / ${report.live.entries.length}`} live entries have no (scope, id) row in state.db usage`,
  )
  console.log(
    `3 topConcentration      ${report.topConcentration === null ? 'n/a' : `${report.topConcentration.toFixed(1)}%`.padStart(6)}` +
      `  top two titles ${report.top.map((item) => item.count).join(' + ') || '0'} = ${report.topTwo} / ${report.slots} parsed injected entry-slots`,
  )
  for (const item of report.topFive) {
    console.log(`     ${String(item.count).padStart(4)}  ${item.status.padEnd(8)}  ${item.title}`)
  }
  const stats = report.scan.stats
  if (stats.summaryUntagged > 0) {
    console.log(`     ${stats.summaryUntagged} of those slots came from tagless entries (no [tags] list in the bullet)`)
  }
  const unparsedSummary = stats.summaryLines - stats.summaryParsed - stats.summarySentinels
  if (unparsedSummary > 0) console.log(`     ${unparsedSummary} '- ' lines matched no entry shape and are not counted as slots`)
  console.log(
    `4 archivedAfterExposure ${String(report.archivedAfterExposure).padStart(6)}` +
      `  injected titles now in archive/*.md and no longer live`,
  )
}

/** Entry point. */
async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const json = flags.json === 'true'
  const home = flags.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const warnings = []
  const warn = (text) => {
    warnings.push(text)
    if (json) console.error(`warning: ${text}`)
  }

  const storeDir = join(home, 'memories')
  const sessionsDir = join(home, 'sessions')
  const logPath = join(home, 'logs', 'dsh-memories.log')

  if (!(await exists(storeDir))) {
    console.error(`store dir not found: ${storeDir}`)
    console.error('pass --home=<dir> to point at the DSH home that holds memories/')
    const empty = { exposureCoverage: null, deadEntries: null, topConcentration: null, archivedAfterExposure: null }
    if (json) console.log(JSON.stringify(empty, null, 2))
    process.exitCode = 1
    return
  }

  const live = await readLiveEntries(storeDir)
  const archived = await readArchivedTitles(storeDir)
  const usage = await readUsageKeys(storeDir, warn)
  const scan = (await exists(sessionsDir))
    ? await scanSessionLogs(sessionsDir, warn)
    : (warn(`session logs not found: ${sessionsDir} — exposure/topConcentration/archivedAfterExposure are empty`),
      { injected: new Map(), recalled: new Set(), stats: { logs: 0, skippedLogs: 0, injectedBlocks: 0, recallBlocks: 0, summaryLines: 0, summaryParsed: 0, summarySentinels: 0, summaryUntagged: 0, recallLines: 0, recallParsed: 0, fallback: false } })
  const logInfo = await readLogInfo(logPath)

  const report = buildReport({ home, storeDir, live, archived, usage, scan })
  if (json) {
    console.log(JSON.stringify(numbers(report), null, 2))
  } else {
    printReport(report, warnings, logPath, logInfo)
  }
}

await main()
