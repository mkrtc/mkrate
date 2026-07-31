import type {
  DesktopBridgeCommandCapability,
  PairingRejectReason,
} from '@craft-agent/server-core/bridge'
import type { BridgeProfileUpdateRequest, ElectronBridgeRuntime } from './bridge-runtime.ts'
import { BRIDGE_IPC_CHANNELS } from '../../shared/bridge-ipc.ts'

export { BRIDGE_IPC_CHANNELS } from '../../shared/bridge-ipc.ts'

export interface BridgeIpcEventLike {
  readonly sender: { readonly id: number }
}

export interface BridgeIpcMainLike {
  handle(channel: string, listener: (event: BridgeIpcEventLike, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export interface RegisterBridgeIpcOptions {
  ipcMain: BridgeIpcMainLike
  runtime: ElectronBridgeRuntime
  isOwnerVisible: (event: BridgeIpcEventLike) => boolean
}

/**
 * Register direct local Electron IPC only. These channels are intentionally
 * absent from registerCoreRpcHandlers, registerAllRpcHandlers, and WsRpcServer.
 */
export function registerBridgeIpc(options: RegisterBridgeIpcOptions): () => void {
  const { ipcMain, runtime, isOwnerVisible } = options
  const registered: string[] = []
  let active = true
  const handle = (channel: string, listener: (event: BridgeIpcEventLike, ...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, listener)
    registered.push(channel)
  }
  const visibleOwner = (event: BridgeIpcEventLike): string => {
    if (!isOwnerVisible(event)) throw new Error('Pairing requires a visible local window')
    return ownerId(event)
  }

  try {
  handle(BRIDGE_IPC_CHANNELS.getState, (event) => {
    const owner = ownerId(event)
    if (!isOwnerVisible(event)) {
      runtime.closePairing(owner)
      return runtime.getSafeState()
    }
    return runtime.getSafeState(owner)
  })
  handle(BRIDGE_IPC_CHANNELS.updateProfile, (_event, request) =>
    runtime.updateProfile(request as BridgeProfileUpdateRequest | null))
  handle(BRIDGE_IPC_CHANNELS.openPairing, (event, allowManualCode) =>
    runtime.openPairing(visibleOwner(event), allowManualCode !== false))
  handle(BRIDGE_IPC_CHANNELS.closePairing, (event) =>
    runtime.closePairing(ownerId(event)))
  handle(BRIDGE_IPC_CHANNELS.approvePairing, (event, capabilities) =>
    runtime.approvePairing(visibleOwner(event), capabilities as readonly DesktopBridgeCommandCapability[]))
  handle(BRIDGE_IPC_CHANNELS.rejectPairing, (event, reason) =>
    runtime.rejectPairing(visibleOwner(event), reason as PairingRejectReason))
  handle(BRIDGE_IPC_CHANNELS.listBindings, () => runtime.listBindings())
  handle(BRIDGE_IPC_CHANNELS.revokeBinding, (_event, bindingId) =>
    runtime.revokeBinding(bindingId as string))
  } catch (error) {
    for (const channel of registered.reverse()) ipcMain.removeHandler(channel)
    throw error
  }

  return () => {
    if (!active) return
    active = false
    for (const channel of registered.reverse()) ipcMain.removeHandler(channel)
  }
}

function ownerId(event: BridgeIpcEventLike): string {
  if (!Number.isSafeInteger(event.sender.id) || event.sender.id < 0) throw new Error('Invalid local IPC sender')
  return `electron-web-contents:${event.sender.id}`
}
