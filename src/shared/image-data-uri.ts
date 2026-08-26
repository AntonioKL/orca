import type { RasterImageDimensions } from './raster-image-dimensions'
import { readRasterImageBase64Header } from './raster-image-base64-preview'
import {
  isKnownRasterImageMimeType,
  isRasterImagePreviewDimensions
} from './raster-image-preview-limits'

export type RasterImagePreview = {
  dataUri: string | null
  /** Size a browser reports as naturalWidth/naturalHeight; null means unreadable, never a guess. */
  dimensions: RasterImageDimensions | null
}

// Builds an inline `data:` URI for base64 image bytes, shared by the desktop
// editor ImageViewer and the mobile file preview so both decode images the same
// way. Strips whitespace from the payload (base64 from git diffs and SSH streams
// can arrive line-wrapped) and returns null when there is nothing an <img>/RN
// <Image> can show — empty content or a non-image mime (PDF, octet-stream, …).
// Returns the header dimensions from the same decode pass so callers that size
// layout before the image loads do not pay for a second one.
export function buildRasterImagePreview(
  mimeType: string | undefined,
  base64Content: string
): RasterImagePreview {
  // Only image/* renders in an <img>/RN <Image>; reject every other mime
  // (application/pdf, application/octet-stream, …), not just PDF.
  if (!mimeType?.startsWith('image/')) {
    return { dataUri: null, dimensions: null }
  }
  const cleaned = base64Content.replace(/\s/g, '')
  if (!cleaned) {
    return { dataUri: null, dimensions: null }
  }
  // Only suppress when the header says the image is too large to render safely. An unreadable
  // header is not evidence of an oversized image, and the decoder handles formats we cannot parse.
  const header = readRasterImageBase64Header(cleaned, mimeType)
  // Limits gate on the stored size (a pixel budget neither axis order changes); layout needs the
  // oriented one, which can stay unknown on an image whose stored size we read fine.
  if (header.encoded !== null && !isRasterImagePreviewDimensions(header.encoded)) {
    return { dataUri: null, dimensions: null }
  }
  return { dataUri: `data:${mimeType};base64,${cleaned}`, dimensions: header.natural }
}

export function buildImageDataUri(
  mimeType: string | undefined,
  base64Content: string
): string | null {
  return buildRasterImagePreview(mimeType, base64Content).dataUri
}

/** Preserves non-raster data URIs and rejects unsafe known-raster data URIs. */
export function validateRasterImageDataUri(dataUri: string): string | null {
  const match = /^data:([^;,]+)((?:;[^,]*)*),([\s\S]*)$/i.exec(dataUri)
  if (!match || !isKnownRasterImageMimeType(match[1])) {
    return dataUri
  }
  const parameters = match[2].split(';').filter(Boolean)
  if (!parameters.some((parameter) => parameter.toLowerCase() === 'base64')) {
    return null
  }
  return buildImageDataUri(match[1], match[3])
}
