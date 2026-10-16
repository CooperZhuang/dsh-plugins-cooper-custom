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
export const FAILURE_PATTERNS = [
  /^test result: FAILED/,
  /^FAILED\b/,
  /^--- FAIL:/,
  /^error(\[E\d+\])?:/,
  /^Traceback \(most recent call last\):/,
  /panicked at/,
  /^AssertionError\b/,
  /^FAIL\b/,
]

/**
 * Distinct failure-signal lines in `text` (trimmed).
 * @param {string} text
 * @returns {string[]}
 */
export function collectFailureLines(text) {
  const found = new Set()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (FAILURE_PATTERNS.some((pattern) => pattern.test(trimmed))) found.add(trimmed)
  }
  return [...found]
}

/** @typedef {{ ok: true } | { ok: false, reason: 'empty' | 'unchanged' | 'expanded' | 'failures' | 'ratio' }} GuardResult */

/**
 * @param {{ raw: string, condensed: string }} input both already-extracted text
 * @returns {GuardResult}
 */
export function checkInvariants({ raw, condensed }) {
  if (condensed.length === 0) return { ok: false, reason: 'empty' }
  const rawBytes = Buffer.byteLength(raw, 'utf8')
  const condensedBytes = Buffer.byteLength(condensed, 'utf8')
  if (condensed.trim() === raw.trim()) return { ok: false, reason: 'unchanged' }
  if (condensedBytes >= rawBytes) return { ok: false, reason: 'expanded' }
  if (collectFailureLines(raw).some((line) => !condensed.includes(line))) {
    return { ok: false, reason: 'failures' }
  }
  if (condensedBytes < rawBytes * 0.02 && rawBytes >= 32 * 1024) {
    const hasOmissionMarker = /\[\+\d+ lines? omitted\]/.test(condensed)
    const hasSpillNotice = condensed.includes('Full formatted result stored at:')
    if (!hasOmissionMarker && !hasSpillNotice) return { ok: false, reason: 'ratio' }
  }
  return { ok: true }
}
