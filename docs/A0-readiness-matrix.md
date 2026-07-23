# Corrected A0 / A1–A7 / R1 / R2 / R2-3 Readiness Matrix

**Date (authoritative):** Wednesday, July 15, 2026 at 05:25 PM GMT+3
**Working tree:** `work/memory-connections-wave-a-integration`
**Baseline SHA:** `06e8c4db`
**Current integration tip:** this committed A0 docs tip (record `git rev-parse HEAD` when dispatching/auditing)

## Legend

- **PASS** – verified by evidence and no unresolved blocker for this scope.
- **FAIL** – verifiable failure remains.
- **BLOCKED** – not permitted to dispatch due policy or dependency not yet ready.
- **NOT RUN** – not executed in this corrective task.
- **NOT READY** – insufficient policy or evidence to permit implementation.
- **PENDING RE-AUDIT** – docs are committed but not accepted until an independent re-audit passes.
- **NEXT AFTER A0 PASS** – safe to dispatch only after A0 re-audit accepts.
- **REMEDIATION QUEUED** – known failing area with an ordered future remediation worker; not a release-ready state.
- **FINAL GATE** – final integration/audit step after remediation workers.
- **TRACKED** – audit findings are mapped and drive remediation order.

## Gate summary (required statement)

- **A0 docs** are committed and **pending independent re-audit**.
- **A1+** dispatch remains **BLOCKED** until independent re-audit accepts this corrected A0 set.
- After A0 acceptance, **A4a** is the first safe pure-contract/decision worker and must be re-audited before A1.
- **Wave A remediation** may proceed only in the documented order after each required review gate; **Wave B/C are forbidden** until Wave A closure audit passes.

## Readiness table

| ID | Area | Required outcome | Current outcome | Status |
|---|---|---|---|---|
| **A0** | Corrective artifact committed + gate semantics | Docs-only commit with explicit BLOCKED gates for A1+ before A0 acceptance | Corrected docs are committed; independent re-audit still required | **PENDING RE-AUDIT** |
| **A4a** | Pure contract/decision freeze | Owns only `limits.ts`, `types.ts`, `identity.ts`, `validation.ts`, related tests; no product-code implementation | First safe worker after accepted A0; must be re-audited before A1 | **NEXT AFTER A0 PASS** |
| **A1** | Path containment + bounded no-follow reads | Canonical containment and bounded reads proven before mutation work | Symlink/path containment failures remain; dispatch only after accepted A4a | **REMEDIATION QUEUED** |
| **A2** | Repository mutation durability + cross-process locking | Atomic write/temp/backup/recovery + fenced reread under lock | Stale-backup/EACCES and two-process same-revision failures remain; waits for A1 | **REMEDIATION QUEUED** |
| **A3** | Credential backend + manager + interface durability | Injectable roots, fail-closed errors, no real credential path mutation, compatible credential APIs | Policy documented; product enforcement missing; waits for A2/A4a where interfaces overlap | **REMEDIATION QUEUED** |
| **A5** | Credential/config saga | Sole-writer service, secret-safe journal, idempotent recovery for canonical operations | Policy documented; product enforcement missing; waits for A2/A3/A4a | **REMEDIATION QUEUED** |
| **A6** | Default-deny resolver/authorizer | Trusted server lookup, deny before callback/network/credential, secret-free plan | Policy documented; product enforcement missing; waits for A4a/A5 unless pure non-runtime contract | **REMEDIATION QUEUED** |
| **A7** | Qdrant transport/egress security | Concrete SSRF/redirect/DNS/proxy/timeout/body-cap decisions and safe transport before runtime use | Policy categories documented; concrete decisions and runtime hardening missing | **REMEDIATION QUEUED** |
| **A8** | Closure audit/integration | Independent audit of integrated Wave A diffs and full verification matrix | Not dispatchable until A1/A2/A3/A5/A6/A7 are accepted | **FINAL GATE** |
| **R1/R2/R2-3** | Audit finding disposition | No false readiness and all blockers mapped to owners | Disposition documented; blockers remain unresolved and drive remediation order | **TRACKED** |

## Exact verification command ledger (copy-pasteable)

### Required command families and intended outcomes

```bash
bun test packages/shared/src/project-memory/connections/__tests__/repository.test.ts packages/shared/src/project-memory/connections/__tests__/validation.test.ts packages/shared/src/project-memory/connections/__tests__/environment.test.ts packages/shared/src/project-memory/connections/__tests__/session-refs.test.ts packages/shared/src/project-memory/connections/__tests__/dto.test.ts packages/shared/src/project-memory/connections/__tests__/boundary.test.ts
bun test packages/shared/src/credentials/__tests__/memory-credentials.test.ts
bun test packages/server/src/__tests__/smoke.test.ts
bun test packages/session-tools-core/src/**/*.test.ts
bun test packages/server-core/src/**/*.test.ts
bun run typecheck:all
bun run validate:ci
bun run lint
```

### Command outcomes (known)

- Targeted project-memory connection command above: **95 tests** | **92 pass** | **3 fail** | **0 error**. Named failures: symlink containment, stale-backup mutation under EACCES, and two-process same-revision acknowledgement.
- `bun test packages/shared/src/credentials/__tests__/memory-credentials.test.ts`: **NOT RUN in this task**
- `bun test packages/server/src/__tests__/smoke.test.ts`: **NOT RUN in this task**
- `bun test packages/session-tools-core/src/**/*.test.ts`: **NOT RUN in this task**
- `bun test packages/server-core/src/**/*.test.ts`: **NOT RUN in this task**
- `bun run typecheck:all`: **NOT RUN in this task**
- `bun run validate:ci`: **NOT RUN in this task**
- `bun run lint`: **NOT RUN in this task**
- **Prior provided audit aggregate:** **98 pass / 8 fail / 4 error** across **106 tests**, with additional setup/load failures; command is **`historical auditor run, exact command unavailable; not acceptable as future gate`**.

### Credential/backend/session-tools/server-core scanner

- There is no dedicated project scanner script/command currently defined in this repo.
- Concrete manual fallback for reproducible secret/keyword scanning (when scanner is unavailable):

Run from the repository root:

```bash
grep -RInE --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
  "AKIA[0-9A-Z]{16}|[Aa][Pp][Ii][_\-]?[Kk][Ee][Yy]|[Bb][Ee][Aa][Rr][Ee][Rr][[:space:]][A-Za-z0-9._-]+|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]" .
```

This fallback does not replace a scanner gate; it is a temporary manual audit mechanism only.

## Cross-platform verification requirement (mandatory)

Wave A matrix must include explicit Linux/macOS/Windows outcomes for FS/race cases or declare fail-closed supported behavior.

- **Current status:** **NOT RUN on all OS variants yet** in this doc correction pass; therefore this requirement remains a gate.

## Status notes for each area

- **A1/A2/A3/A5/A6/A7 must not be marked PASS until their remediation implementation and tests are independently accepted.**
- Downstream executor prompts must use predecessor-based dispatch semantics: a remediation worker may dispatch only when its documented predecessor gates are accepted. A remediation area remains non-PASS until that worker’s own implementation, tests, and independent review are accepted.
- Repo-relative links are now preferred and used throughout this artifact set.
