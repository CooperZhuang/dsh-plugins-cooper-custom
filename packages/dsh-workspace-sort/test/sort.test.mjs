import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activityByWorkspace,
  desiredOrder,
  isRunning,
  newestActivity,
  owningParent,
  ownActivity,
  planMoves,
  sameOrder,
} from '../src/sort.js'

/** Build one Workspace row as the Client store reports it. */
const workspace = (id, path, sessionIds = []) => ({ workspaceId: id, path, sessionIds })

/** Build Session summaries keyed by id; `blank` marks the unsent New Session draft. */
const summaries = (entries) =>
  Object.fromEntries(entries.map(([id, updatedAt, blank, running]) => [id, { updatedAt, blank, running: running === true }]))

/** Apply `insertBefore(id, before)` moves to a local order, the way the Host does. */
const applyMoves = (order, moves) => {
  const next = [...order]
  for (const move of moves) {
    const from = next.indexOf(move.id)
    assert.notEqual(from, -1, `move names an unknown id: ${move.id}`)
    next.splice(from, 1)
    const target = move.before === undefined ? next.length : next.indexOf(move.before)
    assert.notEqual(target, -1, `move names an unknown anchor: ${move.before}`)
    next.splice(target, 0, move.id)
  }
  return next
}

test('owningParent picks the nearest registered ancestor and respects path boundaries', () => {
  const paths = ['/code', '/code/mubea', '/code/mubea/insight', '/code/other']
  assert.equal(owningParent('/code/mubea/insight/sub', paths), '/code/mubea/insight')
  assert.equal(owningParent('/code/mubea/extra', paths), '/code/mubea')
  // `/code2` must not count as a child of `/code`.
  assert.equal(owningParent('/code2/x', paths), undefined)
  assert.equal(owningParent('/code', paths), undefined)
  assert.equal(owningParent('/code/other', paths), '/code')
})

test('own activity counts human prompts only', () => {
  const row = workspace('w1', '/w1', ['a', 'b', 'c', 'missing'])
  const byId = summaries([
    ['a', 100],
    ['b', 300, true],
    ['c', 200],
  ])
  // `b` is the blank draft: its stamp is newer but it is not activity.
  assert.equal(ownActivity(row, byId), 200)
  assert.equal(ownActivity(workspace('w2', '/w2', []), byId), 0)
})

test('a container ranks by its whole subtree unless aggregation is off', () => {
  const rows = [
    workspace('root', '/code'),
    workspace('mubea', '/code/mubea'),
    workspace('insight', '/code/mubea/insight', ['s']),
    workspace('personal', '/code/personal', ['p']),
  ]
  const byId = summaries([
    ['s', 500],
    ['p', 100],
  ])
  const aggregated = activityByWorkspace(rows, byId)
  assert.equal(aggregated.get('root'), 500)
  assert.equal(aggregated.get('mubea'), 500)
  assert.equal(aggregated.get('insight'), 500)
  assert.equal(aggregated.get('personal'), 100)

  const flat = activityByWorkspace(rows, byId, { aggregate: false })
  assert.equal(flat.get('root'), 0)
  assert.equal(flat.get('mubea'), 0)
  assert.equal(flat.get('insight'), 500)
})

test('desired order is newest first and keeps the current order on ties', () => {
  const rows = [workspace('a', '/a', ['x']), workspace('b', '/b', ['y']), workspace('c', '/c', ['z'])]
  const byId = summaries([
    ['x', 100],
    ['y', 300],
    ['z', 100],
  ])
  assert.deepEqual(desiredOrder(rows, byId), ['b', 'a', 'c'])
  // Nothing to sort: the returned order is the current one.
  assert.deepEqual(desiredOrder(rows, {}), ['a', 'b', 'c'])
})

test('a flat activity order renders the right tree under "Group by → Workspace tree"', () => {
  // The shipped sidebar nests each Workspace under `owningParentFolder(path)`
  // and keeps roots and siblings in flat Host order. This mirrors that
  // derivation so the rule is checked against what the user actually sees.
  const rows = [
    workspace('root-code', '/code'),
    workspace('code-mubea', '/code/mubea'),
    workspace('code-personal', '/code/personal'),
    workspace('insight', '/code/mubea/insight', ['s1']),
    workspace('packplan', '/code/mubea/packplan', ['s2']),
    workspace('berth', '/code/personal/berth', ['s3']),
  ]
  const byId = summaries([
    ['s1', 400],
    ['s2', 900],
    ['s3', 700],
  ])
  const paths = rows.map((row) => row.path)
  const byIdOfRow = new Map(rows.map((row) => [row.workspaceId, row]))
  const flatten = (workspaceIds) => {
    const children = new Map()
    for (const id of workspaceIds) {
      const parent = owningParent(byIdOfRow.get(id).path, paths)
      const siblings = children.get(parent)
      if (siblings === undefined) children.set(parent, [id])
      else siblings.push(id)
    }
    const rendered = []
    const walk = (parent) => {
      for (const id of children.get(parent) ?? []) {
        rendered.push(id)
        walk(byIdOfRow.get(id).path)
      }
    }
    walk(undefined)
    return rendered
  }

  // packplan's 900 is the freshest prompt, but it lives under /code/mubea, so the
  // mubea subtree (and /code, its ancestor) lead; siblings follow their activity.
  assert.deepEqual(flatten(desiredOrder(rows, byId)), [
    'root-code',
    'code-mubea',
    'packplan',
    'insight',
    'code-personal',
    'berth',
  ])
})

test('planMoves reaches the target order and is empty when already ordered', () => {
  const current = ['a', 'b', 'c', 'd']
  const desired = ['c', 'a', 'b', 'd']
  const moves = planMoves(current, desired)
  assert.deepEqual(applyMoves(current, moves), desired)
  assert.deepEqual(planMoves(current, current), [])
  // Ids the caller does not know are ignored instead of produced as anchors.
  assert.deepEqual(planMoves(['a', 'b'], ['x', 'a', 'b']), [])
})

test('sameOrder compares sequences, not membership', () => {
  assert.equal(sameOrder(['a', 'b'], ['a', 'b']), true)
  assert.equal(sameOrder(['a', 'b'], ['b', 'a']), false)
  assert.equal(sameOrder(['a'], ['a', 'b']), false)
})

test('newestActivity reports the freshest stamp, 0 when nothing counts', () => {
  const rows = [workspace('a', '/a', ['x']), workspace('b', '/b', ['y'])]
  assert.equal(newestActivity(activityByWorkspace(rows, summaries([['x', 10], ['y', 30]]))), 30)
  assert.equal(newestActivity(activityByWorkspace(rows, {})), 0)
})

test('pins lead in pin order and keep their place regardless of activity', () => {
  const rows = [workspace('a', '/a', ['x']), workspace('b', '/b', ['y']), workspace('c', '/c', ['z'])]
  const byId = summaries([
    ['x', 100],
    ['y', 300],
    ['z', 200],
  ])
  // No pins: pure activity.
  assert.deepEqual(desiredOrder(rows, byId), ['b', 'c', 'a'])
  // Pins keep their own order ahead of the activity ranking.
  assert.deepEqual(desiredOrder(rows, byId, { pins: ['a', 'c'] }), ['a', 'c', 'b'])
  // A pin for a Workspace that no longer exists is ignored, not emitted.
  assert.deepEqual(desiredOrder(rows, byId, { pins: ['ghost', 'b'] }), ['b', 'c', 'a'])
})

test('running-first leads the unpinned partition without touching pins', () => {
  const rows = [workspace('idle-old', '/i1', ['i1']), workspace('run', '/r', ['r']), workspace('idle-new', '/i2', ['i2'])]
  const byId = summaries([
    ['i1', 100],
    ['r', 50, false, true],
    ['i2', 200],
  ])
  assert.deepEqual(desiredOrder(rows, byId), ['idle-new', 'idle-old', 'run'])
  assert.deepEqual(desiredOrder(rows, byId, { runningFirst: true }), ['run', 'idle-new', 'idle-old'])
  assert.deepEqual(
    desiredOrder(rows, byId, { runningFirst: true, pins: ['idle-old'] }),
    ['idle-old', 'run', 'idle-new'],
  )
})

test('isRunning only looks at the Workspace own members', () => {
  const rows = [workspace('a', '/a', ['x']), workspace('b', '/b', ['y'])]
  const byId = summaries([
    ['x', 1, false, true],
    ['y', 1],
  ])
  assert.equal(isRunning(rows[0], byId), true)
  assert.equal(isRunning(rows[1], byId), false)
  assert.equal(isRunning(workspace('empty', '/e'), byId), false)
})
