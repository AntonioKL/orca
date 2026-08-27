import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claudeImageContent, claudeImageMediaType } from './claude-structured-image-content'

describe('Claude image content', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-image-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('inlines a local attachment as a base64 source Claude accepts', async () => {
    const path = join(dir, 'shot.PNG')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await writeFile(path, bytes)

    expect(await claudeImageContent({ type: 'image-ref', path })).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') }
    })
  })

  it('passes a remote reference through as a url source', async () => {
    expect(
      await claudeImageContent({ type: 'image-ref', url: 'https://example.test/a.png' })
    ).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.test/a.png' }
    })
  })

  it('refuses a format Anthropic vision does not accept before anything is sent', async () => {
    const path = join(dir, 'diagram.svg')
    await writeFile(path, '<svg/>')

    await expect(claudeImageContent({ type: 'image-ref', path })).rejects.toThrow(
      'Claude does not accept .svg images; use JPEG, PNG, GIF, or WebP'
    )
  })

  it('reports the read failure rather than sending an empty image', async () => {
    await expect(
      claudeImageContent({ type: 'image-ref', path: join(dir, 'missing.png') })
    ).rejects.toThrow('Claude could not read the attached image')
  })

  it('resolves media types case-insensitively and rejects unknown extensions', () => {
    expect(claudeImageMediaType('/a/b.JPEG')).toBe('image/jpeg')
    expect(claudeImageMediaType('/a/b.webp')).toBe('image/webp')
    expect(claudeImageMediaType('/a/b.tiff')).toBeNull()
  })
})
