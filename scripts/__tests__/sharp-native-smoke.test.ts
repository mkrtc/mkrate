import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const ROOT = join(import.meta.dir, '../..')

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

  it('keeps native sharp outside both standalone WhatsApp worker bundle paths', () => {
    for (const relativePath of ['scripts/build-wa-worker.ts', 'scripts/electron-build-main.ts']) {
      const source = readFileSync(join(ROOT, relativePath), 'utf8')
      expect(source).toContain('"--external:sharp"')
    }
  })

  it('defines an exact target-aware staged packaging graph for Electron artifacts', () => {
    const stager = readFileSync(join(ROOT, 'scripts/stage-sharp-runtime.ts'), 'utf8')
    const builder = readFileSync(join(ROOT, 'apps/electron/electron-builder.yml'), 'utf8')

    expect(stager).toContain("const SHARP_VERSION = '0.35.0'")
    expect(stager).toContain("const LIBVIPS_PACKAGE_VERSION = '1.3.0'")
    expect(stager).toContain("const SHARP_SEMVER_VERSION = '7.8.5'")
    expect(stager).toContain('`@img/sharp-${runtime}`')
    expect(stager).toContain('`@img/sharp-libvips-${runtime}`')
    expect(stager).toContain("platform === 'win32' ? null")
    expect(stager).toContain('verifyNpmIntegrity')
    expect(stager).toContain('npm pack')
    expect(stager).toContain('dist.integrity')
    expect(stager).toContain('sharp-runtime-manifest.json')

    for (const requiredExtraResource of [
      'from: node_modules/sharp',
      'from: node_modules/@img',
      'from: node_modules/detect-libc',
      'from: node_modules/semver',
    ]) {
      expect(builder).toContain(requiredExtraResource)
    }
  })
})
