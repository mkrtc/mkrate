import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BridgeConfigError,
  BRIDGE_DISPLAY_NAME_MAX_LENGTH,
  clearBridgeProfile,
  getBridgeProfile,
  isValidBridgeProfileId,
  normalizeBridgeDisplayName,
  setBridgeProfile,
  validateBridgeUrl,
  type BridgeProfile,
} from '../bridge-config.ts';
import { getConfigPath, loadStoredConfig, saveConfig, type StoredConfig } from '../storage.ts';
import { __setConfigDirForTests } from '../paths.ts';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_UUID = '00000000-1111-4222-8333-444444444444';
const CTRL = String.fromCharCode(0x07);
const COMBINING_ACUTE = String.fromCharCode(0x0301);

let configDir: string;

function baseConfig(extra: Partial<StoredConfig> = {}): StoredConfig {
  return {
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    notificationsEnabled: false,
    colorTheme: 'nord',
    ...extra,
  };
}

function writeRawConfig(config: unknown): void {
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2));
}

function readRawConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'craft-bridge-config-'));
  __setConfigDirForTests(configDir);
  writeRawConfig(baseConfig());
});

afterEach(() => {
  __setConfigDirForTests(null);
  rmSync(configDir, { recursive: true, force: true });
});

describe('validateBridgeUrl — canonical and benign normalization', () => {
  test('accepts canonical hosts, IPv4, and explicit non-default ports', () => {
    expect(validateBridgeUrl('wss://bridge.example.com')).toEqual({ ok: true, url: 'wss://bridge.example.com' });
    expect(validateBridgeUrl('wss://203.0.113.4')).toEqual({ ok: true, url: 'wss://203.0.113.4' });
    expect(validateBridgeUrl('wss://bridge.example.com:9443')).toEqual({
      ok: true,
      url: 'wss://bridge.example.com:9443',
    });
  });

  test('canonicalizes benign scheme/host case, root slash, and default port together', () => {
    expect(validateBridgeUrl('WSS://Bridge.Example.COM:443/')).toEqual({
      ok: true,
      url: 'wss://bridge.example.com',
    });
  });

  test('trims harmless surrounding whitespace', () => {
    expect(validateBridgeUrl('  wss://bridge.example.com/  ')).toEqual({
      ok: true,
      url: 'wss://bridge.example.com',
    });
  });

  test('accepts canonical bracketed IPv6 without rewriting its address form', () => {
    expect(validateBridgeUrl('wss://[2001:db8::1]:9443/')).toEqual({
      ok: true,
      url: 'wss://[2001:db8::1]:9443',
    });
  });
});

describe('validateBridgeUrl — insecure loopback policy', () => {
  test('rejects every ws:// URL by default', () => {
    expect(validateBridgeUrl('ws://bridge.example.com')).toEqual({ ok: false, reason: 'insecure-downgrade' });
    expect(validateBridgeUrl('ws://127.0.0.1:9100')).toEqual({ ok: false, reason: 'insecure-downgrade' });
  });

  test('allows only exact loopback hosts under the explicit option', () => {
    const options = { allowInsecureLoopback: true };
    expect(validateBridgeUrl('ws://127.0.0.1:9100', options)).toEqual({
      ok: true,
      url: 'ws://127.0.0.1:9100',
    });
    expect(validateBridgeUrl('WS://LOCALHOST:80/', options)).toEqual({ ok: true, url: 'ws://localhost' });
    expect(validateBridgeUrl('ws://[::1]:9100', options)).toEqual({ ok: true, url: 'ws://[::1]:9100' });
  });

  test('does not treat private, wildcard, suffix, or legacy numeric hosts as exact loopback', () => {
    const options = { allowInsecureLoopback: true };
    for (const input of [
      'ws://10.0.0.5',
      'ws://0.0.0.0',
      'ws://localhost.example.com',
      'ws://localhost.',
      'ws://127.1',
      'ws://2130706433',
    ]) {
      expect(validateBridgeUrl(input, options).ok).toBe(false);
    }
  });
});

describe('validateBridgeUrl — structural and coercion rejections', () => {
  const cases: Array<[string, string]> = [
    ['userinfo', 'wss://user:pass@bridge.example.com'],
    ['empty userinfo', 'wss://@bridge.example.com'],
    ['query', 'wss://bridge.example.com?token=abc'],
    ['empty query', 'wss://bridge.example.com?'],
    ['fragment', 'wss://bridge.example.com#frag'],
    ['empty fragment', 'wss://bridge.example.com#'],
    ['non-root path', 'wss://bridge.example.com/ws'],
    ['deep normalized path', 'wss://bridge.example.com/../etc'],
    ['dot path normalized to root', 'wss://bridge.example.com/.'],
    ['parent path normalized to root', 'wss://bridge.example.com/..'],
    ['encoded dot path normalized to root', 'wss://bridge.example.com/%2e'],
    ['HTTP scheme', 'http://bridge.example.com'],
    ['HTTPS scheme', 'https://bridge.example.com'],
    ['bare host', 'bridge.example.com'],
    ['backslash', 'wss://bridge.example.com\\evil'],
    ['Unicode IDN coercion', 'wss://bücher.example'],
    ['padded non-default port', 'wss://bridge.example.com:09443'],
    ['padded default port', 'wss://bridge.example.com:0443'],
    ['unbracketed IPv6', 'wss://2001:db8::1'],
    ['IPv6 address-form rewrite', 'wss://[0:0:0:0:0:0:0:1]'],
  ];

  for (const [label, url] of cases) {
    test(`rejects ${label}`, () => {
      expect(validateBridgeUrl(url).ok).toBe(false);
    });
  }

  test('rejects genuinely ambiguous legacy numeric IPv4 forms', () => {
    for (const input of [
      'wss://127.1',
      'wss://2130706433',
      'wss://0x7f.0.0.1',
      'wss://0177.0.0.1',
      'wss://127.000.000.001',
    ]) {
      expect(validateBridgeUrl(input).ok).toBe(false);
    }
  });

  test('rejects empty, non-string, internal whitespace, and controls', () => {
    expect(validateBridgeUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateBridgeUrl('    ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateBridgeUrl(undefined)).toEqual({ ok: false, reason: 'not-a-string' });
    expect(validateBridgeUrl(123 as unknown)).toEqual({ ok: false, reason: 'not-a-string' });
    expect(validateBridgeUrl('wss://bridge.example.com evil').ok).toBe(false);
    expect(validateBridgeUrl(`wss://bridge.example.com${CTRL}`).ok).toBe(false);
    expect(validateBridgeUrl(`\nwss://bridge.example.com`).ok).toBe(false);
  });
});

describe('normalizeBridgeDisplayName', () => {
  test('trims, NFC-normalizes, and bounds by code points', () => {
    const decomposed = `e${COMBINING_ACUTE}`;
    const composed = String.fromCharCode(0x00e9);
    expect(normalizeBridgeDisplayName('  Home Bridge  ')).toBe('Home Bridge');
    expect(normalizeBridgeDisplayName(decomposed)).toBe(composed);
    expect(normalizeBridgeDisplayName('a'.repeat(BRIDGE_DISPLAY_NAME_MAX_LENGTH))).not.toBeNull();
    expect(normalizeBridgeDisplayName('a'.repeat(BRIDGE_DISPLAY_NAME_MAX_LENGTH + 1))).toBeNull();
  });

  test('rejects empty, controls, and non-strings', () => {
    expect(normalizeBridgeDisplayName('   ')).toBeNull();
    expect(normalizeBridgeDisplayName(`bad${CTRL}name`)).toBeNull();
    expect(normalizeBridgeDisplayName(42 as unknown)).toBeNull();
  });
});

describe('Bridge profile in normal StoredConfig/config.json', () => {
  test('get returns null when the optional profile is absent', () => {
    expect(getBridgeProfile()).toBeNull();
  });

  test('set persists a safe canonical profile and preserves unrelated config fields', () => {
    const saved = setBridgeProfile({
      url: 'WSS://Bridge.Example.COM:443/',
      displayName: '  My Bridge  ',
    });

    expect(isValidBridgeProfileId(saved.profileId)).toBe(true);
    expect(saved.url).toBe('wss://bridge.example.com');
    expect(saved.displayName).toBe('My Bridge');
    expect(saved.enabled).toBe(true);
    expect(saved.createdAt).toBeGreaterThan(0);
    expect(saved.updatedAt).toBeGreaterThanOrEqual(saved.createdAt);
    expect(getBridgeProfile()).toEqual(saved);

    const raw = readRawConfig();
    expect(raw.notificationsEnabled).toBe(false);
    expect(raw.colorTheme).toBe('nord');
    expect(raw.workspaces).toEqual([]);
    expect(raw.bridgeProfile).toEqual(saved);
    expect(existsSync(join(configDir, 'bridge-config.json'))).toBe(false);
  });

  test('can create the normal minimal config when config.json is absent', () => {
    rmSync(getConfigPath());
    const saved = setBridgeProfile({ url: 'wss://bridge.example.com', displayName: 'Bridge' });
    expect(getBridgeProfile()).toEqual(saved);
    expect(readRawConfig().workspaces).toEqual([]);
  });

  test('canonicalizes an explicit uppercase UUID and keeps one profile slot', () => {
    expect(setBridgeProfile({
      profileId: UUID.toUpperCase(),
      url: 'wss://a.example.com',
      displayName: 'A',
    }).profileId).toBe(UUID);

    setBridgeProfile({ profileId: OTHER_UUID, url: 'wss://b.example.com', displayName: 'B' });
    expect(getBridgeProfile()?.profileId).toBe(OTHER_UUID);
    expect((readRawConfig().bridgeProfile as BridgeProfile).url).toBe('wss://b.example.com');
  });

  test('same-profile update preserves createdAt and advances updatedAt', async () => {
    const first = setBridgeProfile({ profileId: UUID, url: 'wss://a.example.com', displayName: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = setBridgeProfile({ profileId: UUID, url: 'wss://a2.example.com', displayName: 'A2' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  test('optional non-secret identifiers and disabled state round-trip', () => {
    const saved = setBridgeProfile({
      url: 'wss://bridge.example.com',
      displayName: 'Bridge',
      enabled: false,
      deploymentId: ' deploy-123 ',
      instanceId: 'instance-abc',
    });
    expect(saved).toMatchObject({ enabled: false, deploymentId: 'deploy-123', instanceId: 'instance-abc' });
    expect(getBridgeProfile()).toEqual(saved);
  });

  test('loopback ws:// requires the explicit option on set', () => {
    expect(() => setBridgeProfile({ url: 'ws://127.0.0.1:9100', displayName: 'Local' })).toThrow(
      BridgeConfigError,
    );
    const saved = setBridgeProfile(
      { url: 'WS://LOCALHOST:80/', displayName: 'Local' },
      { allowInsecureLoopback: true },
    );
    expect(saved.url).toBe('ws://localhost');
    expect(getBridgeProfile()).toEqual(saved);
  });

  test('clear removes only the profile and reports whether a valid one existed', () => {
    expect(clearBridgeProfile()).toBe(false);
    setBridgeProfile({ url: 'wss://bridge.example.com', displayName: 'Bridge' });
    expect(clearBridgeProfile()).toBe(true);
    expect(getBridgeProfile()).toBeNull();
    expect(readRawConfig().notificationsEnabled).toBe(false);
    expect(readRawConfig().bridgeProfile).toBeUndefined();
    expect(clearBridgeProfile()).toBe(false);
  });
});

describe('malformed profile fail-closed without poisoning normal config', () => {
  test('missing required profile fields are omitted while unrelated settings remain usable', () => {
    writeRawConfig(baseConfig({
      bridgeProfile: {
        profileId: UUID,
        url: 'wss://bridge.example.com',
      } as BridgeProfile,
    }));

    const loaded = loadStoredConfig();
    expect(loaded).not.toBeNull();
    expect(loaded?.notificationsEnabled).toBe(false);
    expect(loaded?.colorTheme).toBe('nord');
    expect(loaded?.bridgeProfile).toBeUndefined();
    expect(getBridgeProfile()).toBeNull();
  });

  test('invalid URL or timestamps fail the profile closed', () => {
    for (const profile of [
      {
        profileId: UUID,
        url: 'https://bridge.example.com',
        displayName: 'Bridge',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        profileId: UUID,
        url: 'wss://bridge.example.com',
        displayName: 'Bridge',
        enabled: true,
        createdAt: 2,
        updatedAt: 1,
      },
    ]) {
      writeRawConfig({ ...baseConfig(), bridgeProfile: profile });
      expect(getBridgeProfile()).toBeNull();
      expect(loadStoredConfig()?.notificationsEnabled).toBe(false);
    }
  });

  test('a later normal save removes malformed profile data and preserves other fields', () => {
    writeRawConfig({
      ...baseConfig(),
      bridgeProfile: { profileId: UUID, url: 'not-a-url', token: 'should-not-survive' },
    });
    const loaded = loadStoredConfig();
    expect(loaded).not.toBeNull();
    saveConfig(loaded!);
    const raw = readRawConfig();
    expect(raw.bridgeProfile).toBeUndefined();
    expect(raw.colorTheme).toBe('nord');
  });

  test('set refuses to overwrite an existing unreadable normal config', () => {
    const corrupt = '{ this is not valid JSON';
    writeFileSync(getConfigPath(), corrupt);
    expect(() => setBridgeProfile({ url: 'wss://bridge.example.com', displayName: 'Bridge' })).toThrow(
      BridgeConfigError,
    );
    expect(readFileSync(getConfigPath(), 'utf-8')).toBe(corrupt);
  });
});

describe('secret fields never enter or leave StoredConfig', () => {
  const safeProfile = {
    profileId: UUID,
    url: 'wss://bridge.example.com',
    displayName: 'Bridge',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  test('fixed-allowlist load strips token and bootstrap fields from an otherwise valid profile', () => {
    writeRawConfig({
      ...baseConfig(),
      bridgeProfile: {
        ...safeProfile,
        token: 'sk-secret',
        instanceToken: 'sk-secret',
        bootstrapToken: 'sk-secret',
      },
    });

    const loaded = loadStoredConfig()!;
    const profile = loaded.bridgeProfile as (BridgeProfile & Record<string, unknown>) | undefined;
    expect(profile).toBeDefined();
    expect(profile?.token).toBeUndefined();
    expect(profile?.instanceToken).toBeUndefined();
    expect(profile?.bootstrapToken).toBeUndefined();
    expect(Object.keys(profile!).sort()).toEqual(
      ['createdAt', 'displayName', 'enabled', 'profileId', 'updatedAt', 'url'].sort(),
    );

    saveConfig(loaded);
    expect(JSON.stringify(readRawConfig()).toLowerCase()).not.toContain('token');
  });

  test('the normal save boundary strips secret-looking fields from widened input', () => {
    saveConfig({
      ...baseConfig(),
      bridgeProfile: {
        ...safeProfile,
        token: 'sk-secret',
        bootstrapToken: 'sk-secret',
      },
    } as StoredConfig);

    const rawProfile = readRawConfig().bridgeProfile as Record<string, unknown>;
    expect(rawProfile.token).toBeUndefined();
    expect(rawProfile.bootstrapToken).toBeUndefined();
    expect(JSON.stringify(rawProfile)).not.toContain('sk-secret');
  });

  test('set ignores token-like fields supplied through an unsafe widened cast', () => {
    setBridgeProfile({
      url: 'wss://bridge.example.com',
      displayName: 'Bridge',
      token: 'sk-secret',
      instanceToken: 'sk-secret',
      bootstrapToken: 'sk-secret',
    } as never);

    const rawProfile = readRawConfig().bridgeProfile as Record<string, unknown>;
    expect(Object.keys(rawProfile).sort()).toEqual(
      ['createdAt', 'displayName', 'enabled', 'profileId', 'updatedAt', 'url'].sort(),
    );
    expect(JSON.stringify(rawProfile)).not.toContain('sk-secret');
  });
});

describe('setBridgeProfile invalid input', () => {
  test('rejects invalid URL, name, profile id, enabled value, and opaque ids without changing config', () => {
    const original = readFileSync(getConfigPath(), 'utf-8');
    const invalidInputs = [
      { url: 'http://bridge.example.com', displayName: 'Bridge' },
      { url: 'wss://bridge.example.com', displayName: '   ' },
      { url: 'wss://bridge.example.com', displayName: `a${CTRL}b` },
      { profileId: 'not-a-uuid', url: 'wss://bridge.example.com', displayName: 'Bridge' },
      { url: 'wss://bridge.example.com', displayName: 'Bridge', enabled: 'yes' },
      { url: 'wss://bridge.example.com', displayName: 'Bridge', deploymentId: `a${CTRL}b` },
    ];

    for (const input of invalidInputs) {
      expect(() => setBridgeProfile(input as never)).toThrow(BridgeConfigError);
      expect(readFileSync(getConfigPath(), 'utf-8')).toBe(original);
    }
  });
});
