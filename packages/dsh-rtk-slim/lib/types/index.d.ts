/**
 * dsh-rtk-slim: condense oversized `bash` / `job_output` text through `rtk`
 * before the model sees it, with a recoverable full-text copy and a
 * no-surprises failure surface.
 *
 * Registered WITHOUT `prepend`, i.e. as the innermost listener of the
 * `tools/post-execute` waterfall: every outer listener (notably
 * `dsh-spill-policy`, which prepends) has already run `next()` by the time we
 * see the result, so we condense the original text and spill-policy then gets
 * to post-process our (smaller) output.
 *
 * @module dsh-rtk-slim
 */
import z from '@deepseek-ai/schemastery';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { runRtk } from './rtk.js';
import { saveFullText } from './spill.js';
import type { SpillExec } from './spill.js';
export declare const name = "rtk-slim";
/** The tools registry owns the waterfall we hook. */
export declare const inject: string[];
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    command: z<string, string, "defined">;
    tools: z<string[], string[], "defined">;
    minBytes: z<number, number, "defined">;
    maxInputBytes: z<number, number, "defined">;
    timeoutMs: z<number, number, "defined">;
    maxOutputBytes: z<number, number, "defined">;
    filters: z<import("@deepseek-ai/cosmokit").Dict<string | false, string>, import("@deepseek-ai/cosmokit").Dict<string | false, string>, "defined">;
    spill: z<boolean, boolean, "defined">;
    requireSpill: z<boolean, boolean, "defined">;
    notice: z<boolean, boolean, "defined">;
    ultraCompact: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    command: z<string, string, "defined">;
    tools: z<string[], string[], "defined">;
    minBytes: z<number, number, "defined">;
    maxInputBytes: z<number, number, "defined">;
    timeoutMs: z<number, number, "defined">;
    maxOutputBytes: z<number, number, "defined">;
    filters: z<import("@deepseek-ai/cosmokit").Dict<string | false, string>, import("@deepseek-ai/cosmokit").Dict<string | false, string>, "defined">;
    spill: z<boolean, boolean, "defined">;
    requireSpill: z<boolean, boolean, "defined">;
    notice: z<boolean, boolean, "defined">;
    ultraCompact: z<boolean, boolean, "defined">;
}>>, "plain">;
/** The resolved (defaults applied) configuration the handler runs with. */
export interface SlimConfig {
    /** Master switch; `false` leaves the waterfall untouched. */
    enabled: boolean;
    /** rtk executable, resolved through PATH when bare. */
    command: string;
    /** Tool names whose single-text-block output may be condensed. */
    tools: string[];
    /** Outputs smaller than this are left alone. */
    minBytes: number;
    /** Outputs larger than this are left alone (rtk would be pointless). */
    maxInputBytes: number;
    /** rtk wall-clock budget. */
    timeoutMs: number;
    /** rtk output cap; exceeding it aborts the condensation. */
    maxOutputBytes: number;
    /** Per-family filter overrides; `false` disables a family's `-f`. */
    filters: Record<string, string | false>;
    /** Whether to persist the untouched original for traceability. */
    spill: boolean;
    /** Whether a condensation without a recoverable copy must be abandoned. */
    requireSpill: boolean;
    /** Whether to append the byte-count / spill-pointer notice. */
    notice: boolean;
    /** Pass `--ultra-compact` to rtk. */
    ultraCompact: boolean;
}
/** An `accept` decision, as far as this plugin reads and rebuilds it. */
export interface AcceptDecisionLike {
    kind: 'accept';
    content?: ContentBlock[];
    additionalContexts?: readonly unknown[];
}
/** A `block` decision; opaque here, passed through untouched. */
export interface BlockDecisionLike {
    kind: 'block';
    feedback: ContentBlock[];
    additionalContexts?: readonly unknown[];
}
/** The waterfall decision this plugin may observe; `null`/`undefined` pass through. */
export type PostDecisionLike = AcceptDecisionLike | BlockDecisionLike | null | undefined;
/** The execution identity this plugin reads: tool name, call id, cancellation, session. */
export interface ToolExecLike extends SpillExec {
    /** Caller cancellation, forwarded to the rtk child. */
    signal?: AbortSignal;
}
/** The result shape this plugin reads: the error flag and the content blocks. */
export interface ToolResultLike {
    isError?: boolean;
    content?: readonly ContentBlock[];
}
/** The only logger surface this plugin uses. */
export interface LoggerLike {
    warn(message: string): void;
}
/** Host context surface this plugin needs: the service lookup and a logger. */
export interface HandlerContext {
    logger?: LoggerLike;
    get(name: string): unknown;
}
/**
 * The `tools/post-execute` listener. Minimal local signature: the plugin only
 * touches tool name, call id, signal, session id, error flag, and content
 * blocks, so it does not depend on the host's full execution contracts.
 */
export type PostExecuteHandler = (exec: ToolExecLike, result: ToolResultLike | undefined, next: () => Promise<PostDecisionLike>) => Promise<PostDecisionLike>;
/** Host context of `apply`: a {@link HandlerContext} that can register listeners. */
export interface PluginContext extends HandlerContext {
    on(event: 'tools/post-execute', listener: PostExecuteHandler): unknown;
}
/** Seams tests use to drive the handler without spawning rtk or a spill store. */
export interface HandlerDeps {
    runRtk?: typeof runRtk;
    saveFullText?: typeof saveFullText;
}
/**
 * Build the `tools/post-execute` listener. Exported for tests that drive it
 * without a cordis context.
 * @param ctx - host context: logger and service lookup (`spillStore`).
 * @param rawConfig - config as handed over by the loader.
 * @param deps - optional seams that replace rtk and the spill store.
 * @returns the listener to register on `tools/post-execute`.
 */
export declare function createPostExecuteHandler(ctx: HandlerContext, rawConfig: Partial<SlimConfig> | undefined, deps?: HandlerDeps): PostExecuteHandler;
/**
 * Register the condenser on the `tools/post-execute` waterfall.
 * @param ctx - host context.
 * @param config - config as handed over by the loader.
 */
export declare function apply(ctx: PluginContext, config?: Partial<SlimConfig>): void;
