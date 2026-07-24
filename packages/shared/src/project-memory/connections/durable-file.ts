/**
 * Bounded, symlink-safe, durable atomic file primitives.
 *
 * These are the same hardening guarantees the Memory connection repository
 * enforces for `connections.json`, factored into standalone functions so the A5
 * saga journal (and any future durable memory artifact) reuse ONE audited
 * implementation instead of re-deriving atomic-write / no-follow logic.
 *
 * Guarantees:
 * - **No symlink following** — every component of a target path is `lstat`ed and
 *   a symlink anywhere on the path is refused, never traversed.
 * - **Bounded reads** — reads are capped at an explicit byte budget; oversized,
 *   racing, or non-regular files fail closed.
 * - **Durable, atomic, symlink-safe writes** — a unique same-dir `O_EXCL` `0600`
 *   temp file is written, `fsync`ed, then `rename`d directly over the target (no
 *   unlink gap); the directory is `fsync`ed where supported.
 * - **Restrictive modes** — dir `0700`, files `0600`, repaired toward those where
 *   POSIX-supported.
 *
 * This module intentionally pulls Node built-ins and therefore must only be
 * imported from the backend `./index.ts` surface — never from the pure
 * `./contracts.ts` surface (guarded by `__tests__/boundary.test.ts`).
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { randomUuid } from '../../utils/uuid.ts';

/** Typed failure for durable-file operations. `code` mirrors POSIX errno when known. */
export class DurableFileError extends Error {
  readonly reason: DurableFileErrorReason;
  readonly code?: string;
  readonly path: string;
  constructor(reason: DurableFileErrorReason, message: string, path: string, code?: string) {
    super(message);
    this.name = 'DurableFileError';
    this.reason = reason;
    this.path = path;
    if (code !== undefined) this.code = code;
  }
}

export type DurableFileErrorReason =
  | 'symlink'
  | 'not_regular_file'
  | 'too_large'
  | 'race'
  | 'permission'
  | 'io';

export type DurableReadResult =
  | { status: 'ok'; text: string }
  | { status: 'missing' }
  | { status: 'error'; reason: DurableFileErrorReason; message: string; code?: string };

/**
 * Refuse to operate on any path that has a symlink anywhere in its ancestry.
 * Non-existent components are fine (we may be creating them); a symlink is not.
 */
export function assertNoSymlinkOnPath(path: string): void {
  const absolute = resolve(path);
  let cursor = absolute;
  while (true) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new DurableFileError('symlink', `refusing to operate on symlink path: ${path}`, path);
      }
    } catch (error) {
      if (error instanceof DurableFileError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new DurableFileError('io', `cannot stat path ${path}: ${code ?? 'unknown'}`, path, code);
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

/** Ensure `dir` exists as a real (non-symlink) directory with `0700` mode. */
export function ensureDirSecure(dir: string): void {
  assertNoSymlinkOnPath(dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
}

function repairFileMode(path: string): void {
  if (process.platform === 'win32') return;
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

/**
 * Read a regular file with a hard byte budget. Returns a discriminated result
 * (never throws for the expected missing/oversized/racing cases). A symlinked
 * target is treated as an error, never followed.
 */
export function readTextFileBounded(path: string, maxBytes: number): DurableReadResult {
  assertNoSymlinkOnPath(path);

  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { status: 'error', reason: 'symlink', message: 'target is a symlink' };
    if (!stat.isFile()) return { status: 'error', reason: 'not_regular_file', message: 'target is not a regular file' };
    if (stat.size > maxBytes) return { status: 'error', reason: 'too_large', message: 'file exceeds size limit', code: 'EFBIG' };

    fd = openSync(path, 'r');
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile()) return { status: 'error', reason: 'not_regular_file', message: 'opened file is not a regular file' };
    const size = fileStat.size;
    if (size > maxBytes) return { status: 'error', reason: 'too_large', message: 'file exceeds size limit', code: 'EFBIG' };

    const budget = Math.min(size, maxBytes + 1);
    const buffer = Buffer.alloc(budget);
    const bytesRead = readSync(fd, buffer, 0, budget, 0);
    const after = fstatSync(fd);
    if (after.size !== size || bytesRead !== size) {
      return { status: 'error', reason: 'race', message: 'file changed while reading' };
    }
    if (after.size > maxBytes || bytesRead > maxBytes) {
      return { status: 'error', reason: 'too_large', message: 'file exceeds size limit', code: 'EFBIG' };
    }
    return { status: 'ok', text: buffer.toString('utf8', 0, bytesRead) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing' };
    if (code === 'EACCES' || code === 'EPERM') {
      return { status: 'error', reason: 'permission', message: `read failed: ${code}`, code };
    }
    return { status: 'error', reason: 'io', message: `read failed: ${code ?? 'unknown'}`, code };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * Durably and symlink-safely write `data` to `path`: unique same-dir `O_EXCL`
 * `0600` temp → fsync → atomic rename over target (no unlink gap) → fsync dir.
 */
export function atomicWriteSecure(dir: string, path: string, data: string): void {
  ensureDirSecure(dir);
  const tmp = join(dir, `.${basename(path)}.${randomUuid()}.tmp`);
  assertNoSymlinkOnPath(path);
  assertNoSymlinkOnPath(tmp);

  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, data, null, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(tmp); } catch { /* ignore */ }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new DurableFileError('permission', `failed to write ${path}: ${code}`, path, code);
    }
    throw new DurableFileError('io', `failed to write ${path}: ${code ?? 'unknown'}`, path, code);
  }
  repairFileMode(path);
  fsyncDir(dir);
}

/** Remove a file, tolerating absence. Symlink-safe (refuses a symlinked target). */
export function removeFileSecure(path: string): void {
  assertNoSymlinkOnPath(path);
  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw new DurableFileError('io', `failed to remove ${path}: ${code ?? 'unknown'}`, path, code);
  }
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return;
  let dfd: number | undefined;
  try {
    dfd = openSync(dir, 'r');
    fsyncSync(dfd);
  } catch {
    // Best effort: some filesystems reject directory fsync.
  } finally {
    if (dfd !== undefined) { try { closeSync(dfd); } catch { /* ignore */ } }
  }
}
