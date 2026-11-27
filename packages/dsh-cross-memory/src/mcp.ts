#!/usr/bin/env node
/**
 * Lightweight stdio MCP server for `dsh-cross-memory`.
 *
 * Exposes the local `$DSH_HOME/memories` store (and `persona/human.md`) to any
 * MCP-capable client — Antigravity, Claude Code, Cursor, Codex, VS Code — with
 * zero extra runtime dependencies. Reads and writes the exact same Markdown
 * files that DSH maintains, using BM25 lexical search plus optional local
 * embedding RRF re-ranking (`qwen3-embedding:0.6b` via Ollama, silent lexical
 * fallback when unreachable).
 *
 * @module dsh-cross-memory/mcp
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DENSE_MODEL, DEFAULT_DENSE_URL, denseScores, rrf } from './dense.js'
import { redactSecrets } from './extract.js'
import { readPersona } from './persona.js'
import { renderEntry, renderHit } from './render.js'
import { browseMemories, searchMemories, suggestAliases } from './search.js'
import type { ScopeEntries } from './search.js'
import { MemoryStore, projectSlug } from './storage.js'
import { toMemoryDurability, toMemoryKind } from './types.js'
import type { MemoryEntry, MemoryHit, MemoryKind, MemoryScope } from './types.js'

/** Protocol version advertised when the client does not specify one. */
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

/** Runtime options for the MCP server. */
export interface McpServerOptions {
  readonly memoriesDir: string
  readonly denseEnabled: boolean
  readonly denseUrl: string
  readonly denseModel: string
}

/** One incoming JSON-RPC 2.0 request or notification. */
export interface JsonRpcRequest {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method: string
  readonly params?: Record<string, unknown>
}

/** One outgoing JSON-RPC 2.0 response. */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

/** Tool definitions exposed to MCP clients (compact on purpose). */
export const MCP_TOOLS = [
  {
    name: 'memory_persona',
    description: 'Read the user profile (persona/human.md): who the user is, their working conventions, standards, environment, and communication preferences. Call this early in a new session when user preferences matter.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description: 'Search durable cross-session memories (global and/or one project workspace) using BM25 + optional local embedding hybrid ranking. Omit query to browse recent entries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (Chinese or English). Empty lists most recent entries.' },
        scope: { type: 'string', enum: ['global', 'project', 'all'], description: 'Target scope; defaults to all (project + global when projectRoot/projectSlug is given, otherwise global).' },
        projectRoot: { type: 'string', description: 'Absolute path of the current workspace root (used to resolve project scope).' },
        projectSlug: { type: 'string', description: 'Explicit project directory slug under memories/projects/ (alternative to projectRoot).' },
        kind: { type: 'string', enum: ['fact', 'preference', 'knowledge', 'failure', 'procedure'], description: 'Filter by memory kind.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase tag filters.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum hits to return (default 8, max 25).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_read',
    description: 'Read the full body and metadata of one memory entry by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry id returned by memory_search.' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'Scope to read from (defaults to project then global).' },
        projectRoot: { type: 'string', description: 'Workspace root for project scope.' },
        projectSlug: { type: 'string', description: 'Explicit project slug for project scope.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_write',
    description: 'Write or update a durable memory entry. Title is the identity (same title updates in place). Credentials and passwords are automatically redacted before persistence.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project'], description: 'global for cross-project facts/preferences, project for one workspace.' },
        title: { type: 'string', description: 'Short imperative heading (max 120 chars).' },
        body: { type: 'string', description: 'Self-contained fact, 1-4 sentences.' },
        kind: { type: 'string', enum: ['fact', 'preference', 'knowledge', 'failure', 'procedure'] },
        tags: { type: 'array', items: { type: 'string' } },
        keys: { type: 'array', items: { type: 'string' }, description: 'Aliases and bilingual search keywords.' },
        appliesTo: { type: 'string', description: 'Short phrase saying when this memory matters.' },
        durability: { type: 'string', enum: ['durable', 'snapshot'] },
        pinned: { type: 'boolean' },
        permanent: { type: 'boolean' },
        projectRoot: { type: 'string', description: 'Workspace root (required when scope=project unless projectSlug is given).' },
        projectSlug: { type: 'string', description: 'Explicit project slug (alternative to projectRoot).' },
      },
      required: ['scope', 'title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_projects',
    description: 'List known project memory scopes with their slugs, recorded workspace roots, and entry counts.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
] as const

/** Resolve default options from environment variables. */
export function defaultMcpOptions(env: NodeJS.ProcessEnv = process.env): McpServerOptions {
  const dshHome = env['DSH_HOME']?.trim() || join(homedir(), '.dsh')
  const memoriesDir = resolve(env['DSH_MEMORIES_DIR']?.trim() || join(dshHome, 'memories'))
  const denseEnv = env['DSH_MEMORY_DENSE']?.trim().toLowerCase()
  const denseEnabled = denseEnv === undefined ? true : !(denseEnv === '0' || denseEnv === 'false' || denseEnv === 'off')
  const denseUrl = env['DSH_MEMORY_DENSE_URL']?.trim() || DEFAULT_DENSE_URL
  const denseModel = env['DSH_MEMORY_DENSE_MODEL']?.trim() || DEFAULT_DENSE_MODEL
  return { memoriesDir, denseEnabled, denseUrl, denseModel }
}

/** Resolve a workspace root argument from either `projectRoot` or `projectSlug`. */
async function resolveProjectRoot(
  store: MemoryStore,
  projectRootArg: unknown,
  projectSlugArg: unknown,
): Promise<string | undefined> {
  if (typeof projectRootArg === 'string' && projectRootArg.trim().length > 0) {
    return resolve(projectRootArg.trim())
  }
  if (typeof projectSlugArg === 'string' && projectSlugArg.trim().length > 0) {
    const slug = projectSlugArg.trim()
    const descriptor = await store.readProjectDescriptor(slug)
    return descriptor?.root ?? join(store.memoriesDir, 'projects', slug)
  }
  return undefined
}

/** Build text tool result envelope. */
function textResult(text: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] }
}

/** Re-rank lexical hits with the optional local dense embedding channel. */
async function maybeDenseRerank(
  hits: readonly MemoryHit[],
  query: string,
  options: McpServerOptions,
  limit: number,
): Promise<readonly MemoryHit[]> {
  if (!options.denseEnabled || hits.length <= 1 || query.trim().length === 0) return hits.slice(0, limit)
  const pool = hits.slice(0, Math.min(hits.length, 32))
  const scores = await denseScores(
    pool.map((hit) => hit.entry),
    query,
    { url: options.denseUrl, model: options.denseModel, cacheDir: join(options.memoriesDir, 'cache') },
  )
  if (scores.size === 0) return hits.slice(0, limit)
  const lexical = pool.map((hit) => hit.entry.id)
  const semantic = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const fused = rrf([lexical, semantic])
  return [...pool]
    .sort((a, b) => (fused.get(b.entry.id) ?? 0) - (fused.get(a.entry.id) ?? 0))
    .slice(0, limit)
}

/** Execute one MCP tool call. */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  store: MemoryStore,
  options: McpServerOptions,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  switch (name) {
    case 'memory_persona': {
      const persona = await readPersona(options.memoriesDir)
      if (persona === undefined) return textResult('No persona profile stored yet.')
      return textResult(persona)
    }
    case 'memory_projects': {
      const slugs = await store.listProjects()
      if (slugs.length === 0) return textResult('No project memory scopes found.')
      const lines: string[] = [`${slugs.length} project scopes:`]
      for (const slug of slugs) {
        const desc = await store.readProjectDescriptor(slug)
        const root = desc?.root ?? join(store.memoriesDir, 'projects', slug)
        const entries = await store.list('project', root).catch(() => [] as readonly MemoryEntry[])
        lines.push(`- ${slug} (${entries.length} entries)${desc?.root ? ` — ${desc.root}` : ''}`)
      }
      return textResult(lines.join('\n'))
    }
    case 'memory_search': {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : ''
      const scopeArg = typeof args['scope'] === 'string' ? args['scope'] : 'all'
      const rawLimit = typeof args['limit'] === 'number' ? args['limit'] : 8
      const limit = Math.min(Math.max(Math.trunc(rawLimit), 1), 25)
      const kind = typeof args['kind'] === 'string' ? toMemoryKind(args['kind']) : undefined
      const tags = Array.isArray(args['tags']) ? args['tags'].filter((t): t is string => typeof t === 'string') : []
      const projectRoot = await resolveProjectRoot(store, args['projectRoot'], args['projectSlug'])

      const groups: ScopeEntries[] = []
      if ((scopeArg === 'all' || scopeArg === 'project') && projectRoot !== undefined) {
        const entries = await store.list('project', projectRoot).catch(() => [] as readonly MemoryEntry[])
        if (entries.length > 0) groups.push({ scope: 'project', label: store.target('project', projectRoot).label, entries })
      }
      if (scopeArg === 'all' || scopeArg === 'global') {
        const entries = await store.list('global', undefined).catch(() => [] as readonly MemoryEntry[])
        if (entries.length > 0) groups.push({ scope: 'global', label: 'global', entries })
      }
      if (groups.length === 0) return textResult('No memories available in the requested scope.')

      const filter = {
        ...tags.length > 0 ? { tags } : {},
        ...kind === undefined ? {} : { kinds: [kind] as readonly MemoryKind[] },
        limit: query.length > 0 ? Math.max(limit * 3, 24) : limit,
      }
      const rawHits = query.length === 0
        ? browseMemories(groups, filter)
        : searchMemories(groups, query, filter)
      const hits = query.length === 0
        ? rawHits.slice(0, limit)
        : await maybeDenseRerank(rawHits, query, options, limit)

      if (hits.length === 0) {
        const hints = query.length === 0 ? [] : suggestAliases(groups, query, 12)
        const hintLine = hints.length === 0
          ? ''
          : `\nAliases/tags in store: ${hints.map((h) => h.term).join(', ')}`
        return textResult(`No memories matched ${JSON.stringify(query)}.${hintLine}`)
      }
      return textResult([`${hits.length} memories:`, ...hits.map((hit, i) => renderHit(hit, i))].join('\n'))
    }
    case 'memory_read': {
      const id = typeof args['id'] === 'string' ? args['id'].trim() : ''
      if (id.length === 0) return textResult('memory_read requires a non-empty id.', true)
      const scopeArg = args['scope'] === 'global' || args['scope'] === 'project' ? args['scope'] : undefined
      const projectRoot = await resolveProjectRoot(store, args['projectRoot'], args['projectSlug'])
      const order: MemoryScope[] = scopeArg !== undefined ? [scopeArg] : projectRoot !== undefined ? ['project', 'global'] : ['global']
      for (const scope of order) {
        if (scope === 'project' && projectRoot === undefined) continue
        const entry = await store.read(scope, scope === 'project' ? projectRoot : undefined, id)
        if (entry !== undefined) return textResult(renderEntry(entry))
      }
      return textResult(`Memory not found: ${id}`, true)
    }
    case 'memory_write': {
      const scope = args['scope'] === 'global' || args['scope'] === 'project' ? args['scope'] : undefined
      const rawTitle = typeof args['title'] === 'string' ? args['title'].trim() : ''
      const rawBody = typeof args['body'] === 'string' ? args['body'].trim() : ''
      if (scope === undefined) return textResult('memory_write requires scope ("global" or "project").', true)
      if (rawTitle.length === 0 || rawBody.length === 0) return textResult('memory_write requires non-empty title and body.', true)
      const projectRoot = scope === 'project' ? await resolveProjectRoot(store, args['projectRoot'], args['projectSlug']) : undefined
      if (scope === 'project' && projectRoot === undefined) {
        return textResult('memory_write with scope="project" requires projectRoot or projectSlug.', true)
      }
      const tags = Array.isArray(args['tags']) ? args['tags'].filter((t): t is string => typeof t === 'string') : []
      const keys = Array.isArray(args['keys']) ? args['keys'].filter((k): k is string => typeof k === 'string') : undefined
      const appliesTo = typeof args['appliesTo'] === 'string' && args['appliesTo'].trim().length > 0
        ? redactSecrets(args['appliesTo'].trim())
        : undefined
      const durability = typeof args['durability'] === 'string' ? toMemoryDurability(args['durability']) : undefined
      const result = await store.upsert({
        scope,
        title: redactSecrets(rawTitle).slice(0, 120),
        body: redactSecrets(rawBody),
        tags,
        ...typeof args['kind'] === 'string' ? { kind: toMemoryKind(args['kind']) } : {},
        ...keys === undefined ? {} : { keys },
        ...appliesTo === undefined ? {} : { appliesTo },
        ...durability === undefined ? {} : { durability, ...durability === 'snapshot' ? { asOf: Date.now() } : {} },
        ...typeof args['pinned'] === 'boolean' ? { pinned: args['pinned'] } : {},
        ...typeof args['permanent'] === 'boolean' ? { permanent: args['permanent'] } : {},
      }, projectRoot, 'tool')
      if (scope === 'project' && projectRoot !== undefined) {
        await store.writeProjectDescriptor(projectRoot).catch(() => undefined)
      }
      return textResult(`${result.action === 'created' ? 'Remembered' : 'Updated'} ${scope}${projectRoot ? `:${projectSlug(projectRoot)}` : ''} memory "${result.entry.title}" (id=${result.entry.id}).`)
    }
    default:
      return textResult(`Unknown tool: ${name}`, true)
  }
}

/** Handle one JSON-RPC 2.0 request. Returns `undefined` for notifications. */
export async function handleMcpRequest(
  request: JsonRpcRequest,
  options: McpServerOptions,
  store = new MemoryStore(options.memoriesDir),
): Promise<JsonRpcResponse | undefined> {
  const id = request.id
  const isNotification = id === undefined
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result })
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

  switch (request.method) {
    case 'initialize': {
      const requested = typeof request.params?.['protocolVersion'] === 'string'
        ? request.params['protocolVersion']
        : DEFAULT_PROTOCOL_VERSION
      return ok({
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-cross-memory', version: '0.2.12' },
      })
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined
    case 'ping':
      return isNotification ? undefined : ok({})
    case 'tools/list':
      return ok({ tools: MCP_TOOLS })
    case 'tools/call': {
      const toolName = typeof request.params?.['name'] === 'string' ? request.params['name'] : ''
      const toolArgs = (typeof request.params?.['arguments'] === 'object' && request.params['arguments'] !== null)
        ? request.params['arguments'] as Record<string, unknown>
        : {}
      try {
        const result = await executeTool(toolName, toolArgs, store, options)
        return ok(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return ok(textResult(`Error: ${message}`, true))
      }
    }
    default:
      return isNotification ? undefined : fail(-32601, `Method not found: ${request.method}`)
  }
}

/** Run the newline-delimited JSON-RPC 2.0 stdio loop. */
export function startStdioServer(options: McpServerOptions = defaultMcpOptions()): void {
  const store = new MemoryStore(options.memoriesDir)
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let parsed: JsonRpcRequest
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`)
      return
    }
    void handleMcpRequest(parsed, options, store).then((response) => {
      if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`)
    })
  })
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirectRun) startStdioServer()
