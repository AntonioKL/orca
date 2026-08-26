import { describe, expect, it } from 'vitest'
import { applyRasterImageAxisSwap, readRasterImageAxisSwap } from './raster-image-orientation'

/** A TIFF header whose IFD0 holds only an Orientation tag. */
function exifTiff(orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'ascii')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(1, 8)
  tiff.writeUInt16BE(0x0112, 10)
  tiff.writeUInt16BE(3, 12)
  tiff.writeUInt32BE(1, 14)
  tiff.writeUInt16BE(orientation, 18)
  return tiff
}

function jpeg({ orientation, frame = true }: { orientation?: number; frame?: boolean }): Buffer {
  const parts = [Buffer.from([0xff, 0xd8])]
  if (orientation !== undefined) {
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff(orientation)])
    const header = Buffer.alloc(4)
    header.writeUInt16BE(0xffe1)
    header.writeUInt16BE(payload.byteLength + 2, 2)
    parts.push(header, payload)
  }
  if (frame) {
    const sof = Buffer.alloc(11)
    sof.writeUInt16BE(0xffc0)
    sof.writeUInt16BE(8, 2)
    sof[4] = 8
    sof.writeUInt16BE(20, 5)
    sof.writeUInt16BE(40, 7)
    parts.push(sof)
  }
  return Buffer.concat(parts)
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.byteLength)
  header.write(type, 4, 'ascii')
  return Buffer.concat([header, data, Buffer.alloc(4)])
}

function png(chunks: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', Buffer.alloc(13)),
    ...chunks
  ])
}

function webpRiff(chunk?: Buffer): Buffer {
  const parts = [Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]
  return Buffer.concat(chunk ? [...parts, chunk] : parts)
}

function webpExtended(flags: number): Buffer {
  const chunk = Buffer.alloc(18)
  chunk.write('VP8X', 0, 'ascii')
  chunk.writeUInt32LE(10, 4)
  chunk[8] = flags
  return webpRiff(chunk)
}

/** A simple (non-extended) container, which has no room for metadata at all. */
function webpSimple(): Buffer {
  const chunk = Buffer.alloc(8)
  chunk.write('VP8 ', 0, 'ascii')
  return webpRiff(chunk)
}

describe('readRasterImageAxisSwap', () => {
  it('reports a quarter-turn JPEG orientation as swapped and a flip as unswapped', () => {
    expect(readRasterImageAxisSwap(jpeg({ orientation: 6 }))).toBe('swapped')
    expect(readRasterImageAxisSwap(jpeg({ orientation: 8 }))).toBe('swapped')
    expect(readRasterImageAxisSwap(jpeg({ orientation: 3 }))).toBe('unswapped')
  })

  // Why: Exif APP1 has to precede the frame header, so a scan that reached SOF proves there is none.
  it('treats a JPEG that reaches its frame header without EXIF as unswapped', () => {
    expect(readRasterImageAxisSwap(jpeg({}))).toBe('unswapped')
  })

  // Why: the orientation may sit in the bytes we never saw — absent from the prefix is not absent.
  it('stays unknown for a JPEG truncated before its frame header', () => {
    expect(readRasterImageAxisSwap(jpeg({ frame: false }))).toBe('unknown')
  })

  it('reads a PNG eXIf chunk that precedes the image data', () => {
    expect(
      readRasterImageAxisSwap(
        png([pngChunk('eXIf', exifTiff(6)), pngChunk('IDAT', Buffer.alloc(1))])
      )
    ).toBe('swapped')
  })

  // Why: verified against Chromium — it only applies an eXIf chunk seen ahead of the image data.
  it('ignores a PNG eXIf chunk that trails the image data', () => {
    expect(
      readRasterImageAxisSwap(
        png([pngChunk('IDAT', Buffer.alloc(1)), pngChunk('eXIf', exifTiff(6))])
      )
    ).toBe('unswapped')
  })

  it('stays unknown for a PNG whose chunks run out before the image data', () => {
    expect(readRasterImageAxisSwap(png([]))).toBe('unknown')
  })

  // Why: a WebP EXIF chunk trails the image data, so the VP8X flag is the only thing the header
  // gives us and it says nothing about the orientation itself.
  it('stays unknown for a WebP that declares EXIF metadata', () => {
    expect(readRasterImageAxisSwap(webpExtended(0x08))).toBe('unknown')
    expect(readRasterImageAxisSwap(webpExtended(0x10))).toBe('unswapped')
    expect(readRasterImageAxisSwap(webpSimple())).toBe('unswapped')
  })

  // Why: a prefix that stops before the first chunk never showed us the container type, and an
  // extended container is exactly what carries EXIF — so "not VP8X" is a claim we cannot make.
  it('stays unknown for a WebP truncated before its first chunk', () => {
    expect(readRasterImageAxisSwap(webpRiff())).toBe('unknown')
  })

  it('reports formats with no orientation record as unswapped', () => {
    expect(readRasterImageAxisSwap(Buffer.from('GIF89a\0\0\0\0', 'latin1'))).toBe('unswapped')
  })
})

describe('applyRasterImageAxisSwap', () => {
  it('returns null rather than a guess when the orientation is unknown', () => {
    expect(applyRasterImageAxisSwap({ width: 40, height: 20 }, 'unknown')).toBeNull()
    expect(applyRasterImageAxisSwap({ width: 40, height: 20 }, 'swapped')).toEqual({
      width: 20,
      height: 40
    })
    expect(applyRasterImageAxisSwap({ width: 40, height: 20 }, 'unswapped')).toEqual({
      width: 40,
      height: 20
    })
  })
})
