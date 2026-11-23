/**
 * The `resolve_memory_proposal` card body.
 *
 * The shared action-card frame renders the title, the folded brief and the
 * buttons of a registered body. This body reads the card's `details` with its
 * own schema — the browser validates what the Host already validated, exactly
 * like every shipped kind — and shows the waiting batch: its scope label,
 * decision count and staging time, then 确认应用 / 拒绝 / 稍后.
 *
 * The body is plain `createElement` code with no imports, like the rest of the
 * browser half, so the bundle needs no bundler; `client/index.ts` registers it
 * and the copy table with the shell.
 */

/** Value of the card's `action`; must match the Host kind. */
const PROPOSAL_CARD_ACTION = 'resolve_memory_proposal'

/** Locale namespace the copy below is registered under. */
const PROPOSAL_CARD_LOCALE = 'memoriesProposal'

/** Recorded phases that still offer the actions; `dismissed` is recorded by the frame. */
const PROPOSAL_OPEN_PHASES = ['failed']

/** Every string this body renders, per locale. */
const PROPOSAL_COPY = {
  zh: {
    scope: '范围：{label}',
    count: '{count} 条变更待确认',
    staged: '提案生成于 {when}',
    accept: '确认应用',
    reject: '拒绝',
    later: '稍后',
    working: '处理中…',
    applied: '已应用：{written} 条写回，{retired} 条退役。',
    rejected: '已拒绝，记忆保持原样。',
    dismissed: '已稍后处理，这批提案还等着你。',
    superseded: '这批提案已被新的提案取代。',
    'settled-elsewhere': '这批提案已在别处处理（/memories 或设置页）。',
    failed: '应用失败，存储已回滚，可以重试。',
    unknown: '找不到这批提案，请重新打开会话。',
    unavailable: '这个操作现在不可用。',
    'read-only': '当前会话是只读的，不能改动记忆。',
    'access-denied': '没有改动记忆的权限。',
    'not-live-root': '请在原会话里操作这张卡片。',
    closing: '插件正在重载，请稍后再试。',
    transport: '没有收到结果，请刷新后重试。',
  },
  en: {
    scope: 'Scope: {label}',
    count: '{count} change(s) waiting',
    staged: 'Staged {when}',
    accept: 'Apply',
    reject: 'Reject',
    later: 'Not now',
    working: 'Working…',
    applied: '{written} written, {retired} retired.',
    rejected: 'Rejected; the memories are unchanged.',
    dismissed: 'Set aside; the proposal is still waiting.',
    superseded: 'A newer proposal replaced this one.',
    'settled-elsewhere': 'This proposal was already decided elsewhere (/memories or the settings page).',
    failed: 'Applying failed and the store was rolled back; you can retry.',
    unknown: 'This proposal is unavailable. Reopen the conversation.',
    unavailable: 'That action is unavailable now.',
    'read-only': 'This Session is read-only, so memories cannot change.',
    'access-denied': 'You do not have permission to change memories.',
    'not-live-root': 'Use this card in its original conversation.',
    closing: 'The plugin is reloading. Try again shortly.',
    transport: 'No result arrived. Refresh and try again.',
  },
}

/** One validated card's details. */
function parseProposalDetails(value) {
  if (value === null || typeof value !== 'object') return undefined
  const label = value.label
  const count = value.count
  const stagedAt = value.stagedAt
  if (typeof label !== 'string' || label.length === 0) return undefined
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return undefined
  if (typeof stagedAt !== 'number' || !Number.isInteger(stagedAt)) return undefined
  return { label, count, stagedAt }
}

/** Render an epoch-millisecond instant in the reader's locale. */
function proposalWhen(ms) {
  return ms > 0 ? new Date(ms).toLocaleString() : '—'
}

/** One refusal reason, mapped to copy this body owns; unknown reasons read as unavailable. */
function proposalReasonKey(reason) {
  return typeof reason === 'string' && Object.hasOwn(PROPOSAL_COPY.en, reason) ? reason : 'unavailable'
}

/** The copy of one recorded phase; `undefined` while the card is unstarted or open. */
function proposalStatus(t, phase, data) {
  switch (phase) {
    case 'applied': {
      const written = typeof data?.written === 'number' ? data.written : 0
      const retired = typeof data?.retired === 'number' ? data.retired : 0
      return t('applied', { written: String(written), retired: String(retired) })
    }
    case 'rejected':
    case 'dismissed':
    case 'superseded':
    case 'settled-elsewhere':
    case 'failed':
      return t(phase)
    default:
      return undefined
  }
}

/** The class of one status line: a failure is an error, a decision is a success. */
function proposalStatusClass(phase) {
  if (phase === 'failed') return 'dshm-status dshm-error'
  if (phase === 'applied' || phase === 'rejected' || phase === 'dismissed') return 'dshm-status dshm-ok'
  return 'dshm-status'
}

/**
 * Build the card body component.
 *
 * @param React - the shell's React instance.
 * @returns the body component registered under {@link PROPOSAL_CARD_ACTION}.
 */
function createProposalCardBody(React) {
  return function MemoryProposalCard(props) {
    const details = parseProposalDetails(props.proposal?.details)
    if (details === undefined) return props.fallback
    const [pending, setPending] = React.useState(undefined)
    const [error, setError] = React.useState(undefined)
    const phase = props.decision?.phase
    const settled = phase !== undefined && !PROPOSAL_OPEN_PHASES.includes(phase)
    const status = phase === undefined ? undefined : proposalStatus(props.t, phase, props.decision?.data)

    const run = (verb) => {
      setPending(verb)
      setError(undefined)
      Promise.resolve().then(() => props.act(verb)).then((result) => {
        if (result === undefined) setError('transport')
        else if (result.status === 'refused' || result.status === 'unconfirmed') setError(proposalReasonKey(result.reason))
      }, () => setError('transport')).then(() => setPending(undefined))
    }
    const button = (key, label, variant, verb) => React.createElement('button', {
      key,
      type: 'button',
      className: variant === 'primary' ? 'dshm-btn dshm-btn-primary' : 'dshm-btn',
      disabled: pending !== undefined,
      onClick: () => { run(verb) },
    }, pending === verb ? props.t('working') : label)
    const children = [
      props.summary,
      React.createElement('p', { key: 'meta', className: 'dshm-meta' }, [
        React.createElement('span', { key: 'scope' }, props.t('scope', { label: details.label })),
        React.createElement('span', { key: 'count' }, props.t('count', { count: String(details.count) })),
        React.createElement('span', { key: 'staged' }, props.t('staged', { when: proposalWhen(details.stagedAt) })),
      ]),
    ]
    if (status !== undefined) {
      children.push(React.createElement('p', { key: 'status', role: 'status', className: proposalStatusClass(phase) }, status))
    }
    if (error !== undefined) {
      children.push(React.createElement('p', { key: 'error', role: 'alert', className: 'dshm-status dshm-error' }, props.t(error)))
    }
    if (!settled) {
      children.push(React.createElement('footer', { key: 'footer', className: 'dshm-actions' }, [
        button('later', props.t('later'), 'ghost', 'dismiss'),
        button('reject', props.t('reject'), 'ghost', 'reject'),
        button('accept', props.t('accept'), 'primary', 'accept'),
      ]))
    }
    return React.createElement('div', { className: 'dshm-panel' }, children)
  }
}
