/**
 * The Memories settings page: one `settings.section` contribution.
 *
 * The section owns its whole surface — header, filters, entry list, draft
 * skills, and the tunables card — because a settings section's copy and data
 * both belong to the feature that registered it. Data arrives through the
 * Remote namespace the host registered (`ctx.remote.memories`), tunables through
 * this entry's own config form, so this page reads one store and one config and
 * never a private route.
 */

/** Every string the page renders, per locale. */
const SECTION_COPY = {
  zh: {
    lang: 'zh',
    label: '记忆',
    title: '记忆',
    intro: '跨会话记忆：全局库对所有项目生效，项目库只对同一个工作区生效。这里可以查看、搜索、新增和删除记忆。',
    store: '存储位置',
    global: '全局',
    project: '项目',
    unit: '条',
    search: '搜索记忆…',
    allScopes: '全部范围',
    allKinds: '全部类型',
    kindLabels: { preference: '偏好', failure: '失败教训', procedure: '流程', knowledge: '经验', fact: '事实' },
    empty: '没有匹配的记忆。',
    loading: '加载中…',
    forget: '删除',
    confirm: '删除这条记忆？',
    add: '新增记忆',
    cancel: '取消',
    save: '保存',
    titlePlaceholder: '标题：一行说清这条记忆',
    bodyPlaceholder: '正文：1-4 句话',
    tagsPlaceholder: '标签，逗号分隔（可选）',
    drafts: '待提升的 skill 草稿',
    promote: '提升到技能目录',
    discard: '丢弃',
    promoted: '已提升',
    tunables: '配置项',
    tabMemories: '记忆',
    tabPersona: '画像',
    tabConfig: '配置',
    tabDisputes: '待裁决',
    disputesTitle: '合并时需要你拍板的事',
    disputesIntro: '后台合并会自动执行可逆的改动（合并重复、收紧措辞、退役从没被读过的条目）。只有下面这些会伤到内容，才留给你决定——接受就按它改，驳回就原样保留，不动它过 72 小时会自动作废。',
    disputeRetire: '建议退役',
    disputeRewrite: '建议改写',
    accept: '接受',
    reject: '保留原样',
    noDisputes: '没有待裁决的事项。',
    unavailable: '本部署没有把 memories 远程接口暴露给浏览器，只能编辑可调项。',
    uses: '使用',
    session: '来自会话',
    updated: '更新于',
    saved: '已保存。',
    removed: '已删除。',
    personaIntro: '这就是每个会话开头注入的「这个人是谁」画像（<persona> 块）。手动保存后，后台合并默认仍可能按需改写；勾选锁定后，只有你的保存会改变它。',
    personaLock: '锁定画像：后台合并不要自动改写',
    personaLockHint: '锁定只阻止后台合并写入，不影响每个会话的注入。',
    personaPlaceholder: '这个人是谁：工作方式、偏好、不能违反的边界……',
    personaSave: '保存画像',
    personaSaved: '画像已保存。',
    personaBudgetNote: '注入字节预算在「配置」里的 personaMaxBytes 调整（默认 12000）；超出预算的部分按行截断。',
    needTitle: '标题和正文都要填。',
  },
  en: {
    lang: 'en',
    label: 'Memories',
    title: 'Memories',
    intro: 'Cross-session memory: the global store applies to every project, the project store to one workspace. Inspect, search, add, and delete memories here.',
    store: 'Store',
    global: 'Global',
    project: 'Project',
    unit: 'memories',
    search: 'Search memories…',
    allScopes: 'All scopes',
    allKinds: 'All kinds',
    kindLabels: { preference: 'Preference', failure: 'Failure', procedure: 'Procedure', knowledge: 'Knowledge', fact: 'Fact' },
    empty: 'No memory matches.',
    loading: 'Loading…',
    forget: 'Delete',
    confirm: 'Delete this memory?',
    add: 'New memory',
    cancel: 'Cancel',
    save: 'Save',
    titlePlaceholder: 'Title: one line',
    bodyPlaceholder: 'Body: 1-4 sentences',
    tagsPlaceholder: 'Tags, comma separated (optional)',
    drafts: 'Staged skill drafts',
    promote: 'Promote to the skill root',
    discard: 'Discard',
    promoted: 'Promoted',
    tunables: 'Tunables',
    tabMemories: 'Memories',
    tabPersona: 'Persona',
    tabConfig: 'Configuration',
    tabDisputes: 'Needs review',
    disputesTitle: 'Decisions consolidation will not make on its own',
    disputesIntro: 'Background consolidation applies what is reversible by itself: folding duplicates, sharpening wording, retiring memories nothing ever read. The rows below would lose something — accept applies the change, reject keeps the memory as it is, and doing nothing expires the question after 72 hours.',
    disputeRetire: 'retire',
    disputeRewrite: 'rewrite',
    accept: 'Accept',
    reject: 'Keep as is',
    noDisputes: 'Nothing needs your decision.',
    unavailable: 'This deployment does not expose the memories Remote API to the browser; only the tunables can be edited.',
    uses: 'used',
    session: 'from',
    updated: 'updated',
    saved: 'Saved.',
    removed: 'Deleted.',
    personaIntro: 'This is the "who this user is" profile injected at the start of every conversation (the <persona> block). Saving it by hand still leaves background consolidation free to rewrite it; lock it to make your saves the only writes.',
    personaLock: 'Lock the profile: background consolidation must not rewrite it',
    personaLockHint: 'The lock only stops automatic writes; injection is unchanged.',
    personaPlaceholder: 'Who this person is: how they work, what they prefer, the boundaries they set…',
    personaSave: 'Save profile',
    personaSaved: 'Profile saved.',
    personaBudgetNote: 'The injection byte budget is personaMaxBytes under Configuration (default 12000); text beyond it is cut at a line boundary.',
    needTitle: 'A title and a body are both required.',
  },
}

/** Message text of an unknown thrown value. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Render one timestamp as a short local string. */
function whenText(ms) {
  return ms > 0 ? new Date(ms).toLocaleString() : '—'
}

/**
 * Split one disputed body into comparable tokens.
 *
 * CJK is compared character by character (a word boundary would hide the one
 * character a rewrite actually changed), a latin run stays whole so `uses 12`
 * does not turn into three one-letter diffs, and whitespace groups with the
 * token after it so a moved space renders as part of the surrounding change.
 */
const DIFF_TOKEN = /[A-Za-z0-9_]+|\s+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[^\s]/gu

/** Tokenize `text` for the word diff. */
function diffSplit(text) {
  return text.match(DIFF_TOKEN) ?? []
}

/**
 * The word-level difference between two bodies.
 *
 * Common prefix and suffix are trimmed before the LCS pass, so the quadratic
 * table only ever covers the changed span; adjacent tokens of the same kind are
 * merged, and the result is a run list a renderer can walk in order.
 *
 * @param before - the body as stored today.
 * @param after - the body the pass wants instead.
 * @returns unchanged, removed, and added runs, in reading order.
 */
function diffTokens(before, after) {
  const left = diffSplit(before)
  const right = diffSplit(after)
  let head = 0
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1
  let tail = 0
  while (tail < left.length - head && tail < right.length - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail += 1

  const leftMid = left.slice(head, left.length - tail)
  const rightMid = right.slice(head, right.length - tail)
  const cols = rightMid.length + 1
  // `table[i][j]` is the longest common subsequence of `leftMid[i..]` and
  // `rightMid[j..]`, filled backwards so the walk below can go forwards and
  // emit each run at the position it is read at.
  const table = new Int32Array((leftMid.length + 1) * cols)
  for (let i = leftMid.length - 1; i >= 0; i -= 1) {
    for (let j = rightMid.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = leftMid[i] === rightMid[j]
        ? table[(i + 1) * cols + (j + 1)] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)])
    }
  }

  const runs = []
  const push = (kind, text) => {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.kind === kind) last.text += text
    else runs.push({ kind, text })
  }
  for (const token of left.slice(0, head)) push('same', token)
  let i = 0
  let j = 0
  while (i < leftMid.length && j < rightMid.length) {
    if (leftMid[i] === rightMid[j]) { push('same', leftMid[i]); i += 1; j += 1 }
    else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) { push('del', leftMid[i]); i += 1 }
    else { push('ins', rightMid[j]); j += 1 }
  }
  while (i < leftMid.length) { push('del', leftMid[i]); i += 1 }
  while (j < rightMid.length) { push('ins', rightMid[j]); j += 1 }
  for (const token of left.slice(left.length - tail)) push('same', token)
  return runs
}

/** The scope sentence older proposals put in a rewrite reason (no longer produced). */
const SCOPE_REASON = /^作用域要从\s*(\S+)\s*改成\s*(\S+)$/u

/**
 * Split a dispute reason into its grounds and its scope move.
 *
 * Consolidation joins grounds with `；` and states a move as
 * `作用域要从 <from> 改成 <to>`. A move is not a ground — it is a fact about
 * where the memory lives — so it is lifted out for the header instead of
 * sitting in the middle of the reasons as one more sentence.
 *
 * @param reason - the reason text the pass wrote.
 * @returns the scope move, if any, and the remaining grounds.
 */
function splitDisputeReason(reason) {
  const reasons = []
  let scope = null
  const parts = typeof reason === 'string' ? reason.split('；') : []
  for (const part of parts) {
    const text = part.trim()
    if (text.length === 0) continue
    const move = SCOPE_REASON.exec(text)
    if (move !== null && scope === null) {
      scope = { from: move[1], to: move[2] }
      continue
    }
    reasons.push(text)
  }
  return { scope, reasons }
}

/** The locale label for a memory scope, falling back to the raw value. */
function scopeText(copy, scope) {
  if (scope === 'global') return copy.global
  if (scope === 'project') return copy.project
  return scope
}

/**
 * Build the section component.
 *
 * @param React - the shell's React instance.
 * @param Card - the tunables card component, reused verbatim.
 * @returns the settings section component.
 */
function createMemoriesSection(React, Card) {
  const h = React.createElement

  /**
   * One disputed body as a single reading line.
   *
   * There is no "before"/"after" pair any more: unchanged words read exactly as
   * stored, words the pass removes are struck, words it adds are highlighted, so
   * the difference is the layout instead of a caption. A retirement has no
   * replacement; identical text is still shown once, because deciding whether a
   * memory belongs where it is cannot be done without reading it.
   */
  function disputeBody(row) {
    if (row.action === 'retire') return h('p', { key: 'diff', className: 'dshm-diff dshm-retire' }, row.before)
    if (row.before === row.after) return h('p', { key: 'diff', className: 'dshm-diff' }, row.before)
    return h('p', { key: 'diff', className: 'dshm-diff' }, diffTokens(row.before, row.after).map((run, at) => {
      if (run.kind === 'same') return run.text
      const name = run.kind === 'del' ? 'dshm-del' : 'dshm-ins'
      return h(run.kind === 'del' ? 'del' : 'ins', { key: `${name}-${at}`, className: name }, run.text)
    }))
  }

  /** One entry row. */
  function EntryRow(props) {
    const copy = props.copy
    const entry = props.entry
    const badge = (text, extra = false) => h('span', { key: text, className: `dshm-badge${extra === true ? ' dshm-badge-global' : ''}` }, text)
    return h('li', { className: 'dshm-entry' }, [
      h('div', { key: 'head', className: 'dshm-entry-head' }, [
        h('h4', { key: 'title', className: 'dshm-entry-title' }, entry.title),
        badge(copy.kindLabels[entry.kind] ?? entry.kind),
        badge(entry.scope === 'global' ? copy.global : copy.project, entry.scope === 'global'),
      ]),
      h('p', { key: 'body', className: 'dshm-body' }, entry.body),
      h('div', { key: 'meta', className: 'dshm-meta' }, [
        h('span', { key: 'updated' }, `${copy.updated} ${whenText(entry.updatedAt)}`),
        h('span', { key: 'uses' }, `${copy.uses} ${entry.uses}`),
        entry.tags.length > 0 ? h('span', { key: 'tags' }, entry.tags.join(' · ')) : null,
        entry.sourceSession !== undefined && entry.sourceSession.length > 0
          ? h('span', { key: 'session' }, `${copy.session} ${entry.sourceSession}`)
          : null,
      ]),
      h('div', { key: 'actions', className: 'dshm-actions' }, [
        h('button', {
          key: 'forget',
          type: 'button',
          className: 'dshm-btn',
          disabled: props.busy,
          onClick: () => props.onForget(entry),
        }, copy.forget),
      ]),
    ])
  }

  /** One staged draft row. */
  function DraftRow(props) {
    const copy = props.copy
    const draft = props.draft
    return h('li', { key: draft.name, className: 'dshm-entry' }, [
      h('div', { key: 'head', className: 'dshm-entry-head' }, [
        h('h4', { key: 'name', className: 'dshm-entry-title' }, draft.name),
        draft.promoted ? h('span', { key: 'state', className: 'dshm-badge dshm-badge-global' }, copy.promoted) : null,
      ]),
      h('p', { key: 'desc', className: 'dshm-body' }, draft.description || '—'),
      h('div', { key: 'actions', className: 'dshm-actions' }, [
        h('button', {
          key: 'promote',
          type: 'button',
          className: 'dshm-btn dshm-btn-primary',
          disabled: props.busy,
          onClick: () => props.onPromote(draft),
        }, copy.promote),
        h('button', {
          key: 'discard',
          type: 'button',
          className: 'dshm-btn',
          disabled: props.busy,
          onClick: () => props.onDiscard(draft),
        }, copy.discard),
      ]),
    ])
  }

  return function MemoriesSection(props) {
    const copy = props.copy
    const api = props.api
    const [overview, setOverview] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [notice, setNotice] = React.useState(null)
    const [entries, setEntries] = React.useState([])
    const [total, setTotal] = React.useState(0)
    const [loading, setLoading] = React.useState(true)
    const [busy, setBusy] = React.useState(false)
    const [query, setQuery] = React.useState('')
    const [settledQuery, setSettledQuery] = React.useState('')
    const [scope, setScope] = React.useState('all')
    const [kind, setKind] = React.useState('')
    const [project, setProject] = React.useState('')
    const [formOpen, setFormOpen] = React.useState(false)
    const [tab, setTab] = React.useState('memories')
    const [disputes, setDisputes] = React.useState([])
    const [draft, setDraft] = React.useState({ scope: 'global', kind: 'fact', title: '', body: '', tags: '' })
    const [personaDraft, setPersonaDraft] = React.useState('')
    const [personaLocked, setPersonaLocked] = React.useState(false)
    const [personaLoaded, setPersonaLoaded] = React.useState(false)
    const [personaBusy, setPersonaBusy] = React.useState(false)

    const loadOverview = React.useCallback(async () => {
      if (api === undefined) return
      try {
        setOverview(await api.overview())
      } catch (failure) {
        setError(errorText(failure))
      }
    }, [api])

    const loadEntries = React.useCallback(async () => {
      if (api === undefined) return
      setLoading(true)
      try {
        const result = await api.list({
          project,
          scope: scope === 'all' ? '' : scope,
          query: settledQuery,
          kind,
          limit: 100,
        })
        setEntries(result?.entries ?? [])
        setTotal(result?.total ?? 0)
        setError(null)
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setLoading(false)
      }
    }, [api, project, scope, kind, settledQuery])

    // Debounce typing so a search does not issue one call per keystroke.
    React.useEffect(() => {
      const timer = setTimeout(() => setSettledQuery(query), 250)
      return () => clearTimeout(timer)
    }, [query])

    // A decision waits for a person, so the count has to be visible without
    // opening the tab — otherwise it is a question nobody knows was asked.
    const loadDisputes = React.useCallback(async () => {
      if (api === undefined || typeof api.disputes !== 'function') return
      try {
        const result = await api.disputes()
        setDisputes(result?.disputes ?? [])
      } catch (failure) {
        setError(errorText(failure))
      }
    }, [api])

    const loadPersona = React.useCallback(async () => {
      if (api === undefined || typeof api.persona !== 'function') return
      try {
        const result = await api.persona()
        setPersonaDraft(result?.text ?? '')
        setPersonaLocked(result?.locked === true)
        setPersonaLoaded(true)
        setError(null)
      } catch (failure) {
        setError(errorText(failure))
      }
    }, [api])

    // The profile is only read when its tab is opened: it is a document the
    // user edits, not page furniture.
    React.useEffect(() => {
      if (tab === 'persona' && !personaLoaded) void loadPersona()
    }, [tab, personaLoaded, loadPersona])

    React.useEffect(() => { void loadOverview() }, [loadOverview])
    React.useEffect(() => { void loadEntries() }, [loadEntries])
    React.useEffect(() => { void loadDisputes() }, [loadDisputes])

    // Preselect the newest project so the project filter has a subject.
    React.useEffect(() => {
      if (project !== '' || overview === null) return
      const first = overview.projects?.[0]
      if (first !== undefined) setProject(first.slug)
    }, [overview, project])

    const refresh = async () => {
      await Promise.all([loadOverview(), loadEntries(), loadDisputes()])
    }

    /** Accept or reject one waiting decision, then reload what it changed. */
    const onResolve = async (row, decision) => {
      if (api === undefined || typeof api.resolveDispute !== 'function') {
        setError(copy.unavailable)
        return
      }
      setBusy(true)
      setNotice(null)
      try {
        // One object keyed by the descriptor's own parameter names: the Remote
        // wrapper maps those fields onto the gateway's positional arguments, so
        // a positional call arrives as no arguments at all.
        setNotice(await api.resolveDispute({ id: row.id, decision }))
        await refresh()
        setError(null)
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
      }
    }

    const onSavePersona = async () => {
      if (api === undefined || typeof api.savePersona !== 'function') {
        setError(copy.unavailable)
        return
      }
      setPersonaBusy(true)
      setNotice(null)
      try {
        // One object keyed by the wire fields, like every other Remote call.
        const result = await api.savePersona({ text: personaDraft, locked: personaLocked })
        setPersonaDraft(result?.text ?? '')
        setPersonaLocked(result?.locked === true)
        setPersonaLoaded(true)
        setNotice(copy.personaSaved)
        setError(null)
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setPersonaBusy(false)
      }
    }

    const onForget = async (entry) => {
      if (api === undefined) return
      if (typeof window !== 'undefined' && !window.confirm(copy.confirm)) return
      setBusy(true)
      setNotice(null)
      try {
        await api.forget({ project, scope: entry.scope, id: entry.id })
        setNotice(copy.removed)
        await refresh()
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
      }
    }

    const onPromote = async (staged) => {
      if (api === undefined) return
      setBusy(true)
      try {
        const result = await api.promoteSkill({ name: staged.name })
        setNotice(`${copy.promoted}: ${result.path}`)
        await refresh()
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
      }
    }

    const onDiscard = async (staged) => {
      if (api === undefined) return
      setBusy(true)
      try {
        await api.discardSkill({ name: staged.name })
        await refresh()
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
      }
    }

    const onSubmit = async (event) => {
      event.preventDefault()
      if (api === undefined) return
      if (draft.title.trim().length === 0 || draft.body.trim().length === 0) {
        setError(copy.needTitle)
        return
      }
      setBusy(true)
      setError(null)
      try {
        await api.add({ ...draft, project })
        setDraft({ scope: draft.scope, kind: draft.kind, title: '', body: '', tags: '' })
        setFormOpen(false)
        setNotice(copy.saved)
        await refresh()
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(false)
      }
    }

    const setDraftField = (field, value) => setDraft((previous) => ({ ...previous, [field]: value }))

    const kindOptions = (overview?.kinds ?? ['preference', 'failure', 'procedure', 'knowledge', 'fact']).map((value) =>
      h('option', { key: value, value }, copy.kindLabels[value] ?? value))

    // The host is the authority on shape, but a missing array must degrade to an
    // empty list rather than blank the whole page.
    const projects = overview?.projects ?? []
    const staged = overview?.drafts ?? []

    const head = h('div', { key: 'head', className: 'dshm-head' }, [
      h('h2', { key: 'title', className: 'dshm-title' }, copy.title),
    ])

    const stats = overview === null ? null : h('p', { key: 'stats', className: 'dshm-note' }, [
      `${copy.global} ${overview.globalCount ?? 0} ${copy.unit}`,
      ' · ',
      projects.map((row) => `${row.name} ${row.count}`).join(' · ') || `${copy.project} 0 ${copy.unit}`,
    ])

    const toolbar = h('div', { key: 'toolbar', className: 'dshm-toolbar' }, [
      h('input', {
        key: 'search',
        className: 'dshm-input dshm-grow',
        type: 'search',
        value: query,
        placeholder: copy.search,
        disabled: api === undefined,
        onChange: (event) => setQuery(event.target.value),
      }),
      h('select', {
        key: 'scope',
        className: 'dshm-select',
        value: scope,
        disabled: api === undefined,
        onChange: (event) => setScope(event.target.value),
      }, [
        h('option', { key: 'all', value: 'all' }, copy.allScopes),
        h('option', { key: 'global', value: 'global' }, copy.global),
        h('option', { key: 'project', value: 'project' }, copy.project),
      ]),
      h('select', {
        key: 'kind',
        className: 'dshm-select',
        value: kind,
        disabled: api === undefined,
        onChange: (event) => setKind(event.target.value),
      }, [h('option', { key: 'any', value: '' }, copy.allKinds), ...kindOptions]),
      h('select', {
        key: 'project',
        className: 'dshm-select',
        value: project,
        disabled: api === undefined || projects.length === 0,
        onChange: (event) => setProject(event.target.value),
      }, projects.map((row) => h('option', { key: row.slug, value: row.slug }, `${row.name} (${row.count})`))),
      h('button', {
        key: 'add',
        type: 'button',
        className: 'dshm-btn dshm-btn-primary',
        disabled: api === undefined,
        onClick: () => setFormOpen((open) => !open),
      }, copy.add),
    ])

    const form = formOpen ? h('form', { key: 'form', className: 'dshm-form', onSubmit }, [
      h('div', { key: 'row', className: 'dshm-form-row' }, [
        h('select', {
          key: 'scope',
          className: 'dshm-select',
          value: draft.scope,
          onChange: (event) => setDraftField('scope', event.target.value),
        }, [
          h('option', { key: 'global', value: 'global' }, copy.global),
          h('option', { key: 'project', value: 'project' }, copy.project),
        ]),
        h('select', {
          key: 'kind',
          className: 'dshm-select',
          value: draft.kind,
          onChange: (event) => setDraftField('kind', event.target.value),
        }, kindOptions),
      ]),
      h('input', {
        key: 'title',
        className: 'dshm-input',
        style: { width: '100%' },
        value: draft.title,
        placeholder: copy.titlePlaceholder,
        onChange: (event) => setDraftField('title', event.target.value),
      }),
      h('textarea', {
        key: 'body',
        className: 'dshm-area',
        value: draft.body,
        placeholder: copy.bodyPlaceholder,
        onChange: (event) => setDraftField('body', event.target.value),
      }),
      h('input', {
        key: 'tags',
        className: 'dshm-input',
        style: { width: '100%' },
        value: draft.tags,
        placeholder: copy.tagsPlaceholder,
        onChange: (event) => setDraftField('tags', event.target.value),
      }),
      h('div', { key: 'actions', className: 'dshm-actions' }, [
        h('button', { key: 'save', type: 'submit', className: 'dshm-btn dshm-btn-primary', disabled: busy }, copy.save),
        h('button', { key: 'cancel', type: 'button', className: 'dshm-btn', onClick: () => setFormOpen(false) }, copy.cancel),
      ]),
    ]) : null

    const list = loading && entries.length === 0
      ? h('p', { key: 'loading', className: 'dshm-empty' }, copy.loading)
      : entries.length === 0
        ? h('p', { key: 'empty', className: 'dshm-empty' }, copy.empty)
        : h('ul', { key: 'list', className: 'dshm-list' }, entries.map((entry) =>
          h(EntryRow, { key: `${entry.scope}:${entry.id}`, entry, copy, busy, onForget })))

    const drafts = staged.length > 0
      ? h('section', { key: 'drafts', className: 'dshm-card' }, [
        h('h3', { key: 'title', className: 'dshm-section-title' }, copy.drafts),
        h('ul', { key: 'list', className: 'dshm-list' }, staged.map((row) =>
          h(DraftRow, { key: row.name, draft: row, copy, busy, onPromote, onDiscard }))),
      ])
      : null

    const tabList = h('div', { key: 'tabs', className: 'dshm-tabs', role: 'tablist' }, [
      h('button', {
        key: 'memories',
        type: 'button',
        role: 'tab',
        'aria-selected': tab === 'memories',
        className: `dshm-tab${tab === 'memories' ? ' dshm-tab-active' : ''}`,
        onClick: () => setTab('memories'),
      }, copy.tabMemories),
      h('button', {
        key: 'persona',
        type: 'button',
        role: 'tab',
        'aria-selected': tab === 'persona',
        className: `dshm-tab${tab === 'persona' ? ' dshm-tab-active' : ''}${personaLocked ? ' dshm-tab-locked' : ''}`,
        onClick: () => setTab('persona'),
      }, personaLocked ? `🔒 ${copy.tabPersona}` : copy.tabPersona),
      h('button', {
        key: 'config',
        type: 'button',
        role: 'tab',
        'aria-selected': tab === 'config',
        className: `dshm-tab${tab === 'config' ? ' dshm-tab-active' : ''}`,
        onClick: () => setTab('config'),
      }, copy.tabConfig),
      h('button', {
        key: 'disputes',
        type: 'button',
        role: 'tab',
        'aria-selected': tab === 'disputes',
        className: `dshm-tab${tab === 'disputes' ? ' dshm-tab-active' : ''}${disputes.length > 0 ? ' dshm-tab-alert' : ''}`,
        onClick: () => setTab('disputes'),
      }, disputes.length > 0 ? `${copy.tabDisputes} (${disputes.length})` : copy.tabDisputes),
    ])

    // The two tabs keep the store's CONTENT and the plugin's SETTINGS apart: one
    // page, one place to look, and neither surface buries the other.
    const memoriesPanel = h('div', { key: 'panel-memories', role: 'tabpanel', className: 'dshm-panel' }, [
      api === undefined ? h('p', { key: 'unavailable', className: 'dshm-status dshm-error' }, copy.unavailable) : null,
      overview !== null && stats !== null ? stats : null,
      toolbar,
      form,
      h('p', { key: 'count', className: 'dshm-note' }, `${entries.length} / ${total} ${copy.unit}`),
      list,
      drafts,
      error !== null ? h('p', { key: 'error', className: 'dshm-status dshm-error' }, error) : null,
      notice !== null ? h('p', { key: 'notice', className: 'dshm-status dshm-ok' }, notice) : null,
    ])

    const configPanel = h('div', { key: 'panel-config', role: 'tabpanel', className: 'dshm-panel' }, [
      h(Card, {
        key: 'tunables',
        scope: props.scope,
        useSnapshot: props.useSnapshot,
        title: copy.tunables,
        intro: false,
        lang: copy.lang,
      }),
    ])

    const personaPanel = h('div', { key: 'panel-persona', role: 'tabpanel', className: 'dshm-panel' }, [
      h('p', { key: 'intro', className: 'dshm-note' }, copy.personaIntro),
      api === undefined || typeof api.savePersona !== 'function'
        ? h('p', { key: 'unavailable', className: 'dshm-status dshm-error' }, copy.unavailable)
        : null,
      h('textarea', {
        key: 'text',
        className: 'dshm-area',
        rows: 14,
        value: personaDraft,
        placeholder: copy.personaPlaceholder,
        disabled: api === undefined || personaBusy,
        onChange: (event) => setPersonaDraft(event.target.value),
      }),
      h('label', { key: 'lock', className: 'dshm-inline' }, [
        h('input', {
          key: 'input',
          className: 'dshm-check',
          type: 'checkbox',
          checked: personaLocked,
          disabled: api === undefined || personaBusy,
          onChange: (event) => setPersonaLocked(event.target.checked),
        }),
        copy.personaLock,
      ]),
      h('p', { key: 'lock-hint', className: 'dshm-note' }, copy.personaLockHint),
      h('p', { key: 'budget', className: 'dshm-note' }, copy.personaBudgetNote),
      h('div', { key: 'actions', className: 'dshm-actions' }, [
        h('button', {
          key: 'save',
          type: 'button',
          className: 'dshm-btn dshm-btn-primary',
          disabled: personaBusy || api === undefined,
          onClick: onSavePersona,
        }, copy.personaSave),
      ]),
      notice !== null ? h('p', { key: 'notice', className: 'dshm-status dshm-ok' }, notice) : null,
      error !== null ? h('p', { key: 'error', className: 'dshm-status dshm-error' }, error) : null,
    ])

    // Only the decisions a pass refused to make alone. Each row is one reading
    // of the disputed text with the change marked in place, and a scope move is
    // stated in the head rather than buried in the reason sentence.
    const disputeRows = disputes.map((row) => {
      const parsed = splitDisputeReason(row.reason)
      return h('li', { key: `${row.action}:${row.id}`, className: 'dshm-entry' }, [
        h('div', { key: 'head', className: 'dshm-entry-head' }, [
          h('h4', { key: 'title', className: 'dshm-entry-title' }, row.title),
          parsed.scope === null ? null : h('span', { key: 'scope', className: 'dshm-scope' }, [
            h('span', { key: 'from' }, scopeText(copy, parsed.scope.from)),
            h('span', { key: 'arrow', className: 'dshm-scope-arrow', 'aria-hidden': true }, '→'),
            h('span', { key: 'to' }, scopeText(copy, parsed.scope.to)),
          ]),
          h('span', { key: 'action', className: 'dshm-badge dshm-badge-global' }, row.action === 'retire' ? copy.disputeRetire : copy.disputeRewrite),
        ]),
        parsed.reasons.length === 0 ? null : h('div', { key: 'reasons', className: 'dshm-reasons' }, parsed.reasons.map((text, at) =>
          h('span', { key: `${at}:${text}`, className: 'dshm-badge' }, text))),
        disputeBody(row),
        h('div', { key: 'actions', className: 'dshm-actions' }, [
          h('button', {
            key: 'accept',
            type: 'button',
            className: 'dshm-btn dshm-btn-primary',
            disabled: busy,
            onClick: () => onResolve(row, 'accept'),
          }, copy.accept),
          h('button', {
            key: 'reject',
            type: 'button',
            className: 'dshm-btn',
            disabled: busy,
            onClick: () => onResolve(row, 'reject'),
          }, copy.reject),
        ]),
      ])
    })
    const disputesPanel = h('div', { key: 'panel-disputes', role: 'tabpanel', className: 'dshm-panel' }, [
      h('h3', { key: 'title', className: 'dshm-section-title' }, copy.disputesTitle),
      h('p', { key: 'intro', className: 'dshm-note' }, copy.disputesIntro),
      api === undefined ? h('p', { key: 'unavailable', className: 'dshm-status dshm-error' }, copy.unavailable) : null,
      disputeRows.length > 0
        ? h('ul', { key: 'list', className: 'dshm-list' }, disputeRows)
        : h('p', { key: 'empty', className: 'dshm-note' }, copy.noDisputes),
      notice !== null ? h('p', { key: 'notice', className: 'dshm-status dshm-ok' }, notice) : null,
      error !== null ? h('p', { key: 'error', className: 'dshm-status dshm-error' }, error) : null,
    ])

    const children = [head]
    if (overview !== null) children.push(h('p', { key: 'store', className: 'dshm-path' }, `${copy.store}: ${overview.storePath}`))
    children.push(tabList)
    children.push(tab === 'config' ? configPanel : tab === 'disputes' ? disputesPanel : tab === 'persona' ? personaPanel : memoriesPanel)
    return h('div', { className: 'dshm-page' }, children)
  }
}
