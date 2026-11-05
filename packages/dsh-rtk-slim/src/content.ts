/**
 * Boundary between the harness content-block payload and plain text.
 *
 * `tools/post-execute` hands over `result.content` as a `ContentBlock[]`, not a
 * string. The plugin is only interested in the common single-text-block case
 * (what `bash` and `job_output` render); anything else is left untouched so we
 * never fight a tool's own definition-owned content finalizer.
 *
 * @module dsh-rtk-slim/content
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * Text of a payload that is exactly one text block.
 * @param content - the payload's content blocks, when the tool produced any.
 * @returns `undefined` means "out of scope, bail".
 */
export function singleText(content: readonly ContentBlock[] | undefined): string | undefined {
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block: ContentBlock = content[0]
  if (block === null || typeof block !== 'object' || block.type !== 'text') return undefined
  return block.text
}

/**
 * Re-wrap condensed text as the single text block the registry expects.
 * @param text - condensed text.
 * @returns the one-block content payload.
 */
export function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}
