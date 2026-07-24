/**
 * Child-process crash worker for A5 saga recovery tests.
 *
 * Runs one real saga against a real on-disk credential store + connections
 * repository, then hard-crashes (`process.exit`) at a configured barrier boundary
 * — either just before the side effect (`before`) or after the effect but before
 * its `:done` marker is written (`after`, the "status lies" window). The parent
 * sets up any prerequisite state in-process (shared on-disk config dir) and, after
 * the crash, runs recovery and asserts convergence.
 */

import { MemoryConnectionRepository } from '../repository.ts';
import { MemorySagaCoordinator, type SagaBarrierKind, type SagaStepPhase } from '../saga.ts';
import { CredentialManager } from '../../../credentials/manager.ts';

type OpRequest =
  | { kind: 'create'; apiKey?: string; expectedRootRevision: number }
  | { kind: 'setApiKey'; connectionId: string; apiKey: string; expectedRevision: number }
  | { kind: 'replaceApiKey'; connectionId: string; apiKey: string; expectedRevision: number }
  | { kind: 'clearApiKey'; connectionId: string; expectedRevision: number }
  | { kind: 'setCredentialMode'; connectionId: string; mode: 'none' | 'stored-api-key'; expectedRevision: number }
  | { kind: 'deleteConnection'; connectionId: string; expectedRootRevision: number }
  | { kind: 'updateConfig'; connectionId: string; patch: { name?: string; enabled?: boolean; proactiveRemoteSearch?: boolean }; apiKeyOp?: { kind: 'set'; apiKey: string } | { kind: 'clear' }; expectedRevision: number };

interface CrashRequest {
  configDir: string;
  op: OpRequest;
  crashBarrier: SagaBarrierKind;
  crashPhase: SagaStepPhase;
  /** Nth time the barrier/phase is hit before crashing (default 1). */
  occurrence?: number;
}

const raw = process.argv[2];
if (!raw) throw new Error('missing crash worker request');
const request = JSON.parse(raw) as CrashRequest;

const repo = new MemoryConnectionRepository({ configDir: request.configDir });
const manager = new CredentialManager({ credentialsConfigDir: request.configDir });
let hits = 0;
const coordinator = new MemorySagaCoordinator({
  repository: repo,
  credentialManager: manager,
  dir: repo.getDir(),
  leaseTimeoutMs: 8_000,
  hooks: {
    onStep: (ctx) => {
      if (ctx.mode === 'live' && ctx.barrier === request.crashBarrier && ctx.phase === request.crashPhase) {
        hits += 1;
        if (hits >= (request.occurrence ?? 1)) process.exit(37);
      }
    },
  },
});

async function runOp(op: OpRequest): Promise<void> {
  switch (op.kind) {
    case 'create':
      await coordinator.createConnection(
        { name: 'ChildConn', url: 'http://127.0.0.1:6333', collection: 'craft_memory', embedding: { model: 'm', dimension: 8 } },
        op.expectedRootRevision,
        op.apiKey,
      );
      return;
    case 'setApiKey':
      await coordinator.setApiKey(op.connectionId, op.apiKey, op.expectedRevision);
      return;
    case 'replaceApiKey':
      await coordinator.replaceApiKey(op.connectionId, op.apiKey, op.expectedRevision);
      return;
    case 'clearApiKey':
      await coordinator.clearApiKey(op.connectionId, op.expectedRevision);
      return;
    case 'setCredentialMode':
      await coordinator.setCredentialMode(op.connectionId, op.mode, op.expectedRevision);
      return;
    case 'deleteConnection':
      await coordinator.deleteConnection(op.connectionId, op.expectedRootRevision);
      return;
    case 'updateConfig':
      await coordinator.updateConnectionConfig(op.connectionId, op.patch, op.expectedRevision, op.apiKeyOp);
      return;
  }
}

runOp(request.op)
  .then(() => process.exit(0)) // crash point not hit — unexpected
  .catch((error) => {
    process.stderr.write(`worker error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
