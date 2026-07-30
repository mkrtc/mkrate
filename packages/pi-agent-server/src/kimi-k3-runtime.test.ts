import { describe, expect, it } from 'bun:test';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from './in-memory-credential-store.ts';
import { resolvePiModel } from './model-resolution.ts';

describe('Kimi K3 subprocess runtime', () => {
  it('resolves the authenticated Kimi Coding model with full runtime metadata', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.set('kimi-coding', { type: 'api_key', key: 'test-key' });

    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    const registry = new ModelRegistry(runtime);
    const model = resolvePiModel(registry, 'k3', 'kimi-coding');

    expect(model).toMatchObject({
      id: 'k3',
      name: 'Kimi K3',
      provider: 'kimi-coding',
      api: 'anthropic-messages',
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        low: 'low',
        high: 'high',
        max: 'max',
      },
    });
    expect(model && registry.hasConfiguredAuth(model)).toBe(true);
  });
});
