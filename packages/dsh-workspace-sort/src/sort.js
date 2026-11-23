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
 *   * a Session can be **waiting for you**: `ctx.uiSession.pendingInteractions`
 *     reports the highest-precedence request (approval, plan review, question)
 *     that only a human can answer. A waiting Workspace outranks a running one,
 *     because it is the one that stops making progress until you look;
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
export function owningParent(path, paths) {
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
export function ownActivity(workspace, byId) {
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
export function activityByWorkspace(workspaces, byId, options = {}) {
  return bySubtree(workspaces, (workspace) => ownActivity(workspace, byId), Math.max, 0, options)
}

/**
 * Fold one per-Workspace value over the Workspace's whole subtree.
 *
 * This is the shared shape behind both sort keys: activity takes the newest
 * stamp of the subtree, waiting takes the number of waiting Sessions. With
 * `aggregate: false` a container keeps its own value, so a descendant never
 * lifts it.
 *
 * @param workspaces - Workspaces in Host order.
 * @param own - the Workspace's own value.
 * @param merge - combines a folded value with one child's folded value.
 * @param empty - the accumulator before any value is merged.
 * @param options - `aggregate: false` disables the subtree fold.
 * @returns Workspace id to folded value; every input Workspace is present.
 */
function bySubtree(workspaces, own, merge, empty, options = {}) {
  const values = new Map()
  for (const workspace of workspaces) values.set(workspace.workspaceId, own(workspace))
  if (options.aggregate === false) return values

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
    let value = values.get(workspace.workspaceId) ?? empty
    for (const child of children.get(workspace.path) ?? []) value = merge(value, subtree(child))
    memo.set(workspace.workspaceId, value)
    return value
  }
  for (const workspace of workspaces) values.set(workspace.workspaceId, subtree(workspace))
  return values
}

/**
 * Whether any Session of this Workspace is running right now.
 *
 * @param workspace - the Workspace row.
 * @param byId - Session summaries keyed by Session id.
 * @returns true when at least one member Session reports `running`.
 */
export function isRunning(workspace, byId) {
  const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
  for (const id of ids) if (byId?.[id]?.running === true) return true
  return false
}

/**
 * Pending-interaction kinds that mean "this Session is waiting for your input".
 *
 * Mirrors the shipped sidebar's `visiblePendingKind`: only these three kinds get
 * a visible waiting marker. A domain may publish other kinds, such as a plan
 * that is still being generated, which are not the user's turn to act on.
 */
export const WAITING_KINDS = Object.freeze(['approval', 'plan-review', 'question'])

/**
 * Whether one pending-interaction kind is the user's turn to act.
 *
 * @param kind - the domain-owned `kind` string.
 * @returns true for {@link WAITING_KINDS}.
 */
export function isWaitingKind(kind) {
  return typeof kind === 'string' && WAITING_KINDS.includes(kind)
}

/**
 * The pending interaction for one Session, accepting the Map the Client publishes
 * and a plain object for callers that do not have a Map.
 *
 * @param pending - `ctx.uiSession.pendingInteractions` snapshot.
 * @param sessionId - the Session id to look up.
 * @returns the interaction, or undefined.
 */
function pendingOf(pending, sessionId) {
  if (pending === undefined || pending === null) return undefined
  if (typeof pending.get === 'function') return pending.get(sessionId)
  return pending[sessionId]
}

/**
 * How many of this Workspace's own Sessions are waiting for the user.
 *
 * @param workspace - the Workspace row.
 * @param pending - `ctx.uiSession.pendingInteractions` snapshot.
 * @returns the number of member Sessions whose pending kind is visible.
 */
export function ownWaitingCount(workspace, pending) {
  const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
  let count = 0
  for (const id of ids) if (isWaitingKind(pendingOf(pending, id)?.kind)) count += 1
  return count
}

/**
 * Waiting Sessions per Workspace, optionally aggregated over descendants.
 *
 * A container folder that holds a waiting Session lifts with its subtree, for
 * the same reason activity does: it is the group a user would look under. With
 * `aggregate: false` only a Workspace's own Sessions count.
 *
 * @param workspaces - Workspaces in Host order.
 * @param pending - `ctx.uiSession.pendingInteractions` snapshot.
 * @param options - `aggregate: false` disables the subtree fold.
 * @returns Workspace id to waiting count; every input Workspace is present.
 */
export function waitingByWorkspace(workspaces, pending, options = {}) {
  return bySubtree(workspaces, (workspace) => ownWaitingCount(workspace, pending), (left, right) => left + right, 0, options)
}

/**
 * The Workspace ids in display order.
 *
 * Pinned Workspaces keep their pin order at the front. The unpinned remainder is
 * ranked by, in order: a Session waiting for the user, a running Session (only
 * with `runningFirst`), the newest prompt, then the current index. A waiting
 * Workspace therefore outranks a merely busy one: an approval prompt is the
 * thing that actually needs a click. `waitingFirst: false` disables the first
 * key. Ties keep the current relative order, which is what keeps an untouched
 * Workspace from wandering between two runs.
 *
 * @param workspaces - Workspaces in Host order.
 * @param byId - Session summaries keyed by Session id.
 * @param options - `aggregate` (forwarded), `pins` in pin order, `runningFirst`,
 *   `waitingFirst`, `pending`.
 * @returns Workspace ids sorted for display.
 */
export function desiredOrder(workspaces, byId, options = {}) {
  const activity = activityByWorkspace(workspaces, byId, options)
  const waiting = waitingByWorkspace(workspaces, options.pending, options)
  const pins = Array.isArray(options.pins) ? options.pins : []
  const runningFirst = options.runningFirst === true
  const waitingFirst = options.waitingFirst !== false
  const known = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]))
  const pinnedRows = pins.map((id) => known.get(id)).filter((workspace) => workspace !== undefined)
  const pinnedIds = new Set(pinnedRows.map((workspace) => workspace.workspaceId))
  const rest = workspaces
    .map((workspace, index) => ({
      workspace,
      index,
      score: activity.get(workspace.workspaceId) ?? 0,
      waiting: waitingFirst && (waiting.get(workspace.workspaceId) ?? 0) > 0,
      running: runningFirst && isRunning(workspace, byId),
    }))
    .filter((row) => !pinnedIds.has(row.workspace.workspaceId))
    .sort(
      (left, right) =>
        Number(right.waiting) - Number(left.waiting) ||
        Number(right.running) - Number(left.running) ||
        right.score - left.score ||
        left.index - right.index,
    )
  return [...pinnedRows.map((workspace) => workspace.workspaceId), ...rest.map((row) => row.workspace.workspaceId)]
}

/**
 * Whether two id lists are the same order.
 *
 * @param left - one order.
 * @param right - the other order.
 * @returns true when both list the same ids in the same sequence.
 */
export function sameOrder(left, right) {
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
export function planMoves(current, desired) {
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
export function newestActivity(activity) {
  let best = 0
  for (const value of activity.values()) if (value > best) best = value
  return best
}
