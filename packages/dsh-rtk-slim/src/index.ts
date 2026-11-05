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

import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { singleText, textBlock } from './content.js'
import { checkInvariants } from './guards.js'
import { logStartup } from './log.js'
import { splitTailMarkers } from './markers.js'
import { runRtk } from './rtk.js'
import { chooseFilter } from './sniff.js'
import { formatCondenseNotice, saveFullText, type Ref } from './spill.js'
import type { SpillExec } from './spill.js'

export const name = 'rtk-slim'

/** The tools registry owns the waterfall we hook. */
export const inject = ['tools']

export const Config = z.object({
  enabled: z.boolean().default(true),
  command: z.string().default('rtk'),
  tools: z.array(z.string()).default(['bash', 'job_output']),
  minBytes: z.number().default(2048),
  maxInputBytes: z.number().default(4194304),
  timeoutMs: z.number().default(10000),
  maxOutputBytes: z.number().default(8388608),
  filters: z.dict(z.union([z.string(), z.const(false)])).default({}),
  spill: z.boolean().default(true),
  requireSpill: z.boolean().default(true),
  notice: z.boolean().default(true),
  ultraCompact: z.boolean().default(false),
})

/** The resolved (defaults applied) configuration the handler runs with. */
export interface SlimConfig {
  /** Master switch; `false` leaves the waterfall untouched. */
  enabled: boolean
  /** rtk executable, resolved through PATH when bare. */
  command: string
  /** Tool names whose single-text-block output may be condensed. */
  tools: string[]
  /** Outputs smaller than this are left alone. */
  minBytes: number
  /** Outputs larger than this are left alone (rtk would be pointless). */
  maxInputBytes: number
  /** rtk wall-clock budget. */
  timeoutMs: number
  /** rtk output cap; exceeding it aborts the condensation. */
  maxOutputBytes: number
  /** Per-family filter overrides; `false` disables a family's `-f`. */
  filters: Record<string, string | false>
  /** Whether to persist the untouched original for traceability. */
  spill: boolean
  /** Whether a condensation without a recoverable copy must be abandoned. */
  requireSpill: boolean
  /** Whether to append the byte-count / spill-pointer notice. */
  notice: boolean
  /** Pass `--ultra-compact` to rtk. */
  ultraCompact: boolean
}

/** An `accept` decision, as far as this plugin reads and rebuilds it. */
export interface AcceptDecisionLike {
  kind: 'accept'
  content?: ContentBlock[]
  additionalContexts?: readonly unknown[]
}

/** A `block` decision; opaque here, passed through untouched. */
export interface BlockDecisionLike {
  kind: 'block'
  feedback: ContentBlock[]
  additionalContexts?: readonly unknown[]
}

/** The waterfall decision this plugin may observe; `null`/`undefined` pass through. */
export type PostDecisionLike = AcceptDecisionLike | BlockDecisionLike | null | undefined

/** The execution identity this plugin reads: tool name, call id, cancellation, session. */
export interface ToolExecLike extends SpillExec {
  /** Caller cancellation, forwarded to the rtk child. */
  signal?: AbortSignal
}

/** The result shape this plugin reads: the error flag and the content blocks. */
export interface ToolResultLike {
  isError?: boolean
  content?: readonly ContentBlock[]
}

/** The only logger surface this plugin uses. */
export interface LoggerLike {
  warn(message: string): void
}

/** Host context surface this plugin needs: the service lookup and a logger. */
export interface HandlerContext {
  logger?: LoggerLike
  get(name: string): unknown
}

/**
 * The `tools/post-execute` listener. Minimal local signature: the plugin only
 * touches tool name, call id, signal, session id, error flag, and content
 * blocks, so it does not depend on the host's full execution contracts.
 */
export type PostExecuteHandler = (
  exec: ToolExecLike,
  result: ToolResultLike | undefined,
  next: () => Promise<PostDecisionLike>,
) => Promise<PostDecisionLike>

/** Host context of `apply`: a {@link HandlerContext} that can register listeners. */
export interface PluginContext extends HandlerContext {
  on(event: 'tools/post-execute', listener: PostExecuteHandler): unknown
}

/** Seams tests use to drive the handler without spawning rtk or a spill store. */
export interface HandlerDeps {
  runRtk?: typeof runRtk
  saveFullText?: typeof saveFullText
}

/**
 * Defensive defaults so the handler is usable with a raw config object in
 * tests, and with a schema-validated one from the loader.
 * @param raw - config as handed over by the loader (or a partial in tests).
 * @returns the config with every field resolved.
 */
function normalizeConfig(raw: Partial<SlimConfig> | undefined): SlimConfig {
  const defaults: SlimConfig = {
    enabled: true,
    command: 'rtk',
    tools: ['bash', 'job_output'],
    minBytes: 2048,
    maxInputBytes: 4194304,
    timeoutMs: 10000,
    maxOutputBytes: 8388608,
    filters: {},
    spill: true,
    requireSpill: true,
    notice: true,
    ultraCompact: false,
  }
  const merged: SlimConfig = { ...defaults, ...(raw ?? {}) }
  if (!Array.isArray(merged.tools)) merged.tools = defaults.tools
  // Widened to `unknown` so the runtime shape check stays legal even though the
  // config type says "always an object".
  const filters: unknown = merged.filters
  if (filters === null || typeof filters !== 'object') merged.filters = {}
  return merged
}

/**
 * Build the `tools/post-execute` listener. Exported for tests that drive it
 * without a cordis context.
 * @param ctx - host context: logger and service lookup (`spillStore`).
 * @param rawConfig - config as handed over by the loader.
 * @param deps - optional seams that replace rtk and the spill store.
 * @returns the listener to register on `tools/post-execute`.
 */
export function createPostExecuteHandler(
  ctx: HandlerContext,
  rawConfig: Partial<SlimConfig> | undefined,
  deps: HandlerDeps = {},
): PostExecuteHandler {
  const config = normalizeConfig(rawConfig)
  const run = deps.runRtk ?? runRtk
  const spill = deps.saveFullText ?? saveFullText
  const warned = new Set<string>()

  /**
   * One line per distinct reason, ever.
   * @param key - stable warning category (`rtk:timeout`, `guard:expanded`, …).
   * @param detail - short human-readable context.
   */
  function warn(key: string, detail: string): void {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger?.warn(`rtk-slim: ${key}: ${detail}`)
  }

  return async function postExecute(exec, result, next) {
    // Let downstream (more inner) listeners settle first; a throw here belongs
    // to the registry, not to us.
    const decision = await next()
    try {
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision
      if (Object.hasOwn(decision, 'value')) return decision
      if (result?.isError === true) return decision
      if (!config.tools.includes(exec?.name)) return decision

      const raw = singleText(decision.content ?? result?.content)
      if (raw === undefined) return decision

      const rawBytes = Buffer.byteLength(raw, 'utf8')
      if (rawBytes < config.minBytes || rawBytes > config.maxInputBytes) return decision

      const { body, tail } = splitTailMarkers(raw)
      if (body.length === 0) return decision

      const { filter } = chooseFilter(body, config.filters)
      const args: string[] = filter === undefined ? ['pipe'] : ['pipe', '-f', filter]
      if (config.ultraCompact) args.push('--ultra-compact')

      const produced = await run({
        command: config.command,
        args,
        input: body,
        timeoutMs: config.timeoutMs,
        signal: exec?.signal,
        maxOutputBytes: config.maxOutputBytes,
      })
      if (!produced.ok) {
        warn(`rtk:${produced.reason}`, `rtk did not condense ${exec?.name} output`)
        return decision
      }

      const condensedBody = produced.text.replace(/\n+$/, '')
      const guard = checkInvariants({ raw: body, condensed: condensedBody })
      if (!guard.ok) {
        if (guard.reason !== 'unchanged') warn(`guard:${guard.reason}`, `condensation rejected for ${exec?.name}`)
        return decision
      }

      let ref: Ref | undefined
      if (config.spill) {
        ref = await spill(ctx, exec, raw)
        if (ref === undefined && config.requireSpill) {
          warn('spill:failed', `no recoverable copy for ${exec?.name}; keeping the original`)
          return decision
        }
      }

      const notice =
        config.notice && ref !== undefined
          ? formatCondenseNotice({
              beforeBytes: rawBytes,
              afterBytes: Buffer.byteLength(condensedBody, 'utf8'),
              ref,
            })
          : undefined

      const assembled = [condensedBody, notice, tail].filter((part) => part !== undefined && part !== '').join('\n')
      return {
        kind: 'accept',
        content: textBlock(assembled),
        ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
      }
    } catch (error) {
      warn('unexpected', String(error instanceof Error ? error.message : error))
      return decision
    }
  }
}

/**
 * Register the condenser on the `tools/post-execute` waterfall.
 * @param ctx - host context.
 * @param config - config as handed over by the loader.
 */
export function apply(ctx: PluginContext, config?: Partial<SlimConfig>): void {
  const resolved = normalizeConfig(config)
  // Nothing else in the harness records activation to disk, so this one line is
  // what makes "did it mount, and with which config?" answerable after a restart.
  logStartup(
    `mounted pid=${process.pid} enabled=${resolved.enabled} command=${resolved.command} tools=${resolved.tools.join(',')} ` +
      `minBytes=${resolved.minBytes} timeoutMs=${resolved.timeoutMs} spill=${resolved.spill} requireSpill=${resolved.requireSpill} ` +
      `notice=${resolved.notice} ultraCompact=${resolved.ultraCompact} filters=${JSON.stringify(resolved.filters)}`,
  )
  if (resolved.enabled === false) return
  ctx.on('tools/post-execute', createPostExecuteHandler(ctx, resolved))
}
