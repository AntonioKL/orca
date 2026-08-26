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

  // Why: padding eating an axis is not evidence that axis is unbounded — the surface was still
  // measured, and it, not the viewport, is what the image cannot exceed.
  it('keeps the measured surface length on an axis whose padding leaves no content box', () => {
    expect(getImageElementSizing(null, { width: 700, height: 30 })).toEqual({
      className: 'block',
      style: { maxWidth: '668px', maxHeight: '30px' }
    })
  })

  it('keeps the measured surface length when the surface is narrower than its own padding', () => {
    expect(getImageElementSizing(null, { width: 24, height: 800 })).toEqual({
      className: 'block',
      style: { maxWidth: '24px', maxHeight: '768px' }
    })
  })

  it('keeps both measured lengths when neither axis clears its padding', () => {
    expect(getImageElementSizing(null, { width: 24, height: 24 })).toEqual({
      className: 'block',
      style: { maxWidth: '24px', maxHeight: '24px' }
    })
  })

  // Why: a collapsed ancestor reports 0, and a 0-length surface still bounds the image.
  it('keeps a zero-length measured axis rather than widening it to the viewport', () => {
    expect(getImageElementSizing(null, { width: 0, height: 0 })).toEqual({
      className: 'block',
      style: { maxWidth: '0px', maxHeight: '0px' }
    })
  })
})
