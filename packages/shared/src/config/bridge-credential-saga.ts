import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  SagaLease,
  atomicWriteSecure,
  readTextFileBounded,
  removeFileSecure,
} from '../project-memory/connections/index.ts';
import type { CredentialManager } from '../credentials/manager.ts';
import {
  bridgeCredentialMatches,
  createBridgeCredentialEnvelope,
  type BridgeCredentialEnvelope,
} from '../credentials/bridge-credential.ts';
import { randomUuid } from '../utils/uuid.ts';
import { getConfigDir } from './paths.ts';
import { clearBridgeProfile, getBridgeProfile, setBridgeProfile } from './bridge-config.ts';
import { sanitizeStoredBridgeProfile, type BridgeProfile } from './bridge-profile.ts';

const VERSION = 1 as const;
const MAX_BYTES = 1024 * 1024;
const FILE = 'credential-saga.json';
const LEASE = 'credential-saga.lock';

type Operation = 'enroll' | 'clear';
type Barrier = 'stage' | 'credential' | 'profile';
type Status = 'prepared' | `${Barrier}:doing` | `${Barrier}:done` | 'completed' | 'quarantined';

interface ProfileTarget {
  profileId: string;
  url: string;
  displayName: string;
  enabled: boolean;
  deploymentId?: string;
  instanceId?: string;
}

interface Entry {
  version: typeof VERSION;
  sagaId: string;
  operation: Operation;
  status: Status;
  profileId: string;
  before: ProfileTarget | null;
  after: ProfileTarget | null;
  stagedSlot: 'before' | 'after' | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface BridgeCredentialSagaHooks {
  onBarrier?: (event: { operation: Operation; barrier: Barrier; phase: 'before' | 'after'; sagaId: string }) => void | Promise<void>;
  onStageCleanup?: (event: { operation: Operation; sagaId: string }) => void | Promise<void>;
}

export class BridgeCredentialSagaError extends Error {
  constructor(readonly code: 'corrupt-journal' | 'orphan-stage' | 'conflict' | 'quarantined', message: string) {
    super(message);
    this.name = 'BridgeCredentialSagaError';
  }
}

/**
 * Crash-recoverable coordinator for the only two profile/credential mutations:
 * enrollment commit and explicit profile clear. The journal is strictly
 * secret-free. Instance tokens exist only in CredentialManager encrypted staging
 * and the final encrypted credential account. Enrollment bootstrap material is
 * never accepted by this API.
 */
export class BridgeCredentialSaga {
  private readonly dir: string;
  private readonly path: string;
  private readonly backup: string;
  private readonly lease: SagaLease;
  private recovery: Promise<void> | null = null;

  constructor(
    private readonly credentials: CredentialManager,
    private readonly hooks: BridgeCredentialSagaHooks = {},
    dir = join(getConfigDir(), 'bridge'),
  ) {
    this.dir = dir;
    this.path = join(dir, FILE);
    this.backup = `${this.path}.bak`;
    this.lease = new SagaLease({ dir, leasePath: join(dir, LEASE) });
  }

  ensureRecovered(): Promise<void> {
    this.recovery ??= this.lease.withLease(() => this.recoverLocked()).catch(error => {
      this.recovery = null;
      throw error;
    });
    return this.recovery;
  }

  async commitEnrollment(profile: BridgeProfile, instanceToken: string): Promise<BridgeProfile> {
    if (!profile.deploymentId || !profile.instanceId) throw new Error('Bridge enrollment identity is incomplete');
    await this.ensureRecovered();
    return this.lease.withLease(async () => {
      await this.recoverLocked();
      const sagaId = randomUuid();
      const envelope = createBridgeCredentialEnvelope({
        origin: profile.url,
        profileId: profile.profileId,
        deploymentId: profile.deploymentId!,
        instanceId: profile.instanceId!,
        instanceToken,
      });
      let entry: Entry = {
        version: VERSION,
        sagaId,
        operation: 'enroll',
        status: 'prepared',
        profileId: profile.profileId,
        before: target(getBridgeProfile()),
        after: target(profile),
        stagedSlot: 'after',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };
      this.write(entry);
      entry = await this.barrier(entry, 'stage', async () => this.credentials.stageBridgeSagaCredential(sagaId, 'after', envelope));
      entry = await this.barrier(entry, 'credential', async () => this.credentials.setBridgeInstanceCredential(envelope));
      let committed!: BridgeProfile;
      entry = await this.barrier(entry, 'profile', async () => { committed = persistTarget(entry.after!); });
      await this.credentials.deleteStagedBridgeSagaCredential(sagaId, 'after');
      await this.hooks.onStageCleanup?.({ operation: 'enroll', sagaId });
      this.finish(entry);
      return committed;
    });
  }

  async clearProfile(profile: BridgeProfile): Promise<void> {
    await this.ensureRecovered();
    await this.lease.withLease(async () => {
      await this.recoverLocked();
      const sagaId = randomUuid();
      let beforeCredential: BridgeCredentialEnvelope | null = null;
      try { beforeCredential = await this.credentials.getBridgeInstanceCredential(profile.profileId); } catch { /* legacy/unbound is deleted, never used */ }
      let entry: Entry = {
        version: VERSION,
        sagaId,
        operation: 'clear',
        status: 'prepared',
        profileId: profile.profileId,
        before: target(profile),
        after: null,
        stagedSlot: beforeCredential ? 'before' : null,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };
      this.write(entry);
      if (beforeCredential) entry = await this.barrier(entry, 'stage', async () => this.credentials.stageBridgeSagaCredential(sagaId, 'before', beforeCredential!));
      entry = await this.barrier(entry, 'credential', async () => { await this.credentials.deleteBridgeInstanceToken(profile.profileId); });
      entry = await this.barrier(entry, 'profile', async () => {
        if (getBridgeProfile()?.profileId === profile.profileId) clearBridgeProfile();
      });
      if (beforeCredential) await this.credentials.deleteStagedBridgeSagaCredential(sagaId, 'before');
      await this.hooks.onStageCleanup?.({ operation: 'clear', sagaId });
      this.finish(entry);
    });
  }

  private async recoverLocked(): Promise<void> {
    const entry = this.load();
    const stagedIds = await this.credentials.listBridgeSagaStageSagaIds();
    if (!entry) {
      if (stagedIds.length > 0) throw new BridgeCredentialSagaError('orphan-stage', 'Orphaned encrypted Bridge saga staging requires operator recovery');
      return;
    }
    if (entry.status === 'quarantined') throw new BridgeCredentialSagaError('quarantined', 'Bridge credential saga is quarantined');
    if (stagedIds.some(id => id !== entry.sagaId)) throw new BridgeCredentialSagaError('orphan-stage', 'Unexpected encrypted Bridge saga staging requires operator recovery');

    if (entry.operation === 'enroll') {
      const envelope = await this.credentials.readStagedBridgeSagaCredential(entry.sagaId, 'after');
      if (!entry.after) return this.quarantine(entry, envelope, 'Enrollment target is missing');
      const binding = { origin: entry.after.url, profileId: entry.after.profileId, deploymentId: entry.after.deploymentId!, instanceId: entry.after.instanceId! };
      if (!envelope) {
        // Cleanup may delete encrypted staging just before a crash. Treat the
        // operation as committed only when both final stores independently
        // prove the exact journal binding; otherwise fail closed.
        let committed: BridgeCredentialEnvelope | null = null;
        try { committed = await this.credentials.getBridgeInstanceCredential(entry.profileId); } catch { /* conflict below */ }
        const committedProfile = getBridgeProfile();
        if (committed && committedProfile && sameTarget(committedProfile, entry.after)
          && bridgeCredentialMatches(committed, binding)) {
          this.finish(entry);
          return;
        }
        return this.quarantine(entry, null, 'Enrollment staging is missing and final state is not committed');
      }
      if (!bridgeCredentialMatches(envelope, binding)) return this.quarantine(entry, envelope, 'Enrollment staging binding conflicts with journal');
      const currentProfile = getBridgeProfile();
      if (currentProfile && !sameTarget(currentProfile, entry.before) && !sameTarget(currentProfile, entry.after)) {
        return this.quarantine(entry, envelope, 'Bridge profile changed outside the enrollment saga');
      }
      let current: BridgeCredentialEnvelope | null = null;
      try { current = await this.credentials.getBridgeInstanceCredential(entry.profileId); } catch { /* replace legacy/unbound only under journal authority */ }
      if (current && JSON.stringify(current) !== JSON.stringify(envelope)) {
        return this.quarantine(entry, envelope, 'Bridge credential changed outside the enrollment saga');
      }
      await this.credentials.setBridgeInstanceCredential(envelope);
      persistTarget(entry.after);
      await this.credentials.deleteStagedBridgeSagaCredential(entry.sagaId, 'after');
      this.finish(entry);
      return;
    }

    const stagedBefore = entry.stagedSlot === 'before'
      ? await this.credentials.readStagedBridgeSagaCredential(entry.sagaId, 'before')
      : null;
    const currentProfile = getBridgeProfile();
    if (currentProfile?.profileId === entry.profileId && !sameTarget(currentProfile, entry.before)) {
      return this.quarantine(entry, stagedBefore, 'Bridge profile changed outside the clear saga');
    }
    let currentCredential: BridgeCredentialEnvelope | null = null;
    try { currentCredential = await this.credentials.getBridgeInstanceCredential(entry.profileId); } catch { /* legacy/unbound clear remains allowed */ }
    if (currentCredential && (!stagedBefore || JSON.stringify(currentCredential) !== JSON.stringify(stagedBefore))) {
      return this.quarantine(entry, stagedBefore, 'Bridge credential changed outside the clear saga');
    }
    await this.credentials.deleteBridgeInstanceToken(entry.profileId);
    if (currentProfile?.profileId === entry.profileId) clearBridgeProfile();
    if (entry.stagedSlot === 'before') await this.credentials.deleteStagedBridgeSagaCredential(entry.sagaId, 'before');
    this.finish(entry);
  }

  private async barrier(entry: Entry, barrier: Barrier, effect: () => Promise<void> | void): Promise<Entry> {
    let next = { ...entry, status: `${barrier}:doing` as Status, updatedAtMs: Date.now() };
    this.write(next);
    await this.hooks.onBarrier?.({ operation: entry.operation, barrier, phase: 'before', sagaId: entry.sagaId });
    await effect();
    next = { ...next, status: `${barrier}:done` as Status, updatedAtMs: Date.now() };
    this.write(next);
    await this.hooks.onBarrier?.({ operation: entry.operation, barrier, phase: 'after', sagaId: entry.sagaId });
    return next;
  }

  private async quarantine(entry: Entry, envelope: BridgeCredentialEnvelope | null, message: string): Promise<never> {
    if (envelope && entry.stagedSlot) {
      await this.credentials.quarantineBridgeSagaCredential(
        entry.sagaId,
        entry.stagedSlot,
        randomBytes(8).toString('hex'),
        envelope,
      );
      await this.credentials.deleteStagedBridgeSagaCredential(entry.sagaId, entry.stagedSlot);
    }
    this.write({ ...entry, status: 'quarantined', updatedAtMs: Date.now() });
    throw new BridgeCredentialSagaError('conflict', message);
  }

  private finish(entry: Entry): void {
    this.write({ ...entry, status: 'completed', updatedAtMs: Date.now() });
    removeFileSecure(this.path);
    try { removeFileSecure(this.backup); } catch { /* best effort */ }
  }

  private load(): Entry | null {
    const primary = this.read(this.path);
    if (primary) return primary;
    const backup = this.read(this.backup);
    if (backup) return backup;
    const p = readTextFileBounded(this.path, MAX_BYTES);
    const b = readTextFileBounded(this.backup, MAX_BYTES);
    if (p.status === 'missing' && b.status === 'missing') return null;
    throw new BridgeCredentialSagaError('corrupt-journal', 'Bridge credential saga journal is unreadable or invalid');
  }

  private read(path: string): Entry | null {
    const read = readTextFileBounded(path, MAX_BYTES);
    if (read.status !== 'ok') return null;
    try {
      const raw = JSON.parse(read.text) as unknown;
      return validateEntry(raw) ? raw : null;
    } catch { return null; }
  }

  private write(entry: Entry): void {
    const current = this.read(this.path);
    if (current) atomicWriteSecure(this.dir, this.backup, `${JSON.stringify(current, null, 2)}\n`);
    atomicWriteSecure(this.dir, this.path, `${JSON.stringify(entry, null, 2)}\n`);
  }
}

function target(profile: BridgeProfile | null): ProfileTarget | null {
  if (!profile) return null;
  return {
    profileId: profile.profileId,
    url: profile.url,
    displayName: profile.displayName,
    enabled: profile.enabled,
    ...(profile.deploymentId ? { deploymentId: profile.deploymentId } : {}),
    ...(profile.instanceId ? { instanceId: profile.instanceId } : {}),
  };
}

function persistTarget(value: ProfileTarget): BridgeProfile {
  return setBridgeProfile(value, { allowInsecureLoopback: true });
}

function sameTarget(profile: BridgeProfile, expected: ProfileTarget | null): boolean {
  return expected !== null && JSON.stringify(target(profile)) === JSON.stringify(expected);
}

function validateEntry(raw: unknown): raw is Entry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  const keys = ['version', 'sagaId', 'operation', 'status', 'profileId', 'before', 'after', 'stagedSlot', 'createdAtMs', 'updatedAtMs'];
  if (Object.keys(r).length !== keys.length || Object.keys(r).some(key => !keys.includes(key))) return false;
  if (r.version !== VERSION || typeof r.sagaId !== 'string' || typeof r.profileId !== 'string') return false;
  if (r.operation !== 'enroll' && r.operation !== 'clear') return false;
  if (typeof r.status !== 'string' || !['prepared', 'stage:doing', 'stage:done', 'credential:doing', 'credential:done', 'profile:doing', 'profile:done', 'completed', 'quarantined'].includes(r.status)) return false;
  if (r.stagedSlot !== null && r.stagedSlot !== 'before' && r.stagedSlot !== 'after') return false;
  if (typeof r.createdAtMs !== 'number' || !Number.isFinite(r.createdAtMs) || r.createdAtMs < 0
    || typeof r.updatedAtMs !== 'number' || !Number.isFinite(r.updatedAtMs) || r.updatedAtMs < r.createdAtMs) return false;
  if (!validTarget(r.before) || !validTarget(r.after)) return false;
  if (r.operation === 'enroll') {
    return r.after !== null && r.after.profileId === r.profileId
      && typeof r.after.deploymentId === 'string' && typeof r.after.instanceId === 'string'
      && r.stagedSlot === 'after';
  }
  return r.before !== null && r.before.profileId === r.profileId
    && r.after === null && (r.stagedSlot === null || r.stagedSlot === 'before');
}

function validTarget(raw: unknown): raw is ProfileTarget | null {
  if (raw === null) return true;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  const keys = new Set(['profileId', 'url', 'displayName', 'enabled', 'deploymentId', 'instanceId']);
  if (Object.keys(r).some(key => !keys.has(key))) return false;
  const sanitized = sanitizeStoredBridgeProfile({ ...r, createdAt: 1, updatedAt: 1 });
  if (!sanitized) return false;
  const normalized = target(sanitized);
  return normalized !== null && JSON.stringify(normalized) === JSON.stringify(raw);
}
