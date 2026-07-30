import { describe, expect, it } from 'bun:test';
import { InMemoryCredentialStore } from './in-memory-credential-store.ts';

const apiKey = (key: string) => ({ type: 'api_key' as const, key });

describe('InMemoryCredentialStore', () => {
  it('stores only non-secret credential metadata in list results', async () => {
    const store = new InMemoryCredentialStore();
    await store.set('kimi-coding', apiKey('secret'));

    expect(await store.list()).toEqual([{ providerId: 'kimi-coding', type: 'api_key' }]);
  });

  it('serializes concurrent writes for the same provider', async () => {
    const store = new InMemoryCredentialStore();
    await store.set('kimi-coding', apiKey('initial'));

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const writes: string[] = [];

    const first = store.modify('kimi-coding', async () => {
      writes.push('first:start');
      markFirstStarted();
      await firstGate;
      writes.push('first:end');
      return apiKey('first');
    });
    const second = store.modify('kimi-coding', async current => {
      writes.push(`second:${current?.type === 'api_key' ? current.key : 'missing'}`);
      return apiKey('second');
    });

    await firstStarted;
    expect(writes).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(writes).toEqual(['first:start', 'first:end', 'second:first']);
    expect(await store.read('kimi-coding')).toEqual(apiKey('second'));
  });

  it('keeps the current credential when modify returns undefined', async () => {
    const store = new InMemoryCredentialStore();
    await store.set('kimi-coding', apiKey('kept'));

    await store.modify('kimi-coding', async () => undefined);

    expect(await store.read('kimi-coding')).toEqual(apiKey('kept'));
  });
});
