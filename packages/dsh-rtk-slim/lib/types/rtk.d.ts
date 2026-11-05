/**
 * rtk invocation. Owns every way the child can misbehave: missing binary,
 * non-zero exit, timeout, caller cancellation, runaway output. Every failure is
 * a value, never a throw — the caller keeps the original text.
 *
 * @module dsh-rtk-slim/rtk
 */
/** One rtk invocation. */
export interface RtkRunInput {
    /** Executable name or absolute path. */
    command: string;
    /** Arguments after the executable. */
    args: string[];
    /** stdin payload (`rtk pipe` reads the text from stdin). */
    input: string;
    /** Wall-clock budget before the whole process group is killed. */
    timeoutMs: number;
    /** Caller cancellation; aborts the child like a timeout does. */
    signal?: AbortSignal;
    /** Output cap; exceeding it kills the child and yields `too-large`. */
    maxOutputBytes: number;
}
/** Condenser outcome: either condensed text, or the reason it did not happen. */
export type RunResult = {
    ok: true;
    text: string;
} | {
    ok: false;
    reason: 'spawn' | 'exit' | 'timeout' | 'aborted' | 'too-large';
};
/**
 * Run rtk once, feeding `input` on stdin.
 * @param input - command, arguments, stdin payload, and limits.
 * @returns the condensed text or a failure reason; never rejects.
 */
export declare function runRtk({ command, args, input, timeoutMs, signal, maxOutputBytes }: RtkRunInput): Promise<RunResult>;
