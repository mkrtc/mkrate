import {
  BridgeAuthorityStore,
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
  BridgeCredentialSaga,
  createBridgeProfile,
  getBridgeProfile,
  setBridgeProfile,
  validateBridgeUrl,
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
  readonly #credentialSaga: BridgeCredentialSaga
  readonly #authorityStore: BridgeAuthorityStore

  constructor(options: ElectronBridgeRuntimeOptions) {
    this.#allowInsecureLoopback = options.allowInsecureLoopback === true
    this.#credentialSaga = new BridgeCredentialSaga(options.credentials)
    this.#authorityStore = new BridgeAuthorityStore()
    const factory = options.runtimeFactory ?? (runtimeOptions => new DesktopBridgeRuntime(runtimeOptions))
    this.#runtime = factory({
      profile: getBridgeProfile(),
      sessions: createBridgeSessionPort(options.sessionManager),
      credentials: options.credentials,
      authorityStore: this.#authorityStore,
      commitEnrollment: (profile, instanceToken) => this.#credentialSaga.commitEnrollment(profile, instanceToken),
      clientVersion: options.clientVersion,
      allowInsecureLoopback: this.#allowInsecureLoopback,
    })
  }

  async start(): Promise<void> {
    await this.#credentialSaga.ensureRecovered()
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
      const existing = getBridgeProfile()
      if (!existing) return this.#runtime.getSafeState()
      await this.#runtime.prepareProfileClear()
      await this.#credentialSaga.clearProfile(existing)
      this.#authorityStore.clearProfile(existing.profileId)
      await this.#runtime.updateProfile(null)
      return this.#runtime.getSafeState()
    }

    if (request.enrollmentToken !== undefined && !isValidBridgeEnrollmentToken(request.enrollmentToken)) {
      throw new Error('Invalid Bridge enrollment token')
    }

    const existing = getBridgeProfile()
    const checked = validateBridgeUrl(request.url, { allowInsecureLoopback: this.#allowInsecureLoopback })
    if (!checked.ok) throw new Error(`Invalid Bridge URL (${checked.reason})`)
    const originChanged = !!existing && existing.url !== checked.url
    // Validate every field and mint the replacement profile id before any
    // destructive remote revoke/local clear. Invalid input leaves the old
    // profile fully operational.
    const preview = createBridgeProfile({
      ...(!originChanged && existing ? identityFields(existing) : {}),
      url: checked.url,
      displayName: request.displayName,
      enabled: request.enabled ?? true,
    }, originChanged ? null : existing, { allowInsecureLoopback: this.#allowInsecureLoopback })
    if (originChanged) {
      // Revoke the old remote instance first. Then clear its durable authority
      // before replacing config. If the new config write fails, the old profile
      // and encrypted credential remain locally recoverable but are already
      // proven revoked remotely; no destructive rollback is required.
      await this.#runtime.prepareProfileClear()
      this.#authorityStore.clearProfile(existing.profileId)
    }
    const profile = setBridgeProfile({
      profileId: preview.profileId,
      url: preview.url,
      displayName: preview.displayName,
      enabled: preview.enabled,
      ...(preview.deploymentId ? { deploymentId: preview.deploymentId } : {}),
      ...(preview.instanceId ? { instanceId: preview.instanceId } : {}),
    }, { allowInsecureLoopback: this.#allowInsecureLoopback })
    if (originChanged) {
      // Delete the old encrypted credential through the recoverable clear saga.
      // Its profile barrier is profile-id scoped and therefore preserves the
      // newly committed replacement profile.
      await this.#credentialSaga.clearProfile(existing)
    }
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

  ownerHidden(ownerId: string): void {
    this.#runtime.hidePairingOwner(ownerId)
  }

  ownerMinimized(ownerId: string): void {
    this.#runtime.minimizePairingOwner(ownerId)
  }

  ownerDestroyed(ownerId: string): void {
    this.#runtime.destroyPairingOwner(ownerId)
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
