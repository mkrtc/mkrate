import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'

describe('native sharp runtime smoke', () => {
  it('loads sharp 0.35.0, reads metadata, and performs a real resize', async () => {
    expect(sharp.versions.sharp).toBe('0.35.0')
    expect(sharp.versions.vips).toBeTruthy()

    const input = await sharp({
      create: {
        width: 16,
        height: 12,
        channels: 4,
        background: { r: 12, g: 34, b: 56, alpha: 1 },
      },
    })
      .png()
      .toBuffer()

    const inputMetadata = await sharp(input).metadata()
    expect(inputMetadata.format).toBe('png')
    expect(inputMetadata.width).toBe(16)
    expect(inputMetadata.height).toBe(12)

    const resized = await sharp(input)
      .resize({ width: 4, height: 3, fit: 'fill' })
      .png()
      .toBuffer()

    const resizedMetadata = await sharp(resized).metadata()
    expect(resizedMetadata.format).toBe('png')
    expect(resizedMetadata.width).toBe(4)
    expect(resizedMetadata.height).toBe(3)
  })
})
