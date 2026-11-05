/**
 * Lossy-but-traceable condensation: every condensed text is recoverable in
 * full. The store is the official `ctx.spillStore` service (backed by
 * `dsh-spill-local`), used exactly the way `dsh-spill-policy` uses it, so the
 * notice wording and the file layout are the ones the harness already knows.
 *
 * @module dsh-rtk-slim/spill
 */
/** Where the untouched original text can be read back from. */
export interface Ref {
    /** Opaque store locator (an absolute path for the local backend). */
    locator: string;
    /** Size of the saved copy in bytes, when the store reports it. */
    bytes?: number;
    /** Backend-provided "how to read this back" sentence. */
    retrievalHint?: string;
}
/** Host context surface this module needs: the service lookup only. */
export interface SpillContext {
    get(name: string): unknown;
}
/** Execution identity as far as the spill store cares. */
export interface SpillExec {
    /** Tool name (`bash`, `job_output`). */
    name: string;
    /** Call id, when the registry assigned one. */
    callId?: string;
    /** Caller agent; the session id becomes the spill owner. */
    agent?: {
        session?: {
            header?: {
                id?: string;
            };
        };
    };
}
/**
 * Persist the untouched original text.
 * @param ctx - host context; `ctx.get('spillStore')` is the backend.
 * @param exec - the tool execution that produced the text.
 * @param text - original text, exactly as the model would have seen it.
 * @returns the store's reference, or `undefined` when no traceability is available.
 */
export declare function saveFullText(ctx: SpillContext, exec: SpillExec, text: string): Promise<Ref | undefined>;
/** The numbers and reference the condensed-result notice quotes. */
export interface CondenseNoticeInput {
    /** Original size in bytes. */
    beforeBytes: number;
    /** Condensed size in bytes. */
    afterBytes: number;
    /** Where the full original is stored. */
    ref: Ref;
}
/**
 * @param input - byte counts and the spill reference.
 * @returns the one-line notice appended to condensed text.
 */
export declare function formatCondenseNotice({ beforeBytes, afterBytes, ref }: CondenseNoticeInput): string;
