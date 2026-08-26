import { describe, expect, it } from 'vitest'
import { readRasterImageBase64Dimensions } from './raster-image-base64-preview'

function pngBase64(width: number, height: number): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

describe('readRasterImageBase64Dimensions', () => {
  it('reads the natural size straight from the encoded header', () => {
    expect(readRasterImageBase64Dimensions(pngBase64(640, 480), 'image/png')).toEqual({
      width: 640,
      height: 480
    })
  })

  // Why: callers size layout from this — an unreadable header must stay "unknown", never a size.
  it('returns null for a mime whose header this cannot parse', () => {
    expect(
      readRasterImageBase64Dimensions(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />').toString('base64'),
        'image/svg+xml'
      )
    ).toBeNull()
  })

  it('returns null for a truncated header', () => {
    expect(readRasterImageBase64Dimensions(pngBase64(640, 480).slice(0, 8), 'image/png')).toBeNull()
  })
})
