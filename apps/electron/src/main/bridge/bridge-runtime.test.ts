import { describe, expect, mock, test } from 'bun:test'

const order: string[] = []
let recoveryBehavior: () => Promise<void> = async () => {}
let profileValue: unknown = null
let recoveryCalls = 0

mock.module('@craft-agent/shared/config', () => ({
  BridgeCredentialSaga: class {
    constructor() { order.push('saga-created') }
    async ensureRecovered() {
      recoveryCalls += 1
      order.push('recovery-started')
      await recoveryBehavior()
      order.push('recovery-finished')
    }
    async commitEnrollment() {}
    async clearProfile() {}
  },
  createBridgeProfile: (value: unknown) => value,
  getBridgeProfile: () => {
    order.push('profile-read')
    return profileValue
  },
  isValidBridgeEnrollmentToken: () => true,
  setBridgeProfile: (value: unknown) => value,
  validateBridgeUrl: (url: string) => ({ ok: true, url }),
}))

mock.module('@craft-agent/server-core/bridge', () => ({
  BridgeAuthorityStore: class {
    constructor() { order.push('authority-created') }
    clearProfile() {}
  },
  DesktopBridgeRuntime: class {},
  createBridgeSessionPort: () => {
    order.push('session-port-created')
    return {}
  },
  isValidBridgeEnrollmentToken: () => true,
}))

const { ElectronBridgeRuntime } = await import('./bridge-runtime.ts')

function reset() {
  order.length = 0
  recoveryCalls = 0
  profileValue = null
  recoveryBehavior = async () => {}
}

describe('ElectronBridgeRuntime startup recovery order', () => {
  test('recovers the credential saga before reading the profile or constructing durable authority/runtime state', async () => {
    reset()
    let releaseRecovery: () => void = () => { throw new Error('Recovery was not started') }
    recoveryBehavior = () => new Promise<void>(resolve => { releaseRecovery = resolve })
    const inner = {
      start: mock(() => { order.push('runtime-started') }),
      stop: mock(async () => {}),
    }
    const wrapper = new ElectronBridgeRuntime({
      sessionManager: {} as never,
      credentials: {} as never,
      clientVersion: '1.0.0-test',
      runtimeFactory: () => {
        order.push('runtime-created')
        return inner as never
      },
    })

    expect(order).toEqual(['saga-created'])
    const starting = wrapper.start()
    await Promise.resolve()
    expect(order).toEqual(['saga-created', 'recovery-started'])
    releaseRecovery()
    await starting

    const recovered = order.indexOf('recovery-finished')
    expect(order.indexOf('profile-read')).toBeGreaterThan(recovered)
    expect(order.indexOf('authority-created')).toBeGreaterThan(recovered)
    expect(order.indexOf('runtime-created')).toBeGreaterThan(recovered)
    expect(order.at(-1)).toBe('runtime-started')
  })

  test('fails closed on recovery error, then retries once with single-flight construction and the recovered profile', async () => {
    reset()
    const recoveredProfile = { profileId: 'recovered-profile' }
    let fail = true
    recoveryBehavior = async () => {
      if (fail) throw new Error('simulated recovery failure')
      profileValue = recoveredProfile
    }
    const capturedProfiles: unknown[] = []
    const inner = { start: mock(() => {}), stop: mock(async () => {}) }
    const wrapper = new ElectronBridgeRuntime({
      sessionManager: {} as never,
      credentials: {} as never,
      clientVersion: '1.0.0-test',
      runtimeFactory: options => {
        capturedProfiles.push(options.profile)
        return inner as never
      },
    })

    expect(() => wrapper.getSafeState()).toThrow('Bridge runtime has not started')
    await expect(wrapper.start()).rejects.toThrow('simulated recovery failure')
    expect(capturedProfiles).toEqual([])
    expect(order).not.toContain('profile-read')
    expect(order).not.toContain('authority-created')

    fail = false
    const first = wrapper.start()
    const second = wrapper.start()
    expect(first).toBe(second)
    await Promise.all([first, second])
    expect(recoveryCalls).toBe(2)
    expect(capturedProfiles).toEqual([recoveredProfile])
    expect(inner.start).toHaveBeenCalledTimes(1)
  })
})
