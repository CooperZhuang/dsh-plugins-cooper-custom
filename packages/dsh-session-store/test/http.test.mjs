/**
 * `dsh-session-store/http` 的单测：响应封装、请求体读取、前缀路由骨架。
 *
 * 路由协议（403/404/200/400 的响应体）是两个插件对浏览器半边的公开契约，
 * 这里逐条钉死；信任栅栏本身**不在这里**，测试用回调模拟。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createApiHandler, readJsonBody, writeJson } from '../lib/http.js'

/** 假响应：收集状态码、响应头与 body。 */
function fakeRes() {
  const out = { status: 0, headers: undefined, body: '' }
  return {
    out,
    res: {
      writeHead(status, headers) {
        out.status = status
        out.headers = headers
      },
      end(text) {
        out.body = text
      },
    },
  }
}

/** 假请求：GET 用 query，其余方法读这里给的 JSON 载荷；默认带一个受信的 Host 头。 */
function fakeReq({ url, method = 'GET', payload, chunks, host = '127.0.0.1:3080' }) {
  const parts = chunks ?? (payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')])
  return {
    url,
    method,
    headers: host === undefined ? {} : { host },
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part
    },
  }
}

test('writeJson 写 JSON 响应；contentLength 开关决定是否带 content-length', () => {
  const plain = fakeRes()
  writeJson(plain.res, 200, { ok: true, value: { a: 1 } })
  assert.equal(plain.out.status, 200)
  assert.equal(plain.out.body, '{"ok":true,"value":{"a":1}}')
  assert.deepEqual(plain.out.headers, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })

  const lengthed = fakeRes()
  writeJson(lengthed.res, 200, { ok: true }, { contentLength: true })
  assert.equal(lengthed.out.headers['content-length'], Buffer.byteLength('{"ok":true}'))
})

test('readJsonBody 宽松模式：不 trim、不校验类型（admin 原行为）', async () => {
  assert.deepEqual(await readJsonBody(fakeReq({ url: '/x', method: 'POST' })), {})
  assert.deepEqual(await readJsonBody(fakeReq({ url: '/x', method: 'POST', payload: { a: 1 } })), { a: 1 })
  // 数组照收（宽松模式的语义就是不拦）
  assert.deepEqual(await readJsonBody(fakeReq({ url: '/x', method: 'POST', payload: [1, 2] })), [1, 2])
  // 空白 body 会让 JSON.parse 抛（进 HTTP 面就是 400），与改动前逐字一致。
  await assert.rejects(() => readJsonBody(fakeReq({ url: '/x', method: 'POST', chunks: [Buffer.from('  ')] })), SyntaxError)
  await assert.rejects(() => readJsonBody(fakeReq({ url: '/x', method: 'POST', chunks: [Buffer.from('{oops')] })), SyntaxError)
})

test('readJsonBody 严格模式：trim 后空串算 {}，非普通对象一律拒绝（move 原行为）', async () => {
  assert.deepEqual(await readJsonBody(fakeReq({ url: '/x', method: 'POST' }), { requireObject: true }), {})
  assert.deepEqual(await readJsonBody(fakeReq({ url: '/x', method: 'POST', chunks: [Buffer.from('   ')] }), { requireObject: true }), {})
  assert.deepEqual(await readJsonBody(fakeReq({ url: '/x', method: 'POST', payload: { a: 1 } }), { requireObject: true }), { a: 1 })
  await assert.rejects(() => readJsonBody(fakeReq({ url: '/x', method: 'POST', payload: [1] }), { requireObject: true }), /request body must be a JSON object/)
  await assert.rejects(() => readJsonBody(fakeReq({ url: '/x', method: 'POST', chunks: [Buffer.from('null')] }), { requireObject: true }), /request body must be a JSON object/)
})

test('readJsonBody 对超过 1 MiB 的请求体直接拒绝', async () => {
  const big = [Buffer.alloc(600 * 1024, 0x20), Buffer.alloc(600 * 1024, 0x20)]
  await assert.rejects(() => readJsonBody(fakeReq({ url: '/x', method: 'POST', chunks: big })), /request body too large/)
})

/** 造一个只关心协议的路由：两个方法 + 一个会抛错的方法。 */
function route(options = {}) {
  const warnings = []
  const handler = createApiHandler({
    prefix: '/demo/api',
    trustRequest: (req) => req.headers?.host === '127.0.0.1:3080',
    log: (level, message) => warnings.push(`${level}: ${message}`),
    methods: {
      ping: async () => ({ pong: true }),
      echo: async (payload) => payload,
      boom: async () => { throw new Error('kaboom') },
    },
    ...options,
  })
  return { handler, warnings }
}

test('createApiHandler：受信请求 → 200 {ok:true,value}', async () => {
  const { handler } = route()
  const res = fakeRes()
  await handler(fakeReq({ url: '/demo/api/ping', method: 'POST', payload: {} }), res.res)
  assert.equal(res.out.status, 200)
  assert.deepEqual(JSON.parse(res.out.body), { ok: true, value: { pong: true } })
})

test('createApiHandler：GET 的载荷来自 query string', async () => {
  const { handler } = route()
  const res = fakeRes()
  await handler(fakeReq({ url: '/demo/api/echo?scope=temp&limit=5' }), res.res)
  assert.deepEqual(JSON.parse(res.out.body), { ok: true, value: { scope: 'temp', limit: '5' } })
})

test('createApiHandler：不受信 → 403，且不碰方法表', async () => {
  const { handler, warnings } = route()
  const res = fakeRes()
  await handler(fakeReq({ url: '/demo/api/ping', method: 'POST', payload: {}, host: '10.0.0.5:3080' }), res.res)
  assert.equal(res.out.status, 403)
  assert.deepEqual(JSON.parse(res.out.body), { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
  assert.deepEqual(warnings, [])
  // 没有 trustRequest 回调时一律拒绝（安全的那一侧）
  const bare = createApiHandler({ prefix: '/demo/api', methods: {}, trustRequest: undefined })
  const res2 = fakeRes()
  await bare(fakeReq({ url: '/demo/api/ping' }), res2.res)
  assert.equal(res2.out.status, 403)
})

test('createApiHandler：路径与前缀的关系决定 404 文案', async () => {
  const { handler } = route()
  for (const url of ['/demo/api', '/other/api/ping', '/demo/api/a/b']) {
    const res = fakeRes()
    await handler(fakeReq({ url, method: 'POST', payload: {} }), res.res)
    assert.equal(res.out.status, 404, url)
    assert.deepEqual(JSON.parse(res.out.body), { ok: false, error: { code: 'not-found', message: 'unknown method' } })
  }
  // 前缀 + 斜杠之后是空方法名：它不匹配任何方法，所以按「方法名」那条文案回话
  // （文案里带着那个空的 `${method}`，与改动前逐字一致）。
  const empty = fakeRes()
  await handler(fakeReq({ url: '/demo/api/', method: 'POST', payload: {} }), empty.res)
  assert.equal(empty.out.status, 404)
  assert.deepEqual(JSON.parse(empty.out.body), { ok: false, error: { code: 'not-found', message: 'unknown method ' } })

  const res = fakeRes()
  await handler(fakeReq({ url: '/demo/api/nope', method: 'POST', payload: {} }), res.res)
  assert.equal(res.out.status, 404)
  assert.deepEqual(JSON.parse(res.out.body), { ok: false, error: { code: 'not-found', message: 'unknown method nope' } })
})

test('createApiHandler：处理器抛错 → 400 + 一行 warn 日志', async () => {
  const { handler, warnings } = route()
  const res = fakeRes()
  await handler(fakeReq({ url: '/demo/api/boom', method: 'POST', payload: {} }), res.res)
  assert.equal(res.out.status, 400)
  assert.deepEqual(JSON.parse(res.out.body), { ok: false, error: { code: 'bad-request', message: 'kaboom' } })
  assert.deepEqual(warnings, ['warn: boom failed: kaboom'])
})

test('createApiHandler：readBody / contentLength 开关透传', async () => {
  const { handler } = route({
    readBody: (req) => readJsonBody(req, { requireObject: true }),
    contentLength: true,
  })
  const res = fakeRes()
  await handler(fakeReq({ url: '/demo/api/echo', method: 'POST', payload: { a: 1 } }), res.res)
  assert.equal(res.out.headers['content-length'], Buffer.byteLength(res.out.body))
  // 严格模式下空 body 是 {}（而不是按宽松模式抛错）
  const typed = route({ readBody: (req) => readJsonBody(req, { requireObject: true }) })
  const res2 = fakeRes()
  await typed.handler(fakeReq({ url: '/demo/api/echo', method: 'POST' }), res2.res)
  assert.deepEqual(JSON.parse(res2.out.body), { ok: true, value: {} })
})
