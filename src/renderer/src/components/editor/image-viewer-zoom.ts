export const MIN_IMAGE_VIEWER_ZOOM = 0.25
export const MAX_IMAGE_VIEWER_ZOOM = 8
export const IMAGE_VIEWER_ZOOM_STEP = 1.25
export const IMAGE_VIEWER_SURFACE_PADDING = 16

const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const PIXELS_PER_LINE = 16
const PIXELS_PER_PAGE = 800
const MAX_NORMALIZED_WHEEL_DELTA = 200
const WHEEL_ZOOM_SENSITIVITY = 300

type ImageZoomWheelEventLike = {
  ctrlKey: boolean
}

export type ImageViewerImageDimensions = {
  width: number
  height: number
}

export type ImageViewerSurfaceSize = {
  width: number
  height: number
}

export type ImageViewerZoomAnchor = {
  x: number
  y: number
}

export function clampImageViewerZoom(next: number): number {
  return Math.min(MAX_IMAGE_VIEWER_ZOOM, Math.max(MIN_IMAGE_VIEWER_ZOOM, next))
}

export function shouldHandleImageZoomWheel(event: ImageZoomWheelEventLike): boolean {
  return event.ctrlKey
}

export function getPinchZoomFactor(deltaY: number, deltaMode: number): number {
  if (deltaY === 0) {
    return 1
  }

  const normalizedDeltaY =
    deltaMode === DOM_DELTA_LINE
      ? deltaY * PIXELS_PER_LINE
      : deltaMode === DOM_DELTA_PAGE
        ? deltaY * PIXELS_PER_PAGE
        : deltaY
  const boundedDeltaY = Math.max(
    -MAX_NORMALIZED_WHEEL_DELTA,
    Math.min(MAX_NORMALIZED_WHEEL_DELTA, normalizedDeltaY)
  )

  return Math.exp(-boundedDeltaY / WHEEL_ZOOM_SENSITIVITY)
}

export function getNextWheelImageViewerZoom(
  currentZoom: number,
  deltaY: number,
  deltaMode: number
): number {
  return clampImageViewerZoom(currentZoom * getPinchZoomFactor(deltaY, deltaMode))
}

/** Content length one axis offers, or null when that axis is unmeasured or eaten by padding. */
export function getAvailableImageSurfaceLength(
  surfaceLength: number | undefined,
  padding: number = IMAGE_VIEWER_SURFACE_PADDING
): number | null {
  if (surfaceLength === undefined || !Number.isFinite(surfaceLength)) {
    return null
  }

  const available = surfaceLength - padding * 2

  return available > 0 ? available : null
}

/** Content box the image may occupy; null unless both axes are usable, since fitting needs both. */
export function getAvailableImageSurfaceBox(
  surfaceSize: ImageViewerSurfaceSize | null,
  padding: number = IMAGE_VIEWER_SURFACE_PADDING
): ImageViewerSurfaceSize | null {
  const width = getAvailableImageSurfaceLength(surfaceSize?.width, padding)
  const height = getAvailableImageSurfaceLength(surfaceSize?.height, padding)

  return width !== null && height !== null ? { width, height } : null
}

export function getZoomedImageLayoutSize({
  imageDimensions,
  surfaceSize,
  zoom,
  padding = IMAGE_VIEWER_SURFACE_PADDING
}: {
  imageDimensions: ImageViewerImageDimensions | null
  surfaceSize: ImageViewerSurfaceSize | null
  zoom: number
  padding?: number
}): ImageViewerImageDimensions | null {
  const available = getAvailableImageSurfaceBox(surfaceSize, padding)
  if (!imageDimensions || !available || imageDimensions.width <= 0 || imageDimensions.height <= 0) {
    return null
  }

  const fitScale = Math.min(
    1,
    available.width / imageDimensions.width,
    available.height / imageDimensions.height
  )
  const boundedZoom = clampImageViewerZoom(zoom)

  // Why: transformed images do not change scroll extents, so zoom must resize
  // the layout box for popup panning to reach the full image.
  return {
    width: imageDimensions.width * fitScale * boundedZoom,
    height: imageDimensions.height * fitScale * boundedZoom
  }
}

export function getAnchoredImageViewerScrollOffset({
  scrollOffset,
  anchorOffset,
  currentZoom,
  nextZoom
}: {
  scrollOffset: number
  anchorOffset: number
  currentZoom: number
  nextZoom: number
}): number {
  if (currentZoom <= 0) {
    return scrollOffset
  }

  return (scrollOffset + anchorOffset) * (nextZoom / currentZoom) - anchorOffset
}
