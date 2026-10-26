/**
 * 浏览器半边的接线测试：在 Node 里模拟 `window.__ModuleLoader__` 把合并后的 bundle 跑一遍。
 *
 * 这个文件是 `dsh-session-move/test/client.test.mjs` 的加强版——合并后一个 bundle 里同时
 * 住着两个半边，所以原来只断言"搬迁半边那两张脸"的用例，扩成对**两半**的页签、入口、
 * 垃圾桶、数据面前缀与那张合并配置卡片的断言（合并前 admin 那边没有客户端测试）。
 *
 * 只碰"注册"，不渲染组件（除了最后一条卡片用例：它用一个极简 React 桩把卡片渲染成
 * 元素树，只为数清 7 个旋钮）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 当前这轮 `fetch` 收到的 URL（数据面断言用）。 */
let fetched = []
/** 当前这轮 `config` 接口的应答（垃圾桶用例用）。 */
let configReply = { headerDeleteButton: true }

// bundle 是写给浏览器外壳的：挂载时它 `setInterval(…, 120_000)` 起角标轮询，并发
// `fetch('/session-admin/api/count')` 这类**相对 URL**。在 Node 里这两件事都必须换掉：
// 真定时器会重复触发、让本进程永不退出；相对 URL 的 fetch 会直接抛。测试只关心"注册了
// 什么、请求打到哪"，所以进程级替换掉这两个全局即可。
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.fetch = async (url) => {
  fetched.push(String(url))
  return { status: 200, json: async () => ({ ok: true, value: configReply }) }
}

/**
 * 极简 React 桩。
 *
 * `useState` 必须**吃掉初值**：卡片组件会 `Object.hasOwn(drafts, key)`，返回 `undefined`
 * 会直接抛。`createElement` 产出的树下面用 `flatten` 摊平后数控件。
 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}

/** 把 `React.createElement` 产出的树摊平成元素数组（字符串/数字子节点忽略）。 */
function flatten(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out)
    return out
  }
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  flatten(node.children, out)
  return out
}

/** 把 bundle 当经典脚本"加载"一遍，返回它的插件对象。 */
function loadBundle() {
  let plugin
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-session-toolbox', '合并后只有一个 loader id')
        plugin = factory((name) => {
          if (name === 'react') return ReactStub
          throw new Error(`unexpected require(${name})`)
        })
      },
    },
  }
  const source = globalThis.__bundleSource
  const run = new Function('window', 'globalThis', `globalThis.window = window;\n${source}\nreturn undefined`)
  run(window, { window })
  return plugin
}

/** 记录注册动作的假客户端 ctx（与源仓库同形，另存下槽位组件）。 */
function fakeClientCtx({ betterSidebar } = {}) {
  const state = { registered: [], injected: [], effects: [], configFormIds: [], mutations: [] }
  const tabs = {
    register: (definition) => (state.registered.push({ surface: 'sidebarRightTabs', definition }), () => {}),
  }
  const slots = {
    inject(key, callback) {
      state.injected.push(key)
      callback()
      return { dispose() {} }
    },
    register(options, component) {
      state.registered.push({ surface: options.name, options, component })
      return { dispose() {} }
    },
  }
  // 共享配置表单：与 `ConfigFormController` 同形（`getSnapshot` / `subscribe` / `mutate`）。
  // 卡片自己 `ctx.configForms.get('session-toolbox')` 取它，注册项的 `inject` 再把它
  // 转成卡片认识的 `{ state, mutate }`。
  const configForm = {
    getSnapshot: () => ({ status: 'ready', value: {}, user: {}, revision: 4, writable: true }),
    subscribe: () => () => {},
    mutate: (ops, revision) => {
      state.mutations.push({ ops, revision })
      return Promise.resolve()
    },
  }
  const configForms = {
    get(entryId) {
      state.configFormIds.push(entryId)
      return configForm
    },
  }
  const injectedStub = {
    get(name) {
      if (name === 'sidebarRightTabs') return tabs
      if (name === 'sidebarRight') return { openTab: () => {} }
      if (name === 'betterSidebar') return betterSidebar
      return undefined
    },
  }
  const ctx = {
    slots,
    configForms,
    inject(_services, callback) {
      callback(injectedStub)
      return undefined
    },
    effect(fn, label) {
      state.effects.push(label)
      fn()
      return () => {}
    },
    get() {
      return undefined
    },
  }
  return { ctx, state }
}

/** 读 bundle 源码并把它放进 `globalThis.__bundleSource`，跑一遍加载并 apply。 */
async function mount({ betterSidebar } = {}) {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  globalThis.__bundleSource = source
  let plugin
  try {
    plugin = loadBundle()
  } finally {
    delete globalThis.__bundleSource
  }
  const { ctx, state } = fakeClientCtx({ betterSidebar })
  plugin.apply(ctx)
  // 垃圾桶那次 `config` 请求是异步的，给它一个 microtask/宏任务的机会。
  await new Promise((resolve) => setTimeout(resolve, 10))
  return { plugin, ctx, state }
}

/** 注册表里所有 `sidebar.right.pane.tab` 的 key。 */
const paneTabKeys = (state) =>
  state.registered.filter((entry) => entry.options?.name === 'sidebar.right.pane.tab').map((entry) => entry.options.key)

test('两半的右栏页签、设置页 section 与插件页配置槽都注册上，左栏入口已移除（原生路径）', async () => {
  fetched = []
  configReply = { headerDeleteButton: true }
  const { plugin, state } = await mount()
  assert.deepEqual(plugin.inject, ['slots', 'sessions', 'configForms'], 'inject 是两半的并集（+ 配置卡片要的 configForms）')

  const surfaces = state.registered.map((entry) => entry.surface ?? entry.definition?.kind)
  // 2026-10-26 起左栏底部的 ⇄ 入口不再注册：会话归位只保留右栏页签（回归护栏）。
  assert.ok(!surfaces.includes('sidebar.footer.action'), `footer entry should be gone: ${surfaces.join(',')}`)
  assert.ok(surfaces.includes('sidebar.right.pane.tab'), `missing pane body: ${surfaces.join(',')}`)
  assert.ok(surfaces.includes('sidebar.right.pane.tab.title'), `missing pane title: ${surfaces.join(',')}`)
  // 设置页那一项是**清理面板页**（不是配置菜单），因此保留。
  assert.ok(surfaces.includes('settings.section'), `missing settings section: ${surfaces.join(',')}`)
  // 配置卡片在插件页的组合包页面槽里。
  assert.ok(surfaces.includes('plugins.bundle.config'), `missing bundle config: ${surfaces.join(',')}`)

  // 两条原生页签：kind/id 与合并前逐字一致（浏览器半边按 kind 打开页签）。
  const definitions = state.registered.filter((entry) => entry.surface === 'sidebarRightTabs').map((entry) => entry.definition)
  assert.deepEqual(definitions.map((definition) => definition.kind).sort(), ['dsh-session-admin:manager', 'dsh-session-move:panel'])
  assert.deepEqual(definitions.map((definition) => definition.title()).sort(), ['会话归位', '会话管理'])
  // 页签 body 用同一个 kind 作为 key。
  assert.deepEqual(paneTabKeys(state).sort(), ['dsh-session-admin:manager', 'dsh-session-move:panel'])
  assert.deepEqual(
    state.registered.filter((entry) => entry.options?.name === 'sidebar.right.pane.tab.title').map((entry) => entry.options.key).sort(),
    ['dsh-session-admin:manager', 'dsh-session-move:panel'],
  )
})

test('装了 better-sidebar 时两半都改走它的 registerTab', async () => {
  fetched = []
  configReply = { headerDeleteButton: true }
  const calls = []
  const betterSidebar = {
    registerTab(definition) {
      calls.push(definition)
      return () => {}
    },
  }
  const { state } = await mount({ betterSidebar })

  // 两半各注册一次（合并前是两个插件各一次）；id 互不相同，否则 betterSidebar 的注册表会撞。
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((entry) => entry.id).sort(), [
    'dsh-session-admin:manager-via-better-sidebar',
    'dsh-session-move:panel-via-better-sidebar',
  ])
  for (const definition of calls) {
    assert.equal(definition.single, true)
    assert.equal(typeof definition.component, 'function')
    assert.equal(typeof definition.title(), 'string')
  }
  // better-sidebar 在场时两半都撤掉原生那条：原生页签注册过、又被 dispose，只剩 2 次注册记录。
  const nativeDefinitions = state.registered.filter((entry) => entry.surface === 'sidebarRightTabs')
  assert.equal(nativeDefinitions.length, 2, 'native tabs should be registered then disposed')
})

test('标题栏垃圾桶：Host 说不显示就不注册；说显示才注册（id 保持原样）', async () => {
  configReply = { headerDeleteButton: false }
  const off = await mount()
  assert.equal(
    off.state.registered.some((entry) => entry.surface === 'conversation.session.header.utilities'),
    false,
    'headerDeleteButton=false 时不该露出垃圾桶',
  )

  configReply = { headerDeleteButton: true }
  const on = await mount()
  const header = on.state.registered.find((entry) => entry.surface === 'conversation.session.header.utilities')
  assert.equal(header?.options.id, 'dsh-session-admin:delete-current')
  assert.equal(header?.options.registrant, 'dsh-session-toolbox')
  assert.equal(typeof header?.component, 'function')
})

test('数据面：两个半边各打各的前缀', async () => {
  fetched = []
  configReply = { headerDeleteButton: true }
  await mount()
  // 这一次挂载打出去的两个请求都在删除半边的前缀下：角标的 `count` 与垃圾桶开关的 `config`。
  assert.deepEqual(fetched.slice().sort(), ['/session-admin/api/config', '/session-admin/api/count'])
  assert.ok(
    fetched.every((url) => url.startsWith('/session-admin/api')),
    `搬迁半边不该在自己的挂载期打请求，更不该打到别的半边的前缀：${fetched.join(',')}`,
  )
})

test('合并后的配置卡片：只注册一张（插件页 plugins.bundle.config，key = 包名），7 个旋钮都在', async () => {
  fetched = []
  configReply = { headerDeleteButton: true }
  const { state } = await mount()

  // 配置的**唯一**注册处：插件页本组合包页面的配置槽，key 是包的 package name。
  // 原来那处 `plugins.row.config`（key `dsh-session-toolbox#session-toolbox`）已摘掉。
  const cards = state.registered.filter((entry) => entry.surface === 'plugins.bundle.config')
  assert.equal(cards.length, 1, '两半的卡片必须合并成一张，且只注册一处')
  assert.equal(cards[0].options.key, 'dsh-session-toolbox')
  assert.equal(
    state.registered.filter((entry) => entry.surface === 'plugins.row.config').length,
    0,
    '同一份表单不该在插件页出现两次：row.config 那处已摘',
  )

  // 这个槽不传共享表单，注册项的 `inject` 自己把它取出来喂给卡片。
  assert.deepEqual(state.configFormIds, ['session-toolbox'], '卡片读的是本行 entry 的共享表单')
  const injected = cards[0].options.inject()
  assert.deepEqual(injected.form.state, {
    status: 'ready', value: {}, user: {}, revision: 4, writable: true,
  })
  await injected.form.mutate([{ op: 'set', path: ['maxSessions'], value: 5 }], 4)
  assert.deepEqual(state.mutations, [
    { ops: [{ op: 'set', path: ['maxSessions'], value: 5 }], revision: 4 },
  ])

  // summary 分支是合并时留下的（这个槽只以 view:'page' 渲染，用不到它），仍在。
  const summary = cards[0].component({ view: 'summary' })
  const summaryText = flatten(summary).map((node) => (Array.isArray(node.children) ? node.children.join('') : '')).join(' ')
  assert.match(summaryText, /会话工具箱/)

  // 表单视图：注册项的 `inject` 给的同一份 `{ state, mutate }` 喂给卡片。
  const tree = flatten(cards[0].component(injected))
  const labels = tree.filter((node) => node.type === 'span' && node.props?.style?.fontWeight === 500).map((node) => node.children.join(''))
  assert.deepEqual(labels, [
    '标题栏删除图标',
    '允许删除正在运行的会话',
    '允许删除工作区会话',
    '单次最多删除',
    '拒绝搬迁正在跑的会话',
    '归位列表一次最多返回',
    '项目记忆跟随',
  ])
  // 控件形态：4 个布尔 + 2 个数字 + 1 个枚举（搬迁半边的 enum 控件并进来了）。
  const checkboxes = tree.filter((node) => node.type === 'input' && node.props?.type === 'checkbox')
  const numbers = tree.filter((node) => node.type === 'input' && node.props?.type === 'number')
  const selects = tree.filter((node) => node.type === 'select')
  assert.equal(checkboxes.length, 4)
  assert.equal(numbers.length, 2)
  assert.equal(selects.length, 1)
  // 枚举的三个取值都在（off / copy / move）。
  const options = tree.filter((node) => node.type === 'option').map((node) => node.props.value)
  assert.deepEqual(options, ['off', 'copy', 'move'])
})
