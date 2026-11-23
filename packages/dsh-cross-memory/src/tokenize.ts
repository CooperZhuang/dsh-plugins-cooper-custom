/**
 * The tokenizer shared by every lexical path in the plugin.
 *
 * Split out of `search.ts` so the BM25 ranker can use the exact same terms as
 * the hand-weighted scorer without a circular import: the two rankers are
 * supposed to agree on what a "term" is, and a copy of this file would be the
 * first thing to drift.
 *
 * Chinese is the reason this module exists. A query with no spaces
 * ("该插件是否有日志") tokenizes to one indivisible run under any whitespace
 * splitter, so a whole-run substring test is the only thing that could match —
 * and a memory almost never contains a whole question verbatim. Every
 * comparison therefore runs over CJK character bigrams as well.
 *
 * @module dsh-cross-memory/tokenize
 */

/** A CJK ideograph, including the extension blocks in common use. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
/** A CJK character inside a query or a memory field. */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu
/** Lowercase Latin, digits, and underscore — the "word" case. */
const WORD = /[a-z0-9_]+/gu

/** Split text into searchable terms: ASCII words and CJK character bigrams.
 *
 * A CJK run also contributes bigrams of its neighbours, so "该插件是否有日志"
 * yields "该插","插件","件是","是否","否有","有日","日志". A one-character run
 * contributes itself, since a lone ideograph has no bigram.
 *
 * @param text - raw text.
 * @returns lowercase terms; a run that yields nothing contributes nothing.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const terms: string[] = []
  for (const word of lower.match(WORD) ?? []) terms.push(word)
  const chars = lower.match(CJK_CHAR) ?? []
  if (chars.length === 1) terms.push(chars[0] as string)
  for (let index = 0; index + 1 < chars.length; index += 1) {
    terms.push(`${chars[index]}${chars[index + 1]}`)
  }
  return terms
}

/**
 * A term's weight for scoring purposes.
 *
 * One CJK bigram is a much weaker claim than one Latin word — "日志" occurs in
 * countless texts where "logging" does not — so a bigram earns less. Without
 * this every Chinese question would clear the recall gate on noise alone.
 *
 * @param term - one term from {@link tokenize}.
 * @returns a multiplier in `(0, 1]`.
 */
export function termWeight(term: string): number {
  const cjk = (term.match(CJK_CHAR) ?? []).length
  if (cjk === 0) return 1
  // Two-character bigram: half credit. A longer CJK term cannot occur (the
  // tokenizer emits bigrams), but treat it as stronger if it ever does.
  return cjk <= 2 ? 0.5 : Math.min(1, 0.5 + (cjk - 2) * 0.15)
}

/** A short token carries little signal and is skipped as a query term. */
export function isNoise(token: string): boolean {
  if (CJK.test(token)) return false
  return token.length < 2
}
