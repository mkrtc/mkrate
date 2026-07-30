import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const installer = join(repoRoot, 'scripts', 'install-app.sh')
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function runLinuxInstall(
  pgrepOutput: string | ((appImage: string) => string),
  hasExistingInstall: boolean,
) {
  const root = mkdtempSync(join(tmpdir(), 'mkrate-installer-test-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })

  const appImage = join(home, '.craft-agent', 'app', 'Mkrate-x64.AppImage')
  if (hasExistingInstall) {
    mkdirSync(join(home, '.craft-agent', 'app'), { recursive: true })
    writeFileSync(appImage, '#!/bin/sh\nexit 0\n')
    chmodSync(appImage, 0o755)
  }

  const payload = '#!/bin/sh\nif [ "$1" = "--appimage-extract" ]; then\n  mkdir -p squashfs-root/usr/share/icons/hicolor/512x512/apps\n  : > squashfs-root/usr/share/icons/hicolor/512x512/apps/mkrate.png\nfi\n'
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const manifest = `version: 0.0.1\nfiles:\n  - url: Mkrate-x64.AppImage\n    sha512: ${sha512}\n    arch: x64\n`
  const resolvedPgrepOutput =
    typeof pgrepOutput === 'function'
      ? pgrepOutput(appImage)
      : pgrepOutput.replace('__APPIMAGE__', appImage)

  writeExecutable(
    join(bin, 'curl'),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then
    printf '%s' '${payload.replace(/'/g, "'\\''")}' > "$arg"
    chmod +x "$arg"
    exit 0
  fi
  previous="$arg"
done
printf '%s' '${manifest.replace(/'/g, "'\\''")}'
`,
  )
  writeExecutable(
    join(bin, 'pgrep'),
    `#!/bin/sh
[ -n "${resolvedPgrepOutput.replace(/'/g, "'\\''")}" ] && printf '%s\\n' '${resolvedPgrepOutput.replace(/'/g, "'\\''")}'
`,
  )
  const result = Bun.spawnSync(['bash', installer], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      CRAFT_AGENTS_DOWNLOAD_BASE_URL: 'https://example.invalid/v0.0.1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(result.exitCode).toBe(0)
  return {
    appImage,
    stdout: result.stdout.toString(),
  }
}

describe('Linux installer process handoff', () => {
  it('does not signal a live development process during a first install', async () => {
    let target: ReturnType<typeof Bun.spawn>
    const result = runLinuxInstall((appImage) => {
      target = Bun.spawn(['sleep', '60'], { env: { ...process.env, APPIMAGE: appImage } })
      return `${target.pid} /work/mkrate/node_modules/@craft-agentelectron dev`
    }, false)
    try {
      expect(result.stdout).toContain('Installation complete!')
      await Bun.sleep(20)
      expect(target!.exitCode).toBeNull()
    } finally {
      target!.kill()
    }
  })

  it('stops the live existing installed AppImage process during an upgrade', async () => {
    let target: ReturnType<typeof Bun.spawn>
    const result = runLinuxInstall((appImage) => {
      target = Bun.spawn(['sleep', '60'], { env: { ...process.env, APPIMAGE: appImage } })
      return `${target.pid} ${appImage} --no-sandbox`
    }, true)
    try {
      expect(result.stdout).toContain('Stopping installed Mkrate AppImage...')
      expect(await target!.exited).not.toBe(0)
    } finally {
      target!.kill()
    }
  })

  it('does not signal a live unrelated AppImage-like process during an upgrade', async () => {
    let target: ReturnType<typeof Bun.spawn>
    const result = runLinuxInstall(() => {
      target = Bun.spawn(['sleep', '60'])
      return `${target.pid} /tmp/Mkrate-x64.AppImage --no-sandbox`
    }, true)
    try {
      await Bun.sleep(20)
      expect(target!.exitCode).toBeNull()
      expect(result.stdout).not.toContain('Stopping installed Mkrate AppImage...')
    } finally {
      target!.kill()
    }
  })
})
