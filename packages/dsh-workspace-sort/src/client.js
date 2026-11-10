/**
 * Browser half of `dsh-workspace-sort`.
 *
 * The shipped sidebar orders Workspaces only by the Host's durable drag order:
 * `View options → Last updated` sorts the Sessions *inside* each Workspace and
 * never the Workspaces themselves. This bundle closes that gap and adds the one
 * safe layer a Workspace needs — its own ordering — while deliberately leaving
 * every filesystem and destructive operation out of scope:
 *
 *   * automatic order by each Workspace's newest human prompt (`updatedAt` on a
 *     non-blank Session), optionally with running Workspaces first;
 *   * pins that keep chosen Workspaces at the front, in pin order;
 *   * a panel beside the sidebar footer to see session/running counts and the
 *     last activity, filter by name, toggle the two rules, and tidy once;
 *   * every write goes through `ctx.workspaces.insertBefore`, the same durable
 *     command a Workspace drag uses.
 *
 * Not implemented on purpose (the reference plugin's risky half): moving or
 * renaming a Workspace's directory, removing or re-binding a Workspace, or
 * spawning anything from the Host. Ordering state only.
 *
 * Guard rails:
 *
 *   * only a human prompt (or an explicit button) starts a pass;
 *   * a manual drag wins until the next prompt;
 *   * one pass at a time, and a pass that finds the order in place writes nothing;
 *   * the Host half answers the knobs on its own route; a page that cannot read
 *     that route stays inert instead of guessing.
 *
 * `src/sort.js` (inlined by `scripts/build-client.mjs`) holds the pure rules.
 */
window.__ModuleLoader__.load({
  id: '@cooper-zhuang/dsh-workspace-sort',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    // ---- src/sort.js (inlined by scripts/build-client.mjs) -----------------
    /* SORT_RULES_PLACEHOLDER */
    // -----------------------------------------------------------------------

    /** Routes, hand-mirrored from `index.js`: the two halves cannot import each other. */
    const STATE_ROUTE = '/dsh-workspace-sort/api/state'
    const PREFS_ROUTE = '/dsh-workspace-sort/api/prefs'

    /** Locale namespace for this plugin's own labels. */
    const NS = 'workspaceSort'

    /** Coalesce the burst of store updates one prompt produces. */
    const SETTLE_MS = 400

    /** A workspace write within this window is ours; a later order change is the user dragging. */
    const SELF_WRITE_MS = 2000

    /** One retry at most when a write did not land as computed, so a race cannot spin. */
    const MAX_ATTEMPTS = 2

    const DEFAULTS = { enabled: true, aggregate: true, initialSort: true }

    const DEFAULT_PREFS = { auto: true, runningFirst: false, pins: [] }

    const DICT = {
      zh: {
        button: '工作区排序',
        title: '工作区排序',
        close: '关闭',
        auto: '按最近提问自动排序',
        runningFirst: '运行中的排前面',
        tidy: '立即整理',
        filter: '筛选工作区',
        empty: '没有匹配的工作区',
        pinOn: '置顶此工作区',
        pinOff: '取消置顶',
        pinnedTag: '置顶',
        sessions: '{n} 会话',
        running: '{n} 运行中',
        idle: '无会话',
        never: '从没用过',
        minutes: '{n} 分钟前',
        hours: '{n} 小时前',
        days: '{n} 天前',
        note: '只改侧栏顺序，不动文件与会话',
        disabled: '宿主配置已停用自动排序，只能点「立即整理」',
        ephemeral: '本次会话内的置顶与开关不会保存：宿主是旧版插件，重启一次宿主后即可落盘',
      },
      en: {
        button: 'Workspace order',
        title: 'Workspace order',
        close: 'Close',
        auto: 'Sort by latest prompt',
        runningFirst: 'Running first',
        tidy: 'Tidy now',
        filter: 'Filter workspaces',
        empty: 'No workspace matches',
        pinOn: 'Pin this workspace',
        pinOff: 'Unpin',
        pinnedTag: 'Pinned',
        sessions: '{n} sessions',
        running: '{n} running',
        idle: 'No sessions',
        never: 'Never used',
        minutes: '{n} min ago',
        hours: '{n} h ago',
        days: '{n} d ago',
        note: 'Reorders the sidebar only; it never touches files or sessions',
        disabled: 'Disabled in the Host config; only "Tidy now" works',
        ephemeral: 'Pins and switches are session-only here: the Host runs the previous build, restart it once to persist them',
      },
    }

    const STYLE_ID = 'workspace-sort-styles'
    const CSS = `
.wss-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.wss-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wss-btn[data-open="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wss-panel{position:fixed;left:8px;bottom:58px;width:340px;max-height:min(70vh,640px);display:flex;flex-direction:column;box-sizing:border-box;padding:10px;border-radius:var(--dsw-radius-lg,10px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 32px rgba(0,0,0,.28);z-index:40;font-size:13px;color:var(--dsw-alias-label-primary)}
.wss-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 2px 8px}
.wss-title{font-size:13px;font-weight:600}
.wss-row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:var(--dsw-radius-sm,6px);cursor:default}
.wss-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wss-pin{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;padding:0}
.wss-pin:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wss-pin[data-pinned="true"]{color:var(--dsw-alias-brand-primary)}
.wss-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wss-meta{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;flex:none}
.wss-tag{font-size:11px;color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;flex:none}
.wss-list{overflow:auto;min-height:0;flex:1;margin:0 -2px;padding:0 2px}
.wss-tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:0 2px 8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.wss-tools label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.wss-input{width:100%;box-sizing:border-box;height:28px;padding:0 8px;margin:0 0 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);outline:none;font-size:13px}
.wss-input:focus{border-color:var(--dsw-alias-brand-primary)}
.wss-action{height:26px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;flex:none}
.wss-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wss-note{padding:8px 2px 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.wss-warn{color:var(--dsw-alias-state-warn-primary)}
`

    /**
     * A minimal external store: the engine reads it, React subscribes to it.
     *
     * @param initial - starting value.
     * @returns `get`, `set`, and `subscribe`.
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => {
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /**
     * Re-render one component when a store changes.
     *
     * @param store - a store from `createStore`.
     * @returns its current value.
     */
    function useStore(store) {
      const [, force] = React.useState(0)
      React.useEffect(() => store.subscribe(() => force((tick) => tick + 1)), [store])
      return store.get()
    }

    /**
     * Mirror one Client snapshot store into React.
     *
     * @param store - a Client snapshot store (`getSnapshot`/`subscribe`).
     * @returns its current snapshot.
     */
    function useSnapshot(store) {
      const [snapshot, setSnapshot] = React.useState(() => store.getSnapshot())
      React.useEffect(() => {
        setSnapshot(store.getSnapshot())
        return store.subscribe(() => setSnapshot(store.getSnapshot()))
      }, [store])
      return snapshot
    }

    /**
     * Reduce arbitrary JSON to the preference shape, dropping anything unusable.
     *
     * @param value - whatever the Host answered.
     * @returns `{auto, runningFirst, pins}`.
     */
    function sanitizePrefs(value) {
      const record = value !== null && typeof value === 'object' ? value : {}
      const pins = Array.isArray(record.pins) ? record.pins.filter((id) => typeof id === 'string' && id.length > 0) : []
      return {
        auto: record.auto !== false,
        runningFirst: record.runningFirst === true,
        pins: [...new Set(pins)],
      }
    }

    /**
     * The footer icon: an ordered list with an activity arrow.
     *
     * @returns the SVG element.
     */
    function SortIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M2.5 4h11M2.5 8h7M2.5 12h4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M12 7.2v4.3m0 0l-1.6-1.6m1.6 1.6l1.6-1.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /**
     * The pin glyph: filled when pinned.
     *
     * @param props - `{pinned}`.
     * @returns the SVG element.
     */
    function PinIcon({ pinned }) {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', {
          d: 'M9.6 1.7l4.7 4.7-1.9.5-2.7 2.7.3 2.6-1.2 1.2L5 8.1 1.9 11.4l-.7-.7L4.5 7.3.2 3.4l1.2-1.2 2.6.3 2.7-2.7.5-1.9z',
          fill: pinned ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: pinned ? 0 : 1.2,
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
         * Render one timestamp as a coarse relative age.
     *
         * @param stamp - epoch milliseconds.
         * @param tr - the bound translator.
         * @returns the localized label.
     */
        function relativeTime(stamp, tr) {
      const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60000))
      if (minutes < 60) return tr('minutes', { n: Math.max(1, minutes) })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return tr('hours', { n: hours })
      return tr('days', { n: Math.round(hours / 24) })
    }

    return {
      inject: ['workspaces', 'sessions', 'locale', 'slots'],
      apply(ctx) {
        let options = { ...DEFAULTS }
        let timer
        let disposed = false
        /** Timestamp of our own last durable write, to recognise its echo. */
        let selfWriteAt = 0
        /** The user reordered by hand; sorting waits for the next prompt. */
        let manualHold = false
        /** Activity stamps already seen, so only a fresh prompt counts as activity. */
        const seen = new Map()
        /** Whether the baseline pass has run; before that the catalog may still be filling in. */
        let sorted = false
        /** A pass is wanted because activity, the baseline, or a button asked for one. */
        let wanted = false
        /** The next pass must run even when automatic ordering is off. */
        let forced = false
        /** A pass is currently running. */
        let busy = false
        /** The Workspace ids of the previous store emission (to see drags apart from add/remove). */
        let knownIds = []

        const prefs = createStore({ ...DEFAULT_PREFS })
        /** Whether this Host half exposes the prefs route; an older build does not. */
        const capabilities = createStore({ persist: false })
        const panel = createStore({ open: false })
        const t = () => ctx.locale.bind(NS)

        const readItems = () => {
          try {
            const snapshot = ctx.workspaces?.list?.getSnapshot?.()
            return Array.isArray(snapshot?.items) ? snapshot.items : []
          } catch {
            return []
          }
        }

        const readSummaries = () => {
          try {
            const snapshot = ctx.sessions?.list?.getSnapshot?.()
            return snapshot !== null && typeof snapshot === 'object' && typeof snapshot.byId === 'object' && snapshot.byId !== null
              ? snapshot.byId
              : {}
          } catch {
            return {}
          }
        }

        const warn = (message, error) => {
          if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn(`[dsh-workspace-sort] ${message}`, error ?? '')
          }
        }

        const updatePrefs = (patch) => prefs.set({ ...prefs.get(), ...patch })

        /**
         * Persist the prefs on the Host. `localStorage` cannot hold them: the
         * desktop Web server uses an ephemeral port, so the page origin (and every
         * entry under it) changes on each restart.
         *
         * @param value - the prefs to store.
         */
        const savePrefs = (value) => {
          try {
            void fetch(PREFS_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(value),
            })
              .then((response) => {
                if (!response.ok) warn(`prefs not saved (HTTP ${response.status})`)
              })
              .catch((error) => warn('prefs not saved', error))
          } catch (error) {
            warn('prefs not saved', error)
          }
        }

        /**
         * Drop pins whose Workspace no longer exists, so the pin order never keeps
         * a ghost id ahead of every real row.
         *
         * @param workspaceIds - the ids the Host currently reports.
         */
        const prunePins = (workspaceIds) => {
          const pins = prefs.get().pins
          const next = pins.filter((id) => workspaceIds.indexOf(id) !== -1)
          if (next.length !== pins.length) updatePrefs({ pins: next })
        }

        /**
         * Note every Session stamp and report whether a human prompt advanced one.
         *
         * @returns true when a summary's `updatedAt` moved forward, or a Session
         *   that appeared after the baseline pass already carries a prompt.
         */
        const noteActivity = () => {
          const byId = readSummaries()
          let advanced = false
          for (const id of Object.keys(byId)) {
            const summary = byId[id]
            const stamp = typeof summary?.updatedAt === 'number' ? summary.updatedAt : 0
            const previous = seen.get(id)
            if (previous === undefined) {
              seen.set(id, stamp)
              // After the baseline pass a brand-new prompt IS the activity: a
              // first prompt in a Workspace that never had a Session before.
              if (sorted && stamp > 0) advanced = true
              continue
            }
            if (stamp > previous) {
              seen.set(id, stamp)
              advanced = true
            }
          }
          return advanced
        }

        /**
         * Tell the Host half what a pass decided. The Host keeps the last report
         * for `GET /dsh-workspace-sort/api/state` and one log line, so a reload
         * or `curl` can answer "why did my workspace list move?".
         *
         * @param payload - the decision, already JSON-safe.
         */
        const report = (payload) => {
          try {
            void fetch(STATE_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...payload, at: Date.now() }),
            }).catch(() => {})
          } catch {
            /* diagnostics only: never let the report path break a reorder */
          }
        }

        /**
         * One reconcile pass: compute the display order and write the difference.
         *
         * @param manual - true when a button asked for this pass, which ignores
         *   the automatic-ordering switch and any manual drag hold.
         * @returns true when this pass wrote a durable order.
         */
        const pass = async (manual) => {
          if (disposed || options.enabled === false) return false
          const items = readItems()
          if (items.length < 2) return false
          const byId = readSummaries()
          if (Object.keys(byId).length === 0) return false
          const state = prefs.get()
          if (!manual && !state.auto) return false

          const shared = {
            aggregate: options.aggregate !== false,
            pins: state.pins,
            runningFirst: state.runningFirst,
          }
          const current = items.map((workspace) => workspace.workspaceId)
          prunePins(current)
          const desired = desiredOrder(items, byId, shared)
          const newest = newestActivity(activityByWorkspace(items, byId, shared))
          if (newest === 0) {
            // Before the baseline pass the summary store may still be filling in;
            // an all-zero ranking would only reproduce the current index order.
            return false
          }
          if (sameOrder(current, desired)) {
            sorted = true
            manualHold = false
            return false
          }
          if (!manual && sorted && manualHold) return false

          const moves = planMoves(current, desired)
          if (moves.length === 0) {
            sorted = true
            return false
          }
          for (const move of moves) {
            selfWriteAt = Date.now()
            await ctx.workspaces.insertBefore(move.id, move.before)
          }
          sorted = true
          manualHold = false
          report({ current, desired, moves, newest, manual: manual === true })
          return true
        }

        /**
         * Run passes until the queue is empty, one at a time.
         */
        const drain = async () => {
          if (busy) return
          busy = true
          try {
            for (let attempt = 0; attempt < MAX_ATTEMPTS && wanted && !disposed; attempt += 1) {
              const manual = forced
              wanted = false
              forced = false
              await pass(manual)
              if (!wanted) break
            }
          } catch (error) {
            warn('reorder failed', error)
          } finally {
            busy = false
          }
        }

        const schedule = (delay = SETTLE_MS) => {
          if (disposed) return
          wanted = true
          if (timer !== undefined) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = undefined
            void drain()
          }, delay)
        }

        /**
         * Ask for one immediate pass, used by the panel's buttons.
         *
         * @param manual - true for a button press.
         */
        const request = (manual) => {
          if (manual) forced = true
          schedule(0)
        }

        /**
         * Read this bundle's knobs from the Host half before sorting at all.
         */
        const start = async () => {
          let body
          try {
            const response = await fetch(STATE_ROUTE, { headers: { accept: 'application/json' } })
            body = response.ok ? await response.json() : undefined
          } catch (error) {
            warn('host half unreachable; leaving the workspace order untouched', error)
            options = { ...options, enabled: false }
            return
          }
          if (body === undefined || body === null || body.ok !== true || typeof body.config !== 'object' || body.config === null) {
            warn('host half did not answer; leaving the workspace order untouched')
            options = { ...options, enabled: false }
            return
          }
          options = { ...DEFAULTS, ...body.config }
          if (disposed || options.enabled === false) return
          // An older Host half answers without `prefs`; keep pins in memory then,
          // instead of posting to a route that does not exist yet.
          if (body.prefs !== undefined && body.prefs !== null) {
            prefs.set(sanitizePrefs(body.prefs))
            capabilities.set({ persist: true })
          }
          report({ hello: true, options })
          if (options.initialSort !== false) schedule(0)
        }

        // ------------------------------------------------------------ styles
        ctx.effect(() => {
          // HMR re-executes this bundle while the document persists: overwrite the
          // tag instead of skipping it, or the page keeps the first CSS.
          const style = document.getElementById(STYLE_ID) ?? document.createElement('style')
          style.id = STYLE_ID
          style.textContent = CSS
          if (!style.isConnected) document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-workspace-sort: styles')

        // ------------------------------------------------------------ locale
        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-workspace-sort: locale')

        // ------------------------------------------------------------ prefs
        ctx.effect(
          () =>
            prefs.subscribe(() => {
              if (capabilities.get().persist) savePrefs(prefs.get())
            }),
          'dsh-workspace-sort: prefs',
        )

        // ------------------------------------------------------------- engine
        ctx.effect(() => {
          const offs = []
          try {
            // The Workspace store is watched only for two side facts: a reorder
            // that is not our own echo (the user dragging) and the id set (so an
            // added or removed Workspace is not mistaken for a drag). It must NOT
            // start a pass: our own writes would then feed themselves.
            offs.push(
              ctx.workspaces.list.subscribe(() => {
                const ids = readItems().map((workspace) => workspace.workspaceId)
                const membershipChanged = ids.length !== knownIds.length || ids.some((id) => knownIds.indexOf(id) === -1)
                const orderChanged = !membershipChanged && ids.some((id, index) => id !== knownIds[index])
                if (orderChanged && sorted && Date.now() - selfWriteAt > SELF_WRITE_MS) manualHold = true
                knownIds = ids
              }),
            )
            // The Session store is the only activity source. Before the baseline
            // pass its first fill is what makes the initial sort possible; after
            // that only a fresh human prompt may request another pass.
            offs.push(
              ctx.sessions.list.subscribe(() => {
                const advanced = noteActivity()
                if (advanced) manualHold = false
                if (advanced || (!sorted && prefs.get().auto)) schedule()
              }),
            )
            // A pin or a rule toggle changes the target order: re-sort at once.
            offs.push(prefs.subscribe(() => request(true)))
          } catch (error) {
            warn('could not follow the sidebar stores', error)
          }
          void start()
          return () => {
            disposed = true
            if (timer !== undefined) clearTimeout(timer)
            timer = undefined
            for (const off of offs) {
              try {
                off()
              } catch {
                /* already detached */
              }
            }
          }
        }, 'dsh-workspace-sort: activity order')

        // ----------------------------------------------------------------- UI
        /**
         * One Workspace row: pin toggle, name, and its activity summary.
         *
         * @param props - `{workspace, byId, pinned}` plus the resolved `t`.
         * @returns the row element.
         */
        function Row({ workspace, byId, pinned, tr }) {
          const members = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
          let running = 0
          let last = 0
          for (const id of members) {
            const summary = byId[id]
            if (summary === undefined || summary === null) continue
            if (summary.running === true) running += 1
            if (summary.blank !== true && typeof summary.updatedAt === 'number' && summary.updatedAt > last) last = summary.updatedAt
          }
          const meta = members.length === 0 ? tr('idle') : tr('sessions', { n: members.length })
          const when = last === 0 ? tr('never') : relativeTime(last, tr)
          return h(
            'div',
            { className: 'wss-row', 'data-row': workspace.workspaceId },
            h(
              'button',
              {
                type: 'button',
                className: 'wss-pin',
                'data-pinned': pinned ? 'true' : 'false',
                title: pinned ? tr('pinOff') : tr('pinOn'),
                'aria-pressed': pinned ? 'true' : 'false',
                onClick: () => {
                  const current = prefs.get()
                  const pins = current.pins.includes(workspace.workspaceId)
                    ? current.pins.filter((id) => id !== workspace.workspaceId)
                    : [...current.pins, workspace.workspaceId]
                  updatePrefs({ pins })
                },
              },
              h(PinIcon, { pinned }),
            ),
            h('span', { className: 'wss-name', title: workspace.path }, workspace.title || workspace.path),
            running > 0 ? h('span', { className: 'wss-tag' }, tr('running', { n: running })) : null,
            h('span', { className: 'wss-meta', title: when }, `${meta} · ${when}`),
          )
        }

        /** The panel: rules, a filter, and every Workspace in Host order. */
        function Panel() {
          const [, tick] = React.useState(0)
          React.useEffect(() => ctx.locale.subscribe(() => tick((n) => n + 1)), [])
          const tr = t()
          const state = useStore(panel)
          const statePrefs = useStore(prefs)
          const capability = useStore(capabilities)
          const workspaceSnapshot = useSnapshot(ctx.workspaces.list)
          const sessionSnapshot = useSnapshot(ctx.sessions.list)
          const [filter, setFilter] = React.useState('')
          React.useEffect(() => {
            if (!state.open) return undefined
            const onKey = (event) => {
              if (event.key === 'Escape') panel.set({ open: false })
            }
            window.addEventListener('keydown', onKey)
            return () => window.removeEventListener('keydown', onKey)
          }, [state.open])
          if (!state.open) return null
          const items = Array.isArray(workspaceSnapshot.items) ? workspaceSnapshot.items : []
          const needle = filter.trim().toLowerCase()
          const visible = needle.length === 0
            ? items
            : items.filter((workspace) => String(workspace.title || workspace.path).toLowerCase().includes(needle))
          return h(
            'div',
            { className: 'wss-panel', role: 'dialog', 'aria-label': tr('title') },
            h(
              'div',
              { className: 'wss-head' },
              h('span', { className: 'wss-title' }, tr('title')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wss-btn',
                  title: tr('close'),
                  onClick: () => panel.set({ open: false }),
                },
                '✕',
              ),
            ),
            h(
              'div',
              { className: 'wss-tools' },
              h(
                'label',
                null,
                h('input', {
                  type: 'checkbox',
                  checked: statePrefs.auto,
                  onChange: (event) => updatePrefs({ auto: event.target.checked }),
                }),
                tr('auto'),
              ),
              h(
                'label',
                null,
                h('input', {
                  type: 'checkbox',
                  checked: statePrefs.runningFirst,
                  onChange: (event) => updatePrefs({ runningFirst: event.target.checked }),
                }),
                tr('runningFirst'),
              ),
              h(
                'button',
                { type: 'button', className: 'wss-action', onClick: () => request(true) },
                tr('tidy'),
              ),
            ),
            h('input', {
              className: 'wss-input',
              value: filter,
              placeholder: tr('filter'),
              onChange: (event) => setFilter(event.target.value),
            }),
            h(
              'div',
              { className: 'wss-list' },
              visible.length === 0
                ? h('div', { className: 'wss-note' }, tr('empty'))
                : visible.map((workspace) =>
                    h(Row, {
                      key: workspace.workspaceId,
                      workspace,
                      byId: sessionSnapshot.byId ?? {},
                      pinned: statePrefs.pins.includes(workspace.workspaceId),
                      tr,
                    }),
                  ),
            ),
            h('div', { className: 'wss-note' }, tr('note')),
            capability.persist ? null : h('div', { className: 'wss-note wss-warn' }, tr('ephemeral')),
            options.enabled === false ? h('div', { className: 'wss-note wss-warn' }, tr('disabled')) : null,
          )
        }

        /** The footer action that opens and closes the panel. */
        function FooterAction() {
          const state = useStore(panel)
          return h(
            'button',
            {
              type: 'button',
              className: 'wss-btn',
              'data-open': state.open ? 'true' : 'false',
              title: t()('button'),
              'aria-expanded': state.open ? 'true' : 'false',
              onClick: () => panel.set({ open: !state.open }),
            },
            h(SortIcon, null),
          )
        }

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'workspace-sort', order: 40, label: () => t()('button') },
            FooterAction,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'workspace-sort', order: 55 }, Panel),
        )
      },
    }
  },
})
