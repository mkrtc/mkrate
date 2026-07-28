import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __setConfigDirForTests } from '../paths.ts';
import {
  BridgeConfigError,
  BRIDGE_DISPLAY_NAME_MAX_LENGTH,
  clearBridgeProfile,
  getBridgeConfigPath,
  getBridgeProfile,
  isValidBridgeProfileId,
  normalizeBridgeDisplayName,
  setBridgeProfile,
  validateBridgeUrl,
  type BridgeProfile,
} from '../bridge-config.ts';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_UUID = '00000000-1111-4222-8333-444444444444';

// Constructed (never a raw byte in source) so the test file stays clean text.
const CTRL = String.fromCharCode(0x07); // bell — an ASCII control character
const COMBINING_ACUTE = String.fromCharCode(0x0301);

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'craft-bridge-config-'));
  __setConfigDirForTests(configDir);
});

afterEach(() => {
  __setConfigDirForTests(null);
  rmSync(configDir, { recursive: true, force: true });
});

function readRawConfig(): string {
  return readFileSync(getBridgeConfigPath(), 'utf-8');
}

describe('validateBridgeUrl — accepts canonical wss URLs', () => {
  test('plain host', () => {
    expect(validateBridgeUrl('wss://bridge.example.com')).toEqual({ ok: true, url: 'wss://bridge.example.com' });
  });
  test('host with hyphens (not a control-char reject)', () => {
    expect(validateBridgeUrl('wss://my-self-hosted-bridge.example.com')).toEqual({
      ok: true,
      url: 'wss://my-self-hosted-bridge.example.com',
    });
  });
  test('explicit non-default port is preserved', () => {
    expect(validateBridgeUrl('wss://bridge.example.com:9443')).toEqual({ ok: true, url: 'wss://bridge.example.com:9443' });
  });
  test('IPv4 host', () => {
    expect(validateBridgeUrl('wss://203.0.113.4')).toEqual({ ok: true, url: 'wss://203.0.113.4' });
  });
  test('trailing root slash normalizes away', () => {
    expect(validateBridgeUrl('wss://bridge.example.com/')).toEqual({ ok: true, url: 'wss://bridge.example.com' });
  });
});

describe('validateBridgeUrl — insecure downgrade policy', () => {
  test('ws:// rejected by default', () => {
    expect(validateBridgeUrl('ws://bridge.example.com')).toEqual({ ok: false, reason: 'insecure-downgrade' });
  });
  test('ws:// loopback rejected without the explicit option', () => {
    expect(validateBridgeUrl('ws://127.0.0.1:9100')).toEqual({ ok: false, reason: 'insecure-downgrade' });
  });
  test('ws:// allowed ONLY for exact loopback under the explicit option', () => {
    const opt = { allowInsecureLoopback: true };
    expect(validateBridgeUrl('ws://127.0.0.1:9100', opt)).toEqual({ ok: true, url: 'ws://127.0.0.1:9100' });
    expect(validateBridgeUrl('ws://localhost:9100', opt)).toEqual({ ok: true, url: 'ws://localhost:9100' });
    expect(validateBridgeUrl('ws://[::1]:9100', opt)).toEqual({ ok: true, url: 'ws://[::1]:9100' });
  });
  test('ws:// non-loopback still rejected even under the option', () => {
    expect(validateBridgeUrl('ws://bridge.example.com', { allowInsecureLoopback: true })).toEqual({
      ok: false,
      reason: 'insecure-downgrade',
    });
    expect(validateBridgeUrl('ws://10.0.0.5', { allowInsecureLoopback: true })).toEqual({
      ok: false,
      reason: 'insecure-downgrade',
    });
  });
  test('wss loopback is always fine (no option needed)', () => {
    expect(validateBridgeUrl('wss://127.0.0.1:9100')).toEqual({ ok: true, url: 'wss://127.0.0.1:9100' });
  });
});

describe('validateBridgeUrl — structural rejections', () => {
  const cases: Array<[string, string]> = [
    ['userinfo (user:pass)', 'wss://user:pass@bridge.example.com'],
    ['userinfo (empty)', 'wss://@bridge.example.com'],
    ['query string', 'wss://bridge.example.com?token=abc'],
    ['fragment', 'wss://bridge.example.com#frag'],
    ['non-root path', 'wss://bridge.example.com/ws'],
    ['deep path confusion', 'wss://bridge.example.com/../etc'],
    ['http scheme', 'http://bridge.example.com'],
    ['https scheme', 'https://bridge.example.com'],
    ['bare host', 'bridge.example.com'],
    ['uppercase scheme', 'WSS://bridge.example.com'],
    ['uppercase host (non-canonical)', 'wss://Bridge.Example.com'],
    ['redundant default port (non-canonical)', 'wss://bridge.example.com:443'],
    ['backslash', 'wss://bridge.example.com\\evil'],
  ];
  for (const [label, url] of cases) {
    test(`rejects ${label}`, () => {
      expect(validateBridgeUrl(url).ok).toBe(false);
    });
  }

  test('rejects empty / non-string / whitespace-only', () => {
    expect(validateBridgeUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateBridgeUrl('    ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateBridgeUrl(undefined)).toEqual({ ok: false, reason: 'not-a-string' });
    expect(validateBridgeUrl(123 as unknown)).toEqual({ ok: false, reason: 'not-a-string' });
  });

  test('rejects whitespace / control characters embedded in the URL', () => {
    expect(validateBridgeUrl('wss://bridge.example.com evil').ok).toBe(false);
    expect(validateBridgeUrl(`wss://bridge.example.com${CTRL}`).ok).toBe(false);
  });
});

describe('normalizeBridgeDisplayName', () => {
  test('trims surrounding whitespace', () => {
    expect(normalizeBridgeDisplayName('  Home Bridge  ')).toBe('Home Bridge');
  });
  test('applies NFC normalization (decomposed → composed)', () => {
    const decomposed = `e${COMBINING_ACUTE}`; // "e" + combining acute accent
    const composed = String.fromCharCode(0x00e9); // "é"
    expect(decomposed).not.toBe(composed); // sanity: inputs differ pre-normalization
    expect(normalizeBridgeDisplayName(decomposed)).toBe(composed);
  });
  test('rejects empty / whitespace-only', () => {
    expect(normalizeBridgeDisplayName('')).toBeNull();
    expect(normalizeBridgeDisplayName('   ')).toBeNull();
  });
  test('rejects control characters', () => {
    expect(normalizeBridgeDisplayName(`bad${CTRL}name`)).toBeNull();
  });
  test('enforces bounded length by code points', () => {
    const ok = 'a'.repeat(BRIDGE_DISPLAY_NAME_MAX_LENGTH);
    const tooLong = 'a'.repeat(BRIDGE_DISPLAY_NAME_MAX_LENGTH + 1);
    expect(normalizeBridgeDisplayName(ok)).toBe(ok);
    expect(normalizeBridgeDisplayName(tooLong)).toBeNull();
  });
  test('non-string is rejected', () => {
    expect(normalizeBridgeDisplayName(42 as unknown)).toBeNull();
  });
});

describe('getBridgeProfile / setBridgeProfile / clearBridgeProfile', () => {
  test('get returns null when nothing is configured', () => {
    expect(getBridgeProfile()).toBeNull();
  });

  test('set → get round-trips a canonical profile with generated id', () => {
    const saved = setBridgeProfile({ url: 'wss://bridge.example.com', displayName: '  My Bridge  ' });
    expect(isValidBridgeProfileId(saved.profileId)).toBe(true);
    expect(saved.url).toBe('wss://bridge.example.com');
    expect(saved.displayName).toBe('My Bridge');
    expect(saved.enabled).toBe(true);
    expect(saved.createdAt).toBeGreaterThan(0);
    expect(saved.updatedAt).toBeGreaterThanOrEqual(saved.createdAt);

    expect(getBridgeProfile()).toEqual(saved);
  });

  test('explicit uppercase UUID profileId is canonicalized', () => {
    const saved = setBridgeProfile({ profileId: UUID.toUpperCase(), url: 'wss://bridge.example.com', displayName: 'X' });
    expect(saved.profileId).toBe(UUID);
    expect(getBridgeProfile()?.profileId).toBe(UUID);
  });

  test('one active profile: a second set replaces the first', () => {
    setBridgeProfile({ profileId: UUID, url: 'wss://a.example.com', displayName: 'A' });
    setBridgeProfile({ profileId: OTHER_UUID, url: 'wss://b.example.com', displayName: 'B' });
    const loaded = getBridgeProfile();
    expect(loaded?.profileId).toBe(OTHER_UUID);
    expect(loaded?.url).toBe('wss://b.example.com');
  });

  test('updating the same profileId preserves createdAt and bumps updatedAt', async () => {
    const first = setBridgeProfile({ profileId: UUID, url: 'wss://a.example.com', displayName: 'A' });
    await new Promise((r) => setTimeout(r, 2));
    const second = setBridgeProfile({ profileId: UUID, url: 'wss://a2.example.com', displayName: 'A2' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(second.url).toBe('wss://a2.example.com');
  });

  test('optional deploymentId / instanceId round-trip', () => {
    const saved = setBridgeProfile({
      url: 'wss://bridge.example.com',
      displayName: 'X',
      enabled: false,
      deploymentId: 'deploy-123',
      instanceId: 'instance-abc',
    });
    expect(saved.enabled).toBe(false);
    expect(saved.deploymentId).toBe('deploy-123');
    expect(saved.instanceId).toBe('instance-abc');
    expect(getBridgeProfile()).toEqual(saved);
  });

  test('ws:// loopback requires the explicit option on set too', () => {
    expect(() => setBridgeProfile({ url: 'ws://127.0.0.1:9100', displayName: 'Local' })).toThrow(BridgeConfigError);
    const saved = setBridgeProfile({ url: 'ws://127.0.0.1:9100', displayName: 'Local' }, { allowInsecureLoopback: true });
    expect(saved.url).toBe('ws://127.0.0.1:9100');
  });

  test('clear removes the profile and reports whether one existed', () => {
    expect(clearBridgeProfile()).toBe(false);
    setBridgeProfile({ url: 'wss://bridge.example.com', displayName: 'X' });
    expect(clearBridgeProfile()).toBe(true);
    expect(getBridgeProfile()).toBeNull();
    expect(clearBridgeProfile()).toBe(false);
  });
});

describe('setBridgeProfile — invalid input rejected with BridgeConfigError', () => {
  test('invalid URL', () => {
    expect(() => setBridgeProfile({ url: 'http://bridge.example.com', displayName: 'X' })).toThrow(BridgeConfigError);
  });
  test('invalid display name (empty)', () => {
    expect(() => setBridgeProfile({ url: 'wss://bridge.example.com', displayName: '   ' })).toThrow(BridgeConfigError);
  });
  test('invalid display name (control char)', () => {
    expect(() => setBridgeProfile({ url: 'wss://bridge.example.com', displayName: `a${CTRL}b` })).toThrow(
      BridgeConfigError,
    );
  });
  test('invalid profileId (not a uuid)', () => {
    expect(() => setBridgeProfile({ profileId: 'not-a-uuid', url: 'wss://bridge.example.com', displayName: 'X' })).toThrow(
      BridgeConfigError,
    );
  });
  test('invalid profileId (contains delimiter)', () => {
    expect(() => setBridgeProfile({ profileId: 'a::b', url: 'wss://bridge.example.com', displayName: 'X' })).toThrow(
      BridgeConfigError,
    );
  });
  test('invalid opaque id (control char)', () => {
    expect(() =>
      setBridgeProfile({ url: 'wss://bridge.example.com', displayName: 'X', deploymentId: `a${CTRL}b` }),
    ).toThrow(BridgeConfigError);
  });
  test('nothing is written to disk on rejected set', () => {
    expect(() => setBridgeProfile({ url: 'ftp://x', displayName: 'X' })).toThrow();
    expect(getBridgeProfile()).toBeNull();
  });
});

describe('corruption fail-closed', () => {
  test('garbage bytes read back as null', () => {
    setBridgeProfile({ url: 'wss://bridge.example.com', displayName: 'X' });
    writeFileSync(getBridgeConfigPath(), 'this is not json at all');
    expect(getBridgeProfile()).toBeNull();
  });
  test('valid JSON but missing required field reads back as null', () => {
    writeFileSync(
      getBridgeConfigPath(),
      JSON.stringify({ version: 1, profile: { profileId: UUID, url: 'wss://bridge.example.com' } }),
    );
    expect(getBridgeProfile()).toBeNull();
  });
  test('an explicit null profile reads back as null', () => {
    writeFileSync(getBridgeConfigPath(), JSON.stringify({ version: 1, profile: null }));
    expect(getBridgeProfile()).toBeNull();
  });
  test('a stored profile with an invalid (non-canonical) url fails closed', () => {
    writeFileSync(
      getBridgeConfigPath(),
      JSON.stringify({
        version: 1,
        profile: {
          profileId: UUID,
          url: 'wss://Bad-UPPER.example.com', // non-canonical (uppercase) host
          displayName: 'X',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    expect(getBridgeProfile()).toBeNull();
  });
});

describe('no hidden token fields', () => {
  test('a hidden secret field on disk is dropped on read', () => {
    const rogue = {
      version: 1,
      profile: {
        profileId: UUID,
        url: 'wss://bridge.example.com',
        displayName: 'X',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        // Attacker/legacy-injected secret-looking fields:
        token: 'sk-should-never-surface',
        instanceToken: 'sk-should-never-surface',
        bootstrapToken: 'sk-should-never-surface',
      },
    };
    writeFileSync(getBridgeConfigPath(), JSON.stringify(rogue));
    const loaded = getBridgeProfile() as (BridgeProfile & Record<string, unknown>) | null;
    expect(loaded).not.toBeNull();
    expect(loaded!.token).toBeUndefined();
    expect(loaded!.instanceToken).toBeUndefined();
    expect(loaded!.bootstrapToken).toBeUndefined();
    expect(Object.keys(loaded!).sort()).toEqual(
      ['createdAt', 'displayName', 'enabled', 'profileId', 'updatedAt', 'url'].sort(),
    );
  });

  test('set never writes token-like fields even if passed via a widened cast', () => {
    setBridgeProfile({
      url: 'wss://bridge.example.com',
      displayName: 'X',
      // Fields NOT part of the schema; must never be persisted.
      token: 'sk-secret',
      instanceToken: 'sk-secret',
    } as never);
    const raw = readRawConfig();
    expect(raw.includes('token')).toBe(false);
    expect(raw.includes('sk-secret')).toBe(false);

    const stored = JSON.parse(raw).profile as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(
      ['createdAt', 'displayName', 'enabled', 'profileId', 'updatedAt', 'url'].sort(),
    );
  });
});
