import type { ElectronBridgeRuntime } from './bridge-runtime.ts';

interface EventSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

export interface BridgeOwnerWindowLike extends EventSource {
  readonly webContents: EventSource & { readonly id: number };
}

/**
 * Bind the native owner lifecycle, not renderer polling, to the pairing lease.
 * Duplicate native events are harmless because runtime owner closure is
 * idempotent and fenced by the exact webContents owner id.
 */
export function bindBridgeOwnerLifecycle(
  window: BridgeOwnerWindowLike,
  runtime: Pick<ElectronBridgeRuntime, 'ownerHidden' | 'ownerMinimized' | 'ownerDestroyed'>,
): () => void {
  const ownerId = `electron-web-contents:${window.webContents.id}`;
  const hidden = () => runtime.ownerHidden(ownerId);
  const minimized = () => runtime.ownerMinimized(ownerId);
  const destroyed = () => runtime.ownerDestroyed(ownerId);

  window.on('hide', hidden);
  window.on('minimize', minimized);
  window.on('closed', destroyed);
  window.webContents.on('destroyed', destroyed);
  window.webContents.on('render-process-gone', destroyed);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    window.removeListener('hide', hidden);
    window.removeListener('minimize', minimized);
    window.removeListener('closed', destroyed);
    window.webContents.removeListener('destroyed', destroyed);
    window.webContents.removeListener('render-process-gone', destroyed);
    destroyed();
  };
}
