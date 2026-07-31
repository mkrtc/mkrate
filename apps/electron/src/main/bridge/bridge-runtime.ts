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
  readonly #credentialSaga: BridgeCredentialSaga
  readonly #options: ElectronBridgeRuntimeOptions
  #authorityStore: BridgeAuthorityStore | null = null
  #runtime: DesktopBridgeRuntime | null = null
  #startPromise: Promise<void> | null = null

  constructor(options: ElectronBridgeRuntimeOptions) {
    this.#allowInsecureLoopback = options.allowInsecureLoopback === true
    this.#credentialSaga = new BridgeCredentialSaga(options.credentials)
    this.#options = options
  }

  start(): Promise<void> {
    if (!this.#startPromise) {
      this.#startPromise = this.#startAfterRecovery().catch(error => {
        this.#startPromise = null
        throw error
      })
    }
    return this.#startPromise
  }

  async #startAfterRecovery(): Promise<void> {
    // Recovery may commit or remove the profile. Nothing profile-bound may be
    // read or hydrated until the saga has reached a durable terminal state.
    await this.#credentialSaga.ensureRecovered()
    const profile = getBridgeProfile()
    const authorityStore = new BridgeAuthorityStore()
    const factory = this.#options.runtimeFactory ?? (runtimeOptions => new DesktopBridgeRuntime(runtimeOptions))
    const runtime = factory({
      profile,
      sessions: createBridgeSessionPort(this.#options.sessionManager),
      credentials: this.#options.credentials,
      authorityStore,
      commitEnrollment: (nextProfile, instanceToken) => this.#credentialSaga.commitEnrollment(nextProfile, instanceToken),
      clientVersion: this.#options.clientVersion,
      allowInsecureLoopback: this.#allowInsecureLoopback,
    })
    this.#authorityStore = authorityStore
    this.#runtime = runtime
    runtime.start()
  }

  async stop(): Promise<void> {
    if (this.#startPromise) {
      try { await this.#startPromise } catch { return }
    }
    await this.#runtime?.stop()
  }

  #requireRuntime(): DesktopBridgeRuntime {
    if (!this.#runtime) throw new Error('Bridge runtime has not started')
    return this.#runtime
  }

  #requireAuthorityStore(): BridgeAuthorityStore {
    if (!this.#authorityStore) throw new Error('Bridge runtime has not started')
    return this.#authorityStore
  }

  composeSessionEventSink(baseSink: Parameters<DesktopBridgeRuntime['composeSessionEventSink']>[0]) {
    return this.#requireRuntime().composeSessionEventSink(baseSink)
  }

  async updateProfile(request: BridgeProfileUpdateRequest | null): Promise<DesktopBridgeSafeState> {
    const runtime = this.#requireRuntime()
    const authorityStore = this.#requireAuthorityStore()
    if (request === null) {
      const existing = getBridgeProfile()
      if (!existing) return runtime.getSafeState()
      await runtime.prepareProfileClear()
      await this.#credentialSaga.clearProfile(existing)
      authorityStore.clearProfile(existing.profileId)
      await runtime.updateProfile(null)
      return runtime.getSafeState()
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
      await runtime.prepareProfileClear()
      authorityStore.clearProfile(existing.profileId)
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
    await runtime.updateProfile(profile, request.enrollmentToken)
    return runtime.getSafeState()
  }

  getSafeState(ownerId?: string): DesktopBridgeSafeState {
    return this.#requireRuntime().getSafeState(ownerId)
  }

  openPairing(ownerId: string, allowManualCode = true): DesktopBridgeSafeState {
    const runtime = this.#requireRuntime()
    runtime.openPairing(ownerId, { allowManualCode })
    return runtime.getSafeState(ownerId)
  }

  closePairing(ownerId: string): DesktopBridgeSafeState {
    const runtime = this.#requireRuntime()
    runtime.closePairing(ownerId)
    return runtime.getSafeState(ownerId)
  }

  ownerHidden(ownerId: string): void {
    this.#requireRuntime().hidePairingOwner(ownerId)
  }

  ownerMinimized(ownerId: string): void {
    this.#requireRuntime().minimizePairingOwner(ownerId)
  }

  ownerDestroyed(ownerId: string): void {
    this.#requireRuntime().destroyPairingOwner(ownerId)
  }

  async approvePairing(ownerId: string, grantedCapabilities: readonly DesktopBridgeCommandCapability[]): Promise<DesktopBridgeSafeState> {
    const runtime = this.#requireRuntime()
    await runtime.approvePairing(ownerId, grantedCapabilities)
    return runtime.getSafeState(ownerId)
  }

  async rejectPairing(ownerId: string, reason: PairingRejectReason): Promise<DesktopBridgeSafeState> {
    const runtime = this.#requireRuntime()
    await runtime.rejectPairing(ownerId, reason)
    return runtime.getSafeState(ownerId)
  }

  listBindings(): readonly DesktopBridgeBindingMetadata[] {
    return this.#requireRuntime().listBindings()
  }

  async revokeBinding(bindingId: string): Promise<DesktopBridgeSafeState> {
    const runtime = this.#requireRuntime()
    await runtime.revokeBinding(bindingId)
    return runtime.getSafeState()
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
