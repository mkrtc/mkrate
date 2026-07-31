import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
let root = ''
let driverModule: typeof import('../bridge-e2e-desktop-driver-lib.ts')

function secureRoot(): string {
  const value = mkdtempSync(join(tmpdir(), 'bridge-desktop-driver-'))
  chmodSync(value, 0o700)
  for (const area of ['secrets', 'state', 'control', 'logs', 'evidence']) {
    mkdirSync(join(value, area), { mode: 0o700 })
  }
  roots.push(value)
  return value
}

function secureFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 })
  chmodSync(path, 0o600)
}

beforeAll(async () => {
  root = secureRoot()
  process.env.CRAFT_CONFIG_DIR = join(root, 'state')
  process.env.CRAFT_DEBUG = 'false'
  driverModule = await import('../bridge-e2e-desktop-driver-lib.ts')
})

afterAll(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true })
})

function fixture() {
  return {
    v: 1 as const,
    workspaces: [{ id: 'workspace-1', name: 'Local workspace' }],
    sessions: [{
      id: 'session-1',
      workspaceId: 'workspace-1',
      title: 'Durable session',
      isProcessing: false,
      messages: [{ id: 'message-1', role: 'user' as const, text: 'seed', occurredAtMs: 1 }],
    }],
  }
}

describe('DurableDesktopSessionAuthority', () => {
  test('persists acknowledged message IDs and executes the same optimistic send exactly once across reload', async () => {
    const authority = new driverModule.DurableDesktopSessionAuthority(join(root, 'state'))
    authority.loadFixture(fixture())
    const acknowledgements: string[] = []
    const request = {
      optimisticMessageId: 'bridge-optimistic-message-1',
      onAck: (messageId: string) => acknowledgements.push(messageId),
    }

    await authority.sendMessage('session-1', 'hello once', request)
    await authority.sendMessage('session-1', 'hello once', request)
    expect(acknowledgements).toHaveLength(2)
    expect(new Set(acknowledgements).size).toBe(1)
    expect(authority.counts().sendExecutionCount).toBe(1)

    const reloaded = new driverModule.DurableDesktopSessionAuthority(join(root, 'state'))
    reloaded.loadFixture(fixture())
    await reloaded.sendMessage('session-1', 'hello once', request)
    expect(reloaded.counts().sendExecutionCount).toBe(1)
    expect((await reloaded.getSession('session-1'))?.messages.filter(message => message.role === 'user')).toHaveLength(2)

    await reloaded.cancelProcessing('session-1')
    expect(reloaded.counts().cancelExecutionCount).toBe(1)
    expect((await reloaded.getSession('session-1'))?.isProcessing).toBe(false)
    expect((readFileSync(join(root, 'state', 'desktop-session-authority.json')).byteLength)).toBeGreaterThan(0)
  })

  test('persists deterministic assistant events before returning them for live projection', () => {
    const eventRoot = secureRoot()
    const authority = new driverModule.DurableDesktopSessionAuthority(join(eventRoot, 'state'))
    authority.loadFixture(fixture())
    const events = authority.advance({
      v: 1,
      events: [{
        sessionId: 'session-1',
        messageId: 'assistant-1',
        text: 'durable answer',
        occurredAtMs: 2,
      }],
    }, 1)
    expect(events).toEqual([expect.objectContaining({ type: 'text_complete', messageId: 'assistant-1' })])
    expect(authority.counts().fixtureAdvanceCount).toBe(1)
    const reloaded = new driverModule.DurableDesktopSessionAuthority(join(eventRoot, 'state'))
    expect(reloaded.getSessions()[0]?.messages.at(-1)).toMatchObject({ id: 'assistant-1', content: 'durable answer' })

    reloaded.recordCommandResult({
      mutating: true,
      idempotencyConflict: true,
      resyncRequired: false,
      fault: 'drop',
    })
    const metricsReloaded = new driverModule.DurableDesktopSessionAuthority(join(eventRoot, 'state'))
    expect(metricsReloaded.counts()).toMatchObject({
      commandResultCount: 1,
      mutatingResultCount: 1,
      idempotencyConflictCount: 1,
      droppedResultCount: 1,
    })
  })
})

describe('Desktop Bridge E2E closed controls', () => {
  test('emits the strict SemVer client identity through the real connector and canonical serializer', async () => {
    const [{ BridgeConnectorService }, protocol] = await Promise.all([
      import('@craft-agent/server-core/bridge'),
      import('@mkrate/bridge-protocol'),
    ])
    const sent: Array<Parameters<typeof protocol.serializeBridgeMessage>[0]> = []
    const connector = new BridgeConnectorService({
      profile: {
        profileId: '123e4567-e89b-42d3-a456-426614174000',
        url: 'wss://bridge.localhost:4443',
        displayName: 'Wave D Desktop',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      credentials: {
        async getBridgeInstanceCredential() { return null },
        async setBridgeInstanceCredential() {},
        async deleteBridgeInstanceToken() { return false },
      },
      clientVersion: driverModule.DESKTOP_BRIDGE_E2E_CLIENT_VERSION,
      transportFactory: callbacks => ({
        connected: true,
        start: () => callbacks.onOpen(),
        stop: () => {},
        retry: () => {},
        send: async message => { sent.push(message) },
      }),
    })
    connector.start()
    await Promise.resolve()
    const negotiation = sent[0]
    expect(negotiation).toMatchObject({
      type: 'deployment.negotiate',
      clientVersion: '1.0.0-wave-d-e2e',
    })
    const serialized = protocol.serializeBridgeMessage(negotiation!)
    expect(protocol.parseDesktopClientMessage(serialized)).toMatchObject({
      type: 'deployment.negotiate',
      clientVersion: '1.0.0-wave-d-e2e',
    })
    connector.stop()
  })

  test('strictly rejects unknown fields, duplicate IDs, bad protocol coordinates, and symlink refs', async () => {
    const controlRoot = secureRoot()
    const caPath = join(controlRoot, 'control', 'ca.pem')
    secureFile(caPath, '-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----\n')
    const driver = new driverModule.DesktopBridgeE2EDriver(controlRoot)

    expect(await driver.handle({ v: 1, id: 'extra', op: 'driver.state', args: {}, extra: true })).toEqual({
      v: 1, id: 'extra', ok: false, error: { code: 'INVALID_REQUEST' },
    })
    expect(await driver.handle({ v: 1, id: 'unknown', op: 'not-an-op', args: {} })).toEqual({
      v: 1, id: 'unknown', ok: false, error: { code: 'UNKNOWN_OPERATION' },
    })

    const badReady = {
      v: 1,
      id: 'ready-bad',
      op: 'driver.ready',
      args: {
        bridgeUrl: 'wss://bridge.localhost:4443',
        tlsServerName: 'bridge.localhost',
        caCertRef: { area: 'control', path: 'ca.pem' },
        protocol: { ...driverModule.DESKTOP_BRIDGE_E2E_PROTOCOL_COORDINATES, packageVersion: '9.9.9' },
      },
    }
    expect(await driver.handle(badReady)).toMatchObject({ ok: false, error: { code: 'PROTOCOL_MISMATCH' } })

    const duplicate = { v: 1, id: 'duplicate', op: 'driver.state', args: {} }
    expect((await driver.handle(duplicate)).ok).toBe(true)
    expect(await driver.handle(duplicate)).toEqual({
      v: 1, id: 'duplicate', ok: false, error: { code: 'DUPLICATE_REQUEST' },
    })

    if (process.platform !== 'win32') {
      symlinkSync(caPath, join(controlRoot, 'control', 'ca-link.pem'))
      expect(() => driver.resolvePathRef({ area: 'control', path: 'ca-link.pem' }, ['control'])).toThrow()
    }
    expect(() => driver.resolvePathRef({ area: 'control', path: '../secrets/token' }, ['control'])).toThrow()
    await driver.close()
  })

  test('exact Bun bootstrap hands the unopened closed control stream to Node TLS', () => {
    const controlRoot = secureRoot()
    secureFile(join(controlRoot, 'control', 'ca.pem'), '-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----\n')
    const requests = [
      {
        v: 1,
        id: 'ready',
        op: 'driver.ready',
        args: {
          bridgeUrl: 'wss://bridge.localhost:4443',
          tlsServerName: 'bridge.localhost',
          caCertRef: { area: 'control', path: 'ca.pem' },
          protocol: driverModule.DESKTOP_BRIDGE_E2E_PROTOCOL_COORDINATES,
        },
      },
      { v: 1, id: 'stop', op: 'driver.stop', args: {} },
    ]
    const run = Bun.spawnSync([
      process.execPath,
      'run',
      join(import.meta.dir, '..', 'bridge-e2e-desktop-driver.ts'),
      '--control-root',
      controlRoot,
    ], {
      stdin: Buffer.from(`${requests.map(request => JSON.stringify(request)).join('\n')}\n`),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CRAFT_DEBUG: 'false' },
    })
    expect(run.exitCode).toBe(0)
    expect(run.stderr.toString()).toBe('')
    const responses = run.stdout.toString().trim().split('\n').map(line => JSON.parse(line))
    expect(responses).toEqual([
      { v: 1, id: 'ready', ok: true, result: { state: 'ready', runtime: 'node' } },
      { v: 1, id: 'stop', ok: true, result: { state: 'stopped' } },
    ])
  })

  test('accepts the exact ready/state/stop envelopes without unsolicited or secret-bearing fields', async () => {
    const controlRoot = secureRoot()
    secureFile(join(controlRoot, 'control', 'ca.pem'), '-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----\n')
    const driver = new driverModule.DesktopBridgeE2EDriver(controlRoot)
    const ready = await driver.handle({
      v: 1,
      id: 'ready',
      op: 'driver.ready',
      args: {
        bridgeUrl: 'wss://bridge.localhost:4443',
        tlsServerName: 'bridge.localhost',
        caCertRef: { area: 'control', path: 'ca.pem' },
        protocol: driverModule.DESKTOP_BRIDGE_E2E_PROTOCOL_COORDINATES,
      },
    })
    expect(ready).toEqual({ v: 1, id: 'ready', ok: true, result: { state: 'ready' } })
    const state = await driver.handle({ v: 1, id: 'state', op: 'driver.state', args: {} })
    expect(state).toEqual({
      v: 1,
      id: 'state',
      ok: true,
      result: { state: 'ready', count: 0, connectorState: 'stopped' },
    })
    const authorityCounts = await driver.handle({ v: 1, id: 'counts', op: 'desktop.authority.counts', args: {} })
    expect(authorityCounts).toEqual({
      v: 1,
      id: 'counts',
      ok: true,
      result: {
        sendExecutionCount: 0,
        cancelExecutionCount: 0,
        idempotencyConflictCount: 0,
        droppedResultCount: 0,
        resyncRequiredResultCount: 0,
      },
    })
    const countsPath = join(controlRoot, 'state', 'desktop-driver-counts.json')
    expect(statSync(countsPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(countsPath, 'utf8'))).toMatchObject({
      v: 1,
      sendExecutionCount: 0,
      idempotencyConflictCount: 0,
      droppedResultCount: 0,
    })
    expect(JSON.stringify([ready, state])).not.toContain('BEGIN CERTIFICATE')
    expect(await driver.handle({ v: 1, id: 'stop', op: 'driver.stop', args: {} })).toEqual({
      v: 1, id: 'stop', ok: true, result: { state: 'stopped' },
    })
  })
})
