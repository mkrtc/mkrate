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

describe('release is source-only (no active publisher in .github/workflows)', () => {
  const workflowsDir = join(repoRoot, '.github', 'workflows')
  const workflowFiles = readdirSync(workflowsDir).filter(
    (file) => file.endsWith('.yml') || file.endsWith('.yaml'),
  )

  it('does not ship the electron-release publisher workflow', () => {
    // History preserves it for a future, separately-approved release-readiness phase; the
    // current tree must contain no active tag/manual release-publishing workflow.
    expect(workflowFiles).not.toContain('electron-release.yml')
  })

  it('has no workflow that can create/publish/upload a release or request write contents permission', () => {
    for (const file of workflowFiles) {
      const wf = read(workflowsDir, file)
      expect(wf).not.toMatch(/contents:\s*write/)
      expect(wf).not.toContain('gh release create')
      expect(wf).not.toContain('uploads.github.com')
      expect(wf).not.toMatch(/actions\/upload-release/)
      expect(wf).not.toContain('softprops/action-gh-release')
    }
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

describe('README makes no live binary/install/update claim', () => {
  const readme = read(repoRoot, 'README.md')

  it('states plainly that no Mkrate binaries/installers/releases are published yet', () => {
    expect(readme).toContain('There are no published Mkrate binaries, installers, or releases yet.')
  })

  it('offers no copy-pastable one-line installer presented as currently working', () => {
    expect(readme).not.toMatch(/curl -fsSL[^\n]*install-app\.sh[^\n]*\|\s*bash/)
    expect(readme).not.toMatch(/irm[^\n]*install-app\.ps1[^\n]*\|\s*iex/)
  })

  it('keeps macOS native packaging explicitly blocked', () => {
    expect(readme).toMatch(/macOS[^\n]*packaging[^\n]*blocked/i)
  })

  it('does not present the old Craft macOS app path as an available command', () => {
    expect(readme).not.toContain('/Applications/Craft\\ Agents.app')
    expect(readme).toContain('macOS (future packaged build only; unavailable today)')
    expect(readme).toContain('/Applications/Mkrate.app/Contents/MacOS/Mkrate -- --debug')
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
