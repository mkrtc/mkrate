# ADR A0 — Post-Hoc Project Memory Discovery Re-Baseline

**Date (authoritative):** Friday, July 24, 2026 (GMT+3)
**Implementation baseline SHA:** `ce02a3b359fe35db328fcf3e64a34a473bec76a5` on `main`
**Artifact branch:** `docs/a0-posthoc-rebaseline` (the reviewed docs commit is a docs-only descendant of the implementation baseline)
**Scope:** docs-only post-hoc verification and A8-style closure baseline

## 1. Status and decision

The historical A0 documents described a pre-implementation dispatch gate. That sequence was overtaken by implementation that landed after the original docs and is already present at this baseline:

- `1577b11` — repository path, bounded-I/O, durability, and concurrency hardening (A1/A2 class)
- `aaeef98` — credential backend and manager hardening (A3 class)
- `2c961d1` — managed-reference resolver and Qdrant transport guards (A6/A7 class)
- `122f176` — memory connection service with credential coordination

All four commits are ancestors of `ce02a3b359fe35db328fcf3e64a34a473bec76a5`. Therefore:

1. A0 is no longer a valid precondition for dispatching A1–A7.
2. This re-baseline treats A0 as a **post-hoc verification / A8-style closure baseline** over the landed code.
3. The former A4a “first worker” is **moot and must not be dispatched**. Its proposed contract files already exist and are covered by the passing domain suite.
4. A1/A2/A3/A6/A7-class work is implemented and passes the recorded Linux baseline at the scoped guarantees below.
5. The durable, secret-free A5 saga journal and startup recovery landed in `72e6684` and passed independent security/crash audit.
6. Missing macOS/Windows evidence and the final A8-style integrated review remain prerequisites for any Wave B/C or release-readiness claim.

Invalid historical SHA and topology anchors have been removed; only the real baseline above governs this decision.

## 2. Corrected finding disposition

| Area | Disposition at baseline | Evidence and boundary |
|---|---|---|
| **A1 — FS containment and bounded I/O** | **PASS (Linux baseline)** | `1577b11`; no-follow/symlink checks and exclusive temp creation in [repository.ts](../packages/shared/src/project-memory/connections/repository.ts); real assertions in [repository.test.ts](../packages/shared/src/project-memory/connections/__tests__/repository.test.ts) pass. |
| **A2 — mutation durability and cross-process serialization** | **PASS (Linux baseline)** | `1577b11`; process-local queue, exclusive `.lock`, owner token, timeout, fenced reread, revision conflict, and recovery paths in [repository.ts](../packages/shared/src/project-memory/connections/repository.ts); race tests pass. |
| **A3 — credential backend/manager and test isolation** | **PASS (Linux baseline)** | `aaeef98`; injected roots, typed fail-closed errors, and test-mode refusal without an override in [secure-storage.ts](../packages/shared/src/credentials/backends/secure-storage.ts), [manager.ts](../packages/shared/src/credentials/manager.ts), and [memory-credentials.test.ts](../packages/shared/src/credentials/__tests__/memory-credentials.test.ts). Tests assert the real `~/.craft-agent/credentials.enc` path is not used. |
| **A4a — decision-only contract worker** | **MOOT / NOT DISPATCHABLE** | The proposed files and tests already exist at the baseline. Re-running a predecessor worker would recreate obsolete sequencing and risk overlapping landed work. |
| **A5 — durable credential/config saga** | **PASS (Linux baseline; independently accepted)** | `72e6684`; strict write-ahead journal, outer cross-process lease, encrypted staging/quarantine, fail-closed startup recovery, config/credential convergence, legacy-uppercase migration, and coordinator-gated connection/space mutations in [saga.ts](../packages/shared/src/project-memory/connections/saga.ts), [saga-journal.ts](../packages/shared/src/project-memory/connections/saga-journal.ts), [service.ts](../packages/shared/src/project-memory/connections/service.ts), and their tests. |
| **A6 — default-deny managed-reference resolution** | **PASS for the pure resolver scope** | `2c961d1`; deny reasons, binding/membership checks, global-write denial, writability checks, and deny-before-credential-callback behavior in [resolver.ts](../packages/shared/src/project-memory/connections/resolver.ts) and [resolver.test.ts](../packages/shared/src/project-memory/connections/__tests__/resolver.test.ts). This is not a claim about unrelated end-to-end handlers. |
| **A7 — Qdrant guard set** | **PASS for the implemented/tested guard scope** | `2c961d1`; canonical URL validation, embedded-credential rejection, redirect rejection, omitted ambient credentials, timeout, and request-body cap in [qdrant.ts](../packages/shared/src/project-memory/qdrant.ts) and [qdrant.test.ts](../packages/shared/src/project-memory/qdrant.test.ts). This does not invent proof for DNS rebinding, private-address, proxy, or OS-specific behavior outside those tests. |
| **Cross-platform FS/race evidence** | **EVIDENCE GAP** | The recorded commands pass on Linux. They were not run on macOS or Windows for this baseline; no cross-platform release claim is permitted. |

Recorded Linux verification after A5: the exact six-suite command remains **96 pass / 0 fail / 288 expect() calls**; the full project-memory and credentials command is **230 pass / 0 fail**; the real child-process crash matrix is **34 pass / 0 fail / 201 expect() calls**; server memory tests are **25 pass / 0 fail / 101 expect() calls**. `typecheck:all` and `validate:ci` pass. Exact commands are recorded in [A0-readiness-matrix.md](A0-readiness-matrix.md).

## 3. Preserved fail-closed contracts

### Repository and credential safety

- Repository paths must remain contained beneath an injected/configured root; symlink traversal and canonical escapes fail closed.
- Reads and writes remain bounded; mutation uses exclusive temporary files, serialization, fenced rereads, revision checks, and recoverable replacement.
- Credential tests must use an injected temporary root. Test execution must refuse the default real credential path when no override is provided.
- Secrets remain in the credential backend only. Config, logs, errors, resolver outputs, and any future journal must be secret-free.
- Corruption, permission, lock, integrity, or ambiguous recovery failures fail closed.

### Resolver and authorization boundary

- Resolve only from trusted server/session workspace and project identity, never caller-supplied ownership claims.
- Missing, disabled, non-member, non-writable, or global-write targets are denied.
- Read and write decisions remain separate; global memory is read-only.
- Denied refs must not cause credential callbacks, network access, or fallback to unmanaged legacy stores.
- Resolver results contain identities and machine-readable denial reasons, never credentials.

### Qdrant transport boundary

The landed guard set must not regress: reject credential-bearing or non-canonical URLs, reject redirects, omit ambient credentials, enforce timeout/cancellation and request-body limits, and encode collection/path components. DNS rebinding, private-address, proxy, response-size, or other expanded egress requirements require a separately scoped security decision and tests before such support is claimed.

### Migration/version boundary

No current migration worker is dispatched by this ADR. If a future v1→v2 migration is introduced, it must use explicit and mutually exclusive source discriminators (`foundation-v1`, `pre-repair-v1`, `current-v1`), detect before writing, reject ambiguous/corrupt/future versions, and provide idempotent recovery plus rollback evidence. This is forward policy, not evidence of an existing migration gap at this baseline.

## 4. A5 closure evidence

A5 is implemented and independently accepted at `72e6684`. The durable, secret-free saga covers:

- `createConnection`
- `updateConnectionConfig`
- `deleteConnection`
- `setApiKey`
- `replaceApiKey`
- `clearApiKey`
- `setCredentialMode`
- `migrateLegacyUppercaseCredentials`
- `startupRecovery`

Canonical steps remain:

`prepare` → `stageSecret` → `commitConfig` → `commitCredential` → `reconcile` → `complete`, with `rollback` for failed or retried work.

The journal records identifiers, intent, preconditions, idempotency key, actor, attempt, and status—but never secret material. Recovery must complete or fail closed before the next outer-memory mutation.

## 5. Ownership and no-overlap rules

The old named worktree is discarded; worker instructions must use a real branch/worktree and record `git rev-parse HEAD` at dispatch.

For any remaining closure work:

- one worker owns each overlapping runtime file set;
- `packages/shared/src/project-memory/connections/repository.ts` has a single owner;
- `packages/shared/src/project-memory/connections/validation.ts`, `types.ts`, `identity.ts`, and `limits.ts` are not assigned to a parallel “A4a” worker;
- future changes to `packages/shared/src/credentials/**` and credential coordination require a new explicitly owned security scope;
- each worker records base SHA, expected files, verification commands/results, and explicit handoff state;
- integration and review are serial whenever file ownership overlaps.

## 6. Closure rule

This ADR does not declare release readiness. The corrected A0 artifact (`3b3512e`) and A5 implementation (`72e6684`) are independently accepted. Remaining closure requires:

1. explicit macOS and Windows FS/race results, or an approved platform-support decision that does not misrepresent untested behavior; and
2. an A8-style final review of the resulting integrated diff and command ledger.

Until then, Wave B/C and release-readiness claims remain blocked.
