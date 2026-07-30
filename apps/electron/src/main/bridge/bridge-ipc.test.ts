import { describe, expect, test } from 'bun:test'
import { CHANNEL_MAP } from '../../transport/channel-map.ts'
import { BRIDGE_IPC_CHANNELS } from '../../shared/bridge-ipc.ts'
import {
  registerBridgeIpc,
  type BridgeIpcEventLike,
  type BridgeIpcMainLike,
} from './bridge-ipc.ts'
import { stopBridgeBeforeSessionCleanup, type ElectronBridgeRuntime } from './bridge-runtime.ts'

class FakeIpcMain implements BridgeIpcMainLike {
  readonly handlers = new Map<string, (event: BridgeIpcEventLike, ...args: unknown[]) => unknown>()
  readonly removed: string[] = []

  handle(channel: string, listener: (event: BridgeIpcEventLike, ...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.removed.push(channel)
    this.handlers.delete(channel)
  }

  invoke(channel: string, senderId: number, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return handler({ sender: { id: senderId } }, ...args)
  }
}

function fakeRuntime() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const state = { connectorState: 'stopped', terminalReason: null, authenticated: false, pairing: null, bindings: [], profile: null }
  const runtime = {
    getSafeState: (...args: unknown[]) => { calls.push({ method: 'getSafeState', args }); return state },
    updateProfile: (...args: unknown[]) => { calls.push({ method: 'updateProfile', args }); return state },
    openPairing: (...args: unknown[]) => { calls.push({ method: 'openPairing', args }); return state },
    closePairing: (...args: unknown[]) => { calls.push({ method: 'closePairing', args }); return state },
    approvePairing: (...args: unknown[]) => { calls.push({ method: 'approvePairing', args }); return state },
    rejectPairing: (...args: unknown[]) => { calls.push({ method: 'rejectPairing', args }); return state },
    listBindings: (...args: unknown[]) => { calls.push({ method: 'listBindings', args }); return [] },
    revokeBinding: (...args: unknown[]) => { calls.push({ method: 'revokeBinding', args }); return state },
  } as unknown as ElectronBridgeRuntime
  return { runtime, calls }
}

describe('Trusted Bridge local Electron IPC', () => {
  test('registers only direct IPC channels and binds pairing disclosure to a visible sender', async () => {
    const ipcMain = new FakeIpcMain()
    const { runtime, calls } = fakeRuntime()
    let visible = true
    const unregister = registerBridgeIpc({ ipcMain, runtime, isOwnerVisible: () => visible })

    expect([...ipcMain.handlers.keys()].sort()).toEqual(Object.values(BRIDGE_IPC_CHANNELS).sort())
    const rpcChannels = new Set(Object.values(CHANNEL_MAP).map(entry => entry.channel))
    for (const channel of Object.values(BRIDGE_IPC_CHANNELS)) expect(rpcChannels.has(channel)).toBe(false)

    ipcMain.invoke(BRIDGE_IPC_CHANNELS.getState, 42)
    expect(calls.at(-1)).toEqual({ method: 'getSafeState', args: ['electron-web-contents:42'] })

    ipcMain.invoke(BRIDGE_IPC_CHANNELS.openPairing, 42, true)
    expect(calls.at(-1)).toEqual({ method: 'openPairing', args: ['electron-web-contents:42', true] })

    visible = false
    ipcMain.invoke(BRIDGE_IPC_CHANNELS.getState, 42)
    expect(calls.slice(-2)).toEqual([
      { method: 'closePairing', args: ['electron-web-contents:42'] },
      { method: 'getSafeState', args: [] },
    ])
    expect(() => ipcMain.invoke(BRIDGE_IPC_CHANNELS.approvePairing, 42, ['session.list'])).toThrow(
      'Pairing requires a visible local window',
    )

    const bootstrap = 'never-return-or-log-this-bootstrap'
    await ipcMain.invoke(BRIDGE_IPC_CHANNELS.updateProfile, 42, {
      url: 'wss://bridge.example.test', displayName: 'Bridge', enrollmentToken: bootstrap,
    })
    expect(calls.at(-1)).toEqual({
      method: 'updateProfile',
      args: [{ url: 'wss://bridge.example.test', displayName: 'Bridge', enrollmentToken: bootstrap }],
    })

    unregister()
    expect(ipcMain.handlers.size).toBe(0)
    expect(ipcMain.removed.sort()).toEqual(Object.values(BRIDGE_IPC_CHANNELS).sort())
  })

  test('awaits Bridge stop before SessionManager cleanup', async () => {
    const order: string[] = []
    await stopBridgeBeforeSessionCleanup(
      { stop: async () => { order.push('bridge-stop-start'); await Promise.resolve(); order.push('bridge-stop-end') } },
      async () => { order.push('session-cleanup') },
    )
    expect(order).toEqual(['bridge-stop-start', 'bridge-stop-end', 'session-cleanup'])
  })
})
