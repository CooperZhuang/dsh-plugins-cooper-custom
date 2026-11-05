window.__ModuleLoader__.load({
  id: "dsh-open-in-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // ---- client/index.js ----
    /**
     * `dsh-open-in-dsh` browser half.
     *
     * Shipped as the package's `./client` bundle: the DSH client module system
     * loads it as a `window.__ModuleLoader__.load({ id, factory })` script, calls
     * `factory(require)`, and mounts the exported plugin (`apply`) into the browser
     * Cordis tree.
     *
     * What it does: follow the host half's request stream, and for every folder the
     * Explorer verb announced, make that folder the current Workspace and land in a
     * blank Session. All three steps are the Client's own services — the same ones
     * the sidebar calls — so grouping, ordering and the "current Session" store
     * behave exactly as they do for a click:
     *
     *   ctx.workspaces.create({ path })          register-or-resolve by path
     *   ctx.sessions.create({ workspaceId })     a fresh blank Session
     *   ctx.uiWorkspace.openSession(sessionId)   select it and show its Conversation
     *
     * The stream is SSE for one reason: Chrome throttles a hidden page's timers to
     * once a minute, and right after a right-click this page is hidden behind
     * Explorer. A pushed frame still runs.
     *
     * @module dsh-open-in-dsh/client
     */

    /**
     * Parse one SSE `data:` payload.
     * @param text - raw frame data.
     * @returns the parsed object, or null when the frame is not readable JSON.
     */
    function parseFrame(text) {
      try {
        const value = JSON.parse(text)
        return value !== null && typeof value === 'object' ? value : null
      } catch {
        return null
      }
    }

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-open-in-dsh'

    /**
     * Menu labels. scripts/build-client.mjs replaces the marker below with the
     * "menu" objects from locale/zh.json and locale/en.json, so the shipped bundle
     * and the package's locale files cannot drift.
     */
    const MENU_DICTIONARIES = /* @menu-dictionaries */ {"zh":{"menu.qspace":"用 QSpace Pro 打开","menu.finder":"在 Finder 中显示","menu.vscode":"用 VS Code 打开","menu.warp":"用 Warp 打开","menu.terminal":"在终端中打开","menu.explorer":"在资源管理器中显示","menu.qspaceDocument":"用 QSpace 打开所在目录","menu.qspaceSession":"用 QSpace 打开工作目录","menu.sessionNoCwd":"会话没有工作目录","menu.failed":"无法打开，请重试"},"en":{"menu.qspace":"Open in QSpace Pro","menu.finder":"Show in Finder","menu.vscode":"Open in VS Code","menu.warp":"Open in Warp","menu.terminal":"Open in Terminal","menu.explorer":"Show in Explorer","menu.qspaceDocument":"Open folder in QSpace","menu.qspaceSession":"Open workspace folder in QSpace","menu.sessionNoCwd":"No workspace folder","menu.failed":"Could not open. Try again."}}

    /** The Host's open-with route; carried by hand in lib/index.js. */
    const ROUTE_OPEN_WITH = '/dsh-open-in-dsh/api/v1/open-with'

    /** The Host's availability route; carried by hand in lib/index.js. */
    const ROUTE_APPS = '/dsh-open-in-dsh/api/v1/apps'

    /**
     * The Host's Session route; carried by hand in lib/index.js.
     *
     * The Session-scoped entry (the sidebar row menu) only ever knows a session
     * id. This route is where the Host turns that id into a directory, so the
     * browser half never guesses a cwd and never sends one.
     */
    const ROUTE_OPEN_SESSION = '/dsh-open-in-dsh/api/v1/open-session'

    /**
     * Menu order. The Host reports the subset this platform can launch; this list
     * decides how the actions stack when it reports several.
     */
    const MENU_APP_ORDER = ['qspace', 'finder', 'vscode', 'warp', 'terminal', 'explorer']

    /**
     * Whether a path is absolute in either spelling the Host accepts.
     * @param value - the path to classify.
     * @returns true for a POSIX, drive-letter or UNC absolute path.
     */
    function isAbsolutePath(value) {
      if (value.startsWith('/')) return true
      if (value.length >= 3 && value[1] === ':' && (value[2] === '/' || value[2] === '\\')) return true
      return value.startsWith('\\\\')
    }

    /**
     * Resolve a Workspace-relative path against the Session directory.
     * @param cwd - the Session's workspace root, when known.
     * @param path - absolute or Workspace-relative path.
     * @returns an absolute path, or null when a relative path has no root.
     */
    function resolveWorkspacePath(cwd, path) {
      if (isAbsolutePath(path)) return path
      if (typeof cwd !== 'string' || cwd === '') return null
      const separator = cwd.includes('\\') ? '\\' : '/'
      return cwd.replace(/[/\\]+$/, '') + separator + path.replace(/^(?:\.?[/\\])+/, '')
    }

    /**
     * The directory that contains a file, in either path spelling.
     *
     * A document preview only knows the file it is showing, and an application
     * launched with `open -a` on a file runs the file rather than showing its
     * folder. The containing directory is therefore what the action opens.
     *
     * @param path - absolute or relative file path.
     * @returns the containing directory, or null when there is none to name.
     */
    function parentDirectory(path) {
      if (typeof path !== 'string') return null
      const text = path.trim().replace(/[/\\]+$/, '')
      if (text === '') return null
      const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      if (cut < 0) return null
      // '/a.md' belongs to '/', not to ''.
      if (cut === 0) return text.slice(0, 1)
      const head = text.slice(0, cut)
      // 'C:\a.md' belongs to 'C:\', not to 'C:'.
      if (/^[A-Za-z]:$/.test(head)) return head + '\\'
      return head
    }

    /**
     * Read one external module the way the Client module table offers it.
     *
     * The bundle is loaded by `window.__ModuleLoader__`, whose `require` resolves
     * the platform seed ('react' among them). Nothing is installed for this: the
     * plugin declares no React dependency, and a composition whose seed cannot
     * answer simply gets no rendered controls instead of a bundle that fails to
     * load.
     *
     * @param require - the loader-provided require.
     * @param id - the module id to read.
     * @returns the module, or null when it is unavailable.
     */
    function tryRequire(require, id) {
      try {
        const value = typeof require === 'function' ? require(id) : null
        return value === null || value === undefined ? null : value
      } catch {
        return null
      }
    }

    /**
     * Read the injected availability hook. A composition that did not bind it (a
     * slot rendered outside this plugin's inject face) hides the control instead
     * of crashing the entry.
     * @param props - slot props.
     * @returns true when QSpace can be launched here.
     */
    function readAvailability(props) {
      if (typeof props.useQspaceAvailable !== 'function') return false
      return props.useQspaceAvailable((value) => value) === true
    }

    /** The element factory a usable React ships; null when the seed has none. */
    function elementFactory(React) {
      return React !== null && typeof React.createElement === 'function' ? React.createElement : null
    }

    /** Shared look for the two buttons; DSH theme variables only, no stylesheet. */
    const QSPACE_BUTTON_STYLE = Object.freeze({
      display: 'inline-flex',
      alignItems: 'center',
      flex: 'none',
      height: '22px',
      padding: '0 6px',
      font: 'inherit',
      fontSize: '11px',
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary)',
      background: 'transparent',
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: 'var(--dsw-radius-sm, 4px)',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    })

    /**
     * Page-lifetime "is QSpace installed" answer, bound as a slot hook.
     *
     * The Host probes the bundle once per process life, so this store asks at most
     * once: a failed answer is left unresolved and retried by the next mount,
     * because one lost request must not hide the control for the whole page.
     *
     * @param read - the availability reader (see `createAppsReader`).
     * @returns an observable source for `inject({ hooks: { qspaceAvailable } })`.
     */
    function createAvailability(read) {
      let state = null
      let loading = null
      const listeners = new Set()
      const publish = (next) => {
        if (next === state) return
        state = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // A throwing subscriber is a renderer problem, not an availability one.
          }
        }
      }
      const refresh = () => {
        if (state !== null) return loading ?? Promise.resolve()
        if (loading === null) {
          loading = Promise.resolve()
            .then(read)
            .then((ids) => {
              if (Array.isArray(ids)) publish(ids.includes('qspace'))
            })
            .catch(() => {})
            .finally(() => {
              loading = null
            })
        }
        return loading
      }
      return {
        getSnapshot: () => state === true,
        subscribe(listener) {
          listeners.add(listener)
          refresh()
          return () => {
            listeners.delete(listener)
          }
        },
        refresh,
        close() {
          listeners.clear()
        },
      }
    }

    /**
     * Read the Host's availability answer into an ordered id list.
     * @param payload - the Host response body.
     * @returns allowlisted ids the Host reported, in menu order.
     */
    function appIdsFrom(payload) {
      if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.apps)) return []
      const reported = payload.apps.filter((id) => typeof id === 'string')
      return MENU_APP_ORDER.filter((id) => reported.includes(id))
    }

    /**
     * Lazy, page-lifetime availability reader.
     *
     * A successful answer is cached; a failed one is retried on the next menu
     * opening, so one lost request does not hide the menu until a reload.
     *
     * @returns a function resolving the allowlisted ids for this platform.
     */
    function createAppsReader() {
      let cached = null
      let pending = null
      return async () => {
        if (cached !== null) return cached
        if (pending === null) {
          pending = (async () => {
            try {
              const response = await fetch(ROUTE_APPS, { headers: { accept: 'application/json' }, cache: 'no-store' })
              if (!response.ok) return []
              const ids = appIdsFrom(await response.json())
              if (ids.length > 0) cached = ids
              return ids
            } catch {
              return []
            } finally {
              pending = null
            }
          })()
        }
        return pending
      }
    }

    /**
     * Build the localized open-with actions for one target.
     * @param options - resolved app ids, absolute path, translate seat and launcher.
     * @returns the context-menu action array.
     */
    function createMenuActions(options) {
      return options.apps.map((app) => ({
        id: 'open-with.' + app,
        label: options.translate('menu.' + app),
        failureLabel: options.translate('menu.failed'),
        run: () => options.launch(app, options.absolutePath),
      }))
    }

    /**
     * Build the document-preview action: "open the folder that holds this file in
     * QSpace".
     *
     * The component is a plain function of its slot props, with no state of its
     * own: QSpace availability arrives as an injected hook (a snapshot source), so
     * a render never starts a request, and a Host that cannot launch QSpace never
     * shows the control at all.
     *
     * @param React - the seed React module (`require('react')`).
     * @param deps - `{openWith, fail}`: the Host launcher and the failure toast.
     * @returns the slot component for `sidebar.right.tab.document.actions`.
     */
    function createDocumentAction(React, deps) {
      const h = elementFactory(React)
      /**
       * @param props - slot props: `absolutePath`, `useQspaceAvailable`, `t`.
       * @returns the action button, or null when there is nothing to open.
       */
      function QspaceDocumentAction(props) {
        if (h === null) return null
        const available = readAvailability(props)
        const path = typeof props.absolutePath === 'string' ? props.absolutePath : ''
        if (available !== true || path === '') return null
        const directory = parentDirectory(path)
        if (directory === null) return null
        const label = props.t('menu.qspaceDocument')
        return h(
          'button',
          {
            type: 'button',
            'data-dsh-open-in-dsh': 'document',
            // The title says which folder, because the label has to stay short.
            title: directory,
            'aria-label': label,
            style: QSPACE_BUTTON_STYLE,
            onClick: () => {
              Promise.resolve()
                .then(() => deps.openWith('qspace', directory))
                .catch(() => deps.fail())
            },
          },
          label,
        )
      }
      return QspaceDocumentAction
    }

    /** Test and troubleshooting surface; not part of the plugin API. */
    const __internals = {
      appIdsFrom,
      createMenuActions,
      resolveWorkspacePath,
      isAbsolutePath,
      parentDirectory,
      createAvailability,
      createDocumentAction,
      MENU_APP_ORDER,
    }

    /**
     * Build the browser plugin.
     * @param require - the Client module table's require, for the platform seed
     *   React the two rendered controls are built with (no dependency is added for
     *   it; a composition without the seed simply renders no controls).
     * @returns the Cordis plugin export (`inject` + `apply`).
     */
    function createPlugin(require) {
      const React = tryRequire(require, 'react')
      /** Hand-mirrored in `lib/index.js`; the two halves cannot import each other. */
      const EVENTS_PATH = '/dsh-open-in-dsh/api/v1/events'

      /**
       * Highest request sequence this window already handled.
       *
       * Kept in `sessionStorage` so a reload does not re-open the folder the user
       * opened a moment ago, and scoped to the window so a second DSH window is
       * free to handle the same backlog.
       */
      const SEQ_KEY = 'dsh-open-in-dsh:seq'

      /**
       * Read the stored sequence.
       * @returns the stored sequence, or 0.
       */
      function readSeq() {
        try {
          const value = Number.parseInt(window.sessionStorage.getItem(SEQ_KEY) ?? '', 10)
          return Number.isFinite(value) && value > 0 ? value : 0
        } catch {
          return 0
        }
      }

      /**
       * Store the sequence.
       * @param value - the sequence to remember.
       */
      function writeSeq(value) {
        try {
          window.sessionStorage.setItem(SEQ_KEY, String(value))
        } catch {
          // A browser with storage disabled still works: it just replays on reload.
        }
      }

      /** Ask the OS for the foreground. Usually ignored without a user gesture. */
      function focusWindow() {
        try {
          window.focus()
        } catch {
          // Nothing to do; the folder is open either way.
        }
      }

      /**
       * Mount the plugin.
       * @param ctx - browser plugin context, with `workspaces` and `sessions`.
       */
      function apply(ctx) {
        const settings = { alwaysNewSession: true }
        let lastSeq = readSeq()
        let source = null
        let uiWorkspace = null

        // Soft dependency: navigation is the last step, and a composition without
        // `dsh-client-ui-workspace` should still register the Workspace and Session
        // rather than refuse to load. `ctx.get` alone would not be dependable here,
        // so the instance is captured through an injection of its own.
        ctx.inject(['uiWorkspace'], (scoped) => {
          uiWorkspace = scoped.get('uiWorkspace')
        })

        // Menu labels come from the package's locale files, inlined into this
        // bundle at build time: a right-click never waits on a dictionary fetch.
        ctx.effect(() => ctx.locale.register(NS, MENU_DICTIONARIES), 'dsh-open-in-dsh: menu dictionaries')
        const t = ctx.locale.bind(NS)

        /** Availability: one probe per page (the Host caches per process life). */
        const apps = createAppsReader()

        /**
         * Absolute path for a captured file or directory target.
         * @param target - the menu target value: { sessionId, path }.
         * @returns the absolute path, or null when it cannot be resolved.
         */
        const absolutePathFor = (target) => {
          const path = target !== null && typeof target === 'object' && typeof target.path === 'string' ? target.path : ''
          if (path === '') return null
          const cwd = ctx.sessions.list.getSnapshot().byId[target.sessionId]?.cwd
          return resolveWorkspacePath(cwd, path)
        }

        /**
         * Ask the Host to launch one allowlisted app on a path.
         *
         * The Host owns the command: this half can only name an id it received from
         * the availability route, and the Host revalidates both the id and the path
         * before spawning anything.
         *
         * @param app - allowlisted app id.
         * @param path - absolute, validated path.
         * @returns completion; rejects when the Host refuses or cannot launch.
         */
        const launch = async (app, path) => {
          const response = await fetch(ROUTE_OPEN_WITH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: path, app: app }),
          })
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (!response.ok || payload === null || payload.ok !== true) {
            const reason = payload !== null && typeof payload.reason === 'string' ? payload.reason : 'http-' + String(response.status)
            throw new Error('dsh-open-in-dsh: open-with ' + app + ' failed (' + reason + ')')
          }
        }

        /**
         * Resolve the open-with actions for one captured file or directory.
         * @param target - the menu target value: { sessionId, path }.
         * @param signal - the provider's cancellation signal.
         * @returns the action array; empty when there is nothing to offer.
         */
        const resolveActions = async (target, signal) => {
          const absolutePath = absolutePathFor(target)
          if (absolutePath === null) return []
          const ids = await apps()
          if (signal?.aborted) return []
          return createMenuActions({ apps: ids, absolutePath: absolutePath, translate: t, launch: launch })
        }

        ctx.effect(
          () => ctx.contextMenus.register({ id: 'open-with.file', target: 'file', order: 200, resolve: resolveActions }),
          'dsh-open-in-dsh: file menu',
        )
        ctx.effect(
          () => ctx.contextMenus.register({ id: 'open-with.directory', target: 'directory', order: 200, resolve: resolveActions }),
          'dsh-open-in-dsh: directory menu',
        )

        /** One QSpace availability answer per page, shared by the rendered controls. */
        const qspace = createAvailability(apps)
        ctx.effect(() => () => qspace.close(), 'dsh-open-in-dsh: qspace availability')

        /** The failure toast; the same string the menu actions use as `failureLabel`. */
        const notifyFailure = () => {
          try {
            ctx.contextMenus.notify(t('menu.failed'))
          } catch {
            // No menu overlay in this composition; the rejection is already logged.
          }
        }

        /**
         * Ask the Host to open one Session's working directory.
         *
         * The session id is all this half sends: the Host owns the id-to-cwd
         * resolution so the browser never invents a path for a Session it is not
         * currently showing.
         *
         * @param app - allowlisted app id.
         * @param sessionId - the Session to open.
         * @returns completion; rejects when the Host has no cwd or cannot launch.
         */
        const openSession = async (app, sessionId) => {
          const response = await fetch(ROUTE_OPEN_SESSION, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId, app: app }),
          })
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (!response.ok || payload === null || payload.ok !== true) {
            const reason = payload !== null && typeof payload.reason === 'string' ? payload.reason : 'http-' + String(response.status)
            throw new Error('dsh-open-in-dsh: open-session ' + app + ' failed (' + reason + ')')
          }
        }

        /**
         * Resolve the Session row menu's contribution.
         *
         * Nothing is offered when QSpace cannot be launched; a Session the Client
         * knows no cwd for still gets a row, disabled with the reason, because a
         * disappearing item reads as a broken menu.
         *
         * @param target - the menu target value: `{sessionId, displayTitle}`.
         * @param signal - the provider's cancellation signal.
         * @returns the action array; empty when there is nothing to offer.
         */
        const resolveSessionActions = async (target, signal) => {
          const sessionId =
            target !== null && typeof target === 'object' && typeof target.sessionId === 'string' ? target.sessionId : ''
          if (sessionId === '') return []
          const ids = await apps()
          if (signal?.aborted) return []
          if (!ids.includes('qspace')) return []
          const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
          if (typeof cwd !== 'string' || cwd === '') {
            return [{ id: 'qspace', label: t('menu.sessionNoCwd'), disabled: true }]
          }
          return [
            {
              id: 'qspace',
              label: t('menu.qspaceSession'),
              failureLabel: t('menu.failed'),
              run: () => openSession('qspace', sessionId),
            },
          ]
        }

        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'open-with.session',
              target: 'session',
              // Below the workspace plugin's own rows, above its footer actions.
              order: 510,
              // A Session's cwd and the active locale both decide what this row
              // says, so a row already on screen must not keep a stale answer.
              observe: () => [ctx.sessions.list, ctx.locale],
              resolve: resolveSessionActions,
            }),
          'dsh-open-in-dsh: session menu',
        )

        // The one rendered entry. `slots.inject` waits for the declaration, so a
        // composition without the document preview simply never asks for it.
        const documentAction = createDocumentAction(React, { openWith: launch, fail: notifyFailure })
        ctx.slots.inject('sidebar.right.tab.document.actions', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.document.actions',
              id: 'open-with.qspace',
              order: 10,
              locale: NS,
              inject: () => ({ hooks: { qspaceAvailable: qspace } }),
            },
            documentAction,
          ),
        )
        /**
         * Apply one announced folder.
         *
         * Order matters: the Workspace must exist on the Host before a Session can
         * name it, and `sessions.create` is what publishes the sidebar row, so the
         * Session is created through the Client rather than assumed.
         *
         * @param path - the canonical directory path.
         * @returns completion.
         */
        const openFolder = async (path) => {
          const workspace = await ctx.workspaces.create({ path })

          if (settings.alwaysNewSession === false) {
            if (uiWorkspace !== null) await uiWorkspace.openWorkspace(workspace.workspaceId)
            return
          }

          const sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
          if (uiWorkspace !== null) uiWorkspace.openSession(sessionId)
        }

        /**
         * Handle one request frame.
         *
         * `seq <= lastSeq` is the whole de-duplication: the stream replays what a
         * page missed, and EventSource reconnects with the same URL, so the same
         * frame can arrive twice.
         *
         * @param payload - the parsed frame.
         */
        const handle = (payload) => {
          if (payload === null) return
          if (!Number.isInteger(payload.seq) || payload.seq <= lastSeq) return
          if (typeof payload.path !== 'string' || payload.path.length === 0) return
          lastSeq = payload.seq
          writeSeq(lastSeq)
          openFolder(payload.path)
            .then(focusWindow)
            .catch((reason) => {
              // A refused path is the user's to see, and the Workspace notice is
              // the Client's channel for it; this half only logs.
              console.warn('dsh-open-in-dsh: could not open', payload.path, reason)
            })
        }

        /**
         * Open the stream, replaying only what this window has not handled.
         *
         * `since` travels in the URL, so a reconnect after a host restart would
         * still carry a sequence the new host has already passed — and would then
         * miss every backlog row published in the gap. `hello` reports that rewind,
         * and the stream is rebuilt from zero when it happens.
         */
        const connect = () => {
          source = new EventSource(`${EVENTS_PATH}?since=${lastSeq}`)

          source.addEventListener('hello', (event) => {
            const payload = parseFrame(event.data)
            if (payload === null) return
            if (payload.settings !== undefined && payload.settings !== null) Object.assign(settings, payload.settings)

            if (Number.isInteger(payload.seq) && payload.seq < lastSeq) {
              lastSeq = 0
              writeSeq(0)
              source.close()
              connect()
            }
          })

          // Not `open`: EventSource owns that event name for connection state.
          source.addEventListener('request', (event) => handle(parseFrame(event.data)))
        }

        connect()
        ctx.effect(() => () => source?.close(), 'dsh-open-in-dsh: request stream')

        // Troubleshooting hook, callable from the devtools console:
        //   await __dshOpenIn.open('D:\\project')
        //   __dshOpenIn.status()
        window.__dshOpenIn = {
          route: EVENTS_PATH,
          open: openFolder,
          openWith: launch,
          status: () => ({
            lastSeq,
            settings: { ...settings },
            uiWorkspace: uiWorkspace !== null,
            readyState: source === null ? null : source.readyState,
          }),
        }
      }

      return { inject: ['workspaces', 'sessions', 'contextMenus', 'locale', 'slots'], apply }
    }

    const plugin = createPlugin(require);
    exports.apply = plugin.apply;
    exports.inject = plugin.inject;
    exports.__internals = __internals;
    return module.exports;
  }
});
