#!/usr/bin/env bun
import { createInterface } from 'node:readline'
import { realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

function controlRootFromArgv(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--control-root' || !isAbsolute(argv[1]!)) {
    throw new Error('invalid-launch')
  }
  return realpathSync(argv[1]!)
}

const controlRoot = controlRootFromArgv(process.argv.slice(2))
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
