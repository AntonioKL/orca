import { describe, expect, it } from 'vitest'
import { getImageElementSizeClassName } from './image-viewer-dom-zoom'

describe('getImageElementSizeClassName', () => {
  it('fills the measured wrapper box once the natural size is known', () => {
    expect(getImageElementSizeClassName({ width: 800, height: 600 })).toBe('block h-full w-full')
  })

  // Why: the scroll surface's inner box is `w-max`/`h-max`, so percentage maxes on the
  // image resolve to `none` and an unmeasured image lays out at natural resolution.
  it('caps an unmeasured image with viewport lengths, not percentages', () => {
    const className = getImageElementSizeClassName(null)

    expect(className).toContain('max-h-[100vh]')
    expect(className).toContain('max-w-[100vw]')
    expect(className).not.toContain('max-h-full')
    expect(className).not.toContain('max-w-full')
  })
})
