# A0 Post-Hoc Readiness Matrix

**Date (authoritative):** Friday, July 24, 2026 (GMT+3)
**Implementation baseline SHA:** `ce02a3b359fe35db328fcf3e64a34a473bec76a5` on `main`
**Artifact branch:** `docs/a0-posthoc-rebaseline` (the reviewed docs commit is a docs-only descendant of the implementation baseline)
**Verification environment:** Linux x86_64, Bun `1.3.8`
**Purpose:** reproducible post-hoc verification / A8-style closure baseline

## Status legend

- **PASS (Linux baseline)** — implemented and covered by the recorded passing Linux suites.
- **PASS (scoped)** — the named implementation/test scope passes; no broader claim is implied.
- **OPEN** — confirmed implementation gap.
- **EVIDENCE GAP** — implementation may exist, but required platform evidence was not produced.
- **MOOT / NOT DISPATCHABLE** — the historical worker premise was overtaken by landed implementation.
- **PENDING INDEPENDENT ACCEPTANCE** — documentation was re-baselined but has not yet passed its follow-up independent review.

## Gate summary

The historical pre-implementation sequence is no longer operative. A1/A2/A3/A6/A7-class work landed before this re-baseline and is verified below. A0 now serves as a post-hoc verification and A8-style closure baseline.

- **A4a:** moot; do not dispatch.
- **A5:** durable saga journal and startup recovery remain open.
- **Cross-platform:** Linux results exist; macOS and Windows FS/race results do not.
- **Wave B/C and release readiness:** blocked until this re-baseline is independently accepted, A5 closes, and the platform-evidence decision closes.

## Readiness disposition

| ID | Scope | Baseline outcome | Status |
|---|---|---|---|
| **A0** | Correct the stale readiness record against a real SHA | Reframed as post-hoc verification over `ce02a3b`; invalid SHA/worktree claims removed | **PENDING INDEPENDENT ACCEPTANCE** |
| **A1** | Contained, bounded, no-follow repository I/O | Implemented by `1577b11`; symlink/escape assertions pass | **PASS (Linux baseline)** |
| **A2** | Atomic mutation, cross-process locking, fenced reread, recovery | Implemented by `1577b11`; stale-backup and two-process revision-conflict assertions pass | **PASS (Linux baseline)** |
| **A3** | Credential backend/manager durability and isolated test roots | Implemented by `aaeef98`; credential suite and full domain suite pass without using real `~/.craft-agent` credentials | **PASS (Linux baseline)** |
| **A4a** | Historical decision-only predecessor worker | Contract files already exist and pass; dispatch would repeat obsolete sequencing and risk overlap | **MOOT / NOT DISPATCHABLE** |
| **A5** | Durable, secret-free config/credential saga and crash recovery | `122f176` coordinates credentials with in-process compensation, but no durable journal or `startupRecovery` exists | **OPEN** |
| **A6** | Pure default-deny managed-ref resolver | Implemented by `2c961d1`; membership, write, global, and deny-before-callback tests pass | **PASS (scoped)** |
| **A7** | Implemented Qdrant guard set | Implemented by `2c961d1`; URL, userinfo, redirect, ambient-credential, timeout, and request-body protections are covered | **PASS (scoped)** |
| **A8** | Independent integrated closure review | This re-baseline defines the review input; acceptance still required after A5/platform closure | **PENDING INDEPENDENT ACCEPTANCE** |
| **Platform matrix** | Linux/macOS/Windows FS and race behavior | Linux recorded; macOS and Windows not run | **EVIDENCE GAP** |

## Commit-to-evidence map

| Commit | Landed scope | Primary evidence |
|---|---|---|
| `1577b11` | A1/A2 repository hardening | [repository.ts](../packages/shared/src/project-memory/connections/repository.ts), [repository.test.ts](../packages/shared/src/project-memory/connections/__tests__/repository.test.ts) |
| `aaeef98` | A3 credential hardening and isolated-root tests | [secure-storage.ts](../packages/shared/src/credentials/backends/secure-storage.ts), [manager.ts](../packages/shared/src/credentials/manager.ts), [memory-credentials.test.ts](../packages/shared/src/credentials/__tests__/memory-credentials.test.ts) |
| `2c961d1` | A6 resolver and A7 Qdrant guards | [resolver.ts](../packages/shared/src/project-memory/connections/resolver.ts), [resolver.test.ts](../packages/shared/src/project-memory/connections/__tests__/resolver.test.ts), [qdrant.ts](../packages/shared/src/project-memory/qdrant.ts), [qdrant.test.ts](../packages/shared/src/project-memory/qdrant.test.ts) |
| `122f176` | Credential-coordinating service, but not durable A5 recovery | [service.ts](../packages/shared/src/project-memory/connections/service.ts), [service.test.ts](../packages/shared/src/project-memory/connections/__tests__/service.test.ts) |

All four commits are ancestors of the baseline SHA.

## Exact verification ledger

Run from the repository root at `ce02a3b359fe35db328fcf3e64a34a473bec76a5`.

### Six-suite connection baseline

```bash
bun test packages/shared/src/project-memory/connections/__tests__/repository.test.ts packages/shared/src/project-memory/connections/__tests__/validation.test.ts packages/shared/src/project-memory/connections/__tests__/environment.test.ts packages/shared/src/project-memory/connections/__tests__/session-refs.test.ts packages/shared/src/project-memory/connections/__tests__/dto.test.ts packages/shared/src/project-memory/connections/__tests__/boundary.test.ts
```

**Recorded Friday, July 24, 2026:** `96 pass / 0 fail / 288 expect() calls`.

This command includes the real, unskipped symlink-containment, stale-backup/EACCES, and two-process same-revision assertions. Their previous `92 pass / 3 fail` snapshot is historical and superseded.

### Full project-memory and credentials domain

```bash
bun test packages/shared/src/project-memory/ packages/shared/src/credentials/
```

**Recorded Friday, July 24, 2026:** `140 pass / 0 fail / 404 expect() calls`.

This aggregate covers the credential, resolver, service, repository, validation, and Qdrant tests used by this re-baseline. Credential tests use in-memory or injected temporary roots and include a guard against the real default credential path.

### Shared typecheck

```bash
bun run typecheck:shared
```

**Recorded Friday, July 24, 2026:** PASS on Linux x86_64 with Bun `1.3.8`.

### Baseline/artifact ancestry checks

Run on the exact docs artifact commit supplied to the independent auditor:

```bash
git rev-parse HEAD
git branch --show-current
git merge-base --is-ancestor ce02a3b359fe35db328fcf3e64a34a473bec76a5 HEAD
for commit in 1577b11 aaeef98 2c961d1 122f176; do
  git merge-base --is-ancestor "$commit" ce02a3b359fe35db328fcf3e64a34a473bec76a5
done
git diff --name-only ce02a3b359fe35db328fcf3e64a34a473bec76a5...HEAD
```

Every ancestry check must exit zero. The final diff must list only the three A0 documentation files. The independent report records the exact artifact commit SHA; the artifact cannot embed its own Git object ID without becoming self-referential.

## Cross-platform evidence matrix

| Platform | Recorded outcome for this baseline | Release interpretation |
|---|---|---|
| **Linux** | Both commands above pass with the exact recorded counts | Evidence available for this host only |
| **macOS** | **NOT RUN / no evidence recorded** | Do not infer FS, permission, symlink, or race parity |
| **Windows** | **NOT RUN / no evidence recorded** | Do not infer FS, permission, symlink, or race parity |

The implementation is designed to fail closed, but design intent is not cross-platform evidence. macOS and Windows results, or an explicit supported-platform decision, remain part of closure.

## Scope limits

- A6 PASS is for the pure managed-reference resolver contract and tests, not unrelated handler paths.
- A7 PASS is for the implemented guard set. This matrix does not claim untested DNS rebinding, private-address, proxy, response-size, or OS-network behavior.
- A5 is the only confirmed open implementation gap in this artifact set.
- No A4a or other predecessor worker may be launched from the obsolete historical sequence.
