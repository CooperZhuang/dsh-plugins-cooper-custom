/**
 * `dsh-session-toolbox` 浏览器半边。
 *
 * 作为包的 `./client` 产物发布：DSH 客户端模块系统把它当普通经典脚本加载
 * （`window.__ModuleLoader__.load({ id, factory })`），React 由外壳预置
 * （`factory(require)` 里 `require('react')`）。刻意写成无打包器的普通脚本。
 *
 * 这个文件是**两个原插件浏览器半边的合并**：
 *   - 删除半边：`dsh-session-admin/lib/client.js`（右栏「会话管理」页签 + 会话标题栏
 *     垃圾桶图标 + 设置页 section + 那 4 个删除旋钮）；
 *   - 搬迁半边：`dsh-session-move/lib/client.js`（右栏「会话归位」页签 +
 *     那 3 个搬迁旋钮）。左栏底部那个 ⇄ 入口已按 2026-10-26 的要求去掉。
 *
 * 合并方式（为了可逐字核对）：两半各自原封不动地待在一个**块作用域**里
 * （`{ ... }`），块里的常量/组件名互不冲突，所以一行都不用重命名；块尾把该半边的
 * `{ inject, apply }` 交给外层，外层合成一个插件对象。两个半边互不知道对方。
 *
 * ## 对外契约（与合并前逐字一致）
 *
 *   - 页签：kind/id 仍是 `dsh-session-admin:manager`（+`…:manager-via-better-sidebar`）
 *     与 `dsh-session-move:panel`（+`…:panel-via-better-sidebar`），标题分别是
 *     「会话管理」「会话归位」，角标语义不变（删除半边：未分组条数；搬迁半边：无）；
 *   - 会话标题栏垃圾桶的 id `dsh-session-admin:delete-current`（仍然是**图标**，
 *     开关由 Host 的 `headerDeleteButton` 决定，默认开启，删除要两步确认）；
 *   - 数据面仍然只打各自的前缀：`/session-admin/api` 与 `/session-move/api`。
 *
 * ## 合并的那一处：配置卡片
 *
 * 合并前是两张卡片（`dsh-session-admin#session-admin` / `dsh-session-move#session-move`），
 * 现在只有**一张**，7 个 volatile 旋钮全在（删除 4 个 + 搬迁 3 个）。搬迁半边的卡片
 * 代码就此删除，它的 3 个字段与 `enum` 控件形态并入删除半边那张卡片。
 *
 * 2026-09-25 起这张卡片挂在**插件页**：槽 `plugins.bundle.config`、key = 包名
 * `dsh-session-toolbox`，渲染在本组合包页面的「描述与行之间」。原来那处
 * `plugins.row.config`（key `dsh-session-toolbox#session-toolbox`）随之摘掉——同一份
 * 表单只留一处。设置页的 `settings.section`（标签「会话工具」）**保留**：那是清理面板
 * 页，不是配置菜单。卡片体一个字符都没改：这个槽不传 `form`，所以注册项的 `inject`
 * 把 `ctx.configForms.get('session-toolbox')` 的 `{ state, mutate }` 喂给它。
 *
 * @module dsh-session-toolbox/client
 */

;(function () {
  const PACKAGE = 'dsh-session-toolbox'

  // ───────────────────────────────────────────────────────────────────────
  // 删除半边（原 dsh-session-admin/lib/client.js，逐字搬入）
  //
  // 块作用域：两半的常量/组件同名（S、API、createApi、createConfigCard…）也不会撞车，
  // 因此**半边的每一行都是原文件的原字节**（只改了行尾：原 client.js 是 CRLF，这里是 LF）。
  // 唯一被改的是 `factory: (require) => {` → `sessionAdminHalf = (require) => {`。
  // ───────────────────────────────────────────────────────────────────────

  /** 删除半边的插件对象，块尾交给外层合成（见文件末尾的 `target.load`）。 */
  let sessionAdminHalf
  {
  const API = '/session-admin/api'
  /**
   * 页签标识。两条注册路径**必须用不同的字符串**，这是实测出来的硬约束：
   *
   * betterSidebar 把描述符的 `id` 直接当成原生 `kind` 注册
   * （dsh-better-sidebar/lib/client.js:17034 `kind: descriptor.id`）。如果我们
   * 原生那条也用同一个 kind，那么「先撤原生、再注册 betterSidebar」的做法挡不住
   * 冲突——实测里原生的 dispose 不是同步生效的，两条会短暂并存，于是：
   *   `sidebarRight: tab kind "…" is already registered (extension)`
   * 换个 kind 就从根本上不可能撞，也不必去赌 dispose 的时序。
   *
   * 代价是打开页签时不知道当前是哪条在生效，所以 `openManagerTab` 两个都试。
   */
  const TAB_ID = 'dsh-session-admin:manager'
  /** 走 betterSidebar 时用的描述符 id（不透明，但必须与 TAB_ID 不同）。 */
  const BETTER_TAB_ID = 'dsh-session-admin:manager-via-better-sidebar'

  /** 跨入口传递的预设筛选（设置页/头部按钮 → 管理面板）。 */
  const pending = { cwdPrefix: undefined, scope: undefined }

  const S = {
    root: { padding: '4px 2px', fontSize: 13, color: 'inherit', display: 'flex', flexDirection: 'column', gap: 10 },
    bar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
    select: { padding: '4px 8px', fontSize: 12.5, borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit' },
    input: { padding: '4px 8px', fontSize: 12.5, borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit', flex: '1 1 140px', minWidth: 120 },
    button: { padding: '5px 10px', fontSize: 12.5, borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
    danger: { padding: '5px 10px', fontSize: 12.5, borderRadius: 6, border: '1px solid transparent', background: 'var(--dsh-danger, #d92d20)', color: '#fff', cursor: 'pointer' },
    primary: { padding: '5px 10px', fontSize: 12.5, borderRadius: 6, border: '1px solid transparent', background: 'var(--dsh-accent, #4d6bfe)', color: '#fff', cursor: 'pointer' },
    muted: { fontSize: 12, opacity: 0.62 },
    error: { fontSize: 12.5, color: 'var(--dsh-danger, #d92d20)' },
    list: { border: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.22))', borderRadius: 8, maxHeight: 420, overflow: 'auto' },
    row: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', overflow: 'hidden', borderTop: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.16))' },
    rowFirst: { borderTop: 'none' },
    title: { fontSize: 12.5, lineHeight: 1.4, wordBreak: 'break-word', overflowWrap: 'anywhere' },
    path: { fontSize: 11.5, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    badge: { fontSize: 10.5, padding: '0 5px', borderRadius: 999, border: '1px solid var(--dsh-border, #d0d5dd)', opacity: 0.75, whiteSpace: 'nowrap' },
    result: { border: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.22))', borderRadius: 8, padding: '8px 10px', fontSize: 12 },
    headerIconButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 6, border: 'none', borderRadius: 28, background: 'transparent', color: 'inherit', cursor: 'pointer', flex: 'none', opacity: 0.78 },
  }

  /**
   * 面板的两种排版。
   *
   * 同一个组件在两个容器里渲染，宿主的尺寸约束完全不同：
   *   - 右侧面板页签：容器有确定高度，列表应当**撑满**它，否则下面的空间全空着
   *     （这正是把 420px 上限直接搬进页签的后果）。
   *   - 设置弹窗：容器是普通文档流，没有确定高度，给一个上限反而更好——列表自己
   *     滚动，而不是把弹窗无限拉长。
   * 所以 `fill` 由调用方给：页签传 true，设置页不传。
   */
  const S_FILL = {
    root: { height: '100%', minHeight: 0, boxSizing: 'border-box' },
    list: { maxHeight: 'none', flex: '1 1 auto', minHeight: 0 },
  }

  /** 人可读字节数。 */
  function human(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit += 1
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
  }

  /**
   * 删除的二次确认。
   *
   * 两步，且第二步必须**动手输入**：
   *   1. `confirm` 说明到底要删什么（条数、体积、会话 id）；
   *   2. `prompt` 要求输入确认词。
   *
   * 只弹一个 confirm 不够——那个对话框可以被回车或连点顺手确认掉，而这正是上次
   * 「防止误删」担心的事。输入确认词要求的是一次有意的动作，手滑触发不了。
   * @param summary - 这次删除的对象描述。
   * @returns 用户是否确认删除。
   */
  function confirmDeletion(summary) {
    if (
      !window.confirm(
        `${summary}\n\n这会移除会话日志、投影缓存与回退快照，没有撤销、没有回收站。继续？`,
      )
    ) {
      return false
    }
    const typed = window.prompt(`最后一步：输入「删除」以确认\n\n${summary}`, '')
    if (typed === null) return false
    return typed.trim() === '删除'
  }

  /** 时间戳 → `MM-DD HH:mm`。 */
  function stamp(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /** Host 侧 API 客户端。 */
  function createApi() {
    async function call(method, payload) {
      const response = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload ?? {}),
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (body === null || typeof body !== 'object' || body.ok !== true) {
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
      }
      return body.value
    }
    return { call }
  }

  /**
   * 「未分组有多少条」的角标数据源。
   *
   * 角标函数必须是同步且极便宜的——betterSidebar 每次渲染页签栏都会调它一次，
   * 所以这里只读一个缓存值，真正的取值走轻量的 `count` 接口（Host 侧跳过体积
   * 统计）。刷新节奏取两分钟：它只是个提示，不值得为此常驻轮询。
   */
  function createBadge(api) {
    const state = { value: null, timer: undefined }
    const refresh = async () => {
      try {
        const value = await api.call('count', { scope: 'ungrouped' })
        const matched = value?.matched
        state.value = Number.isFinite(matched) && matched > 0 ? matched : null
      } catch {
        /* 取不到就沿用上一次的值，不影响其它功能 */
      }
    }
    return {
      get value() {
        return state.value
      },
      refresh,
      start() {
        void refresh()
        if (state.timer === undefined) state.timer = setInterval(() => void refresh(), 120_000)
      },
      stop() {
        if (state.timer !== undefined) {
          clearInterval(state.timer)
          state.timer = undefined
        }
      },
    }
  }

  /**
   * 拒绝理由 → 中文说明。
   *
   * 每条都要回答「那我该怎么办」，而不是只宣告「不行」：`running-session` 是用户最常
   * 撞上的一条（他正开着的会话通常就是 Host 持有的那个），只写「不允许」会看起来
   * 像功能坏了。它其实是有条件的：会话空闲后（一轮跑完）就不再被持有，那时可以删；
   * 换句话说这不是永久拒绝，而是「现在不行」。
   */
  const REASONS = {
    'running-session': '会话正在运行中（这一轮还没结束）——它跑完就能删；不能边跑边删，那会让这一轮正在进行的写入失败',
    'workspace-session': '属于某个工作区（在面板里显式勾选可放行）',
    'archived-session': '已归档（在面板里选「已归档」范围可放行）',
    'subagent-session': '是子代理子会话（在面板里选「子代理会话」范围可放行）',
    'caller-session': '是当前这个会话本身',
    'batch-limit': '超出单次批量上限',
    'outside-sessions-root': '目录不在 sessions 根下（已拒绝）',
    'not-found': '已经不存在',
  }

  /**
   * 「会话管理」组件：列表 + 范围筛选 + 多选 + 预演/删除。
   * @param React - 外壳预置的 React。
   * @param api - Host API 客户端。
   * @returns React 组件。
   */
  function createManager(React, api, badge) {
    const h = React.createElement

    return function SessionManager(props) {
      const fill = props?.fill === true
      const [scope, setScope] = React.useState(pending.scope ?? 'ungrouped')
      const [search, setSearch] = React.useState('')
      const [cwdPrefix, setCwdPrefix] = React.useState(pending.cwdPrefix ?? '')
      const [data, setData] = React.useState(undefined)
      const [selected, setSelected] = React.useState(() => new Set())
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)
      const [result, setResult] = React.useState(undefined)
      const [showAll, setShowAll] = React.useState(false)

      const load = React.useCallback(async () => {
        setBusy(true)
        setFailure(undefined)
        try {
          const value = await api.call('list', {
            scope,
            search: search === '' ? undefined : search,
            cwdPrefix: cwdPrefix === '' ? undefined : cwdPrefix,
            limit: 2000,
          })
          setData(value)
          setSelected(new Set())
        } catch (error) {
          setFailure(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }, [scope, search, cwdPrefix])

      React.useEffect(() => {
        void load()
      }, [load])

      const rows = data?.sessions ?? []
      const visible = showAll ? rows : rows.slice(0, 200)

      function toggle(id) {
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      async function run(dryRun) {
        const ids = [...selected]
        if (ids.length === 0) return
        const bytes = rows.filter((r) => selected.has(r.id)).reduce((sum, r) => sum + (r.bytes ?? 0), 0)
        if (dryRun !== true) {
          if (!confirmDeletion(`将永久删除 ${ids.length} 个会话（约 ${human(bytes)}）。`)) return
        }
        setBusy(true)
        setFailure(undefined)
        setResult(undefined)
        try {
          const value = await api.call('delete', {
            sessionIds: ids,
            dryRun: dryRun === true,
            // 显式勾选即显式同意：管理面板放行工作区/归档/子代理三类
            // （这三类只在「按范围批量」的模型侧路径上默认被拦）。
            includeWorkspace: true,
            includeArchived: true,
            includeSubagent: true,
          })
          setResult(value)
          if (dryRun !== true) {
            await load()
            // 删完立刻更新角标，不让它挂着一个旧数字。
            void badge?.refresh?.()
          }
        } catch (error) {
          setFailure(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const refusalRows =
        result === undefined
          ? []
          : result.results.filter((r) => r.status === 'skipped' || r.status === 'failed')

      const head = h(
        'div',
        { style: S.bar },
        h(
          'select',
          {
            style: S.select,
            value: scope,
            onChange: (event) => setScope(event.target.value),
          },
          h('option', { value: 'ungrouped' }, '未分组'),
          h('option', { value: 'temp' }, '临时/失效目录'),
          h('option', { value: 'archived' }, '已归档'),
          h('option', { value: 'subagent' }, '子代理会话'),
          h('option', { value: 'all' }, '全部会话'),
        ),
        h('input', {
          style: S.input,
          placeholder: '搜索标题 / 目录 / id',
          value: search,
          onChange: (event) => setSearch(event.target.value),
        }),
        h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => void load() }, busy ? '读取中…' : '刷新'),
      )

      const pathBar =
        cwdPrefix === ''
          ? null
          : h(
              'div',
              { style: S.bar },
              h('span', { style: S.badge }, `目录筛选：${cwdPrefix}`),
              h(
                'button',
                { type: 'button', style: S.button, onClick: () => setCwdPrefix('') },
                '清除',
              ),
            )

      const toolbar = h(
        'div',
        { style: S.bar },
        h(
          'button',
          {
            type: 'button',
            style: S.button,
            disabled: rows.length === 0,
            onClick: () =>
              setSelected((current) =>
                current.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)),
              ),
          },
          selected.size === rows.length && rows.length > 0 ? '取消全选' : `全选 ${rows.length} 条`,
        ),
        h('span', { style: S.muted }, `已选 ${selected.size} 条`),
        h(
          'button',
          { type: 'button', style: S.button, disabled: busy || selected.size === 0, onClick: () => void run(true) },
          '预演',
        ),
        h(
          'button',
          { type: 'button', style: S.danger, disabled: busy || selected.size === 0, onClick: () => void run(false) },
          '永久删除',
        ),
        data === undefined
          ? null
          : h(
              'span',
              { style: S.muted },
              `共 ${data.total} 个会话，命中 ${data.matched} 个${data.truncated ? '（已截断）' : ''}`,
            ),
      )

      const list =
        rows.length === 0
          ? h('div', { style: S.muted }, busy ? '读取中…' : '这个范围下没有会话。')
          : h(
              'div',
              { style: fill ? { ...S.list, ...S_FILL.list } : S.list },
              visible.map((row, index) =>
                h(
                  'div',
                  { key: row.id, style: index === 0 ? { ...S.row, ...S.rowFirst } : S.row },
                  h('input', {
                    type: 'checkbox',
                    checked: selected.has(row.id),
                    onChange: () => toggle(row.id),
                  }),
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: S.title }, row.title ?? '(无标题)'),
                    h('div', { style: S.path, title: row.cwd ?? '' }, row.cwd ?? '(目录未知)'),
                    h(
                      'div',
                      { style: { ...S.bar, marginTop: 3, gap: 5 } },
                      row.live ? h('span', { style: { ...S.badge, color: 'var(--dsh-accent, #4d6bfe)' } }, '使用中') : null,
                      row.ungrouped ? h('span', { style: S.badge }, '未分组') : h('span', { style: S.badge }, row.workspaceTitle ?? '工作区'),
                      row.archived ? h('span', { style: S.badge }, '已归档') : null,
                      row.subagent ? h('span', { style: S.badge }, '子代理') : null,
                      row.temp ? h('span', { style: S.badge }, '临时/失效') : null,
                      h('span', { style: S.badge }, human(row.bytes)),
                      h('span', { style: S.badge }, stamp(row.updatedAt)),
                    ),
                  ),
                ),
              ),
              rows.length > visible.length
                ? h(
                    'div',
                    { style: { padding: 8 } },
                    h(
                      'button',
                      { type: 'button', style: S.button, onClick: () => setShowAll(true) },
                      `还有 ${rows.length - visible.length} 条，显示全部`,
                    ),
                  )
                : null,
            )

      const resultBox =
        result === undefined
          ? null
          : h(
              'div',
              { style: S.result },
              h(
                'div',
                null,
                result.dryRun === true
                  ? `预演：命中 ${result.results.length} 条，可删 ${result.removed} 条，可释放 ${human(result.reclaimed)}。`
                  : `已删除 ${result.removed} 个会话，释放 ${human(result.reclaimed)}。` +
                    (result.pruned?.length > 0 ? ` 清理了 ${result.pruned.length} 个空项目目录。` : ''),
              ),
              refusalRows.length > 0
                ? h(
                    'div',
                    { style: { marginTop: 6 } },
                    h('div', { style: S.muted }, `未处理 ${refusalRows.length} 条：`),
                    refusalRows.slice(0, 12).map((row) =>
                      h(
                        'div',
                        { key: row.id, style: S.muted },
                        `${row.id} — ${REASONS[row.reason] ?? row.reason}`,
                      ),
                    ),
                    refusalRows.length > 12 ? h('div', { style: S.muted }, `…以及另外 ${refusalRows.length - 12} 条`) : null,
                  )
                : null,
            )

      // 待删除队列：条目、状态、撤销、立即重试。
      return h(
        'div',
        { style: fill ? { ...S.root, ...S_FILL.root } : S.root },
        h(
          'div',
          { style: S.muted },
          'DSH 只能「归档」（隐藏）会话；这里做的是把会话的持久化数据真正从磁盘移除。删除需要二次确认，不可恢复。',
        ),
        head,
        pathBar,
        toolbar,
        failure !== undefined ? h('div', { style: S.error }, `失败：${failure}`) : null,
        list,
        resultBox,
      )
    }
  }

  /** 右侧页签的标题条。 */
  function createTabTitle(React) {
    const h = React.createElement
    return function SessionAdminTabTitle() {
      return h('span', { style: { fontSize: 12.5 } }, '会话管理')
    }
  }

  /**
   * 会话标题栏的垃圾桶图标：删除当前会话。
   *
   * 形态是「图标 + 二次确认」而不是带字面标签的按钮：标签会招来点击，而这里删的
   * 正是你正在用的会话。图标不占字面位置，误点最多弹出一个确认框。
   */
  function createHeaderButton(React, ctx, api) {
    const h = React.createElement
    /**
     * 垃圾桶字形，内联 SVG。
     *
     * 描边风格（Lucide 的 `trash-2`），不是实心填充：相邻的头部图标都是细描边，
     * 实心字形在 16px 下会显得又黑又笨重。viewBox 用 24 是为了沿用 Lucide 的坐标，
     * 实际渲染缩到 16。
     *
     * 刻意不 require `@deepseek-ai/dsh-client-ui-primitives`：那个模块表在版本间
     * 漂过（本仓库踩过第三方 UI 插件因它整体不可用的坑），一个 16×16 的图形不值得
     * 为它引一条跨版本依赖。
     */
    const TRASH_GLYPHS = [
      'M3 6h18',
      'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
      'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
      'M10 11v6',
      'M14 11v6',
    ]

    return function SessionAdminHeaderButton() {
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(undefined)

      function currentSessionId() {
        try {
          return ctx.sessions.list.getSnapshot().current
        } catch {
          return undefined
        }
      }

      /** 删成功后离开这个会话——理由见下面的注释。 */
      function leaveDeletedSession() {
        try {
          ctx.sessions.create()
          return
        } catch {
          /* 建不出新会话就退回整页刷新 */
        }
        try {
          window.location.reload()
        } catch {
          /* 已经无可挽回，界面刷新失败也不影响数据层 */
        }
      }

      async function onClick() {
        const id = currentSessionId()
        if (id === undefined) {
          setNote('没有选中会话')
          return
        }
        setBusy(true)
        setNote(undefined)
        try {
          // 先预演：Host 会逐条给出「可删 / 为什么不能删」。只有真的可删才弹确认。
          const probe = await api.call('delete', {
            sessionIds: [id],
            dryRun: true,
            includeWorkspace: true,
            includeArchived: true,
            includeSubagent: true,
          })
          const entry = probe.results[0]
          if (probe.removed === 0) {
            setNote(REASONS[entry?.reason] ?? entry?.reason ?? '无法删除')
            return
          }
          if (!confirmDeletion(`永久删除当前会话 ${id}？`)) return
          const value = await api.call('delete', {
            sessionIds: [id],
            includeWorkspace: true,
            includeArchived: true,
            includeSubagent: true,
          })
          const outcome = value.results[0]
          if (outcome?.status === 'removed') {
            // 数据已经没了，界面不能停在它上面：继续在这个会话里发消息，Host 会往
            // 已删除的目录重新写日志——那正是「无头日志」的由来，而删除守卫正是为了
            // 避免它。
            leaveDeletedSession()
            return
          }
          setNote(REASONS[outcome?.reason] ?? outcome?.reason ?? '删除失败')
        } catch (error) {
          setNote(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h(
          'button',
          {
            type: 'button',
            style: S.headerIconButton,
            disabled: busy,
            title: '删除当前会话（需确认，不可恢复）',
            'aria-label': '删除当前会话',
            'aria-busy': busy ? 'true' : undefined,
            onClick: () => void onClick(),
          },
          h(
            'svg',
            {
              width: 16,
              height: 16,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.7,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
              focusable: 'false',
            },
            TRASH_GLYPHS.map((d, index) => h('path', { key: index, d })),
          ),
        ),
        note !== undefined ? h('span', { style: { ...S.muted, maxWidth: 220 } }, note) : null,
      )
    }
  }

  /** 设置页里的清理面板：复用管理组件，另给一个「在右侧面板打开」。 */
  function createSettingsSection(React, openManagerTab, SessionAdminManager) {
    const h = React.createElement
    return function SessionAdminSettingsSection() {
      return h(
        'div',
        null,
        h('p', { style: { ...S.muted, marginTop: 0 } }, '批量清理会话数据。右侧面板里也有同一份界面。'),
        h(
          'div',
          { style: { ...S.bar, marginBottom: 8 } },
          h(
            'button',
            { type: 'button', style: S.button, onClick: () => openManagerTab() },
            '在右侧面板打开',
          ),
        ),
        h(SessionAdminManager, {}),
      )
    }
  }

  // 本插件在 profile 里的 entry id（`- id: session-toolbox`，由 cordis.patch.yml 声明）。
  // 它同时是 Host 设置命名空间的 key 与 `ctx.configForms.get(...)` 的 key。合并后只有
  // 这一张卡片，键也就只有一个：`session-toolbox`。
  const CONFIG_ENTRY_ID = 'session-toolbox'

  /**
   * 插件页上本组合包页面的**配置卡片**。
   *
   * 注册进 `plugins.bundle.config`（key 是**包的 package name**），渲染在该组合包页面的
   * 「描述与行之间」——官方插件放配置的位置。这个槽**不**把共享表单传进来（不像
   * `plugins.row.config` 传 `{ state, mutate }`），所以注册项的 `inject` 自己把
   * `ctx.configForms.get(CONFIG_ENTRY_ID)` 的同一份 `{ state, mutate }` 作为 `form`
   * 喂给这张卡片；卡片体与当年挂 `plugins.row.config` 时逐字相同。
   *
   * **只有宿主 `Config` 里标了 `.volatile()` 的字段在这里可改**：命名空间正是由
   * volatile 字段撑起来的，只有它被服务时快照才可写。
   * `enabled` / `root` / `adminAllowHosts` / `moveAllowHosts` 是组合事实（挂载期决定
   * 注册什么、会话根与两条信任栅栏），刻意不标 volatile，因此不在这张表里——要改请改
   * profile 的 patch。两半的旋钮合并成这一张卡片，卡片注册只有一处。
   */
  function createConfigCard(React) {
    const h = React.createElement

    /** 字段表：key 必须与宿主 `Config` 的 volatile 字段一一对应（合并后一共 7 个）。 */
    const FIELDS = [
      {
        key: 'headerDeleteButton',
        kind: 'boolean',
        label: '标题栏删除图标',
        hint: '在会话标题栏显示垃圾桶图标（默认开启）。它是图标而不是按钮，且删除要两步确认。改完刷新页面生效。',
      },
      {
        key: 'allowLiveSessions',
        kind: 'boolean',
        label: '允许删除正在运行的会话',
        hint: '默认否。打开后可以删掉仍然挂在 Host 进程里的会话（正在浏览或正在跑）。',
      },
      {
        key: 'allowWorkspaceSessions',
        kind: 'boolean',
        label: '允许删除工作区会话',
        hint: '默认否。打开后可以删掉「属于某个工作区」的会话。',
      },
      {
        key: 'maxBatch',
        kind: 'number',
        label: '单次最多删除',
        hint: '一次调用最多删多少个会话（默认 200），防手滑。',
      },
      {
        key: 'refuseRunning',
        kind: 'boolean',
        label: '拒绝搬迁正在跑的会话',
        hint: '默认开启。搬运期间该会话的写入句柄可能落盘，关掉它要自己承担风险。',
      },
      {
        key: 'maxSessions',
        kind: 'number',
        label: '归位列表一次最多返回',
        hint: '`/session-move/api/list` 一次最多返回多少条会话（浏览器半边还会再筛选）。默认 2000。',
      },
      {
        key: 'memoryFollow',
        kind: 'enum',
        label: '项目记忆跟随',
        hint: 'off（默认）只在报告里给只读预览；copy 把本会话产出的条目复制到目标工作区；move 复制后从源移除——不可逆。',
        options: [
          ['off', 'off（只给预览，推荐）'],
          ['copy', 'copy（复制到目标工作区）'],
          ['move', 'move（复制后从源移除，不可逆）'],
        ],
      },
    ]

    const S = {
      card: { border: '1px solid var(--dsh-border, #d0d5dd)', borderRadius: 10, padding: '16px 18px', margin: '0 0 14px' },
      title: { margin: '0 0 6px', fontSize: 15, fontWeight: 600 },
      intro: { margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.6, opacity: 0.75 },
      row: { padding: '10px 0', borderTop: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.22))' },
      rowHead: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
      label: { fontSize: 13, fontWeight: 500 },
      badge: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--dsh-border, #d0d5dd)', opacity: 0.7 },
      hint: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.6, opacity: 0.66 },
      control: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 },
      input: { padding: '5px 8px', fontSize: 13, borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit', minWidth: 140 },
      actions: { marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' },
      button: { padding: '6px 14px', fontSize: 13, borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      buttonPrimary: { padding: '6px 14px', fontSize: 13, borderRadius: 6, border: '1px solid transparent', background: 'var(--dsh-accent, #4d6bfe)', color: '#fff', cursor: 'pointer' },
      error: { fontSize: 12.5, color: 'var(--dsh-danger, #d92d20)' },
      muted: { fontSize: 12, opacity: 0.6 },
      link: { fontSize: 12, background: 'none', border: 'none', padding: 0, color: 'inherit', opacity: 0.66, cursor: 'pointer', textDecoration: 'underline' },
    }

    const SUMMARY = '会话工具箱：真正删除持久化会话，或把会话搬到另一个工作区。'

    /** 已保存值 → 控件草稿。 */
    function toDraft(field, value) {
      if (field.kind === 'boolean') return value === true
      if (field.kind === 'enum') return typeof value === 'string' && value.length > 0 ? value : field.options[0][0]
      return value === undefined || value === null ? '' : String(value)
    }

    /** 草稿是否非法（只有数字会非法）。 */
    function isInvalid(field, draft) {
      if (field.kind !== 'number') return false
      if (draft === '') return true
      const n = Number(draft)
      return !Number.isInteger(n) || n < 1
    }

    /** 草稿 → 写回本行 entry 配置的值。 */
    function toValue(field, draft) {
      if (field.kind === 'boolean') return draft === true
      if (field.kind === 'enum') return String(draft)
      return Number(draft)
    }

    /** 该字段是否「已被用户层覆盖」。 */
    function isOverridden(user, key) {
      return user !== null && typeof user === 'object' && Object.hasOwn(user, key)
    }

    return function SessionToolboxConfigCard(props) {
      const [drafts, setDrafts] = React.useState({})
      const [resets, setResets] = React.useState({})
      const [fence, setFence] = React.useState(undefined)
      const [saving, setSaving] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)

      // 注册项的 `inject` 把共享表单的 `{ state, mutate }` 作为 `form` 传进来；命名空间
      // 不是「Host 在服务的设置命名空间」时快照是 undefined（见 dsh-client-ui-settings
      // 的 ConfigFormController 与 dsh-client-ui-plugin-manager 的 formFor）。
      const form = props.form
      const snapshot = form !== undefined && form !== null ? form.state : undefined
      const writable = snapshot !== undefined && snapshot.writable !== false

      if (props.view === 'summary') return h('span', null, SUMMARY)
      if (snapshot === undefined) {
        return h(
          'p',
          { style: S.muted },
          'Host 没有把这一行服务成可写的设置命名空间——只有标了 volatile 的字段才会出现在这里。',
        )
      }

      const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
      const user = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {}
      const dirty = Object.keys(drafts).length > 0 || Object.keys(resets).length > 0

      /** 某字段当前该显示什么：优先本地草稿，否则回落到已保存值。 */
      function draftOf(field) {
        if (Object.hasOwn(drafts, field.key)) return drafts[field.key]
        return toDraft(field, value[field.key])
      }

      function edit(field, next) {
        if (fence === undefined) setFence(snapshot.revision)
        setResets((current) => {
          if (!Object.hasOwn(current, field.key)) return current
          const copy = { ...current }
          delete copy[field.key]
          return copy
        })
        setDrafts((current) => ({ ...current, [field.key]: next }))
      }

      /** 标记该字段恢复默认：写回时发 unset，让它重新继承部署层与 schema 默认值。 */
      function restore(field) {
        if (fence === undefined) setFence(snapshot.revision)
        setDrafts((current) => {
          if (!Object.hasOwn(current, field.key)) return current
          const copy = { ...current }
          delete copy[field.key]
          return copy
        })
        setResets((current) => ({ ...current, [field.key]: true }))
      }

      function discard() {
        setDrafts({})
        setResets({})
        setFence(undefined)
        setFailure(undefined)
      }

      async function save() {
        const ops = []
        for (const key of Object.keys(resets)) ops.push({ op: 'unset', path: [key] })
        for (const key of Object.keys(drafts)) {
          const field = FIELDS.find((f) => f.key === key)
          if (field === undefined) continue
          ops.push({ op: 'set', path: [key], value: toValue(field, drafts[key]) })
        }
        if (ops.length === 0) {
          discard()
          return
        }
        setSaving(true)
        setFailure(undefined)
        try {
          await form.mutate(ops, fence)
          setDrafts({})
          setResets({})
          setFence(undefined)
        } catch (error) {
          setFailure(
            error !== null && typeof error === 'object' && typeof error.message === 'string'
              ? error.message
              : String(error),
          )
        } finally {
          setSaving(false)
        }
      }

      const blocked =
        !writable || saving || FIELDS.some((field) => Object.hasOwn(drafts, field.key) && isInvalid(field, drafts[field.key]))

      const rows = FIELDS.map((field) => {
        const draft = draftOf(field)
        const overridden = isOverridden(user, field.key)
        let control
        if (field.kind === 'boolean') {
          control = h('input', {
            type: 'checkbox',
            checked: draft === true,
            disabled: !writable || saving,
            onChange: (event) => edit(field, event.target.checked),
          })
        } else if (field.kind === 'enum') {
          control = h(
            'select',
            {
              style: S.input,
              value: draft,
              disabled: !writable || saving,
              onChange: (event) => edit(field, event.target.value),
            },
            field.options.map(([optionValue, optionLabel]) => h('option', { key: optionValue, value: optionValue }, optionLabel)),
          )
        } else {
          control = h('input', {
            type: 'number',
            style: S.input,
            value: draft,
            disabled: !writable || saving,
            onChange: (event) => edit(field, event.target.value),
          })
        }

        return h(
          'div',
          { key: field.key, style: S.row },
          h(
            'div',
            { style: S.rowHead },
            h('span', { style: S.label }, field.label),
            overridden
              ? h(
                  'span',
                  null,
                  h('span', { style: S.badge }, '已覆盖'),
                  ' ',
                  h('button', { type: 'button', style: S.link, onClick: () => restore(field) }, '恢复默认'),
                )
              : null,
          ),
          h('p', { style: S.hint }, field.hint),
          h(
            'div',
            { style: S.control },
            control,
            field.kind === 'number' && isInvalid(field, draft) ? h('span', { style: S.error }, '需要 ≥ 1 的整数') : null,
          ),
        )
      })

      return h(
        'div',
        { style: S.card },
        h('h3', { style: S.title }, '会话工具箱配置'),
        h(
          'p',
          { style: S.intro },
          '这些是本行（dsh-session-toolbox）的 volatile 旋钮——删除半边 4 个 + 搬迁半边 3 个：保存即写回 profile 的 cordis.patch.yml，Loader 原地换引用，不用重启、也不用重挂。',
        ),
        rows,
        h(
          'div',
          { style: S.actions },
          h(
            'button',
            { type: 'button', style: blocked ? S.button : S.buttonPrimary, disabled: blocked, onClick: save },
            saving ? '保存中…' : '保存',
          ),
          h('button', { type: 'button', style: S.button, disabled: !dirty || saving, onClick: discard }, '放弃更改'),
          failure !== undefined ? h('span', { style: S.error }, `保存失败：${failure}`) : null,
          !writable ? h('span', { style: S.muted }, '当前部署的设置不可写') : null,
        ),
      )
    }
  }

    sessionAdminHalf = (require) => {
      const React = require('react')

      /** 在调用方插件的生命周期上挂载三张脸。 */
      /**
       * 在调用方插件的生命周期上挂载删除半边的三张脸（设置页 section、标题栏垃圾桶、
       * 右栏页签）+ 插件页配置卡片。**函数体逐字来自 dsh-session-admin/lib/client.js**，
       * 只是外面多了一层块作用域与 `sessionAdminHalf` 箭头函数（合并需要，见文件头）。
       */
      function apply(ctx) {
        const api = createApi()
        const badge = createBadge(api)
        badge.start()
        ctx.effect(() => () => badge.stop(), 'dsh-session-admin: badge refresh timer')
        const SessionAdminManager = createManager(React, api, badge)

        // 右侧面板的控制器是可选依赖：`ctx.get` 对没 inject 过的服务不保证拿得到，
        // 所以走 inject 回调把实例存下来，服务缺失时按钮静默无效。
        let sidebarRight
        ctx.inject(['sidebarRight'], (injected) => {
          sidebarRight = injected.get('sidebarRight')
          return () => {
            sidebarRight = undefined
          }
        })
        const openManagerTab = () => {
          if (sidebarRight === undefined || typeof sidebarRight.openTab !== 'function') return
          // 不知道当前是哪条注册在生效，两个 kind 都试一遍。
          for (const kind of [TAB_ID, BETTER_TAB_ID]) {
            try {
              sidebarRight.openTab(kind)
              return
            } catch {
              /* 换下一个 */
            }
          }
        }

        // 1) 设置页：一个独立的 section（合并后只有这一个 section）。
        //
        // 它是**清理面板页**（复用管理组件 + 一个「在右侧面板打开」的快捷入口），不是配置
        // 菜单——配置那张卡片从来不在这一页，2026-09-25 起它挂在插件页的
        // `plugins.bundle.config`（见下面第 4 条）。所以这一项与 dsh-memories 的「记忆页」
        // 同类，保留。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'session-toolbox',
              order: 120,
              label: () => '会话工具',
              inject: () => ({}),
            },
            createSettingsSection(React, openManagerTab, SessionAdminManager),
          ),
        )

        // 2) 会话标题栏：删除当前会话。
        //
        // 这个入口的开关由 Host 配置 `headerDeleteButton`（默认 true）决定：
        // 它就在你正在用的那个会话的右上角，删的也正是它，误点即不可恢复。
        // 清理由右侧面板 / 设置页承担——那是显式挑选动作，不存在误触。
        // 因为要等一次请求才知道开关，所以注册是异步的；请求失败时按「不渲染」处理
        // （安全的那一侧），而不是把按钮露出来。
        let headerButtonDispose
        ctx.effect(
          () => () => {
            try {
              headerButtonDispose?.dispose?.()
            } catch {
              /* 卸载失败不影响其它入口 */
            }
          },
          'dsh-session-admin: header button teardown',
        )
        void api
          .call('config', {})
          .then((config) => {
            if (config?.headerDeleteButton !== true) return
            headerButtonDispose = ctx.slots.inject('conversation.session.header.utilities', () =>
              ctx.slots.register(
                {
                  name: 'conversation.session.header.utilities',
                  id: 'dsh-session-admin:delete-current',
                  order: 20,
                  registrant: PACKAGE,
                },
                createHeaderButton(React, ctx, api),
              ),
            )
          })
          .catch(() => {
            /* Host 不可达时保持不渲染 */
          })

        // 3) 右侧面板页签。两条路，自动二选一：
        //
        //    a) 装了 dsh-better-sidebar → 走它的 `ctx.betterSidebar.registerTab`。
        //       它把描述符**镜像到 DSH 原生 sidebarRightTabs**（client.js:17093
        //       的 sync → registerDescriptor），所以落点是同一个，多出来的是角标、
        //       新建列表里的描述、Side card 里的启用开关和生命周期回调。
        //    b) 没装 / 它半边没起来 → 直接注册原生 sidebarRightTabs，也就是原行为。
        //
        //    两边不能并存：betterSidebar 的注册表对 id 唯一（重复即 throw），原生
        //    tabs.register 对 kind 也冲突。所以是「先挂原生，betterSidebar 一出现就
        //    换成它、并撤掉原生」，它消失时再换回来。
        const registerNativeTab = () => {
          try {
            return ctx.inject(['sidebarRightTabs'], (injected) => {
              const tabs = injected.get('sidebarRightTabs')
              if (tabs === undefined) return undefined
              const disposeDefinition = tabs.register({
                id: TAB_ID,
                kind: TAB_ID,
                priority: 'extension',
                title: () => '会话管理',
                guide: [{ order: 100, title: () => '会话管理' }],
              })
              const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
                ctx.slots.register(
                  // fill: 页签容器有确定高度，让列表撑满它而不是停在 420px。
                  { name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({ fill: true }) },
                  SessionAdminManager,
                ),
              )
              const disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
                ctx.slots.register(
                  { name: 'sidebar.right.pane.tab.title', key: TAB_ID, inject: () => ({}) },
                  createTabTitle(React),
                ),
              )
              return () => {
                try {
                  disposeTitle?.dispose?.()
                  disposeBody?.dispose?.()
                  disposeDefinition?.()
                } catch {
                  /* 卸载失败不影响其它入口 */
                }
              }
            })
          } catch {
            /* 没有右侧面板服务时静默降级 */
            return undefined
          }
        }

        let nativeTabDispose = registerNativeTab()
        try {
          ctx.inject(['betterSidebar'], (injected) => {
            const service = injected.get('betterSidebar')
            if (service === undefined || typeof service.registerTab !== 'function') return undefined
            // 顺序是硬要求：`registerTab` 会**同步**把描述符镜像到原生
            // `sidebarRightTabs`（client.js:17093 的 sync → registerDescriptor），
            // 所以必须先把原生那条撤掉。反过来写——先注册再撤——会让 betterSidebar
            // 的注册正好撞上我们自己的原生注册：
            //   sidebarRight: tab kind "dsh-session-admin:manager" is already registered
            try {
              nativeTabDispose?.dispose?.()
            } catch {
              /* 撤不掉也要往下走，下面的 catch 会把原生接回来 */
            }
            nativeTabDispose = undefined
            let disposeBetter
            try {
              disposeBetter = service.registerTab({
                id: BETTER_TAB_ID,
                title: () => '会话管理',
                description: () => '列出并删除会话：按未分组 / 临时目录 / 归档筛选，先预演再永久删除。',
                order: 120,
                /*
                 * 角标：未分组的条数。
                 *
                 * ⚠️ 实测（2026-09-14，better-sidebar 0.19.1）：**在原生右栏看不到它**。
                 * 角标只由 better-sidebar 自绘的页签条渲染（lib/client.js:16416 的
                 * `sidebar_module_css_default.tabBadge`），而 v0.19 起右列已交给 DSH
                 * 原生侧边栏。它并非死代码：本机存在「展开底部面板」开关，底部工作台
                 * 展开后那个页签条就会出现（我最初查 DOM 时它处于收起状态，所以漏判了）。
                 * 简言之：原生右栏没有数字，底部工作台里会有。
                 */
                badge: () => badge.value,
                // 单实例：再点一次只是聚焦已有页签，不会堆出一排。
                single: true,
                component: () => React.createElement(SessionAdminManager, { fill: true }),
              })
            } catch {
              // 注册失败就把原生接回去，页签不至于整个消失。
              nativeTabDispose = registerNativeTab()
              return undefined
            }
            return () => {
              try {
                disposeBetter?.()
              } catch {
                /* 卸载失败不影响其它入口 */
              }
              // betterSidebar 走了，把原生那条接回来。
              if (nativeTabDispose === undefined) nativeTabDispose = registerNativeTab()
            }
          })
        } catch {
          /* 没有 betterSidebar 时留在原生路径 */
        }
        ctx.effect(
          () => () => {
            try {
              nativeTabDispose?.dispose?.()
            } catch {
              /* 卸载失败不影响其它入口 */
            }
          },
          'dsh-session-admin: pane tab teardown',
        )

        // 4) 插件页：本组合包页面上的**配置卡片**（本插件配置的唯一入口）。
        //
        // key 是**包的 package name**：插件页把 `plugins.bundle.config` 渲染在该组合包页面
        // 的「描述与行之间」（官方插件放配置的位置），认领 key 的正是这个包。
        //
        // 这个槽**不**把共享表单传进来（不像 `plugins.row.config` 传 `{ state, mutate }`），
        // 所以注册项的 `inject` 自己把 `ctx.configForms.get(CONFIG_ENTRY_ID)` 的同一份
        // `{ state, mutate }` 作为 `form` 喂给卡片——卡片体逐字未改。能不能写仍由 Host 决定：
        // 只有这一行有 volatile 字段、命名空间被服务时快照才可写；否则卡片只显示一句说明，
        // 不会假装能改。
        //
        // 2026-09-25 起这是配置的**唯一**注册处：原来的 `plugins.row.config`
        // （key `dsh-session-toolbox#session-toolbox`）摘掉了——同一份表单在插件页出现两次
        // 只会让人怀疑哪个才算数（合并前的取舍也是这个理由）。
        const configForm = ctx.configForms.get(CONFIG_ENTRY_ID)
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: PACKAGE,
              inject: () => ({
                form: {
                  state: configForm.getSnapshot(),
                  mutate: (ops, revision) => configForm.mutate(ops, revision),
                },
              }),
            },
            createConfigCard(React),
          ),
        )
      }

      // `configForms`：配置卡片挂的是插件页的 `plugins.bundle.config`，那个槽不传共享
      // 表单，卡片要自己从 `ctx.configForms.get(CONFIG_ENTRY_ID)` 取（见上面第 4 条）。
      return { inject: ['slots', 'sessions', 'configForms'], apply }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // 搬迁半边（原 dsh-session-move/lib/client.js，逐字搬入）
  //
  // 与删除半边同样处理；它原来那张 `plugins.row.config` 卡片被摘掉（合并成一张，
  // 字段并进了删除半边那张卡片，2026-09-25 起统一挂到插件页的 `plugins.bundle.config`），
  // `factory:` 同样改名。
  // ───────────────────────────────────────────────────────────────────────

  /** 搬迁半边的插件对象（同上）。 */
  let sessionMoveHalf
  {
  const API = '/session-move/api'
  /** 原生页签 kind。 */
  const TAB_ID = 'dsh-session-move:panel'
  /**
   * 走 better-sidebar 时用的描述符 id。**必须与 TAB_ID 不同**：better-sidebar 会把
   * 描述符 id 直接当原生 kind 注册，两条路若同名，撤原生/再注册之间会短暂撞车
   * （dsh-session-admin 实测得到同样的结论）。
   */
  const BETTER_TAB_ID = 'dsh-session-move:panel-via-better-sidebar'

  const S = {
    root: { padding: '4px 2px', fontSize: 13, color: 'inherit', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 },
    title: { fontSize: 13, fontWeight: 600 },
    muted: { fontSize: 12, opacity: 0.62, lineHeight: 1.5 },
    tiny: { fontSize: 11.5, opacity: 0.55 },
    bar: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
    input: {
      padding: '4px 8px', fontSize: 12.5, borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)',
      background: 'transparent', color: 'inherit', flex: '1 1 140px', minWidth: 110,
    },
    select: {
      padding: '4px 6px', fontSize: 12.5, borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)',
      background: 'transparent', color: 'inherit', maxWidth: '100%',
    },
    button: {
      padding: '4px 9px', fontSize: 12.5, borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)',
      background: 'transparent', color: 'inherit', cursor: 'pointer',
    },
    primary: {
      padding: '4px 9px', fontSize: 12.5, borderRadius: 6, border: '1px solid transparent',
      background: 'var(--dsh-accent, #4d6bfe)', color: '#fff', cursor: 'pointer',
    },
    disabled: { opacity: 0.45, cursor: 'default' },
    label: { fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.55 },
    cards: {
      border: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.22))', borderRadius: 8,
      overflow: 'auto', display: 'flex', flexDirection: 'column', minHeight: 120, flex: '1 1 auto',
    },
    card: {
      display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px', cursor: 'grab',
      borderTop: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.14))',
    },
    cardFirst: { borderTop: 'none' },
    cardSelected: { background: 'var(--dsh-surface-hover, rgba(77,107,254,0.10))' },
    cardDragging: { opacity: 0.45 },
    cardTitle: { fontSize: 12.5, lineHeight: 1.35, wordBreak: 'break-word', overflowWrap: 'anywhere' },
    meta: { fontSize: 11.5, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    badges: { display: 'flex', gap: 4, flexWrap: 'wrap' },
    badge: {
      fontSize: 10.5, padding: '0 5px', borderRadius: 999,
      border: '1px solid var(--dsh-border, #d0d5dd)', opacity: 0.8, whiteSpace: 'nowrap',
    },
    badgeWarn: { fontSize: 10.5, padding: '0 5px', borderRadius: 999, border: '1px solid var(--dsh-danger, #d92d20)', color: 'var(--dsh-danger, #d92d20)', whiteSpace: 'nowrap' },
    wsList: {
      border: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.22))', borderRadius: 8,
      overflow: 'auto', display: 'flex', flexDirection: 'column', minHeight: 100, flex: '1 1 auto',
    },
    ws: {
      display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px',
      borderTop: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.14))',
    },
    wsHover: { background: 'var(--dsh-surface-hover, rgba(77,107,254,0.16))', outline: '1px solid var(--dsh-accent, #4d6bfe)' },
    wsTitle: { fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'baseline' },
    wsCount: { fontSize: 11, opacity: 0.55 },
    wsPath: { fontSize: 11, opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    result: { border: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.22))', borderRadius: 8, padding: '8px 10px', fontSize: 12 },
    good: { color: 'var(--dsh-success, #12b76a)' },
    bad: { color: 'var(--dsh-danger, #d92d20)' },
    pre: {
      maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      background: 'rgba(128,128,128,0.1)', borderRadius: 6, padding: 8, margin: '6px 0 0',
      fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11,
    },
  }

  const S_FILL = {
    root: { height: '100%', minHeight: 0, boxSizing: 'border-box' },
    cards: { maxHeight: 'none', flex: '1 1 45%' },
    wsList: { maxHeight: 'none', flex: '1 1 45%' },
  }

  /** Host 侧 API 客户端。 */
  function createApi() {
    async function call(method, payload) {
      const response = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload ?? {}),
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (body === null || typeof body !== 'object' || body.ok !== true) {
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
      }
      return body.value
    }
    return { call }
  }

  /** 路径末段。 */
  function baseName(value) {
    if (typeof value !== 'string' || value.length === 0) return ''
    const parts = value.replace(/[\\/]+$/, '').split(/[\\/]/)
    return parts.length === 0 ? value : parts[parts.length - 1]
  }

  /** 会话 id 的短形式。 */
  function shortId(id) {
    const text = String(id)
    const stripped = text.startsWith('session-') ? text.slice(8) : text
    return stripped.length > 8 ? stripped.slice(0, 8) : stripped
  }

  /** `MM-DD HH:mm`。 */
  function stamp(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /**
   * 拖放面板。
   * @param React - 外壳预置的 React。
   * @param api - Host API 客户端。
   * @returns 面板组件。
   */
  function createPanel(React, api) {
    const h = React.createElement
    return function SessionMovePanel(props) {
      const fill = props.fill === true
      const useSessions = props.useSessions
      const store = typeof useSessions === 'function' ? useSessions((snapshot) => snapshot) : undefined
      const byId = store !== undefined && store !== null ? store.byId : undefined

      const [snapshot, setSnapshot] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(true)
      const [filter, setFilter] = React.useState('')
      const [selected, setSelected] = React.useState('')
      const [targetPick, setTargetPick] = React.useState('')
      const [dragging, setDragging] = React.useState('')
      const [hover, setHover] = React.useState('')
      const [outcome, setOutcome] = React.useState(null)
      const [token, setToken] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        setBusy(true)
        api
          .call('list', {})
          .then(
            (value) => {
              if (!alive) return
              setSnapshot(value)
              setFailure(null)
            },
            (error) => {
              if (alive) setFailure(String(error?.message ?? error))
            },
          )
          .then(() => {
            if (alive) setBusy(false)
          })
        return () => {
          alive = false
        }
      }, [token])

      const workspaces = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.workspaces) ? snapshot.workspaces : []
      const sessions = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.sessions) ? snapshot.sessions : []

      const titleOf = (row) => {
        const record = byId !== undefined ? byId[row.id] : undefined
        if (record === undefined || record === null) return ''
        if (typeof record.displayTitle === 'string' && record.displayTitle.length > 0) return record.displayTitle
        if (typeof record.title === 'string' && record.title.length > 0) return record.title
        return ''
      }
      const needle = filter.trim().toLowerCase()
      const rows = sessions.filter((row) => {
        if (needle.length === 0) return true
        if (row.id.toLowerCase().includes(needle)) return true
        if ((row.cwd ?? '').toLowerCase().includes(needle)) return true
        if ((row.workspaceTitle ?? '').toLowerCase().includes(needle)) return true
        return titleOf(row).toLowerCase().includes(needle)
      })
      // 未分组排最前（最需要归位的），跑着的沉底。
      const rank = (row) => (row.workspaceId === null ? 0 : 1) * 2 + (row.running === 'running' ? 1 : 0)
      rows.sort((left, right) => rank(left) - rank(right) || (right.createdAt ?? 0) - (left.createdAt ?? 0))

      const selectedRow = rows.find((row) => row.id === selected) ?? sessions.find((row) => row.id === selected)

      const runMove = (sessionId, workspaceId, dryRun) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        if (typeof workspaceId !== 'string' || workspaceId.length === 0) return
        setBusy(true)
        setOutcome(null)
        api
          .call('move', { sessionId, targetWorkspace: workspaceId, dryRun: dryRun === true })
          .then(
            (value) => {
              setOutcome({ ok: true, report: value, dryRun: dryRun === true })
              if (dryRun !== true) setToken((current) => current + 1)
            },
            (error) => setOutcome({ ok: false, error: String(error?.message ?? error) }),
          )
          .then(() => setBusy(false))
      }

      const children = []
      children.push(h('div', { key: 'title', style: S.title }, '会话归位'))
      children.push(
        h('div', { key: 'hint', style: S.muted },
          '把会话卡片拖到下面的工作区即可搬迁（真搬迁：日志与 header.cwd 一起走）。也可以点卡片选中，再用上面的下拉框精确选择。' +
            (busy ? ' 处理中…' : '')),
      )
      if (failure !== null) children.push(h('div', { key: 'fail', style: S.bad }, `读取失败：${failure}`))

      children.push(
        h('div', { key: 'bar', style: S.bar }, [
          h('input', {
            key: 'q',
            style: S.input,
            type: 'text',
            placeholder: '筛选：标题 / 路径 / 工作区 / id',
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          }),
          h('button', { key: 'r', type: 'button', style: busy ? { ...S.button, ...S.disabled } : S.button, disabled: busy, onClick: () => setToken((current) => current + 1) }, '刷新'),
        ]),
      )

      const sessionOptions = [h('option', { key: 'none', value: '' }, '（未选中）')]
      for (const row of rows) {
        sessionOptions.push(
          h('option', { key: row.id, value: row.id },
            `${titleOf(row) || '(无标题)'} — ${row.workspaceTitle ?? '未分组'} · ${shortId(row.id)}`),
        )
      }
      const workspaceOptions = [h('option', { key: 'none', value: '' }, '（未选择）')]
      for (const workspace of workspaces) {
        workspaceOptions.push(h('option', { key: workspace.id, value: workspace.id }, `${workspace.title} — ${workspace.path}`))
      }
      const blocked = busy || selectedRow === undefined || targetPick.length === 0 || selectedRow.running === 'running'
      children.push(
        h('div', { key: 'manual', style: S.bar }, [
          h('select', {
            key: 's',
            style: { ...S.select, flex: '1 1 150px' },
            value: selectedRow === undefined ? '' : selectedRow.id,
            onChange: (event) => setSelected(event.target.value),
          }, sessionOptions),
          h('select', {
            key: 'w',
            style: { ...S.select, flex: '1 1 130px' },
            value: targetPick,
            onChange: (event) => setTargetPick(event.target.value),
          }, workspaceOptions),
          h('button', {
            key: 'dry',
            type: 'button',
            style: blocked ? { ...S.button, ...S.disabled } : S.button,
            disabled: blocked,
            onClick: () => runMove(selectedRow.id, targetPick, true),
          }, '预演'),
          h('button', {
            key: 'go',
            type: 'button',
            style: blocked ? { ...S.primary, ...S.disabled } : S.primary,
            disabled: blocked,
            onClick: () => runMove(selectedRow.id, targetPick, false),
          }, '移动'),
        ]),
      )

      children.push(h('div', { key: 'labelSessions', style: S.label }, `会话 ${rows.length} / ${sessions.length}`))
      const cards = []
      rows.forEach((row, index) => {
        const draggable = row.running !== 'running'
        const badges = []
        if (row.running === 'running') badges.push(h('span', { key: 'run', style: S.badgeWarn }, '● 运行中'))
        else if (row.resident) badges.push(h('span', { key: 'live', style: S.badge }, '○ 已加载'))
        else badges.push(h('span', { key: 'cold', style: S.badge }, '冷会话'))
        if (row.archived) badges.push(h('span', { key: 'arch', style: S.badge }, '已归档'))
        if (row.workspaceId === null) badges.push(h('span', { key: 'ung', style: S.badge }, '未分组'))
        if (row.hasWriteHandle) badges.push(h('span', { key: 'wh', style: S.badge }, '写入句柄'))
        // cwd 已经等于某个工作区的路径、却不在它名下（导入 / 同步回来 / 建工作区之前就有的会话）：
        // 这种"归位"只补注册表成员，不动日志。
        const samePath = workspaces.find((workspace) => workspace.path === row.cwd)
        if (samePath !== undefined && row.workspaceId !== samePath.id) {
          badges.push(h('span', { key: 'filed', style: S.badge }, `⟲ 可直接归位：${samePath.title}`))
        }
        cards.push(
          h('div', {
            key: row.id,
            draggable,
            onDragStart: draggable
              ? (event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', row.id)
                  setDragging(row.id)
                  if (selected !== row.id) setSelected(row.id)
                }
              : undefined,
            onDragEnd: () => {
              setDragging('')
              setHover('')
            },
            onClick: () => setSelected(row.id),
            style: {
              ...S.card,
              ...(index === 0 ? S.cardFirst : null),
              ...(selected === row.id ? S.cardSelected : null),
              ...(dragging === row.id ? S.cardDragging : null),
              ...(draggable ? null : { cursor: 'default' }),
            },
            title: row.cwd ?? '',
          }, [
            h('div', { key: 't', style: S.cardTitle }, titleOf(row) || '(无标题)'),
            h('div', { key: 'm', style: S.meta },
              `${row.workspaceTitle ?? '未分组'} · ${baseName(row.cwd) || '无 cwd'} · ${shortId(row.id)}${row.createdAt ? ` · ${stamp(row.createdAt)}` : ''}`),
            h('div', { key: 'b', style: S.badges }, badges),
          ]),
        )
      })
      if (cards.length === 0) cards.push(h('div', { key: 'empty', style: { ...S.muted, padding: '8px 10px' } }, '没有匹配的会话。'))
      children.push(h('div', { key: 'cards', style: fill ? { ...S.cards, ...S_FILL.cards } : S.cards }, cards))

      children.push(h('div', { key: 'labelWs', style: S.label }, '工作区（拖到这里）'))
      const wsRows = []
      workspaces.forEach((workspace, index) => {
        const isCurrent = selectedRow !== undefined && selectedRow !== null && selectedRow.workspaceId === workspace.id
        const active = hover === workspace.id
        wsRows.push(
          h('div', {
            key: workspace.id,
            onDragOver: (event) => {
              if (dragging.length === 0) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              if (hover !== workspace.id) setHover(workspace.id)
            },
            onDragLeave: () => {
              if (hover === workspace.id) setHover('')
            },
            onDrop: (event) => {
              event.preventDefault()
              const dropped = dragging.length > 0 ? dragging : event.dataTransfer.getData('text/plain')
              setDragging('')
              setHover('')
              runMove(dropped, workspace.id, false)
            },
            onClick: () => setTargetPick(workspace.id),
            style: {
              ...S.ws,
              ...(index === 0 ? { borderTop: 'none' } : null),
              ...(active ? S.wsHover : null),
              cursor: dragging.length > 0 ? 'copy' : 'pointer',
            },
          }, [
            h('div', { key: 't', style: S.wsTitle }, [
              h('span', { key: 'n' }, workspace.title),
              h('span', { key: 'c', style: S.wsCount }, `${workspace.visible}${workspace.accounted !== workspace.visible ? `/${workspace.accounted}` : ''}`),
              isCurrent ? h('span', { key: 'cur', style: S.badge }, '当前') : null,
            ]),
            h('div', { key: 'p', style: S.wsPath }, workspace.path),
          ]),
        )
      })
      children.push(h('div', { key: 'ws', style: fill ? { ...S.wsList, ...S_FILL.wsList } : S.wsList }, wsRows))

      if (outcome !== null && outcome !== undefined) {
        const ok = outcome.ok === true
        children.push(
          h('div', { key: 'out', style: S.result }, [
            h('div', { key: 's', style: ok ? S.good : S.bad },
              ok
                ? `${outcome.dryRun === true ? '✔ 预演完成' : '✔ 已搬迁'}${outcome.report?.noop === true ? '（无需搬迁）' : ''}`
                : `✘ ${String(outcome.error)}`),
            h('pre', { key: 'd', style: S.pre }, JSON.stringify(outcome.report ?? outcome, null, 2)),
          ]),
        )
      }

      children.push(
        h('div', { key: 'foot', style: S.tiny },
          snapshot !== null && snapshot !== undefined
            ? `根目录 ${snapshot.root} · zstd=${String(snapshot.zstd)} · 工作区 ${snapshot.counts?.workspaces ?? workspaces.length} · 会话 ${snapshot.counts?.stored ?? sessions.length}（Host 内已加载 ${snapshot.counts?.resident ?? 0}）`
            : '正在读取 Host 状态…'),
      )
      return h('div', { style: fill ? { ...S.root, ...S_FILL.root } : S.root }, children)
    }
  }

  /** 右栏页签标题。 */
  function createTabTitle(React) {
    return function SessionMoveTabTitle() {
      return React.createElement('span', null, '会话归位')
    }
  }


    sessionMoveHalf = (require) => {
      const React = require('react')

      function apply(ctx) {
        const api = createApi()
        const Panel = createPanel(React, api)

        // 右栏页签：优先 better-sidebar，回落到原生。
        // 左栏底部那个 ⇄ 入口已去掉（2026-10-26）：会话归位只挂侧边栏页签，不再往左栏
        // footer 塞按钮。
        const registerNativeTab = () => {
          try {
            return ctx.inject(['sidebarRightTabs'], (injected) => {
              const tabs = injected.get('sidebarRightTabs')
              if (tabs === undefined) return undefined
              const disposeDefinition = tabs.register({
                id: TAB_ID,
                kind: TAB_ID,
                priority: 'extension',
                title: () => '会话归位',
                guide: [{ order: 140, title: () => '会话归位' }],
              })
              const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
                ctx.slots.register(
                  { name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({ fill: true }) },
                  Panel,
                ),
              )
              const disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
                ctx.slots.register(
                  { name: 'sidebar.right.pane.tab.title', key: TAB_ID, inject: () => ({}) },
                  createTabTitle(React),
                ),
              )
              return () => {
                try {
                  disposeTitle?.dispose?.()
                  disposeBody?.dispose?.()
                  disposeDefinition?.()
                } catch {
                  /* 卸载失败不影响其它入口 */
                }
              }
            })
          } catch {
            return undefined
          }
        }

        let nativeTabDispose = registerNativeTab()
        try {
          ctx.inject(['betterSidebar'], (injected) => {
            const service = injected.get('betterSidebar')
            if (service === undefined || typeof service.registerTab !== 'function') return undefined
            // 顺序是硬要求：registerTab 会同步把描述符镜像到原生 sidebarRightTabs，
            // 所以必须先把原生那条撤掉，否则撞 kind。
            try {
              nativeTabDispose?.dispose?.()
            } catch {
              /* 撤不掉也要往下走，catch 会把原生接回来 */
            }
            nativeTabDispose = undefined
            let disposeBetter
            try {
              disposeBetter = service.registerTab({
                id: BETTER_TAB_ID,
                title: () => '会话归位',
                description: () => '把会话拖到另一个工作区：真搬迁（日志与 header.cwd 一起走），可预演。',
                order: 140,
                single: true,
                component: () => React.createElement(Panel, { fill: true }),
              })
            } catch {
              nativeTabDispose = registerNativeTab()
              return undefined
            }
            return () => {
              try {
                disposeBetter?.()
              } catch {
                /* 卸载失败不影响其它入口 */
              }
              if (nativeTabDispose === undefined) nativeTabDispose = registerNativeTab()
            }
          })
        } catch {
          /* 没有 betterSidebar 时留在原生路径 */
        }
        ctx.effect(
          () => () => {
            try {
              nativeTabDispose?.dispose?.()
            } catch {
              /* 卸载失败不影响其它入口 */
            }
          },
          'dsh-session-move: pane tab teardown',
        )
      }

      return { inject: ['slots'], apply }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // 模块加载：一个包、一个 loader id、一个插件对象
  // ───────────────────────────────────────────────────────────────────────

  const target = globalThis.window === undefined ? undefined : globalThis.window.__ModuleLoader__
  if (target === undefined) {
    throw new Error(
      `${PACKAGE}: window.__ModuleLoader__ is missing — this bundle is served by the DSH web shell and cannot be loaded directly`,
    )
  }

  target.load({
    id: PACKAGE,
    factory: (require) => {
      const adminHalf = sessionAdminHalf(require)
      const moveHalf = sessionMoveHalf(require)

      /**
       * 两半各自 apply 一次：都只碰自己的槽位与自己的 HTTP 前缀，顺序无关紧要。
       * `inject` 取并集——删除半边要 `sessions`（会话标题）与 `configForms`（插件页配置
       * 卡片自己取共享表单），搬迁半边只用 `slots`。
       */
      function apply(ctx) {
        adminHalf.apply(ctx)
        moveHalf.apply(ctx)
      }

      return { inject: ['slots', 'sessions', 'configForms'], apply }
    },
  })
})()
