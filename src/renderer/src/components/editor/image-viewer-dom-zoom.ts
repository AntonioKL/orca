import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import {
  type ImageViewerImageDimensions,
  type ImageViewerSurfaceSize,
  type ImageViewerZoomAnchor,
  clampImageViewerZoom,
  getAnchoredImageViewerScrollOffset,
  getAvailableImageSurfaceLength,
  getNextWheelImageViewerZoom,
  shouldHandleImageZoomWheel
} from './image-viewer-zoom'

export type ApplyImageViewerZoomChange = (
  getNextZoom: (currentZoom: number) => number,
  anchor?: ImageViewerZoomAnchor | null
) => void

export function getElementSurfaceSize(element: HTMLElement): ImageViewerSurfaceSize {
  return {
    width: element.clientWidth,
    height: element.clientHeight
  }
}

export function getImageLayoutStyle(
  size: ImageViewerImageDimensions | null
): CSSProperties | undefined {
  if (!size) {
    return undefined
  }

  return {
    width: `${size.width}px`,
    height: `${size.height}px`
  }
}

export type ImageElementSizing = {
  className: string
  style: CSSProperties | undefined
}

/**
 * Max length for one axis: its padded content box, or the raw measured surface when padding leaves
 * no content box. Only an axis we never measured falls through to the viewport — a 30px pane is a
 * tighter bound than the window, and widening it to the viewport would give the smallest surfaces
 * the loosest box.
 */
function getImageAxisMaxLength(surfaceLength: number | undefined): number | null {
  if (surfaceLength === undefined || !Number.isFinite(surfaceLength) || surfaceLength < 0) {
    return null
  }

  return getAvailableImageSurfaceLength(surfaceLength) ?? surfaceLength
}

/**
 * Sizing for the preview `<img>`.
 *
 * A null `layoutSize` means the natural size is not known yet, not that the image is small.
 * The scroll surface's inner box is `w-max`/`h-max`, so percentage maxes there resolve to `none`
 * and an unmeasured image would lay out — and raster — at full natural resolution before onLoad.
 * The surface itself is already measured by then, and in a split pane or side-by-side image diff
 * it is a fraction of the viewport, so cap against it; viewport lengths are only the fallback for
 * a surface we have not measured, which is not the same as an unbounded one.
 */
export function getImageElementSizing(
  layoutSize: ImageViewerImageDimensions | null,
  surfaceSize: ImageViewerSurfaceSize | null
): ImageElementSizing {
  if (layoutSize) {
    return { className: 'block h-full w-full', style: undefined }
  }

  const maxWidth = getImageAxisMaxLength(surfaceSize?.width)
  const maxHeight = getImageAxisMaxLength(surfaceSize?.height)
  const style: CSSProperties = {}
  if (maxWidth !== null) {
    style.maxWidth = `${maxWidth}px`
  }
  if (maxHeight !== null) {
    style.maxHeight = `${maxHeight}px`
  }

  return {
    className: [
      'block',
      maxHeight === null ? 'max-h-[100vh]' : null,
      maxWidth === null ? 'max-w-[100vw]' : null
    ]
      .filter(Boolean)
      .join(' '),
    style: maxWidth === null && maxHeight === null ? undefined : style
  }
}

export function applyAnchoredImageViewerZoomChange(
  surface: HTMLDivElement | null,
  setZoom: Dispatch<SetStateAction<number>>,
  getNextZoom: (currentZoom: number) => number,
  anchor?: ImageViewerZoomAnchor | null
): void {
  const resolvedAnchor = surface
    ? (anchor ?? { x: surface.clientWidth / 2, y: surface.clientHeight / 2 })
    : null
  const scrollLeft = surface?.scrollLeft ?? 0
  const scrollTop = surface?.scrollTop ?? 0
  let currentZoom = 1
  let nextZoom = 1

  flushSync(() => {
    setZoom((current) => {
      currentZoom = current
      nextZoom = clampImageViewerZoom(getNextZoom(current))
      return nextZoom
    })
  })

  if (!surface || !resolvedAnchor || currentZoom === nextZoom) {
    return
  }

  surface.scrollLeft = getAnchoredImageViewerScrollOffset({
    scrollOffset: scrollLeft,
    anchorOffset: resolvedAnchor.x,
    currentZoom,
    nextZoom
  })
  surface.scrollTop = getAnchoredImageViewerScrollOffset({
    scrollOffset: scrollTop,
    anchorOffset: resolvedAnchor.y,
    currentZoom,
    nextZoom
  })
}

export function applyImageSurfaceWheel(
  event: WheelEvent,
  applyZoomChange: ApplyImageViewerZoomChange
): void {
  if (!shouldHandleImageZoomWheel(event)) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  const surface = event.currentTarget instanceof HTMLDivElement ? event.currentTarget : null
  const rect = surface?.getBoundingClientRect()
  applyZoomChange(
    (currentZoom) => getNextWheelImageViewerZoom(currentZoom, event.deltaY, event.deltaMode),
    rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null
  )
}
