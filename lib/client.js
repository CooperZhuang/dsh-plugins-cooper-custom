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

    /**
     * Build the browser plugin.
     * @returns the Cordis plugin export (`inject` + `apply`).
     */
    function createPlugin() {
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
          status: () => ({
            lastSeq,
            settings: { ...settings },
            uiWorkspace: uiWorkspace !== null,
            readyState: source === null ? null : source.readyState,
          }),
        }
      }

      return { inject: ['workspaces', 'sessions'], apply }
    }

    const plugin = createPlugin(require);
    exports.apply = plugin.apply;
    exports.inject = plugin.inject;
    return module.exports;
  }
});
