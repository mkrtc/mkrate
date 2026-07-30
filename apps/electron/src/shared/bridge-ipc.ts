export const BRIDGE_IPC_CHANNELS = Object.freeze({
  getState: '__bridge:get-state',
  updateProfile: '__bridge:update-profile',
  openPairing: '__bridge:pairing-open',
  closePairing: '__bridge:pairing-close',
  approvePairing: '__bridge:pairing-approve',
  rejectPairing: '__bridge:pairing-reject',
  listBindings: '__bridge:binding-list',
  revokeBinding: '__bridge:binding-revoke',
})
