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
 * The Workspace ids in display order.
 *
 * Pinned Workspaces keep their pin order at the front; the rest follow activity.
 * With `runningFirst` a Workspace holding a running Session leads the unpinned
 * partition, so a long agent run does not sink out of sight. Ties keep the
 * current relative order, which is what keeps an untouched Workspace from
 * wandering between two runs.
 *
 * @param workspaces - Workspaces in Host order.
 * @param byId - Session summaries keyed by Session id.
 * @param options - `aggregate` (forwarded), `pins` in pin order, `runningFirst`.
 * @returns Workspace ids sorted for display.
 */
export function desiredOrder(workspaces, byId, options = {}) {
  const activity = activityByWorkspace(workspaces, byId, options)
  const pins = Array.isArray(options.pins) ? options.pins : []
  const runningFirst = options.runningFirst === true
  const known = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]))
  const pinnedRows = pins.map((id) => known.get(id)).filter((workspace) => workspace !== undefined)
  const pinnedIds = new Set(pinnedRows.map((workspace) => workspace.workspaceId))
  const rest = workspaces
    .map((workspace, index) => ({
      workspace,
      index,
      score: activity.get(workspace.workspaceId) ?? 0,
      running: runningFirst && isRunning(workspace, byId),
    }))
    .filter((row) => !pinnedIds.has(row.workspace.workspaceId))
    .sort(
      (left, right) =>
        Number(right.running) - Number(left.running) || right.score - left.score || left.index - right.index,
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
