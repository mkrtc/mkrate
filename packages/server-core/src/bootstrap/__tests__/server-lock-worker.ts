import { bootstrapServer, ServerLockConflictError } from '../headless-start.ts';

const mode = process.env.SERVER_LOCK_WORKER_MODE;
const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function start() {
  return bootstrapServer({
    serverToken: '0123456789abcdef0123456789abcdef',
    rpcPort: mode === 'fail-after-lock' ? 70_000 : 0,
    serverVersion: 'packaged-like-test',
    platformFactory: () => ({ logger } as any),
    initModelRefreshService: () => ({ startAll() {}, stopAll() {} }),
    createSessionManager: () => ({}),
    createHandlerDeps: () => ({}),
    registerAllRpcHandlers: () => {},
    setSessionEventSink: () => {},
    initializeSessionManager: async () => {},
    cleanupSessionManager: async () => {},
  });
}

try {
  const instance = await start();
  if (mode === 'hold') {
    process.stdout.write(`READY:${process.pid}\n`);
    process.on('SIGTERM', () => { void instance.stop().finally(() => process.exit(0)); });
    await new Promise(() => {});
  } else {
    await instance.stop();
    process.stdout.write('STARTED_AND_STOPPED\n');
  }
} catch (error) {
  if (error instanceof ServerLockConflictError) {
    process.stdout.write(JSON.stringify({
      visibleAction: true,
      ownerPid: error.ownerPid,
      message: error.message,
      choices: ['close-existing-application', 'explicit-separate-profile'],
    }) + '\n');
    process.exit(23);
  }
  if (mode === 'fail-after-lock') {
    process.stdout.write(`EXPECTED_STARTUP_FAILURE:${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(24);
  }
  throw error;
}
