/**
 * Lossy-but-traceable condensation: every condensed text is recoverable in
 * full. The store is the official `ctx.spillStore` service (backed by
 * `dsh-spill-local`), used exactly the way `dsh-spill-policy` uses it, so the
 * notice wording and the file layout are the ones the harness already knows.
 *
 * @module dsh-rtk-slim/spill
 */
const FALLBACK_HINT = 'Use read with offset/limit, or grep this path to search within it.';
/**
 * Persist the untouched original text.
 * @param ctx - host context; `ctx.get('spillStore')` is the backend.
 * @param exec - the tool execution that produced the text.
 * @param text - original text, exactly as the model would have seen it.
 * @returns the store's reference, or `undefined` when no traceability is available.
 */
export async function saveFullText(ctx, exec, text) {
    const store = ctx.get('spillStore');
    if (store === null || typeof store !== 'object' || typeof store.saveText !== 'function')
        return undefined;
    const sessionId = exec.agent?.session?.header?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0)
        return undefined;
    try {
        const saved = await store.saveText({
            owner: { sessionId },
            source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
            suggestedName: `${exec.name}.txt`,
            content: text,
        });
        if (saved === null || typeof saved !== 'object')
            return undefined;
        const ref = saved;
        if (typeof ref.locator !== 'string' || ref.locator.length === 0) {
            return undefined;
        }
        return ref;
    }
    catch {
        return undefined;
    }
}
/**
 * @param input - byte counts and the spill reference.
 * @returns the one-line notice appended to condensed text.
 */
export function formatCondenseNotice({ beforeBytes, afterBytes, ref }) {
    const hint = typeof ref.retrievalHint === 'string' && ref.retrievalHint.length > 0 ? ref.retrievalHint : FALLBACK_HINT;
    return `(rtk condensed ${beforeBytes} → ${afterBytes} bytes. Full formatted result stored at: ${ref.locator}. ${hint})`;
}
