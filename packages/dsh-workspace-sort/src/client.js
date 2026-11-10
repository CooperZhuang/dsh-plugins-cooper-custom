/**
 * Browser half of `dsh-workspace-sort`.
 *
 * The shipped sidebar orders Workspaces only by the Host's durable drag order:
 * `View options → Last updated` sorts the Sessions *inside* each Workspace and
 * never the Workspaces themselves. This bundle closes that gap. It reads the
 * two Client stores the sidebar already maintains — `ctx.workspaces.list`
 * (Host order) and `ctx.sessions.list` (Session summaries with `updatedAt`) —
 * and, whenever a human prompt advances activity, writes the activity order
 * back through `ctx.workspaces.insertBefore`, the same durable reorder command
 * a Workspace drag uses.
 *
 * Guard rails, each one a promise this file keeps:
 *
 *   * only a human prompt starts a pass: opening a Session, an assistant reply,
 *     a background run, or this bundle's own write echo never re-sorts;
 *   * a manual drag wins until the next prompt: an order change this bundle did
 *     not write pauses automatic sorting instead of fighting the pointer;
 *   * one pass at a time, and a pass that already found the order in place
 *     writes nothing, so a quiet page performs no Host writes at all;
 *   * the Host half owns `enabled` / `aggregate` / `initialSort` and answers
 *     them on its own route; a page that cannot read that route stays inert and
 *     says so once in the console instead of guessing.
 *
 * `src/sort.js` (inlined by `scripts/build-client.mjs`) holds the pure rules.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-sort',
  factory(require) {
    'use strict'

    // ---- src/sort.js (inlined by scripts/build-client.mjs) -----------------
    /* SORT_RULES_PLACEHOLDER */
    // -----------------------------------------------------------------------

    /** One route, hand-mirrored from `index.js`: the two halves cannot import each other. */
    const STATE_ROUTE = '/dsh-workspace-sort/api/state'

    /** Coalesce the burst of store updates one prompt produces. */
    const SETTLE_MS = 400

    /** A workspace write within this window is ours; a later order change is the user dragging. */
    const SELF_WRITE_MS = 2000

    /** One retry at most when a write did not land as computed, so a race cannot spin. */
    const MAX_ATTEMPTS = 2

    const DEFAULTS = { enabled: true, aggregate: true, initialSort: true }

    return {
      inject: ['workspaces', 'sessions'],
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
        /** A pass is wanted because activity or the baseline changed. */
        let wanted = false
        /** A pass is currently running. */
        let busy = false
        /** The Workspace ids of the previous store emission (to see drags apart from add/remove). */
        let knownIds = []

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
         * Tell the Host half what this page decided. The Host keeps the last
         * report for `GET /dsh-workspace-sort/api/state` and one log line, so a
         * reload or `curl` can answer "why did my workspace list move?".
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
         * One reconcile pass: compute the activity order and write the difference.
         *
         * @returns true when this pass wrote a durable order.
         */
        const pass = async () => {
          if (disposed || options.enabled === false) return false
          const items = readItems()
          if (items.length < 2) return false
          const byId = readSummaries()
          if (Object.keys(byId).length === 0) return false

          const shared = { aggregate: options.aggregate !== false }
          const current = items.map((workspace) => workspace.workspaceId)
          const desired = desiredOrder(items, byId, shared)
          const newest = newestActivity(activityByWorkspace(items, byId, shared))
          if (newest === 0) {
            // Before the baseline pass the summary store may still be filling in;
            // an all-zero ranking would only reproduce the current index order.
            return false
          }
          if (sameOrder(current, desired)) {
            sorted = true
            return false
          }
          if (sorted && manualHold) return false

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
          report({ current, desired, moves, newest })
          return true
        }

        /**
         * Run passes until the queue is empty, one at a time.
         *
         * A second pass only proves the first one landed; concurrent passes could
         * each compute a move set from a half-applied order and write durably, so
         * they are serialized instead of racing.
         */
        const drain = async () => {
          if (busy) return
          busy = true
          try {
            for (let attempt = 0; attempt < MAX_ATTEMPTS && wanted && !disposed; attempt += 1) {
              wanted = false
              await pass()
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
         * Read this bundle's knobs from the Host half before sorting at all.
         */
        const start = async () => {
          let body
          try {
            const response = await fetch(STATE_ROUTE, { headers: { accept: 'application/json' } })
            body = response.ok ? await response.json() : undefined
          } catch (error) {
            warn('host half unreachable; leaving the workspace order untouched', error)
            return
          }
          if (body === undefined || body === null || body.ok !== true || typeof body.config !== 'object' || body.config === null) {
            warn('host half did not answer; leaving the workspace order untouched')
            return
          }
          options = { ...DEFAULTS, ...body.config }
          if (disposed || options.enabled === false) return
          report({ hello: true, options })
          if (options.initialSort !== false) schedule(0)
        }

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
                if (advanced || !sorted) schedule()
              }),
            )
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
      },
    }
  },
})
