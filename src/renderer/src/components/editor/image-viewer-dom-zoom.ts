import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import {
  type ImageViewerImageDimensions,
  type ImageViewerSurfaceSize,
  type ImageViewerZoomAnchor,
  clampImageViewerZoom,
  getAnchoredImageViewerScrollOffset,
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

/**
 * Sizing classes for the preview `<img>`.
 *
 * A null size means the natural size has not been measured yet, not that the image is small.
 * The scroll surface's inner box is `w-max`/`h-max`, so percentage maxes there resolve to `none`
 * and an unmeasured image would lay out — and raster — at full natural resolution before onLoad.
 * Viewport lengths are definite without measuring anything, so they cap that first layout.
 */
export function getImageElementSizeClassName(size: ImageViewerImageDimensions | null): string {
  return size ? 'block h-full w-full' : 'block max-h-[100vh] max-w-[100vw]'
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
