/**
 * Backend barrel for Memory connection/space contracts, persistence, DTOs, and
 * the environment-compat connection.
 *
 * This entry pulls in Node built-ins (via the repository / crypto derivations).
 * Renderer/browser-facing code must import the pure `./contracts.ts` subpath
 * instead (`@craft-agent/shared/project-memory/contracts`).
 */

// Pure contract surface (types, limits, validators, identity, DTO types, session refs).
export * from './contracts.ts';

// Backend-only: repository, environment builder, crypto derivations, mappers.
export * from './repository.ts';
export * from './environment.ts';
export * from './mappers.ts';
export * from './service.ts';
// Backend-only: A5 durable saga (journal, lease, coordinator, durable-file).
export * from './saga.ts';
export * from './saga-journal.ts';
export * from './saga-lease.ts';
export * from './durable-file.ts';
export { MEMORY_GLOBAL_SPACE_NAMESPACE } from './global-space.ts';
