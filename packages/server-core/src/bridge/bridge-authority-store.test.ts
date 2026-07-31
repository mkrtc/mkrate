import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeAuthorityStore } from './bridge-authority-store.ts';

let root: string | null = null;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null; });

function store(): BridgeAuthorityStore {
  root = mkdtempSync(join(tmpdir(), 'mkrate-bridge-authority-'));
  const value = new BridgeAuthorityStore(root);
  value.activate({ profileId: 'profile-1', deploymentId: 'deployment-1', instanceId: 'instance-1' });
  value.putBinding({ bindingId: 'binding-1', deviceId: 'device-1', deviceName: 'Phone', grantedCapabilities: ['session.cancel'], approvedAtMs: 1 });
  return value;
}

describe('BridgeAuthorityStore', () => {
  test('returns durable mutating results after restart and rejects conflicting reuse', () => {
    const first = store();
    expect(first.beginMutation('binding-1', 'request-1', { command: 'session.cancel', sessionId: 's1' }, 10)).toEqual({ kind: 'new' });
    first.completeMutation('binding-1', 'request-1', { outcome: 'success', result: { command: 'session.cancel', cancelled: true } }, 11);

    const restarted = new BridgeAuthorityStore(root!);
    restarted.activate({ profileId: 'profile-1', deploymentId: 'deployment-1', instanceId: 'instance-1' });
    expect(restarted.beginMutation('binding-1', 'request-1', { command: 'session.cancel', sessionId: 's1' }, 12)).toMatchObject({
      kind: 'completed', outcome: { outcome: 'success', result: { cancelled: true } },
    });
    expect(restarted.beginMutation('binding-1', 'request-1', { command: 'session.cancel', sessionId: 'other' }, 12)).toEqual({ kind: 'conflict' });
  });

  test('turns a crash-left in-flight mutation and replay gap into resync-required', () => {
    const first = store();
    first.beginMutation('binding-1', 'request-2', { command: 'session.cancel', sessionId: 's1' }, 10);
    const restarted = new BridgeAuthorityStore(root!);
    expect(restarted.beginMutation('binding-1', 'request-2', { command: 'session.cancel', sessionId: 's1' }, 11)).toEqual({ kind: 'resync-required' });
    expect(restarted.isResyncRequired('binding-1')).toBe(true);
  });

  test('persists bounded replay metadata and clears all binding state transactionally on revoke', () => {
    const first = store();
    first.saveReplay('binding-1', { sequence: 2, entries: [], snapshotCheckpoints: [0, 2], resyncRequired: true });
    const restarted = new BridgeAuthorityStore(root!);
    expect(restarted.loadReplay('binding-1')).toEqual({ sequence: 2, entries: [], snapshotCheckpoints: [0, 2], resyncRequired: true });
    restarted.removeBinding('binding-1');
    expect(restarted.listBindings()).toEqual([]);
    expect(restarted.loadReplay('binding-1')).toBeNull();
  });

  test('reloads stale instances under lock and preserves resync until explicit snapshot clear', () => {
    const first = store();
    const second = new BridgeAuthorityStore(root!);
    first.markResyncRequired('binding-1');
    second.saveReplay('binding-1', { sequence: 1, entries: [], snapshotCheckpoints: [0, 1], resyncRequired: false });
    expect(second.isResyncRequired('binding-1')).toBe(true);
    second.saveReplay('binding-1', { sequence: 2, entries: [], snapshotCheckpoints: [0, 2], resyncRequired: false }, { clearResync: true });
    expect(first.isResyncRequired('binding-1')).toBe(false);
  });

  test('fails closed when another authority transaction lock is present', () => {
    const value = store();
    writeFileSync(join(root!, 'authority-state.lock'), JSON.stringify({ pid: 999, createdAtMs: 1 }));
    expect(() => value.putBinding({
      bindingId: 'binding-2', deviceId: 'device-2', deviceName: 'Other',
      grantedCapabilities: ['session.cancel'], approvedAtMs: 2,
    })).toThrow('transaction lock is already held');
  });

  test('fails closed on corrupt or future authority state', () => {
    const first = store();
    void first;
    writeFileSync(join(root!, 'authority-state.json'), '{bad json');
    expect(() => new BridgeAuthorityStore(root!)).toThrow('invalid JSON');
  });
});
