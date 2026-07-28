/**
 * Trusted Bridge one-profile API backed by the normal StoredConfig/config.json path.
 *
 * This module never stores credentials. The per-instance token belongs only in
 * CredentialManager as `bridge_instance_token::{bridgeProfileId}`.
 */

import { existsSync } from 'fs';
import { getConfigPath, loadStoredConfig, saveConfig, type StoredConfig } from './storage.ts';
import {
  BridgeConfigError,
  createBridgeProfile,
  sanitizeStoredBridgeProfile,
  type BridgeProfile,
  type BridgeProfileInput,
  type BridgeUrlOptions,
} from './bridge-profile.ts';

export * from './bridge-profile.ts';

/** Read the single active Bridge profile, failing closed for malformed profile data. */
export function getBridgeProfile(): BridgeProfile | null {
  const config = loadStoredConfig();
  return config ? sanitizeStoredBridgeProfile(config.bridgeProfile) : null;
}

/**
 * Validate and persist the single active Bridge profile through normal config.json.
 * Replacing a profile preserves unrelated StoredConfig fields and preserves
 * `createdAt` when updating the same `profileId`.
 */
export function setBridgeProfile(input: BridgeProfileInput, options: BridgeUrlOptions = {}): BridgeProfile {
  let config: StoredConfig;
  const storedConfig = loadStoredConfig();
  if (storedConfig) {
    config = storedConfig;
  } else if (existsSync(getConfigPath())) {
    throw new BridgeConfigError('config-unavailable', 'Cannot update Bridge profile because config.json is unreadable.');
  } else {
    config = {
      workspaces: [],
      activeWorkspaceId: null,
      activeSessionId: null,
    };
  }

  const profile = createBridgeProfile(input, sanitizeStoredBridgeProfile(config.bridgeProfile), options);
  config.bridgeProfile = profile;
  saveConfig(config);
  return profile;
}

/**
 * Clear the active Bridge profile without touching its CredentialManager token.
 * Rewrites an otherwise-valid config even when the stored profile was malformed,
 * ensuring malformed/unknown Bridge fields are removed from the normal save path.
 */
export function clearBridgeProfile(): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  const hadProfile = sanitizeStoredBridgeProfile(config.bridgeProfile) !== null;
  delete config.bridgeProfile;
  saveConfig(config);
  return hadProfile;
}
