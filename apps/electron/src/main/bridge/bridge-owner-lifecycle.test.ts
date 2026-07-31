import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { bindBridgeOwnerLifecycle } from './bridge-owner-lifecycle.ts';

class Source extends EventEmitter {
  readonly id: number;
  constructor(id = 0) { super(); this.id = id; }
}

class FakeWindow extends Source {
  readonly webContents = new Source(42);
}

describe('Bridge pairing native owner lifecycle', () => {
  test('fences hide, minimize, close, renderer destruction, and renderer crash by exact owner', () => {
    const window = new FakeWindow();
    const calls: string[] = [];
    const runtime = {
      ownerHidden: (owner: string) => calls.push(`hide:${owner}`),
      ownerMinimized: (owner: string) => calls.push(`minimize:${owner}`),
      ownerDestroyed: (owner: string) => calls.push(`destroy:${owner}`),
    };
    const cleanup = bindBridgeOwnerLifecycle(window, runtime);
    window.emit('hide');
    window.emit('minimize');
    window.emit('closed');
    window.webContents.emit('destroyed');
    window.webContents.emit('render-process-gone');
    expect(calls).toEqual([
      'hide:electron-web-contents:42',
      'minimize:electron-web-contents:42',
      'destroy:electron-web-contents:42',
      'destroy:electron-web-contents:42',
      'destroy:electron-web-contents:42',
    ]);
    cleanup();
    cleanup();
    const afterCleanup = calls.length;
    window.emit('hide');
    window.webContents.emit('destroyed');
    expect(calls).toHaveLength(afterCleanup);
  });
});
