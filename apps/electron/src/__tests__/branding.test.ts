/**
 * Static branding / rebrand validation.
 *
 * Guards the Mkrate external rebrand (Phase 1): product name, application ID,
 * updater repository, artifact names, release titles, install URLs and the
 * intentionally-preserved internal compatibility identifiers (`@craft-agent/*`
 * scopes, `CRAFT_*` env vars, `~/.craft-agent` config dir, `craftagents://`
 * deep-link scheme). If a future change re-introduces Craft product branding or
 * drops a preserved identifier, these assertions fail.
 *
 * Text-based on purpose: runs without installing workspace dependencies.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const electronDir = join(import.meta.dir, '..', '..')
const repoRoot = join(electronDir, '..', '..')
const read = (...p: string[]) => readFileSync(join(...p), 'utf8')

const builder = read(electronDir, 'electron-builder.yml')
const pkg = JSON.parse(read(electronDir, 'package.json'))

describe('Mkrate product identity (electron-builder.yml)', () => {
  it('uses the Mkrate product name', () => {
    expect(builder).toContain('productName: Mkrate')
    expect(builder).not.toContain('productName: Craft')
  })

  it('uses the new Mkrate reverse-domain application ID and drops the Craft bundle ID', () => {
    expect(builder).toContain('appId: ru.mkrate.desktop')
    expect(builder).not.toContain('com.lukilabs.craft-agent')
  })

  it('publishes updates to the mkrtc/mkrate repository', () => {
    expect(builder).toMatch(/owner:\s*mkrtc/)
    expect(builder).toMatch(/repo:\s*mkrate\b/)
    expect(builder).not.toMatch(/repo:\s*craft-agents-oss/)
  })

  it('names all platform artifacts Mkrate-* and none Craft-Agents-*', () => {
    // mac, dmg, win, linux → at least 4 Mkrate artifact names.
    const mkrateArtifacts = builder.match(/artifactName:\s*"Mkrate-\$\{arch\}/g) ?? []
    expect(mkrateArtifacts.length).toBeGreaterThanOrEqual(4)
    expect(builder).toContain('title: "Mkrate"')
    expect(builder).not.toContain('Craft-Agents-')
  })

  it('keeps Craft Docs Ltd. attribution in the copyright while rebranding to Mkrate', () => {
    expect(builder).toMatch(/copyright:.*Mkrate/)
    expect(builder).toMatch(/copyright:.*Craft Docs Ltd\./)
  })

  it('rebrands the macOS local-network usage description to Mkrate', () => {
    expect(builder).toMatch(/NSLocalNetworkUsageDescription:\s*"Mkrate uses/)
  })
})

describe('Mkrate product identity (apps/electron/package.json)', () => {
  it('sets productName to Mkrate so app.getName() (window title, menus) is Mkrate', () => {
    expect(pkg.productName).toBe('Mkrate')
  })

  it('preserves the internal @craft-agent/* package scope for compatibility', () => {
    expect(pkg.name).toBe('@craft-agent/electron')
  })

  it('uses Mkrate product-facing author and homepage', () => {
    expect(pkg.author.name).toBe('Mkrate')
    expect(pkg.homepage).toBe('https://mkrate.ru')
  })

  it('still depends on @craft-agent/* workspace packages', () => {
    const deps = Object.keys(pkg.dependencies ?? {})
    expect(deps.some((d) => d.startsWith('@craft-agent/'))).toBe(true)
  })
})

describe('afterPack references the Mkrate .app bundle name', () => {
  it('matches the new productName', () => {
    const afterPack = read(electronDir, 'scripts', 'afterPack.cjs')
    expect(afterPack).toContain('Mkrate.app')
    expect(afterPack).not.toContain('Craft Agents.app')
  })
})

describe('release workflow rebrand (security checks preserved)', () => {
  const workflow = read(repoRoot, '.github', 'workflows', 'electron-release.yml')

  it('uses Mkrate release titles and artifact names, not Craft', () => {
    expect(workflow).toContain('Mkrate $RELEASE_TAG')
    expect(workflow).toContain('Mkrate-x64.exe')
    expect(workflow).toContain('Mkrate-arm64.dmg')
    expect(workflow).not.toContain('Craft-Agents-')
    expect(workflow).not.toContain('Craft Agents ')
  })

  it('keeps the asset-name allowlist and checksum verification', () => {
    expect(workflow).toContain('[A-Za-z0-9._-]')
    expect(workflow).toContain('sha512')
    expect(workflow).toContain('createHash')
  })
})

describe('preserved internal compatibility identifiers', () => {
  it('keeps the craftagents:// deep-link scheme as the default and adds no mkrate:// scheme', () => {
    const mainIndex = read(electronDir, 'src', 'main', 'index.ts')
    expect(mainIndex).toContain("process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents'")
    expect(mainIndex).not.toContain('mkrate://')
  })

  it('keeps the ~/.craft-agent config directory (gated by CRAFT_CONFIG_DIR)', () => {
    const paths = read(repoRoot, 'packages', 'shared', 'src', 'config', 'paths.ts')
    expect(paths).toContain('CRAFT_CONFIG_DIR')
    expect(paths).toContain('.craft-agent')
  })
})

describe('install scripts rebrand', () => {
  it('macOS/Linux installer uses Mkrate app names, new appId, and mkrate release repo', () => {
    const sh = read(repoRoot, 'scripts', 'install-app.sh')
    expect(sh).toContain('Mkrate.app')
    expect(sh).toContain('Mkrate-x64.AppImage')
    expect(sh).toContain('ru.mkrate.desktop')
    expect(sh).toContain('mkrtc/mkrate')
    // Preserved: config dir and OS scheme handler.
    expect(sh).toContain('.craft-agent')
    expect(sh).toContain('x-scheme-handler/craftagents')
    expect(sh).not.toContain('com.lukilabs.craft-agent')
  })

  it('Windows installer uses Mkrate names and mkrate release repo', () => {
    const ps = read(repoRoot, 'scripts', 'install-app.ps1')
    expect(ps).toContain('Mkrate-')
    expect(ps).toContain('mkrtc/mkrate')
    expect(ps).not.toContain('Craft Agents')
  })
})
