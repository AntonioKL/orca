import {
  isJpegStartOfFrameMarker,
  scanJpegSegments,
  type RasterImageDimensions
} from './raster-image-dimensions'

/**
 * Whether the rendered image swaps the encoded axes.
 *
 * `unknown` means the header never said — a metadata block we could not reach or parse. It is not
 * the same as `unswapped`, because guessing "no rotation" transposes every portrait phone photo.
 */
export type RasterImageAxisSwap = 'swapped' | 'unswapped' | 'unknown'

const EXIF_ORIENTATION_TAG = 0x0112
const EXIF_SHORT_TYPE = 3
const EXIF_IDENTIFIER = 'Exif\0\0'
const EXIF_APP1_MARKER = 0xe1
const TIFF_MAGIC = 42
// Orientations 5-8 rotate a quarter turn, so the rendered axes are the encoded ones swapped.
const AXIS_SWAPPING_ORIENTATIONS = new Set([5, 6, 7, 8])
const PNG_EXIF_CHUNK = 'eXIf'
const PNG_IMAGE_DATA_CHUNK = 'IDAT'
const WEBP_EXIF_FLAG = 0x08

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) {
    return ''
  }
  let text = ''
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index]!)
  }
  return text
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Reads IFD0's Orientation tag from a TIFF header spanning [start, end). */
function readTiffAxisSwap(bytes: Uint8Array, start: number, end: number): RasterImageAxisSwap {
  const byteOrder = asciiAt(bytes, start, 2)
  const littleEndian = byteOrder === 'II'
  if ((!littleEndian && byteOrder !== 'MM') || start + 8 > end) {
    return 'unknown'
  }
  const view = viewOf(bytes)
  const readUint16 = (offset: number): number => view.getUint16(offset, littleEndian)
  const readUint32 = (offset: number): number => view.getUint32(offset, littleEndian)
  if (readUint16(start + 2) !== TIFF_MAGIC) {
    return 'unknown'
  }
  const directory = start + readUint32(start + 4)
  if (directory < start || directory + 2 > end) {
    return 'unknown'
  }
  const entryCount = readUint16(directory)
  if (directory + 2 + entryCount * 12 > end) {
    return 'unknown'
  }
  for (let index = 0; index < entryCount; index += 1) {
    const entry = directory + 2 + index * 12
    if (readUint16(entry) !== EXIF_ORIENTATION_TAG) {
      continue
    }
    if (readUint16(entry + 2) !== EXIF_SHORT_TYPE || readUint32(entry + 4) !== 1) {
      return 'unknown'
    }
    return AXIS_SWAPPING_ORIENTATIONS.has(readUint16(entry + 8)) ? 'swapped' : 'unswapped'
  }
  // EXIF that carries no Orientation tag means orientation 1, which the spec defines as unrotated.
  return 'unswapped'
}

function readJpegAxisSwap(bytes: Uint8Array): RasterImageAxisSwap {
  // Exif APP1 precedes the frame header, so reaching SOF without one proves there is none.
  return (
    scanJpegSegments<RasterImageAxisSwap>(bytes, (marker, lengthOffset, segmentLength) => {
      if (isJpegStartOfFrameMarker(marker)) {
        return 'unswapped'
      }
      if (
        marker !== EXIF_APP1_MARKER ||
        asciiAt(bytes, lengthOffset + 2, EXIF_IDENTIFIER.length) !== EXIF_IDENTIFIER
      ) {
        return undefined
      }
      return readTiffAxisSwap(
        bytes,
        lengthOffset + 2 + EXIF_IDENTIFIER.length,
        lengthOffset + segmentLength
      )
    }) ?? 'unknown'
  )
}

function readPngAxisSwap(bytes: Uint8Array): RasterImageAxisSwap {
  const view = viewOf(bytes)
  let offset = 8
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset)
    const chunkType = asciiAt(bytes, offset + 4, 4)
    const data = offset + 8
    if (chunkType === PNG_EXIF_CHUNK) {
      return data + chunkLength <= bytes.byteLength
        ? readTiffAxisSwap(bytes, data, data + chunkLength)
        : 'unknown'
    }
    // Chromium only applies an eXIf chunk it saw ahead of the image data; a trailing one is inert.
    if (chunkType === PNG_IMAGE_DATA_CHUNK) {
      return 'unswapped'
    }
    offset = data + chunkLength + 4
  }
  return 'unknown'
}

function readWebpAxisSwap(bytes: Uint8Array): RasterImageAxisSwap {
  // Only an extended container carries metadata, and its EXIF chunk trails the image data rather
  // than the header we decode — so the flag is all we get, and it only tells us we cannot know.
  const chunkType = asciiAt(bytes, 12, 4)
  // A prefix that stopped before the first chunk never showed us whether this is the extended
  // container that can carry EXIF at all.
  if (chunkType === '') {
    return 'unknown'
  }
  if (chunkType !== 'VP8X') {
    return 'unswapped'
  }
  const flags = bytes[20]
  if (flags === undefined) {
    return 'unknown'
  }
  return (flags & WEBP_EXIF_FLAG) === 0 ? 'unswapped' : 'unknown'
}

/** Whether a browser will render the encoded axes swapped, read without decoding the image. */
export function readRasterImageAxisSwap(bytes: Uint8Array): RasterImageAxisSwap {
  if (bytes[0] === 137 && asciiAt(bytes, 1, 3) === 'PNG') {
    return readPngAxisSwap(bytes)
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return readJpegAxisSwap(bytes)
  }
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') {
    return readWebpAxisSwap(bytes)
  }
  // GIF, BMP and ICO have no orientation record, so their encoded axes are the rendered ones.
  return 'unswapped'
}

/** Encoded size as the browser will report it, or null when the orientation stayed unknown. */
export function applyRasterImageAxisSwap(
  dimensions: RasterImageDimensions,
  swap: RasterImageAxisSwap
): RasterImageDimensions | null {
  if (swap === 'unknown') {
    return null
  }
  return swap === 'swapped' ? { width: dimensions.height, height: dimensions.width } : dimensions
}
