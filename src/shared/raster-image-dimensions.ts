export type RasterImageDimensions = { width: number; height: number }

// No scan cap: this is a forward seek over a caller-bounded buffer, so it costs O(1) memory and at
// most one pass. Capping it only made valid images with large ICC/MPF metadata unreadable.
const ICO_MAX_IMAGES = 1_024
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function hasBytes(bytes: Uint8Array, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= bytes.byteLength
}

function matchesBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return (
    hasBytes(bytes, offset, expected.length) &&
    expected.every((value, index) => bytes[offset + index] === value)
  )
}

function matchesAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (!hasBytes(bytes, offset, expected.length)) {
    return false
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) {
      return false
    }
  }
  return true
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset]! << 24) >>> 0) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  )
}

function readInt32Le(bytes: Uint8Array, offset: number): number {
  return readUint32Le(bytes, offset) | 0
}

function positiveDimensions(width: number, height: number): RasterImageDimensions | null {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null
}

function readPngDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (
    !matchesBytes(bytes, 0, PNG_SIGNATURE) ||
    !hasBytes(bytes, 8, 16) ||
    readUint32Be(bytes, 8) !== 13 ||
    !matchesAscii(bytes, 12, 'IHDR')
  ) {
    return null
  }
  return positiveDimensions(readUint32Be(bytes, 16), readUint32Be(bytes, 20))
}

function readGifDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (
    !hasBytes(bytes, 0, 10) ||
    (!matchesAscii(bytes, 0, 'GIF87a') && !matchesAscii(bytes, 0, 'GIF89a'))
  ) {
    return null
  }
  return positiveDimensions(readUint16Le(bytes, 6), readUint16Le(bytes, 8))
}

export function isJpegStartOfFrameMarker(marker: number): boolean {
  return JPEG_START_OF_FRAME_MARKERS.has(marker)
}

/**
 * Walks JPEG marker segments from SOI, passing each one's length-field offset and length to
 * `visit`. Returns the first result `visit` gives, or undefined when the scan runs out of
 * segments — which includes a truncated buffer, so undefined never means "the segment is absent".
 */
export function scanJpegSegments<T>(
  bytes: Uint8Array,
  visit: (marker: number, lengthOffset: number, segmentLength: number) => T | undefined
): T | undefined {
  if (!hasBytes(bytes, 0, 4) || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined
  }
  let offset = 2
  const scanEnd = bytes.byteLength
  while (offset < scanEnd) {
    while (offset < scanEnd && bytes[offset] === 0xff) {
      offset += 1
    }
    const marker = bytes[offset]
    offset += 1
    if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xda) {
      return undefined
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue
    }
    if (!hasBytes(bytes, offset, 2)) {
      return undefined
    }
    const segmentLength = readUint16Be(bytes, offset)
    if (segmentLength < 2 || offset + segmentLength > scanEnd) {
      return undefined
    }
    const visited = visit(marker, offset, segmentLength)
    if (visited !== undefined) {
      return visited
    }
    offset += segmentLength
  }
  return undefined
}

function readJpegDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  return (
    scanJpegSegments<RasterImageDimensions | null>(bytes, (marker, lengthOffset, segmentLength) =>
      isJpegStartOfFrameMarker(marker)
        ? segmentLength >= 7
          ? positiveDimensions(
              readUint16Be(bytes, lengthOffset + 5),
              readUint16Be(bytes, lengthOffset + 3)
            )
          : null
        : undefined
    ) ?? null
  )
}

function readWebpDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (
    !hasBytes(bytes, 0, 20) ||
    !matchesAscii(bytes, 0, 'RIFF') ||
    !matchesAscii(bytes, 8, 'WEBP')
  ) {
    return null
  }

  let offset = 12
  while (hasBytes(bytes, offset, 8)) {
    const chunkSize = readUint32Le(bytes, offset + 4)
    const dataOffset = offset + 8
    const dataEnd = dataOffset + chunkSize

    if (matchesAscii(bytes, offset, 'VP8X') && chunkSize >= 10 && hasBytes(bytes, dataOffset, 10)) {
      return positiveDimensions(
        readUint24Le(bytes, dataOffset + 4) + 1,
        readUint24Le(bytes, dataOffset + 7) + 1
      )
    }
    if (
      matchesAscii(bytes, offset, 'VP8L') &&
      chunkSize >= 5 &&
      hasBytes(bytes, dataOffset, 5) &&
      bytes[dataOffset] === 0x2f
    ) {
      const b0 = bytes[dataOffset + 1]!
      const b1 = bytes[dataOffset + 2]!
      const b2 = bytes[dataOffset + 3]!
      const b3 = bytes[dataOffset + 4]!
      return positiveDimensions(
        1 + (((b1 & 0x3f) << 8) | b0),
        1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      )
    }
    if (
      matchesAscii(bytes, offset, 'VP8 ') &&
      chunkSize >= 10 &&
      hasBytes(bytes, dataOffset, 10) &&
      bytes[dataOffset + 3] === 0x9d &&
      bytes[dataOffset + 4] === 0x01 &&
      bytes[dataOffset + 5] === 0x2a
    ) {
      return positiveDimensions(
        readUint16Le(bytes, dataOffset + 6) & 0x3fff,
        readUint16Le(bytes, dataOffset + 8) & 0x3fff
      )
    }
    if (dataEnd > bytes.byteLength) {
      return null
    }
    offset = dataEnd + (chunkSize % 2)
  }
  return null
}

function readDibDimensions(bytes: Uint8Array, offset: number): RasterImageDimensions | null {
  if (!hasBytes(bytes, offset, 12)) {
    return null
  }
  const headerSize = readUint32Le(bytes, offset)
  if (headerSize === 12) {
    return positiveDimensions(readUint16Le(bytes, offset + 4), readUint16Le(bytes, offset + 6))
  }
  if (headerSize < 40 || !hasBytes(bytes, offset, 12)) {
    return null
  }
  return positiveDimensions(
    Math.abs(readInt32Le(bytes, offset + 4)),
    Math.abs(readInt32Le(bytes, offset + 8))
  )
}

function readBmpDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  return matchesAscii(bytes, 0, 'BM') ? readDibDimensions(bytes, 14) : null
}

function isIcoHeader(bytes: Uint8Array): boolean {
  return hasBytes(bytes, 0, 6) && readUint16Le(bytes, 0) === 0 && readUint16Le(bytes, 2) === 1
}

/** Entry count, or 0 when this is not an ICO whose directory table is fully present. */
function readIcoImageCount(bytes: Uint8Array): number {
  if (!isIcoHeader(bytes)) {
    return 0
  }
  const imageCount = readUint16Le(bytes, 4)
  return imageCount > 0 && imageCount <= ICO_MAX_IMAGES && hasBytes(bytes, 6, imageCount * 16)
    ? imageCount
    : 0
}

function readIcoDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  const imageCount = readIcoImageCount(bytes)
  if (imageCount === 0) {
    return null
  }

  let maxWidth = 0
  let maxHeight = 0
  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16
    const encodedSize = readUint32Le(bytes, entryOffset + 8)
    const imageOffset = readUint32Le(bytes, entryOffset + 12)
    if (encodedSize <= 0 || !hasBytes(bytes, imageOffset, encodedSize)) {
      return null
    }
    const payload = bytes.subarray(imageOffset, imageOffset + encodedSize)
    const embedded = readPngDimensions(payload) ?? readDibDimensions(payload, 0)
    const width = embedded?.width ?? (bytes[entryOffset] === 0 ? 256 : bytes[entryOffset]!)
    const height =
      embedded?.height ?? (bytes[entryOffset + 1] === 0 ? 256 : bytes[entryOffset + 1]!)
    maxWidth = Math.max(maxWidth, width)
    maxHeight = Math.max(maxHeight, height)
  }
  return positiveDimensions(maxWidth, maxHeight)
}

/**
 * Size a browser renders an ICO at: Chromium 151 decodes the largest-area directory entry at the
 * size that entry states, ignoring both the payload's own header and the doubled AND-mask height a
 * BMP entry stores. Null when differently shaped entries tie on area, because Blink then orders
 * them by bit depth and leaves the choice unproven.
 */
function readIcoRenderedDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  const imageCount = readIcoImageCount(bytes)
  let rendered: RasterImageDimensions | null = null
  let tied = false
  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16
    // A 0 axis byte encodes 256, the largest size a directory entry can express.
    const size = {
      width: bytes[entryOffset] || 256,
      height: bytes[entryOffset + 1] || 256
    }
    const renderedArea = rendered ? rendered.width * rendered.height : 0
    const area = size.width * size.height
    if (!rendered || area > renderedArea) {
      rendered = size
      tied = false
    } else if (area === renderedArea && size.width !== rendered.width) {
      tied = true
    }
  }
  return tied ? null : rendered
}

/**
 * Size the decoder renders, before EXIF orientation. Differs from the stored read only for ICO,
 * whose stored read is a forgery-resistant over-estimate rather than any size a browser reports.
 */
export function readRenderedRasterImageDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  return isIcoHeader(bytes) ? readIcoRenderedDimensions(bytes) : readRasterImageDimensions(bytes)
}

/** Reads raster dimensions as stored, before EXIF orientation, without invoking a decoder. */
export function readRasterImageDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  return (
    readPngDimensions(bytes) ??
    readGifDimensions(bytes) ??
    readJpegDimensions(bytes) ??
    readWebpDimensions(bytes) ??
    readBmpDimensions(bytes) ??
    readIcoDimensions(bytes)
  )
}
