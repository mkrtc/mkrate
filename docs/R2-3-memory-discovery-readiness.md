# R2-3 Appendix — Memory Discovery Readiness and Risk Register

**Date (authoritative):** Wednesday, July 15, 2026 at 05:25 PM GMT+3
**Purpose:** authoritative appendix for A0 correction, containing finding disposition and policy freezes for future executor prompts.

## Decision ownership and non-dispatch scope

- Byte cap/version/identity/limit policy questions: **owner `A4a`**.
- Qdrant transport SSRF/egress policy questions: **owner `A7`**.
- Business-policy exceptions (for example, alias migration exceptions): **owner `orchestrator/user decision`**.
- Unresolved items stay **BLOCKING OPEN QUESTION** until their owner marks them accepted.

## 1) P0/P1 finding disposition (detailed)

### 1.1 Credential fault-test isolation / real `~/.craft-agent` credential safety

- **Disposition:** **BLOCKED**
- **Current evidence:** hooks are not contractually required in docs/tests; no explicit “do not run on real path” gate in tool/process docs.
- **Required next:** add explicit test harness constraints in Wave A docs and enforce in test scaffolding.

### 1.2 Credential backend durability + manager contract

- **Disposition:** **FAIL**
- **Current evidence:** durability/recovery tests report boundary failures (repo test output in corrected matrix).
- **Required next:** prove storage error handling is fail-closed and idempotent recovery paths work across interrupted/locked writes.

### 1.3 Credential/config saga protocol

- **Disposition:** **BLOCKED**
- **Owner:** **A5** for implementation; A0 documents vocabulary only.
- **Current evidence:** policy is documented in ADR §D with canonical operation + marker vocabulary, but no implementation enforcement in runtime/tests yet.
- **Required next:** implement/enforce saga intent/journal/rollback behavior for all mutation operations in A5 after A2/A3/A4a gates pass.

### 1.4 Repository FS containment / bounded I/O

- **Disposition:** **FAIL**
- **Current evidence:** symlink containment assertions did not fail as expected and path escape behavior remains a blocker.
- **Required next:** harden path resolution, canonical checks, and bounded I/O windows.

### 1.5 Repository cross-process locking / fenced reread / transaction recovery

- **Disposition:** **FAIL**
- **Current evidence:** two real processes both acknowledged create at same root revision in tests.
- **Required next:** enforce single-writer lock + fenced reread + monotonic root revision recovery.

### 1.6 Migration/version policy (v1→v2)

- **Disposition:** **BLOCKING OPEN QUESTION**
- **Owner:** **A4a**
- **Current evidence:** explicit discriminators for `foundation-v1`, `pre-repair-v1`, and `current-v1` are defined as policy but not yet enforced in implementation.
- **Required next:** decide migration constants, idempotent pre-validation detector, rollback/backup policy, and corrupted/future-version fail-closed behavior.

### 1.7 Default-deny resolver / authorizer

- **Disposition:** **BLOCKED**
- **Current evidence:** ADR documents the resolver contract, but centralized deny-first behavior is still missing in product enforcement.
- **Required next:** after A4a/A5 predecessor gates pass, dispatch the A6 remediation worker to enforce policy in resolver + authorizer handlers and add contract tests. Runtime use/downstream progression remains blocked until A6 implementation/tests are independently accepted.

### 1.8 Qdrant transport / SSRF / egress policy

- **Disposition:** **BLOCKED**
- **Owner:** **A7**
- **Current evidence:** transport policy categories are documented, but concrete allow/deny decisions and runtime enforcement are not complete for redirects, DNS, IPv4/IPv6, proxy, URLs with credentials, or timeout/body caps.
- **Required next:** define/implement deny rules before using arbitrary stored URLs at runtime.

### 1.9 Identity, limits, serialized bytes, safe integers, global collision

- **Disposition:** **BLOCKING OPEN QUESTION**
- **Owner:** **A4a**
- **Current evidence:** identity hardening (duplicate/alias policy, serialized-byte invariants, safe-integer overflow, global collision guarantees) is documented but not yet enforced in code.
- **Required next:** codify and verify these constraints as mandatory before A1.

### 1.10 Worktree topology / worker collision policy

- **Disposition:** **NOT READY**
- **Current evidence:** contract now added in ADR; file ownership still needs follow-up re-audit before worker dispatch.
- **Required next:** enforce base SHA + expected file set + serial integration for each worker.

### 1.11 Verification matrix / cross-platform matrix

- **Disposition:** **NOT COMPLETE**
- **Current evidence:** matrix had false PASS claims and incomplete OS-specific evidence.
- **Required next:** maintain a live matrix with command families and Linux/macOS/Windows outcomes.

### 1.12 A4a contract gate status

- **Disposition:** **BLOCKED**
- **Current evidence:** A4a scope is now documented, but re-audit of this decision-only gate is not complete.
- **Required next:** after A0 re-audit, run A4a as pure-contract worker from the audited tip, then re-audit before A1 dispatch.

### 1.13 A8 closure audit status

- **Disposition:** **FINAL GATE**
- **Owner:** integration/audit worker after A1/A2/A3/A5/A6/A7 are accepted
- **Current evidence:** no integrated remediation diffs exist yet.
- **Required next:** independently audit the integrated Wave A branch and rerun the full verification matrix before merge/release or Wave B/C.

## 2) Exact operation list required for A5 saga

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

### Required per-operation sequence

For all mutation operations (`createConnection`, `updateConnectionConfig`, `deleteConnection`, `setApiKey`, `replaceApiKey`, `clearApiKey`, `setCredentialMode`, `migrateLegacyUppercaseCredentials`):
`prepare` → `stageSecret` → `commitConfig` → `commitCredential` → `reconcile` → `complete`; rollback uses `rollback`.

For `startupRecovery`:
`prepare` → `reconcile` → `complete` with `rollback` on failure.

## 3) Default-deny resolver freeze list

- trusted server/session/workspace/project lookup first
- disabled/deleted/missing entities denied
- missing/deleted spaces denied
- read-membership required for read mode
- write-membership + writable required for write mode
- global read-only (never writable)
- workspace/project/custom binding explicit and non-fallback
- refs bounds, dedupe, explicit-mode semantics
- no callbacks/network/credential access on deny
- secret-free output shape
- no fallback from managed refs to raw legacy store
- **Product enforcement status:** policy defined; A6 remediation dispatch is allowed only after A4a/A5 predecessor gates pass. Runtime use/downstream progression remains BLOCKED until handlers/tests enforce it and independent A6 review accepts it.

## 4) Verification outcomes snapshot (authoritative)

- `bun test packages/shared/src/project-memory/connections/__tests__/repository.test.ts packages/shared/src/project-memory/connections/__tests__/validation.test.ts packages/shared/src/project-memory/connections/__tests__/environment.test.ts packages/shared/src/project-memory/connections/__tests__/session-refs.test.ts packages/shared/src/project-memory/connections/__tests__/dto.test.ts packages/shared/src/project-memory/connections/__tests__/boundary.test.ts`: `92 pass` / `3 fail` / `0 error` (95 tests). Named failures: symlink containment, stale-backup mutation under EACCES, and two-process same-revision acknowledgement.
- `bun test packages/shared/src/credentials/__tests__/memory-credentials.test.ts`: **NOT RUN in this doc correction pass**.
- `bun test packages/server/src/__tests__/smoke.test.ts`: **NOT RUN in this doc correction pass**.
- `bun test packages/session-tools-core/src/**/*.test.ts`: **NOT RUN in this doc correction pass**.
- `bun test packages/server-core/src/**/*.test.ts`: **NOT RUN in this doc correction pass**.
- `historical auditor run, exact command unavailable; not acceptable as future gate`: `98 pass` / `8 fail` / `4 error` across `106 tests`, with additional failures from missing dependencies and setup mismatch.
- **No scanner command exists as a dedicated script in this repository.** Use fallback check below for manual reproducibility:

Run from the repository root:

```bash
grep -RInE --ignore-case --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
  "AKIA[0-9A-Z]{16}|api[_-]?key|bearer[[:space:]][A-Za-z0-9._-]+|secret|password" .
```

## 5) Mandatory vs adjacent risk register

### Mandatory Wave A blockers (must close before merge/release or Wave B/C)

1. FS containment and bounded I/O (A1 remediation)
2. Cross-process concurrency recovery (A2 remediation)
3. Fault-test isolation + credential-safety harness (A3 remediation)
4. Saga + recovery journal for all mutation operations (A5 remediation)
5. Resolver default-deny authorizer and binding policy (A6 remediation)
6. Migration discriminators and rollback semantics (A4a decision gate, later migration owner)
7. Qdrant transport hardening (A7 remediation)

### Adjacent repo risks (not part of core Wave A, defer with explicit gate)

- broader session-tool/server-core regressions outside project-memory
- general linting and secret-scan baseline in unrelated areas
- optional-platform behavior not in direct Wave A scope

Deferred risks must be linked to future tasks with explicit acceptance conditions before unblocking adjacent areas.
