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
    /**
 * Pure ordering rules for the sidebar's Workspace sections.
 *
 * The browser half (`src/client.js`) inlines this file at build time, and the
 * test suite imports it directly, so every rule here must stay free of host
 * state, timers, and network access: give it Workspaces plus Session summaries
 * and it returns the order the sidebar should show.
 *
 * Vocabulary, matching the shipped Workspace UI:
 *
 *   * a **Workspace** is one registered directory (`{workspaceId, path, sessionIds}`),
 *     ordered durably by the Host; the sidebar has no sort mode for it at all;
 *   * a Session summary carries `updatedAt` = the persisted last *human* prompt
 *     time (opening a Session or an assistant reply never advances it) and
 *     `blank` = the unsent New Session draft, which is not activity;
 *   * under **Group by → Workspace tree** the sidebar nests a Workspace below
 *     its nearest registered ancestor path and nothing else — nesting is
 *     derived from paths, so reordering the flat Host order reorders siblings.
 *     That is why the activity of a container Workspace is its whole subtree's:
 *     otherwise `Code/Mubea` (registered with an empty conversation, no Sessions)
 *     would sink below its own children.
 *
 * @module dsh-workspace-sort/sort
 */

/**
 * The nearest registered ancestor directory of `path`.
 *
 * Mirrors the shipped `owningParentFolder(path, paths)` rule: only the exact
 * registered spellings count, the match must end on a path boundary, and the
 * nearest (longest) ancestor wins.
 *
 * @param path - absolute directory of the Workspace being placed.
 * @param paths - absolute directories of every registered Workspace.
 * @returns the ancestor's registered path, or `undefined` for a root.
 */
function owningParent(path, paths) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  let best
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || candidate === path) continue
    const prefix = candidate.endsWith('/') ? candidate : `${candidate}/`
    if (!path.startsWith(prefix)) continue
    if (best === undefined || candidate.length > best.length) best = candidate
  }
  return best
}

/**
 * One Workspace's own activity: its newest counted Session prompt.
 *
 * Draft rows (`blank`) and summaries without a numeric `updatedAt` are skipped,
 * so an empty New Session never makes a Project look used.
 *
 * @param workspace - the Workspace row.
 * @param byId - Session summaries keyed by Session id.
 * @returns the newest `updatedAt` in milliseconds, or 0 when nothing counts.
 */
function ownActivity(workspace, byId) {
  const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
  let best = 0
  for (const id of ids) {
    const summary = byId?.[id]
    if (summary === undefined || summary === null || summary.blank === true) continue
    const stamp = typeof summary.updatedAt === 'number' ? summary.updatedAt : 0
    if (stamp > best) best = stamp
  }
  return best
}

/**
 * Activity for every Workspace, optionally aggregated over descendants.
 *
 * @param workspaces - Workspaces in Host order.
 * @param byId - Session summaries keyed by Session id.
 * @param options - `aggregate: false` ranks a container by its own Sessions only.
 * @returns Workspace id to activity timestamp; every input Workspace is present.
 */
function activityByWorkspace(workspaces, byId, options = {}) {
  const aggregate = options.aggregate !== false
  const activity = new Map()
  for (const workspace of workspaces) activity.set(workspace.workspaceId, ownActivity(workspace, byId))
  if (!aggregate) return activity

  const paths = workspaces.map((workspace) => workspace.path)
  const children = new Map()
  for (const workspace of workspaces) {
    const parent = owningParent(workspace.path, paths)
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [workspace])
    else siblings.push(workspace)
  }

  const memo = new Map()
  const subtree = (workspace) => {
    const cached = memo.get(workspace.workspaceId)
    if (cached !== undefined) return cached
    // No cycle is possible: a parent path is strictly shorter than its child's.
    let best = activity.get(workspace.workspaceId) ?? 0
    for (const child of children.get(workspace.path) ?? []) best = Math.max(best, subtree(child))
    memo.set(workspace.workspaceId, best)
    return best
  }
  for (const workspace of workspaces) activity.set(workspace.workspaceId, subtree(workspace))
  return activity
}

/**
 * The Workspace ids in display order: newest activity first.
 *
 * Ties keep the current relative order, which is what keeps an untouched
 * Workspace from wandering between two runs.
 *
 * @param workspaces - Workspaces in Host order.
 * @param byId - Session summaries keyed by Session id.
 * @param options - forwarded to `activityByWorkspace`.
 * @returns Workspace ids sorted by activity, newest first.
 */
function desiredOrder(workspaces, byId, options = {}) {
  const activity = activityByWorkspace(workspaces, byId, options)
  return workspaces
    .map((workspace, index) => ({ id: workspace.workspaceId, index, score: activity.get(workspace.workspaceId) ?? 0 }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((row) => row.id)
}

/**
 * Whether two id lists are the same order.
 *
 * @param left - one order.
 * @param right - the other order.
 * @returns true when both list the same ids in the same sequence.
 */
function sameOrder(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false
  return true
}

/**
 * The minimal `insertBefore` moves that turn `current` into `desired`.
 *
 * Every move names an anchor that exists in the same list, so the caller can
 * apply the moves in order with the Host's durable reorder command without
 * re-reading the order in between.
 *
 * @param current - the order the Host reports now.
 * @param desired - the order to reach; ids missing here are left untouched.
 * @returns moves in application order, `before` never equal to `id`.
 */
function planMoves(current, desired) {
  const working = Array.isArray(current) ? [...current] : []
  const moves = []
  // Ids the caller does not know cannot be anchors; dropping them up front keeps
  // the index comparison honest and avoids a no-op durable write.
  const target = (Array.isArray(desired) ? desired : []).filter((id) => working.indexOf(id) !== -1)
  for (let index = 0; index < target.length; index += 1) {
    const id = target[index]
    if (working[index] === id) continue
    const from = working.indexOf(id)
    const before = working[index]
    if (before === undefined || before === id) continue
    moves.push({ id, before })
    working.splice(from, 1)
    working.splice(Math.min(index, working.length), 0, id)
  }
  return moves
}

/**
 * Most recent activity across a set of Workspaces, for one diagnostic number.
 *
 * @param activity - the map from `activityByWorkspace`.
 * @returns the newest timestamp, or 0.
 */
function newestActivity(activity) {
  let best = 0
  for (const value of activity.values()) if (value > best) best = value
  return best
}
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
