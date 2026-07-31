#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

function controlRootFromArgv(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--control-root' || !isAbsolute(argv[1]!)) {
    throw new Error('invalid-launch')
  }
  return realpathSync(argv[1]!)
}

function boundNodeRuntime(controlRoot: string): string {
  const manifestPath = join(controlRoot, 'control', 'desktop-node-runtime.json')
  if (lstatSync(manifestPath).isSymbolicLink() || !statSync(manifestPath).isFile() || (statSync(manifestPath).mode & 0o077) !== 0) {
    throw new Error('invalid-node-runtime')
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'nodePath,nodeSha256,v') {
    throw new Error('invalid-node-runtime')
  }
  const manifest = raw as { v?: unknown; nodePath?: unknown; nodeSha256?: unknown }
  if (manifest.v !== 1 || typeof manifest.nodePath !== 'string' || !isAbsolute(manifest.nodePath) ||
      typeof manifest.nodeSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(manifest.nodeSha256)) {
    throw new Error('invalid-node-runtime')
  }
  const nodePath = realpathSync(manifest.nodePath)
  if (!statSync(nodePath).isFile()) throw new Error('invalid-node-runtime')
  const actualSha256 = createHash('sha256').update(readFileSync(nodePath)).digest('hex')
  if (actualSha256 !== manifest.nodeSha256) throw new Error('invalid-node-runtime')
  return nodePath
}

const controlRoot = controlRootFromArgv(process.argv.slice(2))
// Bun 1.3.10's ws compatibility path does not honor the explicit custom-CA
// ClientOptions used by production @craft-agent/server-core/bridge. Electron's
// main process uses Node TLS, so preserve the exact Bun launcher while handing
// the unopened control stream to the preflight-pinned Node runtime.
if (typeof globalThis.Bun !== 'undefined') {
  let nodePath: string
  try {
    nodePath = boundNodeRuntime(controlRoot)
  } catch {
    process.stderr.write('{"event":"launcher-rejected","code":"INVALID_NODE_RUNTIME"}\n')
    process.exit(2)
  }
  const script = fileURLToPath(import.meta.url)
  const child = spawnSync(nodePath, ['--import', 'tsx', script, ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exitCode = child.status ?? 2
} else {
  // Shared config captures CRAFT_CONFIG_DIR at module evaluation. Set it before
  // dynamically importing any Craft/Bridge module, and keep all credentials and
  // durable authority inside the coordinator-owned isolated state directory.
  process.env.CRAFT_CONFIG_DIR = join(controlRoot, 'state')
  process.env.CRAFT_DEBUG = 'false'

  const { DesktopBridgeE2EDriver } = await import('./bridge-e2e-desktop-driver-lib.ts')
  const driver = new DesktopBridgeE2EDriver(controlRoot)
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })

  for await (const line of lines) {
    if (line.length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(line) as unknown
    } catch {
      process.stderr.write('{"event":"control-rejected","code":"INVALID_REQUEST"}\n')
      continue
    }
    const response = await driver.handle(raw)
    process.stdout.write(`${JSON.stringify(response)}\n`)
    if (driver.stopped) break
  }

  await driver.close()
}
