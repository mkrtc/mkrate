/**
 * Exhaustive real cross-process crash + restart recovery for the A5 saga.
 *
 * For every operation class, a child bun process runs the saga against a real
 * on-disk credential store + connections repository and hard-crashes at EACH of
 * its write-ahead barriers, in BOTH windows — `before` (intent marker written,
 * effect not yet run) and `after` (effect ran, `:done` marker NOT yet written —
 * the "status lies" case). The parent then runs recovery and asserts the
 * universal invariants that must hold regardless of crash window:
 *   • the journal drains (no leftover in-flight saga),
 *   • the final state is ATOMIC — exactly the pre-saga OR the post-saga state,
 *   • credentialMode is consistent with actual key presence, and
 *   • the on-disk journal never contains the secret.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { MemoryConnectionRepository } from '../repository.ts';
import { MemorySagaCoordinator, SAGA_JOURNAL_FILE, type SagaBarrierKind, type SagaStepPhase } from '../index.ts';
import { CredentialManager } from '../../../credentials/manager.ts';

const WORKER_PATH = fileURLToPath(new URL('./saga-crash-worker.ts', import.meta.url));
const BASE = { name: 'ChildConn', url: 'http://127.0.0.1:6333', collection: 'craft_memory', embedding: { model: 'm', dimension: 8 } };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'saga-recovery-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function stack() {
  const repo = new MemoryConnectionRepository({ configDir: dir });
  const manager = new CredentialManager({ credentialsConfigDir: dir });
  const coordinator = new MemorySagaCoordinator({ repository: repo, credentialManager: manager, dir: repo.getDir(), leaseTimeoutMs: 8_000 });
  return { repo, manager, coordinator };
}

async function runChild(op: unknown, barrier: SagaBarrierKind, phase: SagaStepPhase): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(
    [process.execPath, WORKER_PATH, JSON.stringify({ configDir: dir, op, crashBarrier: barrier, crashPhase: phase })],
    { env: { ...process.env, CRAFT_CONFIG_DIR: dir }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${out}${err}` };
}

/** Assert a secret needle appears in NO captured surface: child output or the journal file. */
function assertNoSecretLeak(needles: string[], output: string): void {
  const journalPath = join(dir, 'memory', SAGA_JOURNAL_FILE);
  const journalText = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
  for (const needle of needles) {
    expect(output).not.toContain(needle);      // child stdout/stderr never leaks a secret
    expect(journalText).not.toContain(needle);  // journal never persists a secret
  }
}

interface Predicates {
  isPre(repo: MemoryConnectionRepository, manager: CredentialManager): Promise<boolean>;
  isPost(repo: MemoryConnectionRepository, manager: CredentialManager): Promise<boolean>;
}

interface RecoveryCase {
  name: string;
  barriers: SagaBarrierKind[];
  /** Every secret this case touches (setup + op). Scanned in child output + journal. */
  secrets: string[];
  /** Build prerequisite state in-process; return the worker op + predicates. */
  setup(s: ReturnType<typeof stack>): Promise<{ op: unknown } & Predicates>;
}

const CASES: RecoveryCase[] = [
  {
    name: 'create (no key)',
    barriers: ['config'],
    secrets: [],
    async setup() {
      return {
        op: { kind: 'create', expectedRootRevision: 0 },
        isPre: async (repo) => repo.listConnections().length === 0,
        isPost: async (repo, m) => repo.listConnections().length === 1 && (await m.getMemoryApiKey(repo.listConnections()[0]!.connectionId)) === null,
      };
    },
  },
  {
    name: 'create (with key)',
    barriers: ['stage', 'config', 'credential'],
    secrets: ['sk-create'],
    async setup() {
      return {
        op: { kind: 'create', apiKey: 'sk-create', expectedRootRevision: 0 },
        isPre: async (repo) => repo.listConnections().length === 0,
        isPost: async (repo, m) => {
          const list = repo.listConnections();
          return list.length === 1 && list[0]!.credentialMode === 'stored-api-key' && (await m.getMemoryApiKey(list[0]!.connectionId)) === 'sk-create';
        },
      };
    },
  },
  {
    name: 'setApiKey',
    barriers: ['credential', 'config'],
    secrets: ['sk-set'],
    async setup(s) {
      const c = await s.coordinator.createConnection(BASE, 0);
      return {
        op: { kind: 'setApiKey', connectionId: c.connectionId, apiKey: 'sk-set', expectedRevision: c.revision },
        isPre: async (repo, m) => repo.getConnection(c.connectionId)?.credentialMode === 'none' && (await m.getMemoryApiKey(c.connectionId)) === null,
        isPost: async (repo, m) => repo.getConnection(c.connectionId)?.credentialMode === 'stored-api-key' && (await m.getMemoryApiKey(c.connectionId)) === 'sk-set',
      };
    },
  },
  {
    name: 'replaceApiKey',
    barriers: ['stage', 'credential'],
    secrets: ['sk-old', 'sk-new'],
    async setup(s) {
      const c = await s.coordinator.createConnection(BASE, 0, 'sk-old');
      return {
        op: { kind: 'replaceApiKey', connectionId: c.connectionId, apiKey: 'sk-new', expectedRevision: c.revision },
        isPre: async (_r, m) => (await m.getMemoryApiKey(c.connectionId)) === 'sk-old',
        isPost: async (_r, m) => (await m.getMemoryApiKey(c.connectionId)) === 'sk-new',
      };
    },
  },
  {
    name: 'clearApiKey',
    barriers: ['config', 'credential'],
    secrets: ['sk-clear'],
    async setup(s) {
      const c = await s.coordinator.createConnection(BASE, 0, 'sk-clear');
      return {
        op: { kind: 'clearApiKey', connectionId: c.connectionId, expectedRevision: c.revision },
        isPre: async (repo, m) => repo.getConnection(c.connectionId)?.credentialMode === 'stored-api-key' && (await m.getMemoryApiKey(c.connectionId)) === 'sk-clear',
        isPost: async (repo, m) => repo.getConnection(c.connectionId)?.credentialMode === 'none' && (await m.getMemoryApiKey(c.connectionId)) === null,
      };
    },
  },
  {
    name: 'deleteConnection',
    barriers: ['config', 'credential'],
    secrets: ['sk-del'],
    async setup(s) {
      const c = await s.coordinator.createConnection(BASE, 0, 'sk-del');
      return {
        op: { kind: 'deleteConnection', connectionId: c.connectionId, expectedRootRevision: s.repo.getRootRevision() },
        isPre: async (repo, m) => repo.getConnection(c.connectionId) !== null && (await m.getMemoryApiKey(c.connectionId)) === 'sk-del',
        isPost: async (repo, m) => repo.getConnection(c.connectionId) === null && (await m.getMemoryApiKey(c.connectionId)) === null,
      };
    },
  },
  {
    name: 'updateConfig (config-only)',
    barriers: ['config'],
    secrets: [],
    async setup(s) {
      const c = await s.coordinator.createConnection(BASE, 0);
      return {
        op: { kind: 'updateConfig', connectionId: c.connectionId, patch: { name: 'Renamed' }, expectedRevision: c.revision },
        isPre: async (repo) => repo.getConnection(c.connectionId)?.name === 'ChildConn',
        isPost: async (repo) => repo.getConnection(c.connectionId)?.name === 'Renamed',
      };
    },
  },
  {
    name: 'updateConfig + set key',
    barriers: ['stage', 'credential', 'config'],
    secrets: ['sk-upd'],
    async setup(s) {
      const c = await s.coordinator.createConnection(BASE, 0);
      return {
        op: { kind: 'updateConfig', connectionId: c.connectionId, patch: { name: 'Renamed' }, apiKeyOp: { kind: 'set', apiKey: 'sk-upd' }, expectedRevision: c.revision },
        isPre: async (repo, m) => repo.getConnection(c.connectionId)?.name === 'ChildConn' && (await m.getMemoryApiKey(c.connectionId)) === null,
        isPost: async (repo, m) => repo.getConnection(c.connectionId)?.name === 'Renamed' && repo.getConnection(c.connectionId)?.credentialMode === 'stored-api-key' && (await m.getMemoryApiKey(c.connectionId)) === 'sk-upd',
      };
    },
  },
  // NOTE: setCredentialMode is a mode-only op whose meaningful crash scenario has a
  // deliberately-inconsistent (drifted) pre-state; it is covered by its own explicit
  // describe block below so the key invariant can be asserted directly.
];

describe('A5 saga: exhaustive real crash + restart recovery matrix', () => {
  for (const c of CASES) {
    for (const barrier of c.barriers) {
      for (const phase of ['before', 'after'] as SagaStepPhase[]) {
        test(`${c.name} — crash at ${barrier}:${phase} converges atomically`, async () => {
          rmSync(dir, { recursive: true, force: true });
          dir = mkdtempSync(join(tmpdir(), 'saga-recovery-'));
          const setup = stack();
          const { op, isPre, isPost } = await c.setup(setup);

          const { exitCode, output } = await runChild(op, barrier, phase);
          expect(exitCode).toBe(37); // crash point was actually hit
          // Secret hygiene: no secret this case touches may appear in the child's
          // stdout/stderr or the on-disk journal — even on a crash.
          assertNoSecretLeak(c.secrets, output);

          const { repo, manager, coordinator } = stack();
          await coordinator.ensureRecovered();

          // Journal drained.
          expect(coordinator.getJournalStore().listEntries()).toEqual([]);
          // Atomic: final state is exactly pre OR post — never partial.
          const pre = await isPre(repo, manager);
          const post = await isPost(repo, manager);
          expect(pre || post).toBe(true);
          // credentialMode ⇔ key presence consistency for any surviving connection.
          for (const conn of repo.listConnections()) {
            const hasKey = (await manager.getMemoryApiKey(conn.connectionId)) !== null;
            expect(conn.credentialMode === 'stored-api-key').toBe(hasKey);
          }
        });
      }
    }
  }
});

// setCredentialMode is a config-barrier, credential-untouching, mode-only op. Its
// meaningful crash scenario repairs a key/mode drift (key present, mode 'none'),
// whose pre-state is deliberately inconsistent — so it gets its own explicit block
// that asserts BOTH mode convergence AND the key invariant (the credential is never
// touched by setCredentialMode).
describe('A5 saga: setCredentialMode mode-only crash recovery', () => {
  for (const phase of ['before', 'after'] as SagaStepPhase[]) {
    test(`crash at config:${phase} converges the mode and never touches the key`, async () => {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'saga-recovery-'));
      const setup = stack();
      const created = await setup.coordinator.createConnection(BASE, 0, 'sk-mode');
      // Drift: key present but mode 'none'. setCredentialMode('stored-api-key') repairs it.
      const drifted = await setup.repo.applyConnectionConfig(created.connectionId, { credentialMode: 'none' }, created.revision);
      expect(drifted.credentialMode).toBe('none');

      const { exitCode, output } = await runChild(
        { kind: 'setCredentialMode', connectionId: created.connectionId, mode: 'stored-api-key', expectedRevision: drifted.revision },
        'config', phase,
      );
      expect(exitCode).toBe(37); // crash actually hit the config barrier's `${phase}` window
      assertNoSecretLeak(['sk-mode'], output); // the key must never leak to child output or journal

      const { repo, manager, coordinator } = stack();
      await coordinator.ensureRecovered();
      expect(coordinator.getJournalStore().listEntries()).toEqual([]);

      const conn = repo.getConnection(created.connectionId)!;
      // KEY INVARIANT: setCredentialMode is credential-untouching — the key is intact.
      const key = await manager.getMemoryApiKey(created.connectionId);
      expect(key).toBe('sk-mode');
      // DETERMINISTIC FORWARD REPAIR: the pre-state is an invalid drift this op exists
      // to repair, so recovery must NEVER leave the drift — it rolls forward to the
      // intended target for BOTH the before and after crash windows.
      expect(conn.credentialMode).toBe('stored-api-key');
      // MODE ⇔ KEY PRESENCE CONSISTENCY — asserted for both windows, no skip.
      const hasKey = key !== null;
      expect(conn.credentialMode === 'stored-api-key').toBe(hasKey);
    });
  }
});
