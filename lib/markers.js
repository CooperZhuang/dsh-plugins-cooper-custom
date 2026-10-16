/**
 * Trailing status markers, exactly as the harness bash tool renders them
 * (`dsh-tool-bash`'s `renderResult` / `renderPromoted`). They are the model's
 * contract for exit status, so they must survive condensation byte-for-byte.
 *
 * @module dsh-rtk-slim/markers
 */

/** One trailing status marker line. */
const MARKER = /^\[(?:exit code: -?\d+|timed out after \d+ms|stopped: [^\]]*|killed by signal: [^\]]*|sandbox: [^\]]*|still running after \d+ms; moved to background job [^\]]+)\]$/

/** Opening words of the guidance paragraph that follows a background promotion. */
const BACKGROUND_GUIDANCE = 'The command keeps running in the background.'

/**
 * Split the trailing status block off a rendered tool result.
 * @param {string} text
 * @returns {{ body: string, tail: string }} `tail` is `''` when nothing matched.
 */
export function splitTailMarkers(text) {
  if (text.length === 0) return { body: '', tail: '' }
  const lines = text.split('\n')
  let cut = lines.length
  // The promoted-to-background shape is "<marker>\n<guidance>"; consume the
  // guidance only when a real marker sits directly above it.
  if (cut > 1 && lines[cut - 1].startsWith(BACKGROUND_GUIDANCE) && MARKER.test(lines[cut - 2])) cut -= 1
  while (cut > 0 && MARKER.test(lines[cut - 1])) cut -= 1
  if (cut === lines.length) return { body: text, tail: '' }
  return { body: lines.slice(0, cut).join('\n'), tail: lines.slice(cut).join('\n') }
}

/**
 * Re-attach a split `tail`. `joinTailMarkers(...split(x)) === x` for every `x`.
 * @param {string} body
 * @param {string} tail
 * @returns {string}
 */
export function joinTailMarkers(body, tail) {
  if (tail === '') return body
  return body === '' ? tail : `${body}\n${tail}`
}
