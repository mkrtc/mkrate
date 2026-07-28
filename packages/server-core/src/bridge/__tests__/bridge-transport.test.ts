import { describe, expect, test } from 'bun:test';
import {
  BRIDGE_PROTOCOL_VERSION,
  CLOSE_CODES,
  COMMAND_CAPABILITIES,
  encodeBase64Url,
  serializeBridgeMessage,
  type DesktopServerMessage,
} from '@mkrate/bridge-protocol';
import { BridgeTransport, type BridgeWebSocketLike } from '../bridge-transport.ts';
import { createBridgeLogger, sanitizeBridgeLogMetadata, type BridgeLogRecord } from '../bridge-logging.ts';

function id(byte: number): string {
  return encodeBase64Url(new Uint8Array(16).fill(byte));
}

class FakeSocket implements BridgeWebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  pingCount = 0;
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: 'open' | 'message' | 'close' | 'error' | 'pong', listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    callback();
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 2;
  }

  terminate(): void {
    this.readyState = 3;
  }

  ping(): void {
    this.pingCount += 1;
  }
}

function accepted(requestId = id(1)): DesktopServerMessage {
  return {
    type: 'deployment.accepted',
    endpoint: 'desktop',
    deploymentId: id(2),
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    capabilities: [...COMMAND_CAPABILITIES],
    serverTimeMs: 1,
    requestId,
    version: BRIDGE_PROTOCOL_VERSION,
  };
}

describe('BridgeTransport security boundary', () => {
  test('uses Desktop endpoint, mandatory TLS validation, and idempotent start/stop', () => {
    const socket = new FakeSocket();
    const calls: Array<{ url: string; rejectUnauthorized: boolean; maxPayload: number }> = [];
    const transport = new BridgeTransport({
      baseUrl: 'wss://bridge.example.test',
      webSocketFactory: (url, options) => {
        calls.push({ url, ...options });
        return socket;
      },
      onMessage: () => {},
    });

    transport.start();
    transport.start();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('wss://bridge.example.test/v1/desktop');
    expect(calls[0]?.rejectUnauthorized).toBe(true);
    transport.stop();
    transport.stop();
    expect(transport.state).toBe('stopped');
  });

  test('permits ws only for exact loopback under explicit dev/test option', () => {
    expect(() => new BridgeTransport({ baseUrl: 'ws://localhost', onMessage: () => {} })).toThrow();
    expect(() => new BridgeTransport({
      baseUrl: 'ws://bridge.example.test',
      allowInsecureLoopback: true,
      onMessage: () => {},
    })).toThrow();
    expect(() => new BridgeTransport({
      baseUrl: 'ws://127.0.0.1:8787',
      allowInsecureLoopback: true,
      onMessage: () => {},
    })).not.toThrow();
  });

  test('accepts valid text but rejects binary, malformed, wrong-version, and wrong-direction frames', () => {
    const sockets: FakeSocket[] = [];
    const received: DesktopServerMessage[] = [];
    const faults: string[] = [];
    const make = (): { socket: FakeSocket; transport: BridgeTransport } => {
      const socket = new FakeSocket();
      sockets.push(socket);
      const transport = new BridgeTransport({
        baseUrl: 'wss://bridge.example.test',
        webSocketFactory: () => socket,
        onMessage: (message) => received.push(message),
        onFault: (fault) => faults.push(fault),
      });
      transport.start();
      socket.open();
      return { socket, transport };
    };

    const valid = make();
    valid.socket.emit('message', serializeBridgeMessage(accepted()), false);
    expect(received).toHaveLength(1);
    valid.transport.stop();

    const binary = make();
    binary.socket.emit('message', Buffer.from(serializeBridgeMessage(accepted())), true);
    expect(binary.socket.closed.at(-1)?.code).toBe(CLOSE_CODES.protocolError);
    binary.transport.stop();

    const malformed = make();
    malformed.socket.emit('message', '{"version":1,"type":"deployment.accepted",', false);
    expect(malformed.socket.closed.at(-1)?.code).toBe(CLOSE_CODES.protocolError);
    malformed.transport.stop();

    const version = make();
    version.socket.emit('message', '{"type":"deployment.accepted","version":2}', false);
    expect(version.socket.closed.at(-1)?.code).toBe(CLOSE_CODES.protocolError);
    version.transport.stop();

    const direction = make();
    direction.socket.emit('message', JSON.stringify({
      type: 'deployment.negotiate', endpoint: 'desktop', supportedVersions: [1],
      clientVersion: '1.0.0', requestId: id(4), version: 1,
    }), false);
    expect(direction.socket.closed.at(-1)?.code).toBe(CLOSE_CODES.protocolError);
    direction.transport.stop();
    expect(faults.filter((fault) => fault === 'protocol')).toHaveLength(4);
  });

  test('never logs peer-controlled close reasons, frames, or token-shaped values', () => {
    const records: BridgeLogRecord[] = [];
    const socket = new FakeSocket();
    const token = encodeBase64Url(new Uint8Array(32).fill(9));
    const transport = new BridgeTransport({
      baseUrl: 'wss://bridge.example.test',
      webSocketFactory: () => socket,
      logger: createBridgeLogger((record) => records.push(record)),
      backoffMinMs: 60_000,
      backoffMaxMs: 60_000,
      onMessage: () => {},
    });
    transport.start();
    socket.open();
    socket.emit('close', 4999, `hostile ${token} frame={...}`);
    transport.stop();
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('hostile');
    expect(serialized).not.toContain('frame={');

    expect(sanitizeBridgeLogMetadata({
      token,
      state: token,
      frame: '{secret}',
      operation: 'auth',
    })).toEqual({ state: '[REDACTED]', operation: 'auth' });
  });
});
