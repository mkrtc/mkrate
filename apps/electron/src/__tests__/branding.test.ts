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
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const electronDir = join(import.meta.dir, '..', '..')
const repoRoot = join(electronDir, '..', '..')
const read = (...p: string[]) => readFileSync(join(...p), 'utf8')

const builder = read(electronDir, 'electron-builder.yml')
const pkg = JSON.parse(read(electronDir, 'package.json'))
const localeDir = join(repoRoot, 'packages', 'shared', 'src', 'i18n', 'locales')

// These keys describe official Craft integrations or the persisted provider name,
// rather than the external Mkrate product identity.
const OFFICIAL_CRAFT_LOCALE_KEYS = [
  'editPopover.example.addSource',
  'hints.reviewGitHubPRs',
  'hints.summarizeGmail',
  'onboarding.apiSetup.apiKeyDesc',
  'onboarding.apiSetup.chatGPTPlusDesc',
  'onboarding.apiSetup.craftAgentsBackend',
  'onboarding.apiSetup.githubCopilotDesc',
  'onboarding.apiSetup.piDesc',
  'onboarding.reauth.expired',
  'onboarding.reauth.loginWithCraft',
].sort()

describe('Mkrate locale product identity', () => {
  const localeFiles = readdirSync(localeDir)
    .filter((file) => file.endsWith('.json'))
    .sort()

  it('restricts Craft wording in every locale to reviewed official-integration keys', () => {
    for (const file of localeFiles) {
      const messages = JSON.parse(read(localeDir, file)) as Record<string, string>
      const craftKeys = Object.entries(messages)
        .filter(([, value]) => value.includes('Craft'))
        .map(([key]) => key)
        .sort()

      expect(craftKeys).toEqual(OFFICIAL_CRAFT_LOCALE_KEYS)
    }
  })
})

describe('Mkrate canonical kraken identity', () => {
  const canonicalIconPath = join(
    repoRoot,
    'docs',
    'brand',
    'assets',
    'mkrate-icon-1024.png',
  )

  it('pins the exact user-approved 1024px source raster', () => {
    const digest = createHash('sha256')
      .update(readFileSync(canonicalIconPath))
      .digest('hex')
    expect(digest).toBe(
      '941584a70cef656815c36e6ab48885579f8c428f6847e81edfbf5e7b970b41b6',
    )
  })

  it('verifies every canonical and repository-output hash in the asset manifest', () => {
    const manifest = JSON.parse(
      read(repoRoot, 'docs', 'brand', 'asset-manifest.json'),
    ) as {
      files: Array<{ file: string; sha256: string }>
      repositoryOutputs: Array<{ path: string; sha256: string }>
    }
    const digest = (path: string) =>
      createHash('sha256').update(readFileSync(path)).digest('hex')

    for (const entry of manifest.files) {
      if (entry.file === 'asset-manifest.json') continue
      expect(digest(join(repoRoot, 'docs', 'brand', entry.file))).toBe(entry.sha256)
    }
    for (const entry of manifest.repositoryOutputs) {
      expect(digest(join(repoRoot, entry.path))).toBe(entry.sha256)
    }
  })

  it('uses the canonical icon asset and retires the old graph path in renderer symbols', () => {
    for (const file of ['MkrateLogo.tsx', 'MkrateSymbol.tsx']) {
      const source = read(
        electronDir,
        'src',
        'renderer',
        'components',
        'icons',
        file,
      )
      expect(source).toContain('mkrate_app_icon.svg')
      expect(source).not.toContain('M7 25 L7 7 L16 18 L25 7 L25 25')
    }
  })

  it('embeds the canonical kraken icon in standalone OAuth callbacks', () => {
    const branding = read(repoRoot, 'packages', 'shared', 'src', 'branding.ts')
    const callback = read(
      repoRoot,
      'packages',
      'shared',
      'src',
      'auth',
      'callback-page.ts',
    )
    expect(branding).toContain('MKRATE_LOGO_DATA_URI')
    expect(branding).not.toContain('MKRATE_LOGO_HTML')
    expect(callback).toContain('<img class="logo"')
    expect(callback).not.toContain('<pre class="logo"')
  })
})

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

describe('native macOS Mkrate icon release contract', () => {
  const afterPack = read(electronDir, 'scripts', 'afterPack.cjs')
  const dmgScript = read(electronDir, 'scripts', 'build-dmg.sh')
  const iconGenerator = read(electronDir, 'scripts', 'generate-macos-icon.sh')

  it('uses a generated native icon for the Mkrate bundle and plain DMG', () => {
    expect(builder).toMatch(/mac:[\s\S]*?icon:\s*resources\/icon\.icns/)
    expect(builder).toMatch(/dmg:[\s\S]*?icon:\s*resources\/icon\.icns/)
    expect(afterPack).toContain("productName !== 'Mkrate'")
    expect(afterPack).not.toContain('Craft Agents.app')
    expect(afterPack).toContain('CANONICAL_ICON_SHA256')
    expect(afterPack).toContain('icon.icns')
    expect(afterPack).not.toContain('copyFileSync')
  })

  it('generates and structurally verifies the icon on macOS from the pinned raster only', () => {
    expect(iconGenerator).toContain('mkrate-icon-1024.png')
    expect(iconGenerator).toContain('941584a70cef656815c36e6ab48885579f8c428f6847e81edfbf5e7b970b41b6')
    expect(iconGenerator).toContain('sips')
    expect(iconGenerator).toContain('iconutil -c icns')
    expect(iconGenerator).toContain('iconutil -c iconset')
    expect(iconGenerator).not.toContain('Craft Agents.app')
    expect(iconGenerator).not.toContain('craft-logos')
    expect(dmgScript).toContain('generate-macos-icon.sh')
    expect(dmgScript).toContain('ru.mkrate.desktop')
    expect(dmgScript).toContain('Mkrate.app')
    expect(dmgScript).toContain('not notarized')
  })
})

describe('cross-platform reproducible packaging contracts', () => {
  const linuxScript = read(electronDir, 'scripts', 'build-linux.sh')
  const dmgScript = read(electronDir, 'scripts', 'build-dmg.sh')
  const winScript = read(electronDir, 'scripts', 'build-win.ps1')
  const uvBootstrap = read(repoRoot, 'scripts', 'prepare-electron-uv.ts')
  const commonBuild = read(repoRoot, 'scripts', 'build', 'common.ts')

  it('pins embedded Bun 1.3.10 and installs only from the frozen lockfile', () => {
    for (const script of [linuxScript, dmgScript, winScript]) {
      expect(script).toContain('1.3.10')
      expect(script).toContain('bun install --frozen-lockfile')
    }
  })

  it('downloads and requires a checksummed target uv runtime in every clean platform build', () => {
    expect(linuxScript).toContain('prepare-electron-uv.ts linux "$ARCH"')
    expect(linuxScript).toContain('resources/bin/linux-${ARCH}/uv')
    expect(dmgScript).toContain('prepare-electron-uv.ts darwin "$ARCH"')
    expect(dmgScript).toContain('resources/bin/darwin-${ARCH}/uv')
    expect(winScript).toContain('prepare-electron-uv.ts win32 x64')
    expect(winScript).toContain('resources\\bin\\win32-x64\\uv.exe')
    expect(uvBootstrap).toContain('await downloadUv(config)')
    expect(commonBuild).toContain('uv checksum verification failed')
    expect(builder).toContain('resources/bin/linux-x64/**/*')
    expect(builder).toContain('resources/bin/darwin-arm64/**/*')
    expect(builder).toContain('resources/bin/darwin-x64/**/*')
    expect(builder).toContain('resources/bin/win32-x64/**')
  })

  it('verifies cross-architecture npm tarballs against registry dist.integrity before extraction', () => {
    for (const script of [linuxScript, dmgScript, winScript]) {
      expect(script).toContain('dist.integrity')
      expect(script).toContain('npm pack --json')
      expect(script.indexOf('dist.integrity')).toBeLessThan(script.lastIndexOf('tar -xzf'))
    }
  })

  it('reports the deliberate unsigned release status on Windows and macOS', () => {
    expect(winScript).toContain('Get-AuthenticodeSignature')
    expect(winScript).toContain("'NotSigned'")
    expect(dmgScript).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false')
    expect(dmgScript).toContain('Signing status:')
  })
})

describe('Mkrate release workflow identity and privilege split', () => {
  const workflowsDir = join(repoRoot, '.github', 'workflows')
  const workflowFiles = readdirSync(workflowsDir).filter(
    (file) => file.endsWith('.yml') || file.endsWith('.yaml'),
  )
  const releaseWorkflow = read(workflowsDir, 'electron-release.yml')
  const evidenceWorkflow = read(workflowsDir, 'electron-pretag-evidence.yml')

  it('ships the reviewed Mkrate publisher and pre-tag evidence workflows', () => {
    expect(workflowFiles).toContain('electron-release.yml')
    expect(workflowFiles).toContain('electron-pretag-evidence.yml')
    expect(releaseWorkflow).toContain('Mkrate $RELEASE_TAG')
    expect(releaseWorkflow).toContain('mkrate-release-run:')
    expect(releaseWorkflow).not.toContain('Craft-Agents-')
  })

  it('keeps write/release mutation in the tag-only publisher and out of pre-tag evidence', () => {
    expect(releaseWorkflow).toMatch(/push:\s*\n\s*tags:/)
    expect(releaseWorkflow).not.toContain('workflow_dispatch:')
    expect(releaseWorkflow).toMatch(/contents:\s*write/)
    expect(releaseWorkflow).toContain('gh release create')
    expect(releaseWorkflow).toContain('uploads.github.com')

    expect(evidenceWorkflow).toContain('workflow_dispatch:')
    expect(evidenceWorkflow).toMatch(/contents:\s*read/)
    expect(evidenceWorkflow).not.toContain('gh release create')
    expect(evidenceWorkflow).not.toContain('uploads.github.com')
  })
})

describe('runtime application product identity', () => {
  const mainIndex = read(electronDir, 'src', 'main', 'index.ts')

  it('falls back to the Mkrate app name when CRAFT_APP_NAME is unset (env var name preserved)', () => {
    expect(mainIndex).toContain("app.setName(process.env.CRAFT_APP_NAME || 'Mkrate')")
    expect(mainIndex).not.toContain("|| 'Craft Agents'")
  })
})

describe('WebUI PWA manifest product identity', () => {
  const manifest = JSON.parse(
    read(repoRoot, 'apps', 'webui', 'src', 'public', 'manifest.json'),
  ) as { name: string; short_name: string }

  it('names the installable WebUI app Mkrate', () => {
    expect(manifest.name).toBe('Mkrate')
    expect(manifest.short_name).toBe('Mkrate')
  })
})

describe('Mkrate assistant persona and co-author trailer', () => {
  const systemPrompt = read(
    repoRoot,
    'packages',
    'shared',
    'src',
    'prompts',
    'system.ts',
  )

  it('self-identifies as Mkrate, not Craft Agent', () => {
    expect(systemPrompt).toContain('You are Mkrate - an AI assistant')
    expect(systemPrompt).toContain('You must refer to yourself as Mkrate when asked.')
    expect(systemPrompt).not.toContain('You are Craft Agent -')
    expect(systemPrompt).not.toContain('refer to yourself as Craft Agent')
  })

  it('uses a Mkrate co-author trailer with a GitHub noreply address, kept opt-in only', () => {
    expect(systemPrompt).toContain('Co-Authored-By: Mkrate <mkrtc@users.noreply.github.com>')
    expect(systemPrompt).not.toContain('Co-Authored-By: Craft Agent')
    // The trailer stays behind the explicit opt-in flag — never default-on.
    expect(systemPrompt).toContain('includeCoAuthoredBy ? `## Git Conventions')
  })

  it('preserves the factual Craft Agents Backend provider wording and SDK-detection marker', () => {
    expect(systemPrompt).toContain('craft_agent_environment')
  })

  it('uses Mkrate for CLI display headings while retaining the craft-agent compatibility command', () => {
    expect(systemPrompt).toContain('| Mkrate CLI |')
    expect(systemPrompt).toContain('## Mkrate CLI')
    expect(systemPrompt).toContain('craft-agent')
    expect(systemPrompt).not.toContain('| Craft CLI |')
    expect(systemPrompt).not.toContain('## Craft Agent CLI')
  })
})

describe('README release-readiness claims', () => {
  const readme = read(repoRoot, 'README.md')

  it('describes the immutable v0.0.1 path without a time-sensitive publication claim', () => {
    expect(readme).toContain('The first supported Mkrate Desktop binary line is v0.0.1.')
    expect(readme).toContain('Linux x64')
    expect(readme).toContain('macOS arm64/x64')
    expect(readme).toContain('Windows x64')
    expect(readme).toContain('published only after the exact immutable tag passes')
    expect(readme).not.toContain('No Mkrate Desktop release has been published yet.')
  })

  it('discloses the deliberate unsigned and unnotarized status without blocking native macOS packaging', () => {
    expect(readme).toMatch(/artifacts are intentionally \*\*unsigned\*\*/)
    expect(readme).toMatch(/macOS artifacts are also[\s\S]*\*\*unnotarized\*\*/)
    expect(readme).toContain('standard native Mkrate `.icns`')
    expect(readme).not.toMatch(/macOS[^\n]*packaging[^\n]*blocked/i)
  })

  it('offers no copy-pastable one-line installer presented as currently working', () => {
    expect(readme).not.toMatch(/curl -fsSL[^\n]*install-app\.sh[^\n]*\|\s*bash/)
    expect(readme).not.toMatch(/irm[^\n]*install-app\.ps1[^\n]*\|\s*iex/)
  })

  it('uses Mkrate packaged debug paths rather than a retired Craft app name', () => {
    expect(readme).not.toContain('/Applications/Craft\\ Agents.app')
    expect(readme).toContain('macOS (published packaged build)')
    expect(readme).toContain('/Applications/Mkrate.app/Contents/MacOS/Mkrate -- --debug')
    expect(readme).toContain('mkrate -- --debug')
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
