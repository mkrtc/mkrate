import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps', 'electron')
const ELECTRON_NODE_MODULES = join(ELECTRON_DIR, 'node_modules')
const MANIFEST_PATH = join(ELECTRON_DIR, 'resources', 'sharp-runtime-manifest.json')

const SHARP_VERSION = '0.35.0'
const LIBVIPS_PACKAGE_VERSION = '1.3.0'
const SHARP_SEMVER_VERSION = '7.8.5'
const IMG_COLOUR_VERSION = '1.1.0'
const DETECT_LIBC_VERSION = '2.1.2'

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32'])
const SUPPORTED_ARCHES = new Set(['arm64', 'x64'])

type Platform = 'darwin' | 'linux' | 'win32'
type Arch = 'arm64' | 'x64'
type SourceKind = 'installed' | 'npm-pack'

type PackageRecord = {
  name: string
  version: string
  destination: string
  source: SourceKind
  distIntegrity?: string
}

type TargetGraph = {
  runtimePlatform: string
  nativePackage: string
  libvipsPackage: string | null
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function packageSegments(packageName: string): string[] {
  return packageName.split('/')
}

function packageDir(baseNodeModules: string, packageName: string): string {
  return join(baseNodeModules, ...packageSegments(packageName))
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function packageVersion(dir: string): string | null {
  const pkg = join(dir, 'package.json')
  if (!existsSync(pkg)) return null
  return readJson(pkg).version ?? null
}

function requireFile(path: string, description: string): void {
  assert(existsSync(path) && statSync(path).isFile(), `${description} missing at ${path}`)
}

function requireDir(path: string, description: string): void {
  assert(existsSync(path) && statSync(path).isDirectory(), `${description} missing at ${path}`)
}

function findFileRecursive(root: string, predicate: (path: string) => boolean): string | null {
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile() && predicate(path)) return path
    if (entry.isDirectory()) {
      const nested = findFileRecursive(path, predicate)
      if (nested) return nested
    }
  }
  return null
}

function runtimePlatform(platform: Platform, arch: Arch): string {
  if (platform === 'darwin') return `darwin-${arch}`
  if (platform === 'linux') return `linux-${arch}`
  if (platform === 'win32') return `win32-${arch}`
  throw new Error(`unsupported platform: ${platform}`)
}

function targetGraph(platform: Platform, arch: Arch): TargetGraph {
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error('Windows release packaging currently supports x64 only')
  }
  const runtime = runtimePlatform(platform, arch)
  return {
    runtimePlatform: runtime,
    nativePackage: `@img/sharp-${runtime}`,
    // sharp 0.35.0 links Linux/macOS libvips through target @img/sharp-libvips-* packages.
    // The Windows native package carries the required libvips DLLs itself and does not declare
    // a runtime @img/sharp-libvips-win32-* optional dependency.
    libvipsPackage: platform === 'win32' ? null : `@img/sharp-libvips-${runtime}`,
  }
}

function hostArch(): Arch | 'other' {
  if (process.arch === 'x64') return 'x64'
  if (process.arch === 'arm64') return 'arm64'
  return 'other'
}

function targetExecutableOnHost(platform: Platform, arch: Arch): boolean {
  return process.platform === platform && hostArch() === arch
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    )
  }
  return result.stdout.trim()
}

function verifyNpmIntegrity(tarball: string, integrity: string): void {
  const match = /^([a-z0-9-]+)-([A-Za-z0-9+/=]+)$/i.exec(integrity.trim())
  if (!match) throw new Error(`npm registry did not return a valid dist.integrity value: ${integrity}`)
  const actual = createHash(match[1]).update(readFileSync(tarball)).digest('base64')
  if (actual !== match[2]) {
    throw new Error(`npm tarball integrity mismatch for ${tarball}`)
  }
}

function fetchPackage(packageName: string, version: string): { dir: string; tempDir: string; distIntegrity: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'mkrate-sharp-pack-'))
  const spec = `${packageName}@${version}`
  try {
    console.log(`  ${packageName}@${version} missing locally; fetching from npm with dist.integrity verification...`)
    const packJson = run('npm', ['pack', '--json', spec], tempDir)
    const packed = JSON.parse(packJson)[0]
    assert(packed?.filename && packed?.version, `npm pack did not report filename/version for ${spec}`)
    assert(packed.version === version, `npm pack returned ${packageName}@${packed.version}, expected ${version}`)
    const tarball = join(tempDir, packed.filename)
    requireFile(tarball, `npm tarball for ${spec}`)

    const distIntegrity = run('npm', ['view', spec, 'dist.integrity'], tempDir).trim()
    verifyNpmIntegrity(tarball, distIntegrity)
    run('tar', ['-xzf', tarball], tempDir)
    requireDir(join(tempDir, 'package'), `extracted npm package for ${spec}`)
    return { dir: join(tempDir, 'package'), tempDir, distIntegrity }
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
}

function installedPackage(packageName: string, version: string, preferredNodeModules: string[] = []): string | null {
  for (const base of [...preferredNodeModules, join(ROOT_DIR, 'node_modules')]) {
    const dir = packageDir(base, packageName)
    if (!existsSync(dir)) continue
    const foundVersion = packageVersion(dir)
    if (foundVersion === version) return dir
    if (foundVersion) {
      console.log(`  ignoring ${dir}: version ${foundVersion}, expected ${version}`)
    }
  }
  return null
}

function withPackageSource<T>(
  packageName: string,
  version: string,
  preferredNodeModules: string[],
  fn: (dir: string, source: SourceKind, distIntegrity?: string) => T,
): T {
  const installed = installedPackage(packageName, version, preferredNodeModules)
  if (installed) return fn(installed, 'installed')

  const fetched = fetchPackage(packageName, version)
  try {
    return fn(fetched.dir, 'npm-pack', fetched.distIntegrity)
  } finally {
    rmSync(fetched.tempDir, { recursive: true, force: true })
  }
}

function copyClean(source: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(source, dest, { recursive: true, dereference: true })
}

function copyEntries(source: string, dest: string, entries: string[]): void {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  for (const entry of entries) {
    const src = join(source, entry)
    if (!existsSync(src)) throw new Error(`required package entry ${entry} missing from ${source}`)
    cpSync(src, join(dest, entry), { recursive: true, dereference: true })
  }
}

function stagePackage(
  records: PackageRecord[],
  packageName: string,
  version: string,
  destination: string,
  options: { preferredNodeModules?: string[]; sharpRuntimeSubset?: boolean } = {},
): void {
  withPackageSource(packageName, version, options.preferredNodeModules ?? [], (source, sourceKind, distIntegrity) => {
    console.log(`  staging ${packageName}@${version} -> ${relative(ELECTRON_DIR, destination)}`)
    if (options.sharpRuntimeSubset) {
      copyEntries(source, destination, ['dist', 'package.json', 'LICENSE'])
    } else {
      copyClean(source, destination)
    }
    records.push({
      name: packageName,
      version,
      destination: relative(ELECTRON_DIR, destination),
      source: sourceKind,
      distIntegrity,
    })
  })
}

function cleanPreviousSharpStage(): void {
  rmSync(join(ELECTRON_NODE_MODULES, 'sharp'), { recursive: true, force: true })
  rmSync(join(ELECTRON_NODE_MODULES, '@img'), { recursive: true, force: true })
  rmSync(join(ELECTRON_NODE_MODULES, 'detect-libc'), { recursive: true, force: true })
  rmSync(join(ELECTRON_NODE_MODULES, 'semver'), { recursive: true, force: true })
}

function writeManifest(platform: Platform, arch: Arch, graph: TargetGraph, packages: PackageRecord[]): void {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: { platform, arch, runtimePlatform: graph.runtimePlatform },
    sharpVersion: SHARP_VERSION,
    libvipsPackageVersion: LIBVIPS_PACKAGE_VERSION,
    packages,
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`  wrote ${relative(ROOT_DIR, MANIFEST_PATH)}`)
}

function verifyPackageAt(baseNodeModules: string, packageName: string, version: string): string {
  const dir = packageDir(baseNodeModules, packageName)
  requireDir(dir, `${packageName} staged package`)
  const foundVersion = packageVersion(dir)
  assert(foundVersion === version, `${packageName} version mismatch: ${foundVersion}, expected ${version}`)
  return dir
}

function verifyGraph(baseNodeModules: string, platform: Platform, arch: Arch): void {
  const graph = targetGraph(platform, arch)

  const sharpDir = verifyPackageAt(baseNodeModules, 'sharp', SHARP_VERSION)
  requireFile(join(sharpDir, 'dist', 'index.cjs'), 'sharp CommonJS entry')
  requireFile(join(sharpDir, 'dist', 'sharp.cjs'), 'sharp native loader')
  requireFile(join(sharpDir, 'dist', 'utility.cjs'), 'sharp utility runtime')
  assert(!existsSync(join(sharpDir, 'src')), 'staged sharp package must not include build sources or local native .node outputs')

  verifyPackageAt(baseNodeModules, 'semver', SHARP_SEMVER_VERSION)
  verifyPackageAt(baseNodeModules, '@img/colour', IMG_COLOUR_VERSION)
  verifyPackageAt(baseNodeModules, 'detect-libc', DETECT_LIBC_VERSION)

  const nativeDir = verifyPackageAt(baseNodeModules, graph.nativePackage, SHARP_VERSION)
  requireFile(join(nativeDir, 'index.cjs'), `${graph.nativePackage} loader`)
  const nativeNode = join(nativeDir, 'lib', `sharp-${graph.runtimePlatform}-${SHARP_VERSION}.node`)
  requireFile(nativeNode, `${graph.nativePackage} native module`)

  if (graph.libvipsPackage) {
    const libvipsDir = verifyPackageAt(baseNodeModules, graph.libvipsPackage, LIBVIPS_PACKAGE_VERSION)
    requireFile(join(libvipsDir, 'versions.json'), `${graph.libvipsPackage} versions metadata`)
    requireFile(join(libvipsDir, 'lib', 'index.js'), `${graph.libvipsPackage} lib export`)
    assert(
      findFileRecursive(join(libvipsDir, 'lib'), (path) => path.includes('libvips-cpp')),
      `${graph.libvipsPackage} must contain libvips-cpp runtime library`,
    )
  } else {
    requireFile(join(nativeDir, 'versions.json'), `${graph.nativePackage} bundled versions metadata`)
    requireFile(join(nativeDir, 'lib', 'libvips-42.dll'), `${graph.nativePackage} bundled libvips DLL`)
    requireFile(join(nativeDir, 'lib', 'libvips-cpp-8.18.3.dll'), `${graph.nativePackage} bundled libvips-cpp DLL`)
  }
}

async function runSharpSmokeFromAppRoot(appRoot: string): Promise<void> {
  const requireFromApp = createRequire(join(appRoot, 'package.json'))
  const sharp = requireFromApp('sharp') as typeof import('sharp')

  assert(sharp.versions.sharp === SHARP_VERSION, `sharp smoke loaded ${sharp.versions.sharp}, expected ${SHARP_VERSION}`)
  assert(Boolean(sharp.versions.vips), 'sharp smoke did not expose a libvips version')

  const input = await sharp({
    create: {
      width: 16,
      height: 12,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 1 },
    },
  }).png().toBuffer()

  const metadata = await sharp(input).metadata()
  assert(metadata.format === 'png', `sharp smoke metadata format mismatch: ${metadata.format}`)
  assert(metadata.width === 16 && metadata.height === 12, `sharp smoke metadata size mismatch: ${metadata.width}x${metadata.height}`)

  const resized = await sharp(input).resize({ width: 4, height: 3, fit: 'fill' }).png().toBuffer()
  const resizedMetadata = await sharp(resized).metadata()
  assert(resizedMetadata.width === 4 && resizedMetadata.height === 3, 'sharp smoke resize metadata mismatch')
}

function verifyManifest(appRoot: string, platform: Platform, arch: Arch): void {
  const manifestPath = join(appRoot, 'dist', 'resources', 'sharp-runtime-manifest.json')
  requireFile(manifestPath, 'packaged sharp runtime manifest')
  const manifest = readJson(manifestPath)
  assert(manifest.schemaVersion === 1, 'sharp runtime manifest schema mismatch')
  assert(manifest.target?.platform === platform, `manifest platform mismatch: ${manifest.target?.platform}`)
  assert(manifest.target?.arch === arch, `manifest arch mismatch: ${manifest.target?.arch}`)
  assert(manifest.target?.runtimePlatform === runtimePlatform(platform, arch), 'manifest runtime platform mismatch')
  assert(manifest.sharpVersion === SHARP_VERSION, 'manifest sharp version mismatch')
  assert(manifest.libvipsPackageVersion === LIBVIPS_PACKAGE_VERSION, 'manifest libvips package version mismatch')
  assert(Array.isArray(manifest.packages) && manifest.packages.length >= 5, 'manifest package list is incomplete')
}

async function stage(platform: Platform, arch: Arch): Promise<void> {
  const graph = targetGraph(platform, arch)
  const records: PackageRecord[] = []
  console.log(`Staging sharp ${SHARP_VERSION} runtime for ${graph.runtimePlatform}...`)
  cleanPreviousSharpStage()

  stagePackage(records, 'sharp', SHARP_VERSION, join(ELECTRON_NODE_MODULES, 'sharp'), { sharpRuntimeSubset: true })
  stagePackage(records, '@img/colour', IMG_COLOUR_VERSION, join(ELECTRON_NODE_MODULES, '@img', 'colour'))
  stagePackage(records, 'detect-libc', DETECT_LIBC_VERSION, join(ELECTRON_NODE_MODULES, 'detect-libc'))
  stagePackage(records, 'semver', SHARP_SEMVER_VERSION, join(ELECTRON_NODE_MODULES, 'semver'), {
    preferredNodeModules: [join(ROOT_DIR, 'node_modules', 'sharp', 'node_modules')],
  })
  stagePackage(records, graph.nativePackage, SHARP_VERSION, packageDir(ELECTRON_NODE_MODULES, graph.nativePackage))
  if (graph.libvipsPackage) {
    stagePackage(records, graph.libvipsPackage, LIBVIPS_PACKAGE_VERSION, packageDir(ELECTRON_NODE_MODULES, graph.libvipsPackage))
  }

  verifyGraph(ELECTRON_NODE_MODULES, platform, arch)
  writeManifest(platform, arch, graph, records)
  console.log(`Sharp runtime staging verified for ${graph.runtimePlatform}`)
}

async function verifyStaged(platform: Platform, arch: Arch): Promise<void> {
  verifyGraph(ELECTRON_NODE_MODULES, platform, arch)
  console.log(`Sharp staged graph verified for ${runtimePlatform(platform, arch)}`)
}

async function verifyPackaged(platform: Platform, arch: Arch, appRoot: string): Promise<void> {
  requireDir(appRoot, 'packaged Electron app root')
  const baseNodeModules = join(appRoot, 'node_modules')
  verifyGraph(baseNodeModules, platform, arch)
  verifyManifest(appRoot, platform, arch)

  if (targetExecutableOnHost(platform, arch)) {
    await runSharpSmokeFromAppRoot(appRoot)
    console.log(`Packaged sharp smoke passed for ${runtimePlatform(platform, arch)}`)
  } else {
    console.log(
      `Packaged sharp graph verified for ${runtimePlatform(platform, arch)}; ` +
      `native smoke skipped on host ${process.platform}-${hostArch()}`,
    )
  }
}

function parseTarget(args: string[]): { platform: Platform; arch: Arch } {
  const [platformArg, archArg] = args
  if (!SUPPORTED_PLATFORMS.has(platformArg) || !SUPPORTED_ARCHES.has(archArg)) {
    fail('usage: bun scripts/stage-sharp-runtime.ts <stage|verify-staged|verify-packaged> <darwin|linux|win32> <arm64|x64> [app-root]')
  }
  return { platform: platformArg as Platform, arch: archArg as Arch }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'stage') {
    const { platform, arch } = parseTarget(rest)
    await stage(platform, arch)
    return
  }
  if (command === 'verify-staged') {
    const { platform, arch } = parseTarget(rest)
    await verifyStaged(platform, arch)
    return
  }
  if (command === 'verify-packaged') {
    const { platform, arch } = parseTarget(rest)
    const appRoot = rest[2]
    if (!appRoot) fail('verify-packaged requires an app root path')
    await verifyPackaged(platform, arch, appRoot)
    return
  }
  fail('usage: bun scripts/stage-sharp-runtime.ts <stage|verify-staged|verify-packaged> <darwin|linux|win32> <arm64|x64> [app-root]')
}

await main()
