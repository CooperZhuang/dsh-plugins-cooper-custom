/**
 * Tests for the lightweight stdio MCP server exposing `$DSH_HOME/memories`.
 *
 * @module dsh-cross-memory/test/mcp.test
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { handleMcpRequest } from '../mcp.js'
import type { McpServerOptions } from '../mcp.js'
import { writePersona } from '../persona.js'

test('MCP server supports initialize, tools/list, persona, write (with redaction), search, read, and projects', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cross-memory-mcp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const options: McpServerOptions = {
    memoriesDir: dir,
    denseEnabled: false,
    denseUrl: 'http://127.0.0.1:11434',
    denseModel: 'qwen3-embedding:0.6b',
  }

  const init = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, options)
  assert.equal((init?.result as { protocolVersion: string }).protocolVersion, '2025-03-26')

  const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, options)
  const toolNames = ((listed?.result as { tools: { name: string }[] }).tools).map((tool) => tool.name)
  assert.deepEqual(toolNames, ['memory_persona', 'memory_search', 'memory_read', 'memory_write', 'memory_projects'])

  await writePersona(dir, '## 他怎么工作\n- 中文短句直给。')
  const personaRes = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'memory_persona', arguments: {} },
  }, options)
  const personaText = (personaRes?.result as { content: { text: string }[] }).content[0]!.text
  assert.match(personaText, /中文短句直给/u)

  // Write global memory with a Chinese password to verify automatic redaction
  const writeGlobal = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'memory_write',
      arguments: {
        scope: 'global',
        title: '路由器管理方式',
        body: '小米路由器使用 mi.sh 管理，管理密码 402402402。',
        kind: 'knowledge',
        keys: ['router', 'mi.sh'],
      },
    },
  }, options)
  assert.match((writeGlobal?.result as { content: { text: string }[] }).content[0]!.text, /Remembered global memory/u)

  // Write project memory
  const projectRoot = join(dir, 'fake-repo')
  await handleMcpRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'memory_write',
      arguments: {
        scope: 'project',
        projectRoot,
        title: '构建命令用 pnpm build',
        body: '改动源码后必须运行 pnpm build 重新生成 lib/。',
        kind: 'procedure',
      },
    },
  }, options)

  // Search across project + global
  const searchRes = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'memory_search', arguments: { query: '路由器 mi.sh', projectRoot } },
  }, options)
  const searchText = (searchRes?.result as { content: { text: string }[] }).content[0]!.text
  assert.match(searchText, /路由器管理方式/u)

  // Read back and verify password was redacted
  const readRes = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'memory_read', arguments: { id: '路由器管理方式', scope: 'global' } },
  }, options)
  const readText = (readRes?.result as { content: { text: string }[] }).content[0]!.text
  assert.match(readText, /\[redacted\]/u)
  assert.doesNotMatch(readText, /402402402/u)

  // List projects
  const projectsRes = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'memory_projects', arguments: {} },
  }, options)
  const projectsText = (projectsRes?.result as { content: { text: string }[] }).content[0]!.text
  assert.match(projectsText, /fake-repo \(1 entries\)/u)
})
