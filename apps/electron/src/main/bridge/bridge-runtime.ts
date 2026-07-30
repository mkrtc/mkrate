import {
  DesktopBridgeRuntime,
  createBridgeSessionPort,
  isValidBridgeEnrollmentToken,
  type DesktopBridgeBindingMetadata,
  type DesktopBridgeCommandCapability,
  type DesktopBridgeRuntimeOptions,
  type DesktopBridgeSafeState,
  type PairingRejectReason,
} from '@craft-agent/server-core/bridge'
import type { SessionManager } from '@craft-agent/server-core/sessions'
import {
  clearBridgeProfile,
  getBridgeProfile,
  setBridgeProfile,
  type BridgeProfile,
} from '@craft-agent/shared/config'
import type { CredentialManager } from '@craft-agent/shared/credentials'
import type { BridgeProfileUpdateRequest } from '../../shared/types.ts'

export type { BridgeProfileUpdateRequest } from '../../shared/types.ts'

export interface ElectronBridgeRuntimeOptions {
  sessionManager: SessionManager
  credentials: CredentialManager
  clientVersion: string
  allowInsecureLoopback?: boolean
  runtimeFactory?: (options: DesktopBridgeRuntimeOptions) => DesktopBridgeRuntime
}

/**
 * Electron-owned wrapper around the server-core Bridge runtime.
 * Persistence is limited to the normal non-secret Bridge profile; bootstrap
 * material crosses only the direct local IPC call into runtime construction.
 */
export class ElectronBridgeRuntime {
  readonly #allowInsecureLoopback: boolean
  readonly #runtime: DesktopBridgeRuntime

  constructor(options: ElectronBridgeRuntimeOptions) {
    this.#allowInsecureLoopback = options.allowInsecureLoopback === true
    const factory = options.runtimeFactory ?? (runtimeOptions => new DesktopBridgeRuntime(runtimeOptions))
    this.#runtime = factory({
      profile: getBridgeProfile(),
      sessions: createBridgeSessionPort(options.sessionManager),
      credentials: options.credentials,
      clientVersion: options.clientVersion,
      allowInsecureLoopback: this.#allowInsecureLoopback,
    })
  }

  start(): void {
    this.#runtime.start()
  }

  stop(): Promise<void> {
    return this.#runtime.stop()
  }

  composeSessionEventSink(baseSink: Parameters<DesktopBridgeRuntime['composeSessionEventSink']>[0]) {
    return this.#runtime.composeSessionEventSink(baseSink)
  }

  async updateProfile(request: BridgeProfileUpdateRequest | null): Promise<DesktopBridgeSafeState> {
    if (request === null) {
      clearBridgeProfile()
      await this.#runtime.updateProfile(null)
      return this.#runtime.getSafeState()
    }

    if (request.enrollmentToken !== undefined && !isValidBridgeEnrollmentToken(request.enrollmentToken)) {
      throw new Error('Invalid Bridge enrollment token')
    }

    const existing = getBridgeProfile()
    const profile = setBridgeProfile({
      ...(existing ? identityFields(existing) : {}),
      url: request.url,
      displayName: request.displayName,
      enabled: request.enabled ?? true,
    }, { allowInsecureLoopback: this.#allowInsecureLoopback })
    await this.#runtime.updateProfile(profile, request.enrollmentToken)
    return this.#runtime.getSafeState()
  }

  getSafeState(ownerId?: string): DesktopBridgeSafeState {
    return this.#runtime.getSafeState(ownerId)
  }

  openPairing(ownerId: string, allowManualCode = true): DesktopBridgeSafeState {
    this.#runtime.openPairing(ownerId, { allowManualCode })
    return this.#runtime.getSafeState(ownerId)
  }

  closePairing(ownerId: string): DesktopBridgeSafeState {
    this.#runtime.closePairing(ownerId)
    return this.#runtime.getSafeState(ownerId)
  }

  async approvePairing(ownerId: string, grantedCapabilities: readonly DesktopBridgeCommandCapability[]): Promise<DesktopBridgeSafeState> {
    await this.#runtime.approvePairing(ownerId, grantedCapabilities)
    return this.#runtime.getSafeState(ownerId)
  }

  async rejectPairing(ownerId: string, reason: PairingRejectReason): Promise<DesktopBridgeSafeState> {
    await this.#runtime.rejectPairing(ownerId, reason)
    return this.#runtime.getSafeState(ownerId)
  }

  listBindings(): readonly DesktopBridgeBindingMetadata[] {
    return this.#runtime.listBindings()
  }

  async revokeBinding(bindingId: string): Promise<DesktopBridgeSafeState> {
    await this.#runtime.revokeBinding(bindingId)
    return this.#runtime.getSafeState()
  }
}

export async function stopBridgeBeforeSessionCleanup(
  runtime: Pick<ElectronBridgeRuntime, 'stop'> | null,
  cleanupSessionManager: () => Promise<void>,
): Promise<void> {
  try {
    await runtime?.stop()
  } finally {
    await cleanupSessionManager()
  }
}

function identityFields(profile: BridgeProfile): Pick<BridgeProfile, 'profileId'> & Partial<Pick<BridgeProfile, 'deploymentId' | 'instanceId'>> {
  return {
    profileId: profile.profileId,
    ...(profile.deploymentId ? { deploymentId: profile.deploymentId } : {}),
    ...(profile.instanceId ? { instanceId: profile.instanceId } : {}),
  }
}
