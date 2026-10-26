/**
 * Lossy-but-traceable condensation: every condensed text is recoverable in
 * full. The store is the official `ctx.spillStore` service (backed by
 * `dsh-spill-local`), used exactly the way `dsh-spill-policy` uses it, so the
 * notice wording and the file layout are the ones the harness already knows.
 *
 * @module dsh-rtk-slim/spill
 */

/** @typedef {{ locator: string, bytes?: number, retrievalHint?: string }} Ref */

const FALLBACK_HINT = 'Use read with offset/limit, or grep this path to search within it.'

/**
 * Persist the untouched original text.
 * @param {{ get: (name: string) => any }} ctx
 * @param {{ name: string, callId?: string, agent?: any }} exec
 * @param {string} text
 * @returns {Promise<Ref | undefined>} `undefined` means "no traceability available".
 */
export async function saveFullText(ctx, exec, text) {
  const store = ctx.get('spillStore')
  if (store === null || typeof store !== 'object' || typeof store.saveText !== 'function') return undefined
  const sessionId = exec.agent?.session?.header?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  try {
    const ref = await store.saveText({
      owner: { sessionId },
      source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
      suggestedName: `${exec.name}.txt`,
      content: text,
    })
    if (ref === null || typeof ref !== 'object' || typeof ref.locator !== 'string' || ref.locator.length === 0) {
      return undefined
    }
    return ref
  } catch {
    return undefined
  }
}

/**
 * @param {{ beforeBytes: number, afterBytes: number, ref: Ref }} input
 * @returns {string}
 */
export function formatCondenseNotice({ beforeBytes, afterBytes, ref }) {
  const hint = typeof ref.retrievalHint === 'string' && ref.retrievalHint.length > 0 ? ref.retrievalHint : FALLBACK_HINT
  return `(rtk condensed ${beforeBytes} → ${afterBytes} bytes. Full formatted result stored at: ${ref.locator}. ${hint})`
}
