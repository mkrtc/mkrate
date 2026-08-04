import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..')
const releaseVersion = '0.0.3'

function readJson(path: string) {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'))
}

function readText(path: string) {
  return readFileSync(join(repoRoot, path), 'utf8')
}

describe('Mkrate v0.0.3 release version contract', () => {
  it('sets only selected product and Bridge client-version locations to v0.0.3', () => {
    const rootPackage = readJson('package.json')
    const electronPackage = readJson('apps/electron/package.json')
    const serverCorePackage = readJson('packages/server-core/package.json')

    expect(rootPackage.version).toBe(releaseVersion)
    expect(rootPackage.packageManager).toBe('bun@1.3.10')
    expect(readText('scripts/build/common.ts')).toContain("export const BUN_VERSION = 'bun-v1.3.10'")
    expect(electronPackage.version).toBe(releaseVersion)

    expect(readText('packages/server-core/src/bridge/desktop-bridge-runtime.ts')).toContain(
      "this.#clientVersion = options.clientVersion ?? '0.0.3'",
    )
    expect(readText('packages/server-core/src/bridge/bridge-connector-service.ts')).toContain(
      "this.#clientVersion = options.clientVersion ?? '0.0.3';",
    )

    expect(serverCorePackage.version).toBe('0.11.23')
    expect(readJson('packages/core/package.json').version).toBe('0.11.23')
    expect(readJson('packages/shared/package.json').version).toBe('0.11.23')
    expect(readJson('packages/server/package.json').version).toBe('0.11.23')
    expect(readJson('packages/session-tools-core/package.json').version).toBe('0.11.23')
    expect(readJson('packages/ui/package.json').version).toBe('0.11.23')
    expect(readJson('apps/viewer/package.json').version).toBe('0.11.12')
    expect(readJson('apps/webui/package.json').version).toBe('0.11.12')
  })

  it('pins sharp and platform packages to the audited security versions without changing trustedDependencies', () => {
    const rootPackage = readJson('package.json')
    const electronPackage = readJson('apps/electron/package.json')
    const serverCorePackage = readJson('packages/server-core/package.json')

    expect(electronPackage.dependencies.sharp).toBe('0.35.0')
    expect(serverCorePackage.dependencies.sharp).toBe('0.35.0')

    for (const packageName of [
      '@img/sharp-darwin-arm64',
      '@img/sharp-darwin-x64',
      '@img/sharp-linux-arm64',
      '@img/sharp-linux-x64',
    ]) {
      expect(rootPackage.optionalDependencies[packageName]).toBe('0.35.0')
    }

    for (const packageName of [
      '@img/sharp-libvips-darwin-arm64',
      '@img/sharp-libvips-darwin-x64',
      '@img/sharp-libvips-linux-arm64',
      '@img/sharp-libvips-linux-x64',
    ]) {
      expect(rootPackage.optionalDependencies[packageName]).toBe('1.3.0')
    }

    expect(rootPackage.overrides).toEqual({
      sharp: '0.35.0',
      '@img/sharp-darwin-arm64': '0.35.0',
      '@img/sharp-darwin-x64': '0.35.0',
      '@img/sharp-linux-arm64': '0.35.0',
      '@img/sharp-linux-x64': '0.35.0',
      '@img/sharp-libvips-darwin-arm64': '1.3.0',
      '@img/sharp-libvips-darwin-x64': '1.3.0',
      '@img/sharp-libvips-linux-arm64': '1.3.0',
      '@img/sharp-libvips-linux-x64': '1.3.0',
    })

    expect(rootPackage.trustedDependencies).toEqual([
      '@sentry/cli',
      '@vscode/ripgrep',
      'electron',
      'electron-winstaller',
      'esbuild',
      'koffi',
      'protobufjs',
      'sharp',
    ])
  })

  it('has accurate initial release notes for the unsigned v0.0.1 binary set', () => {
    const notes = readText('apps/electron/resources/release-notes/0.0.1.md')

    expect(notes).toContain('# v0.0.1')
    expect(notes).toContain('Apache-2.0')
    expect(notes).toContain('Kimi K3')
    expect(notes).toContain('Trusted Bridge v1')
    expect(notes).toContain('Linux x64 AppImage')
    expect(notes).toContain('macOS arm64/x64 DMG and ZIP')
    expect(notes).toContain('Windows x64 installer')
    expect(notes).toContain('@craft-agent/*')
    expect(notes).toContain('CRAFT_*')
    expect(notes).toContain('~/.craft-agent')
    expect(notes).toContain('craftagents://')
    expect(notes).toContain('Craft Agents Backend')
    expect(notes).toContain('unsigned')
    expect(notes).toContain('unnotarized')
  })

  it('locks the runtime sharp graph to sharp 0.35.0 and libvips 1.3.0 with no old sharp residue', () => {
    const lock = readText('bun.lock')

    expect(lock).toContain('"apps/electron": {')
    expect(lock).toContain('"packages/server-core": {')
    expect(lock).toContain('"overrides": {')
    expect(lock).toContain('"sharp": "0.35.0"')
    expect(lock).toContain('"sharp": ["sharp@0.35.0"')
    expect(lock).toContain('@img/sharp-linux-x64@0.35.0')
    expect(lock).toContain('@img/sharp-linux-arm64@0.35.0')
    expect(lock).toContain('@img/sharp-darwin-x64@0.35.0')
    expect(lock).toContain('@img/sharp-darwin-arm64@0.35.0')
    expect(lock).toContain('@img/sharp-libvips-linux-x64@1.3.0')
    expect(lock).toContain('@img/sharp-libvips-linux-arm64@1.3.0')
    expect(lock).toContain('@img/sharp-libvips-darwin-x64@1.3.0')
    expect(lock).toContain('@img/sharp-libvips-darwin-arm64@1.3.0')
    expect(lock).not.toContain('sharp@0.34.5')
    expect(lock).not.toContain('@img/sharp-libvips-darwin-arm64@1.2.4')
    expect(lock).not.toContain('@img/sharp-libvips-darwin-x64@1.2.4')
    expect(lock).not.toContain('@img/sharp-libvips-linux-arm64@1.2.4')
    expect(lock).not.toContain('@img/sharp-libvips-linux-x64@1.2.4')
  })
})
