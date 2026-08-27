import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { NativeChatImageRefBlock } from '../../shared/native-chat-types'

// Claude's stream-json stdin takes Anthropic message content, which has no
// local-path image source — unlike Codex's `localImage`. A local attachment has
// to be read and inlined as base64, so the composer's file is resolved here
// rather than handed to the provider as a path it would silently ignore.

/** The image formats Anthropic vision accepts. An extension outside this set is
 *  refused locally: the provider would reject it mid-turn, which is exactly the
 *  unknown-outcome state the send path must never enter. */
const CLAUDE_IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

/** Anthropic's documented per-image ceiling. */
export const CLAUDE_MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Whole-message ceilings, so one send cannot inline an unbounded base64 body
 *  into the provider's stdin. */
export const CLAUDE_MAX_IMAGE_COUNT = 20
export const CLAUDE_MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024

export function claudeImageMediaType(path: string): string | null {
  return CLAUDE_IMAGE_MEDIA_TYPES[extname(path).toLowerCase()] ?? null
}

export type ClaudeImageBudget = { remainingBytes: number }

/** Throws for a message carrying more images than one turn may inline; the
 *  returned budget then fails the send on the first byte over the aggregate. */
export function claudeImageBudget(imageCount: number): ClaudeImageBudget {
  if (imageCount > CLAUDE_MAX_IMAGE_COUNT) {
    throw new Error(
      `Claude accepts at most ${CLAUDE_MAX_IMAGE_COUNT} images per message; this one has ${imageCount}`
    )
  }
  return { remainingBytes: CLAUDE_MAX_IMAGE_TOTAL_BYTES }
}

export async function claudeImageContent(
  block: NativeChatImageRefBlock,
  budget: ClaudeImageBudget = claudeImageBudget(1),
  readImage: (path: string) => Promise<Buffer> = readFile
): Promise<Record<string, unknown>> {
  if (block.url) {
    return { type: 'image', source: { type: 'url', url: block.url } }
  }
  if (!block.path) {
    throw new Error('Claude image dispatch requires a path or url')
  }
  const mediaType = claudeImageMediaType(block.path)
  if (!mediaType) {
    throw new Error(
      `Claude does not accept ${extname(block.path) || 'this'} images; use JPEG, PNG, GIF, or WebP`
    )
  }
  let data: Buffer
  try {
    data = await readImage(block.path)
  } catch (error) {
    throw new Error(`Claude could not read the attached image: ${(error as Error).message}`)
  }
  // Measured on bytes actually read, never on a stat the file could have grown past.
  if (data.byteLength > CLAUDE_MAX_IMAGE_BYTES) {
    throw new Error(
      `Claude accepts images up to ${CLAUDE_MAX_IMAGE_BYTES} bytes; ${block.path} is ${data.byteLength}`
    )
  }
  budget.remainingBytes -= data.byteLength
  if (budget.remainingBytes < 0) {
    throw new Error(
      `Claude accepts up to ${CLAUDE_MAX_IMAGE_TOTAL_BYTES} bytes of images per message`
    )
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: data.toString('base64') }
  }
}
