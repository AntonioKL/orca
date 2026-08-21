import { describe, expect, it } from 'vitest'
import {
  IMAGE_PASTE_FOLLOWING_TEXT_SEPARATOR,
  joinImagePastesAndPrompt
} from './image-paste-following-text'

const IMAGE_A = '\x1b[200~/tmp/orca-paste-a.png\x1b[201~'
const IMAGE_B = '\x1b[200~/tmp/orca-paste-b.png\x1b[201~'
const PROMPT =
  'add the QR code for wechat group 8 next to group 7. saying if group 7 is full can join group 8'

describe('joinImagePastesAndPrompt', () => {
  it('separates an attachment path from following prompt text by a single space', () => {
    expect(joinImagePastesAndPrompt([IMAGE_A], PROMPT)).toBe(`${IMAGE_A} ${PROMPT}`)
    expect(joinImagePastesAndPrompt([IMAGE_A], PROMPT)).not.toBe(`${IMAGE_A}${PROMPT}`)
    expect(joinImagePastesAndPrompt([IMAGE_A], PROMPT)).not.toContain('pngadd')
    expect(IMAGE_PASTE_FOLLOWING_TEXT_SEPARATOR).toBe(' ')
  })

  it('keeps an attachment-only send as the framed path with no trailing separator', () => {
    expect(joinImagePastesAndPrompt([IMAGE_A], '')).toBe(IMAGE_A)
  })

  it('leaves prompt-only text unchanged', () => {
    expect(joinImagePastesAndPrompt([], PROMPT)).toBe(PROMPT)
  })

  it('separates multiple attachments from each other and from the prompt', () => {
    expect(joinImagePastesAndPrompt([IMAGE_A, IMAGE_B], PROMPT)).toBe(
      `${IMAGE_A} ${IMAGE_B} ${PROMPT}`
    )
    expect(joinImagePastesAndPrompt([IMAGE_A, IMAGE_B], '')).toBe(`${IMAGE_A} ${IMAGE_B}`)
  })
})
