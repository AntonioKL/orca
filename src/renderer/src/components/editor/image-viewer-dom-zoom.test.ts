import { describe, expect, it } from 'vitest'
import { getImageElementSizing } from './image-viewer-dom-zoom'

describe('getImageElementSizing', () => {
  it('fills the measured wrapper box once the natural size is known', () => {
    expect(getImageElementSizing({ width: 800, height: 600 }, { width: 700, height: 800 })).toEqual(
      {
        className: 'block h-full w-full',
        style: undefined
      }
    )
  })

  // Why: the scroll surface's inner box is `w-max`/`h-max`, so percentage maxes on the image
  // resolve to `none` and an unmeasured image lays out at natural resolution; the surface is
  // already measured by then, and it is far tighter than the viewport in a split pane.
  it('caps an unmeasured image with the measured surface box minus its padding', () => {
    expect(getImageElementSizing(null, { width: 700, height: 800 })).toEqual({
      className: 'block',
      style: { maxWidth: '668px', maxHeight: '768px' }
    })
  })

  // Why: a null surface means "not measured yet", not "unbounded" — fall back to a definite
  // viewport cap rather than letting the natural size through.
  it('falls back to viewport lengths while the surface is unmeasured', () => {
    expect(getImageElementSizing(null, null)).toEqual({
      className: 'block max-h-[100vh] max-w-[100vw]',
      style: undefined
    })
  })

  // Why: an axis we could not use is not evidence the other axis is unbounded — a surface too
  // narrow to cap the width still measured a height, so keep it and fall back only on that axis.
  it('keeps the measured height when the surface is narrower than its own padding', () => {
    expect(getImageElementSizing(null, { width: 24, height: 800 })).toEqual({
      className: 'block max-w-[100vw]',
      style: { maxHeight: '768px' }
    })
  })

  it('keeps the measured width when the surface is shorter than its own padding', () => {
    expect(getImageElementSizing(null, { width: 900, height: 24 })).toEqual({
      className: 'block max-h-[100vh]',
      style: { maxWidth: '868px' }
    })
  })

  it('falls back to viewport lengths when neither surface axis clears its padding', () => {
    expect(getImageElementSizing(null, { width: 24, height: 24 })).toEqual({
      className: 'block max-h-[100vh] max-w-[100vw]',
      style: undefined
    })
  })
})
