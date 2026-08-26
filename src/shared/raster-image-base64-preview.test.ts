import { describe, expect, it } from 'vitest'
import { readRasterImageBase64Header } from './raster-image-base64-preview'

function pngBase64(width: number, height: number): string {
  const bytes = Buffer.alloc(41)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes.write('IDAT', 37, 'ascii')
  return bytes.toString('base64')
}

/** APP1 carrying an EXIF IFD0 with only an Orientation tag. */
function exifApp1(orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'ascii')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(1, 8)
  tiff.writeUInt16BE(0x0112, 10)
  tiff.writeUInt16BE(3, 12)
  tiff.writeUInt32BE(1, 14)
  tiff.writeUInt16BE(orientation, 18)
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const header = Buffer.alloc(4)
  header.writeUInt16BE(0xffe1)
  header.writeUInt16BE(payload.byteLength + 2, 2)
  return Buffer.concat([header, payload])
}

function jpegBase64(width: number, height: number, orientation?: number): string {
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0)
  sof.writeUInt16BE(8, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    orientation === undefined ? Buffer.alloc(0) : exifApp1(orientation),
    sof
  ]).toString('base64')
}

/** A BMP-encoded ICO entry: its DIB header stores the XOR bitmap plus the AND mask, so biHeight is
 * twice the icon's height. */
function icoBmpEntry(width: number, height: number): Buffer {
  const dib = Buffer.alloc(40)
  dib.writeUInt32LE(40, 0)
  dib.writeInt32LE(width, 4)
  dib.writeInt32LE(height * 2, 8)
  dib.writeUInt16LE(1, 12)
  dib.writeUInt16LE(32, 14)
  const xor = Buffer.alloc(width * height * 4)
  const mask = Buffer.alloc(Math.ceil(width / 32) * 4 * height)
  return Buffer.concat([dib, xor, mask])
}

function icoBase64(sizes: readonly (readonly [number, number])[]): string {
  const payloads = sizes.map(([width, height]) => icoBmpEntry(width, height))
  const directory = Buffer.alloc(6 + sizes.length * 16)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(sizes.length, 4)
  let payloadOffset = directory.byteLength
  sizes.forEach(([width, height], index) => {
    const entry = 6 + index * 16
    // A 0 axis byte encodes 256, the largest size a directory entry can express.
    directory[entry] = width % 256
    directory[entry + 1] = height % 256
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(payloads[index]!.byteLength, entry + 8)
    directory.writeUInt32LE(payloadOffset, entry + 12)
    payloadOffset += payloads[index]!.byteLength
  })
  return Buffer.concat([directory, ...payloads]).toString('base64')
}

describe('readRasterImageBase64Header', () => {
  // Why: Chromium reports naturalWidth/naturalHeight with EXIF orientation applied, so a portrait
  // phone photo (stored landscape, Orientation=6) must measure portrait here too.
  it('transposes the axes for an EXIF orientation that rotates the image', () => {
    expect(readRasterImageBase64Header(jpegBase64(4032, 3024, 6), 'image/jpeg')).toEqual({
      encoded: { width: 4032, height: 3024 },
      natural: { width: 3024, height: 4032 }
    })
  })

  it('keeps the encoded axes for a JPEG with no EXIF block', () => {
    expect(readRasterImageBase64Header(jpegBase64(4032, 3024), 'image/jpeg')).toEqual({
      encoded: { width: 4032, height: 3024 },
      natural: { width: 4032, height: 3024 }
    })
  })

  it('reads the natural size straight from the encoded header', () => {
    expect(readRasterImageBase64Header(pngBase64(640, 480), 'image/png')).toEqual({
      encoded: { width: 640, height: 480 },
      natural: { width: 640, height: 480 }
    })
  })

  // Why: callers size layout from this — an unreadable header must stay "unknown", never a size.
  it('reports both sizes unknown for a mime whose header this cannot parse', () => {
    expect(
      readRasterImageBase64Header(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />').toString('base64'),
        'image/svg+xml'
      )
    ).toEqual({ encoded: null, natural: null })
  })

  it('reports both sizes unknown for a truncated header', () => {
    expect(readRasterImageBase64Header(pngBase64(640, 480).slice(0, 8), 'image/png')).toEqual({
      encoded: null,
      natural: null
    })
  })

  // Why: Chromium 151 reports naturalWidth/naturalHeight of 32x32, 48x48 and 256x256 for these
  // exact bytes. The stored read is a deliberate over-estimate — a BMP ICO entry's doubled
  // AND-mask height, maximised per axis across entries — so it may never size layout.
  it('measures an ICO from the entry the decoder renders, not the stored budget', () => {
    expect(readRasterImageBase64Header(icoBase64([[32, 32]]), 'image/x-icon')).toEqual({
      encoded: { width: 32, height: 64 },
      natural: { width: 32, height: 32 }
    })
    expect(
      readRasterImageBase64Header(
        icoBase64([
          [16, 16],
          [48, 48]
        ]),
        'image/x-icon'
      )
    ).toEqual({
      encoded: { width: 48, height: 96 },
      natural: { width: 48, height: 48 }
    })
    expect(
      readRasterImageBase64Header(icoBase64([[256, 256]]), 'image/vnd.microsoft.icon')
    ).toEqual({
      encoded: { width: 256, height: 512 },
      natural: { width: 256, height: 256 }
    })
  })

  // Why: Blink breaks an equal-area tie on bit depth, which leaves two differently shaped entries
  // unordered — so the rendered size is unproven and must not be guessed from either one.
  it('reports an ICO natural size unknown when differently shaped entries tie on area', () => {
    expect(
      readRasterImageBase64Header(
        icoBase64([
          [16, 48],
          [48, 16]
        ]),
        'image/x-icon'
      )
    ).toEqual({ encoded: { width: 48, height: 96 }, natural: null })
  })
})
