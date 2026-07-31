import { BridgeCredentialSaga, getBridgeProfile } from '../index.ts';
import { CredentialManager } from '../../credentials/manager.ts';

const mode = process.env.BRIDGE_SAGA_WORKER_MODE;
const crash = process.env.BRIDGE_SAGA_CRASH_POINT;
const credentials = new CredentialManager({ credentialsConfigDir: process.env.CRAFT_CONFIG_DIR });
const saga = new BridgeCredentialSaga(credentials, {
  onBarrier: ({ barrier, phase }) => {
    if (crash === `${barrier}:${phase}`) process.exit(77);
  },
  onStageCleanup: () => {
    if (crash === 'cleanup:after') process.exit(77);
  },
});

if (mode === 'commit') {
  const current = getBridgeProfile();
  if (!current) throw new Error('profile missing');
  await saga.commitEnrollment({ ...current, deploymentId: 'deployment-1', instanceId: 'instance-1' }, 'instance-token-secret');
} else if (mode === 'recover') {
  await saga.ensureRecovered();
} else {
  throw new Error('unknown worker mode');
}
