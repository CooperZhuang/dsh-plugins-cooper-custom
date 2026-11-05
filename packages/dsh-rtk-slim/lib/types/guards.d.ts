/**
 * Invariants a condensation must satisfy before it may replace model-visible
 * text. Any failure means "keep the original" — never an error result.
 *
 * I1 (marker preservation) is structural: callers split the trailing status
 * block off before calling rtk and re-attach it verbatim afterwards, so it
 * cannot be lost here.
 *
 * @module dsh-rtk-slim/guards
 */
/**
 * Failure-signal lines. Deliberately narrow: a bare `failed` word would make
 * the invariant vacuously false on a passing run ("0 failed"), killing the
 * main win.
 */
export declare const FAILURE_PATTERNS: readonly RegExp[];
/**
 * Distinct failure-signal lines in `text` (trimmed).
 * @param text - rendered tool output.
 * @returns one entry per distinct failure line, in first-seen order.
 */
export declare function collectFailureLines(text: string): string[];
/** Why a condensation was rejected; `ok: true` means it may replace the text. */
export type GuardResult = {
    ok: true;
} | {
    ok: false;
    reason: 'empty' | 'unchanged' | 'expanded' | 'failures' | 'ratio';
};
/** The two already-extracted texts an invariant check compares. */
export interface GuardInput {
    /** Original text, trailing status markers already removed. */
    raw: string;
    /** Candidate condensed text. */
    condensed: string;
}
/**
 * @param input - original and condensed texts, both already extracted.
 * @returns whether the condensation may replace the original.
 */
export declare function checkInvariants({ raw, condensed }: GuardInput): GuardResult;
