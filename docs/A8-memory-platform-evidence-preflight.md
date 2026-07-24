# A8 cross-platform memory evidence preflight

**Prepared:** Friday, July 24, 2026 (GMT+3)
**Implementation base:** `a501d89f5d11920fc51afc3fe578cce65f455e38`
**Status:** PREPARED; macOS and Windows evidence remains remote-only until the dedicated matrix completes successfully.

## Toolchain decision

Cross-platform evidence uses **Bun `1.3.10` exactly**.

- `package.json` declares `packageManager: bun@1.3.10`.
- The existing repository validation workflows already select Bun `1.3.10`.
- The dedicated evidence matrix and the evidence runner both enforce that exact version.
- The older Linux A0/A5 ledger remains historically accurate at Bun `1.3.8`; it is not silently relabeled as `1.3.10` evidence.

A version mismatch fails before tests run and still produces a sanitized failure artifact.

## What the runner proves

Run from the repository root:

```bash
bun run memory:evidence
```

The strict runner:

1. requires a clean non-ignored working tree (staged, unstaged, and untracked changes all fail);
2. records the exact commit, Git tree, OS version, architecture, runner image metadata when available, and Bun version;
3. creates a realpath-resolved evidence sandbox below the physical OS temp directory and forces child `TMPDIR`, `TMP`, and `TEMP` to a nested physical temp root, preventing alias paths such as macOS `/var` → `/private/var` from invalidating containment checks;
4. runs the full `packages/shared/src/project-memory/` and `packages/shared/src/credentials/` domain plus the three server memory suites using separate Bun JUnit reports;
5. rejects any failure, skip, duplicate exact name, or missing required security-critical shared/server case;
6. requires every named A5 child-process crash window plus server startup-gate, serialization, reconciliation, and deny-before-callback cases rather than brittle historical aggregate totals;
7. runs and records core, shared, and server-core typechecks as separate commands, including exact arguments, working directory, status, and exit code;
8. fingerprints `<REAL_CONFIG_DIR>/config.json`, every `credentials.enc*` file, and `<REAL_CONFIG_DIR>/memory/**` recursively before and after, failing on creation, deletion, or byte changes;
9. bounds protected-store entry count, depth, per-file bytes, and total bytes; symlinks and unsupported entries fail closed rather than being followed;
10. confirms the full non-ignored working-tree status remains byte-for-byte stable during the run;
11. requires every source-manifest path to exist in the exact `HEAD` tree before hashing tested memory/credential/server sources, the runner, workflow, package manifests, tsconfigs, and lockfile;
12. emits schema-v4 path-sanitized, secret-free JSON and Markdown artifacts; failed cases may include only a sanitized testcase file, positive numeric line, and bounded, sanitized JUnit `<failure>`/`<error>` kind, `type`, and message. A structured `message` attribute is preferred; when Bun omits it, only the first non-empty body line is eligible as a fallback. Remaining body lines, stacks, and arbitrary stdout/stderr are never retained. On command failure, the runner may additionally retain at most 64 exact `[MEMORY_EVIDENCE_DIAG]` records whose code and state keys are allowlisted and whose state values are booleans only; every other stderr line is ignored. The whole artifact is still rejected if a known path or secret survives.

`MEMORY_EVIDENCE_ALLOW_DIRTY=1` is an explicit local-development exception for the working-tree cleanliness gate only. Source-manifest provenance remains strict: an ignored or untracked relevant source still fails. Dirty artifacts are labeled `local-preflight` and cannot be interpreted as clean-commit evidence. CI never sets this exception.

## Honest platform capability mapping

The runner requires exact platform-labeled cases and rejects skips. It does not treat a platform early return as PASS.

| Invariant | Linux/macOS evidence | Windows evidence |
|---|---|---|
| restrictive `0600` primary/backup modes | POSIX-specific named case | Not claimed; POSIX modes do not model Windows DACLs |
| primary file no-follow | POSIX file-symlink named case | Not claimed as a file-symlink parity result |
| directory containment | POSIX directory-symlink named case | real directory-junction named case |
| unreadable primary never falls back to a stale backup for mutation | real `chmod(000)`/`EACCES` named case on a non-root runner | real `icacls` read-data deny named case; `EACCES`/`EPERM` required |
| same-revision cross-process serialization | same real two-process case | same real two-process case |
| crash/restart convergence | all 34 exact A5 crash-window names | all 34 exact A5 crash-window names |

If junction creation, Windows ACL denial, POSIX permission denial, or any required mechanism is unavailable, that platform fails explicitly. There is no capability-based skip path.

## GitHub evidence matrix

[`.github/workflows/memory-platform-evidence.yml`](../.github/workflows/memory-platform-evidence.yml) runs with:

- `ubuntu-latest`, `macos-latest`, and `windows-latest`;
- `strategy.fail-fast: false`, so one platform failure does not erase the other results;
- exact Bun `1.3.10` and a frozen lockfile install;
- repository permission `contents: read` only;
- no production, API, model-provider, or application secrets;
- checkout credential persistence disabled;
- checkout, setup-bun, and upload-artifact pinned to verified immutable full commit SHAs from their official repositories, with version comments;
- pull-request and push path filters covering every hashed/tested shared, server, package-manifest, and tsconfig input;
- per-platform JSON and Markdown artifacts uploaded even after runner failure.

## Artifact acceptance checklist

A platform artifact is acceptable only when all of the following are true:

- `outcome` is `pass`;
- `evidenceMode` is `clean-tree-evidence`;
- `workingTreeClean`, `workingTreeStable`, and `protectedStore.unchanged` are all `true`;
- every source-manifest path is tracked in the artifact's exact `HEAD`;
- Bun is exactly `1.3.10`;
- all five recorded commands passed with exit code zero;
- shared and server test failures and skips are both zero;
- every platform capability is `passed`;
- every required exact case appears once;
- commit SHA is the reviewed candidate SHA;
- source, case, lockfile, and result SHA-256 values are present;
- JSON and Markdown contain no host absolute paths or secret-like environment values.

Passing all three matrix jobs closes the platform-evidence collection step only. Final A8 remains an independent integrated review of the candidate diff, artifacts, and command ledger; the workflow does not self-approve release readiness or Wave B/C.
