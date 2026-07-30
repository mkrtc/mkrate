import { join } from 'node:path'
import { downloadUv, type Arch, type BuildConfig, type Platform } from './build/common'

const SUPPORTED_PLATFORMS = new Set<Platform>(['darwin', 'linux', 'win32'])
const SUPPORTED_ARCHES = new Set<Arch>(['arm64', 'x64'])

function fail(message: string): never {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

const [platformArg, archArg, ...unexpected] = process.argv.slice(2)
if (
  unexpected.length > 0 ||
  !SUPPORTED_PLATFORMS.has(platformArg as Platform) ||
  !SUPPORTED_ARCHES.has(archArg as Arch)
) {
  fail('usage: bun scripts/prepare-electron-uv.ts <darwin|linux|win32> <arm64|x64>')
}

const rootDir = join(import.meta.dir, '..')
const config: BuildConfig = {
  platform: platformArg as Platform,
  arch: archArg as Arch,
  upload: false,
  uploadLatest: false,
  uploadScript: false,
  rootDir,
  electronDir: join(rootDir, 'apps', 'electron'),
}

await downloadUv(config)
