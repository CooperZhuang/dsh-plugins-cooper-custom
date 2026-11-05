/**
 * Trailing status markers, exactly as the harness bash tool renders them
 * (`dsh-tool-bash`'s `renderResult` / `renderPromoted`). They are the model's
 * contract for exit status, so they must survive condensation byte-for-byte.
 *
 * @module dsh-rtk-slim/markers
 */
/** A rendered tool result split into condenser input and verbatim status tail. */
export interface SplitMarkers {
    /** Text rtk may condense. */
    body: string;
    /** Trailing status block, re-attached verbatim; `''` when nothing matched. */
    tail: string;
}
/**
 * Split the trailing status block off a rendered tool result.
 * @param text - full rendered tool result.
 * @returns the body to condense and the tail to preserve.
 */
export declare function splitTailMarkers(text: string): SplitMarkers;
/**
 * Re-attach a split `tail`. `joinTailMarkers(...split(x)) === x` for every `x`.
 * @param body - condensed body.
 * @param tail - status block produced by {@link splitTailMarkers}.
 * @returns the reassembled text.
 */
export declare function joinTailMarkers(body: string, tail: string): string;
