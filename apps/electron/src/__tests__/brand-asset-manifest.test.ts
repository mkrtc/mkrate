/**
 * Brand asset manifest integrity gate.
 *
 * Canonical file and relationship paths are relative to docs/brand. Repository
 * output paths are relative to the repository root. The manifest's own hash is
 * intentionally non-applicable because it cannot contain its own digest.
 */
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

interface BrandFile {
  file: string
  bytes: number | null
  sha256: string
  renderedFrom?: string
  sourceOf?: string[] | null
}

interface RepositoryOutput {
  path: string
  derivedFrom: string
  sha256: string
}

interface BrandManifest {
  files: BrandFile[]
  repositoryOutputs: RepositoryOutput[]
  deferred: {
    macos: string[]
    note: string
  }
}

const electronDir = resolve(import.meta.dir, '..', '..')
const repoRoot = resolve(electronDir, '..', '..')
const brandDir = resolve(repoRoot, 'docs', 'brand')
const manifestPath = resolve(brandDir, 'asset-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BrandManifest
const manifestEntry = manifest.files.find((entry) => entry.file === 'asset-manifest.json')
const canonicalPaths = new Set(manifest.files.map((entry) => entry.file))

function resolveWithin(base: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Expected relative path, received: ${path}`)

  const resolved = resolve(base, path)
  const relation = relative(base, resolved)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Path escapes its declared base: ${path}`)
  }
  return resolved
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('Mkrate brand asset manifest', () => {
  it('uses docs/brand-relative paths for canonical files', () => {
    expect(manifestEntry).toBeDefined()

    const rootDocuments = new Set(['README.md', 'asset-manifest.json', 'brand-guidelines.md'])
    for (const entry of manifest.files) {
      resolveWithin(brandDir, entry.file)
      if (rootDocuments.has(entry.file)) continue
      expect(entry.file.startsWith('assets/')).toBe(true)
    }
  })

  it('verifies every non-self canonical file byte count and SHA-256', () => {
    for (const entry of manifest.files) {
      if (entry === manifestEntry) continue

      const path = resolveWithin(brandDir, entry.file)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).isFile()).toBe(true)
      if (entry.bytes !== null) expect(statSync(path).size).toBe(entry.bytes)
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(sha256(path)).toBe(entry.sha256)
    }
  })

  it('documents the self-referential manifest hash as non-applicable', () => {
    expect(manifestEntry).toEqual(
      expect.objectContaining({
        bytes: null,
        sha256:
          'not-applicable-self-referential (hash file contents directly to verify; this field cannot include its own hash)',
      }),
    )
    expect(existsSync(manifestPath)).toBe(true)
  })

  it('resolves canonical source relationships against docs/brand', () => {
    const references: string[] = []
    for (const entry of manifest.files) {
      if (entry.renderedFrom) references.push(entry.renderedFrom)
      if (entry.sourceOf) references.push(...entry.sourceOf)
    }
    references.push(...manifest.repositoryOutputs.map((output) => output.derivedFrom))

    for (const reference of references) {
      expect(canonicalPaths.has(reference)).toBe(true)
      expect(existsSync(resolveWithin(brandDir, reference))).toBe(true)
    }
  })

  it('verifies repository outputs from the repository root', () => {
    for (const output of manifest.repositoryOutputs) {
      const path = resolveWithin(repoRoot, output.path)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).isFile()).toBe(true)
      expect(output.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(sha256(path)).toBe(output.sha256)
    }
  })

  it('keeps old Craft macOS assets absent and explicitly deferred, not shipped', () => {
    const expectedDeferred = [
      'apps/electron/resources/icon.icns',
      'apps/electron/resources/Assets.car',
      'apps/electron/resources/icon.icon/',
    ]
    expect(manifest.deferred.macos).toEqual(expectedDeferred)
    expect(manifest.deferred.note).toMatch(/old Craft assets.*NOT regenerated.*blocked/s)

    const shippedPaths = new Set(manifest.repositoryOutputs.map((output) => output.path))
    for (const path of expectedDeferred) {
      expect(existsSync(resolveWithin(repoRoot, path))).toBe(false)
      expect(shippedPaths.has(path)).toBe(false)
    }
  })
})
