# R2-3 Appendix — Post-Hoc Memory Discovery Readiness

**Date (authoritative):** Friday, July 24, 2026 (GMT+3)
**Implementation baseline SHA:** `ce02a3b359fe35db328fcf3e64a34a473bec76a5` on `main`
**Artifact branch:** `docs/a0-posthoc-rebaseline` (the reviewed docs commit is a docs-only descendant of the implementation baseline)
**Purpose:** detailed finding disposition and preserved closure contracts for the A0 post-hoc re-baseline

## 1. Historical sequence correction

The prior appendix treated A0 as a prerequisite to dispatch A4a and then A1–A7. Repository history has overtaken that sequence: A1/A2/A3/A6/A7-class implementation landed in `1577b11`, `aaeef98`, and `2c961d1`, followed by credential-coordinating service work in `122f176`. All are ancestors of this baseline.

A0 is therefore re-scoped as post-hoc verification and A8-style closure. **A4a is moot and not dispatchable.** Invalid historical SHA and topology anchors have been removed.

## 2. Corrected P0/P1 finding disposition

### 2.1 Credential fault-test isolation

- **Disposition:** **PASS (Linux baseline)**
- **Evidence:** `aaeef98`; [memory-credentials.test.ts](../packages/shared/src/credentials/__tests__/memory-credentials.test.ts) uses in-memory or `mkdtemp` roots, asserts the path differs from `~/.craft-agent/credentials.enc`, and verifies test-mode construction refuses an uninjected default path.
- **Preserved rule:** destructive credential tests must use injected roots and must never touch the real default store.

### 2.2 Credential backend durability and manager contract

- **Disposition:** **PASS (Linux baseline)**
- **Evidence:** `aaeef98`; typed fail-closed storage errors, canonical connection-scoped credential identities, and hardened backend operations in [secure-storage.ts](../packages/shared/src/credentials/backends/secure-storage.ts), [manager.ts](../packages/shared/src/credentials/manager.ts), and their tests.

### 2.3 Credential/config saga protocol

- **Disposition:** **OPEN — confirmed implementation gap**
- **Owner:** A5 closure work
- **Evidence:** `122f176` adds in-process credential coordination and compensation in [service.ts](../packages/shared/src/project-memory/connections/service.ts), but repository search finds no durable saga journal, `stageSecret`, or `startupRecovery` implementation.
- **Required closure:** durable secret-free intent records, idempotent crash replay, reconciliation, and fail-closed startup recovery.

### 2.4 Repository FS containment and bounded I/O

- **Disposition:** **PASS (Linux baseline)**
- **Evidence:** `1577b11`; [repository.ts](../packages/shared/src/project-memory/connections/repository.ts) performs no-follow path checks and exclusive bounded writes. The real symlink-containment assertions in [repository.test.ts](../packages/shared/src/project-memory/connections/__tests__/repository.test.ts) pass.

### 2.5 Cross-process locking, fenced reread, and recovery

- **Disposition:** **PASS (Linux baseline)**
- **Evidence:** `1577b11`; exclusive `.lock` creation, owner token, timeout, fenced reread, revision checks, and recovery logic are covered by passing stale-backup/EACCES and two-process race assertions.

### 2.6 Contract, identity, limit, and version policy

- **Disposition:** **PASS for current contract tests; forward migration policy preserved**
- **Evidence:** current [limits.ts](../packages/shared/src/project-memory/connections/limits.ts), [types.ts](../packages/shared/src/project-memory/connections/types.ts), [identity.ts](../packages/shared/src/project-memory/connections/identity.ts), [validation.ts](../packages/shared/src/project-memory/connections/validation.ts), and their tests are present and pass in the domain suite.
- **Boundary:** no A4a worker is needed. A future schema migration must explicitly discriminate `foundation-v1`, `pre-repair-v1`, and `current-v1`, detect before writing, reject ambiguous/corrupt/future versions, and provide idempotent rollback/recovery. This is forward policy, not a current dispatch blocker.

### 2.7 Default-deny resolver/authorizer

- **Disposition:** **PASS for the pure resolver scope**
- **Evidence:** `2c961d1`; [resolver.ts](../packages/shared/src/project-memory/connections/resolver.ts) implements connection/space existence, enabled state, membership/binding, global-write, writability, secret-free output, and deny-before-credential-callback behavior; [resolver.test.ts](../packages/shared/src/project-memory/connections/__tests__/resolver.test.ts) passes.
- **Boundary:** this disposition does not claim coverage for unrelated handlers or future resolver consumers.

### 2.8 Qdrant transport guards

- **Disposition:** **PASS for the implemented/tested guard scope**
- **Evidence:** `2c961d1`; [qdrant.ts](../packages/shared/src/project-memory/qdrant.ts) and [qdrant.test.ts](../packages/shared/src/project-memory/qdrant.test.ts) cover canonical URLs, embedded-credential rejection, redirect rejection, omitted ambient credentials, timeout/cancellation, request-body limits, and encoded collection paths.
- **Boundary:** no DNS rebinding, private-address, proxy, response-size, cross-platform, or other untested egress claim is made. Expanded support requires a new scoped security decision and tests; it is not a reason to preserve the stale blanket A7 BLOCKED disposition.

### 2.9 Worktree topology and worker collision policy

- **Disposition:** **CORRECTED**
- **Evidence anchor:** implementation baseline `ce02a3b359fe35db328fcf3e64a34a473bec76a5` on `main`; `docs/a0-posthoc-rebaseline` is a real docs-only descendant, and the independent report must record its exact artifact commit SHA.
- **Rule:** every future worker records its actual base SHA, branch/worktree, expected files, verification commands/results, and ownership. Overlapping runtime work integrates serially.

### 2.10 Verification and platform matrix

- **Disposition:** **Linux PASS; macOS/Windows EVIDENCE GAP**
- **Evidence:** exact commands and counts are in [A0-readiness-matrix.md](A0-readiness-matrix.md).
- **Boundary:** fail-closed design intent is not a substitute for OS evidence. No macOS/Windows FS, permission, symlink, or race parity is claimed.

### 2.11 A4a and A8 status

- **A4a:** **MOOT / NOT DISPATCHABLE**. Its contract files already exist and pass; dispatch would revive an obsolete predecessor sequence and risk file overlap.
- **A8-style closure:** **PENDING**. Independently review this re-baseline, then review the A5 implementation and platform-evidence decision before any release or Wave B/C claim.

## 3. A5 saga closure contract

### Canonical operation names

- `createConnection`
- `updateConnectionConfig`
- `deleteConnection`
- `setApiKey`
- `replaceApiKey`
- `clearApiKey`
- `setCredentialMode`
- `migrateLegacyUppercaseCredentials`
- `startupRecovery`

### Canonical marker steps

`prepare` → `stageSecret` → `commitConfig` → `commitCredential` → `reconcile` → `complete` → `rollback`

### Required behavior

- Persist a secret-free intent before each state mutation.
- Journal operation ID, intent, target kind/id, preconditions, idempotency key, actor, attempt, and status—never secret material.
- Make replay and rollback idempotent.
- Complete recovery or fail closed before accepting the next outer-memory mutation.
- Cover crash points between config and credential commits in tests.
- Preserve typed errors without leaking credentials into logs or journal entries.

## 4. Default-deny resolver freeze list

The landed resolver contract must not regress:

- trusted server/session workspace and project context only;
- missing or disabled connections denied;
- missing spaces and non-members denied;
- read and write membership kept separate;
- write requires writable state;
- global memory is read-only;
- workspace/project/custom bindings are explicit and non-fallback;
- denied refs cause no callback, credential lookup, or network access;
- resolver output is identity-only with machine-readable denial reasons;
- managed refs never silently fall back to an unmanaged legacy raw store.

## 5. Verification snapshot

```bash
bun test packages/shared/src/project-memory/connections/__tests__/repository.test.ts packages/shared/src/project-memory/connections/__tests__/validation.test.ts packages/shared/src/project-memory/connections/__tests__/environment.test.ts packages/shared/src/project-memory/connections/__tests__/session-refs.test.ts packages/shared/src/project-memory/connections/__tests__/dto.test.ts packages/shared/src/project-memory/connections/__tests__/boundary.test.ts
```

Recorded Friday, July 24, 2026: **96 pass / 0 fail / 288 expect() calls**.

```bash
bun test packages/shared/src/project-memory/ packages/shared/src/credentials/
```

Recorded Friday, July 24, 2026: **140 pass / 0 fail / 404 expect() calls**.

The former `92 pass / 3 fail` result and its three named failures are superseded; the assertions remain real and now pass because the landed code was hardened.

## 6. Remaining risk and ownership

### Confirmed open implementation work

1. **A5 durable saga journal and startup recovery** — owner: the serial A5 implementation/review chain.

### Evidence/acceptance work

1. Independent acceptance of the three re-baselined A0 documents.
2. macOS and Windows FS/race verification, or an explicit supported-platform decision.
3. A8-style independent review after A5 and platform closure.

### No-overlap rules

- `packages/shared/src/project-memory/connections/repository.ts` remains single-owner.
- Do not dispatch a parallel A4a worker over `limits.ts`, `types.ts`, `identity.ts`, or `validation.ts`.
- While A5 is active, `packages/shared/src/credentials/**` and credential-coordination files belong only to the A5 chain.
- Serial review/integration is mandatory whenever expected file sets overlap.

Wave B/C and release-readiness claims remain blocked until the evidence/acceptance work and A5 closure complete.
