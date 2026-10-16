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
import { singleText, textBlock } from './content.js'
import { checkInvariants } from './guards.js'
import { logStartup } from './log.js'
import { joinTailMarkers, splitTailMarkers } from './markers.js'
import { runRtk } from './rtk.js'
import { chooseFilter } from './sniff.js'
import { formatCondenseNotice, saveFullText } from './spill.js'

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

/**
 * @typedef {object} SlimConfig
 * @property {boolean} enabled
 * @property {string} command
 * @property {string[]} tools
 * @property {number} minBytes
 * @property {number} maxInputBytes
 * @property {number} timeoutMs
 * @property {number} maxOutputBytes
 * @property {Record<string, string | false>} filters
 * @property {boolean} spill
 * @property {boolean} requireSpill
 * @property {boolean} notice
 * @property {boolean} ultraCompact
 */

/**
 * Defensive defaults so the handler is usable with a raw config object in
 * tests, and with a schema-validated one from the loader.
 * @param {Partial<SlimConfig> | undefined} raw
 * @returns {SlimConfig}
 */
function normalizeConfig(raw) {
  const defaults = {
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
  const merged = { ...defaults, ...(raw ?? {}) }
  if (!Array.isArray(merged.tools)) merged.tools = defaults.tools
  if (merged.filters === null || typeof merged.filters !== 'object') merged.filters = {}
  return merged
}

/**
 * Build the `tools/post-execute` listener. Exported for tests that drive it
 * without a cordis context.
 * @param {{ logger?: { warn: (message: string) => void }, get: (name: string) => any }} ctx
 * @param {Partial<SlimConfig> | undefined} rawConfig
 * @param {{ runRtk?: typeof runRtk, saveFullText?: typeof saveFullText }} [deps]
 * @returns {(exec: any, result: any, next: () => Promise<any>) => Promise<any>}
 */
export function createPostExecuteHandler(ctx, rawConfig, deps = {}) {
  const config = normalizeConfig(rawConfig)
  const run = deps.runRtk ?? runRtk
  const spill = deps.saveFullText ?? saveFullText
  const warned = new Set()

  /**
   * One line per distinct reason, ever.
   * @param {string} key
   * @param {string} detail
   */
  function warn(key, detail) {
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
      const args = filter === undefined ? ['pipe'] : ['pipe', '-f', filter]
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

      /** @type {import('./spill.js').Ref | undefined} */
      let ref
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
 * @param {{ on: (event: string, listener: any) => any, logger?: { warn: (message: string) => void }, get: (name: string) => any }} ctx
 * @param {Partial<SlimConfig> | undefined} config
 */
export function apply(ctx, config) {
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
