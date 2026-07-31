import {
  BRIDGE_ENDPOINTS,
  CLOSE_CODES,
  SECURITY_LIMITS,
  parseDesktopClientMessage,
  parseDesktopServerMessage,
  serializeBridgeMessage,
  type DesktopClientMessage,
  type DesktopServerMessage,
} from '@mkrate/bridge-protocol';
import { validateBridgeUrl } from '@craft-agent/shared/config';
import WebSocket from 'ws';
import { NULL_BRIDGE_LOGGER, type BridgeLogger } from './bridge-logging.ts';

const READY_STATE_OPEN = 1;
const READY_STATE_CLOSING = 2;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_MIN_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

export type BridgeTransportState = 'stopped' | 'connecting' | 'open' | 'backoff';
export type BridgeTransportFault = 'protocol' | 'payload-too-large' | 'heartbeat-timeout' | 'connect-timeout';

export interface BridgeWebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: 'close', listener: (code: number, reason: unknown) => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'pong', listener: () => void): this;
  send(data: string, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  ping?(): void;
}

export interface BridgeWebSocketOptions {
  /** Always true. Tests may assert this, but production callers cannot override it. */
  rejectUnauthorized: true;
  /** Compression is forbidden for authenticated Bridge frames. */
  perMessageDeflate: false;
  maxPayload: number;
}

export type BridgeWebSocketFactory = (url: string, options: BridgeWebSocketOptions) => BridgeWebSocketLike;

export interface BridgeTimerApi {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const DEFAULT_TIMERS: BridgeTimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
};

function defaultWebSocketFactory(url: string, options: BridgeWebSocketOptions): BridgeWebSocketLike {
  return new WebSocket(url, {
    rejectUnauthorized: options.rejectUnauthorized,
    perMessageDeflate: options.perMessageDeflate,
    maxPayload: options.maxPayload,
  }) as unknown as BridgeWebSocketLike;
}

export interface BridgeTransportOptions {
  baseUrl: string;
  allowInsecureLoopback?: boolean;
  webSocketFactory?: BridgeWebSocketFactory;
  timers?: BridgeTimerApi;
  randomUnit?: () => number;
  logger?: BridgeLogger;
  connectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  onMessage: (message: DesktopServerMessage) => void;
  onOpen?: () => void;
  onClose?: (event: { code: number; retrying: boolean }) => void;
  onFault?: (fault: BridgeTransportFault) => void;
  onStateChange?: (state: BridgeTransportState) => void;
}

function desktopEndpointUrl(baseUrl: string, allowInsecureLoopback: boolean): string {
  const validated = validateBridgeUrl(baseUrl, { allowInsecureLoopback });
  if (!validated.ok) throw new Error(`Invalid Bridge URL (${validated.reason})`);
  return `${validated.url}${BRIDGE_ENDPOINTS.desktop}`;
}

function asStrictText(data: unknown, isBinary: boolean): string {
  if (isBinary) throw new TypeError('binary-frame');
  if (typeof data === 'string') return data;

  let bytes: Uint8Array;
  if (data instanceof Uint8Array) {
    bytes = data;
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw new TypeError('non-text-frame');
  }

  if (bytes.byteLength > SECURITY_LIMITS.websocketMaxPayloadBytes) throw new RangeError('payload-too-large');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Strict Desktop-only WebSocket transport. It validates both directions through
 * the pinned protocol package and deliberately exposes no generic RPC surface.
 */
export class BridgeTransport {
  readonly #url: string;
  readonly #factory: BridgeWebSocketFactory;
  readonly #timers: BridgeTimerApi;
  readonly #randomUnit: () => number;
  readonly #logger: BridgeLogger;
  readonly #options: Required<Pick<BridgeTransportOptions,
    'connectTimeoutMs' | 'heartbeatIntervalMs' | 'heartbeatTimeoutMs' | 'backoffMinMs' | 'backoffMaxMs'>>;
  readonly #onMessage: BridgeTransportOptions['onMessage'];
  readonly #onOpen?: BridgeTransportOptions['onOpen'];
  readonly #onClose?: BridgeTransportOptions['onClose'];
  readonly #onFault?: BridgeTransportOptions['onFault'];
  readonly #onStateChange?: BridgeTransportOptions['onStateChange'];

  #state: BridgeTransportState = 'stopped';
  #socket: BridgeWebSocketLike | null = null;
  #generation = 0;
  #attempt = 0;
  #connectTimeout: ReturnType<typeof setTimeout> | null = null;
  #heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  #heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #awaitingPong = false;
  #stopping = true;

  constructor(options: BridgeTransportOptions) {
    this.#url = desktopEndpointUrl(options.baseUrl, options.allowInsecureLoopback === true);
    this.#factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#timers = options.timers ?? DEFAULT_TIMERS;
    this.#randomUnit = options.randomUnit ?? Math.random;
    this.#logger = options.logger ?? NULL_BRIDGE_LOGGER;
    this.#options = {
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      backoffMinMs: options.backoffMinMs ?? DEFAULT_BACKOFF_MIN_MS,
      backoffMaxMs: options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    };
    if (this.#options.backoffMinMs <= 0 || this.#options.backoffMaxMs < this.#options.backoffMinMs) {
      throw new Error('Invalid Bridge backoff bounds');
    }
    this.#onMessage = options.onMessage;
    this.#onOpen = options.onOpen;
    this.#onClose = options.onClose;
    this.#onFault = options.onFault;
    this.#onStateChange = options.onStateChange;
  }

  get state(): BridgeTransportState {
    return this.#state;
  }

  get connected(): boolean {
    return this.#state === 'open' && this.#socket?.readyState === READY_STATE_OPEN;
  }

  start(): void {
    if (!this.#stopping) return;
    this.#stopping = false;
    this.#attempt = 0;
    this.#connect();
  }

  stop(): void {
    if (this.#stopping && this.#state === 'stopped') return;
    this.#stopping = true;
    this.#generation += 1;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket && socket.readyState < READY_STATE_CLOSING) socket.close(CLOSE_CODES.normal, 'stopped');
    this.#setState('stopped');
  }

  /** Close the current connection and re-enter bounded backoff. */
  retry(): void {
    if (this.#stopping) return;
    const socket = this.#socket;
    if (socket && socket.readyState < READY_STATE_CLOSING) socket.close(CLOSE_CODES.normal, 'retry');
    this.#scheduleReconnect();
  }

  async send(message: DesktopClientMessage): Promise<void> {
    const socket = this.#socket;
    if (!socket || this.#state !== 'open' || socket.readyState !== READY_STATE_OPEN) {
      throw new Error('Bridge transport is not connected');
    }

    // Validate caller direction and strict schema before serializing.
    const serialized = serializeBridgeMessage(message);
    parseDesktopClientMessage(serialized);
    if (new TextEncoder().encode(serialized).byteLength > SECURITY_LIMITS.websocketMaxPayloadBytes) {
      throw new Error('Bridge message exceeds transport limit');
    }
    if (socket.bufferedAmount > SECURITY_LIMITS.websocketBackpressureLimitBytes) {
      throw new Error('Bridge transport backpressure limit exceeded');
    }

    await new Promise<void>((resolve, reject) => {
      try {
        socket.send(serialized, (error) => {
          if (error) {
            this.#logger.log('warn', 'transport.send-failed', { reason: 'network' });
            reject(new Error('Bridge send failed'));
          } else {
            resolve();
          }
        });
      } catch {
        this.#logger.log('warn', 'transport.send-failed', { reason: 'network' });
        reject(new Error('Bridge send failed'));
      }
    });
  }

  #connect(): void {
    if (this.#stopping || this.#state === 'connecting' || this.#state === 'open') return;
    this.#clearReconnectTimeout();
    const generation = ++this.#generation;
    this.#setState('connecting');
    this.#logger.log('info', 'transport.connecting', { attempt: this.#attempt + 1 });

    let socket: BridgeWebSocketLike;
    try {
      socket = this.#factory(this.#url, {
        rejectUnauthorized: true,
        perMessageDeflate: false,
        maxPayload: SECURITY_LIMITS.websocketMaxPayloadBytes,
      });
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    this.#connectTimeout = this.#timers.setTimeout(() => {
      if (!this.#isCurrent(generation, socket) || this.#state !== 'connecting') return;
      this.#onFault?.('connect-timeout');
      socket.terminate?.();
      this.#scheduleReconnect();
    }, this.#options.connectTimeoutMs);

    socket.on('open', () => this.#handleOpen(generation, socket));
    socket.on('message', (data, isBinary) => this.#handleMessage(generation, socket, data, isBinary));
    socket.on('pong', () => this.#handlePong(generation, socket));
    socket.on('error', () => {
      // Error strings can include URLs, proxy credentials, or peer-controlled text.
      // The close path owns state/retry; intentionally log no Error payload.
    });
    socket.on('close', (code) => this.#handleClose(generation, socket, code));
  }

  #handleOpen(generation: number, socket: BridgeWebSocketLike): void {
    if (!this.#isCurrent(generation, socket) || this.#stopping) return;
    this.#clearConnectTimeout();
    this.#attempt = 0;
    this.#setState('open');
    this.#logger.log('info', 'transport.connected');
    this.#startHeartbeat(generation, socket);
    this.#onOpen?.();
  }

  #handleMessage(generation: number, socket: BridgeWebSocketLike, data: unknown, isBinary: boolean): void {
    if (!this.#isCurrent(generation, socket) || this.#state !== 'open') return;
    try {
      const text = asStrictText(data, isBinary);
      const byteLength = new TextEncoder().encode(text).byteLength;
      if (byteLength > SECURITY_LIMITS.websocketMaxPayloadBytes) throw new RangeError('payload-too-large');
      this.#onMessage(parseDesktopServerMessage(text));
    } catch (error) {
      const payloadTooLarge = error instanceof RangeError;
      this.#logger.log('warn', 'transport.protocol-rejected', {
        reason: 'protocol',
        code: payloadTooLarge ? 'PAYLOAD_TOO_LARGE' : 'MALFORMED_MESSAGE',
      });
      this.#onFault?.(payloadTooLarge ? 'payload-too-large' : 'protocol');
      socket.close(payloadTooLarge ? CLOSE_CODES.payloadTooLarge : CLOSE_CODES.protocolError);
    }
  }

  #handleClose(generation: number, socket: BridgeWebSocketLike, code: number): void {
    if (!this.#isCurrent(generation, socket)) return;
    this.#socket = null;
    this.#clearConnectionTimers();
    const retrying = !this.#stopping;
    this.#logger.log('info', 'transport.disconnected', {
      code: Number.isInteger(code) ? code : 0,
      reason: this.#stopping ? 'stopped' : 'network',
      retryable: retrying,
    });
    this.#onClose?.({ code: Number.isInteger(code) ? code : 0, retrying });
    if (retrying) this.#scheduleReconnect();
    else this.#setState('stopped');
  }

  #startHeartbeat(generation: number, socket: BridgeWebSocketLike): void {
    if (!socket.ping) return;
    this.#heartbeatInterval = this.#timers.setInterval(() => {
      if (!this.#isCurrent(generation, socket) || this.#state !== 'open') return;
      if (this.#awaitingPong) return;
      this.#awaitingPong = true;
      try {
        socket.ping?.();
      } catch {
        socket.terminate?.();
        return;
      }
      this.#heartbeatTimeout = this.#timers.setTimeout(() => {
        if (!this.#isCurrent(generation, socket) || !this.#awaitingPong) return;
        this.#logger.log('warn', 'transport.heartbeat-timeout', { reason: 'timeout' });
        this.#onFault?.('heartbeat-timeout');
        socket.terminate?.();
      }, this.#options.heartbeatTimeoutMs);
    }, this.#options.heartbeatIntervalMs);
  }

  #handlePong(generation: number, socket: BridgeWebSocketLike): void {
    if (!this.#isCurrent(generation, socket)) return;
    this.#awaitingPong = false;
    if (this.#heartbeatTimeout) {
      this.#timers.clearTimeout(this.#heartbeatTimeout);
      this.#heartbeatTimeout = null;
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopping || this.#reconnectTimeout) return;
    this.#generation += 1;
    this.#socket = null;
    this.#clearConnectionTimers();
    this.#setState('backoff');
    const exponent = Math.min(this.#attempt, 16);
    const unjittered = Math.min(this.#options.backoffMaxMs, this.#options.backoffMinMs * (2 ** exponent));
    const unit = Math.max(0, Math.min(1, this.#randomUnit()));
    const delayMs = Math.max(this.#options.backoffMinMs, Math.min(
      this.#options.backoffMaxMs,
      Math.round(unjittered * (0.75 + (unit * 0.5))),
    ));
    this.#attempt += 1;
    this.#logger.log('info', 'transport.reconnect-scheduled', { attempt: this.#attempt, delayMs });
    this.#reconnectTimeout = this.#timers.setTimeout(() => {
      this.#reconnectTimeout = null;
      this.#connect();
    }, delayMs);
  }

  #isCurrent(generation: number, socket: BridgeWebSocketLike): boolean {
    return generation === this.#generation && socket === this.#socket;
  }

  #setState(state: BridgeTransportState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onStateChange?.(state);
  }

  #clearConnectTimeout(): void {
    if (!this.#connectTimeout) return;
    this.#timers.clearTimeout(this.#connectTimeout);
    this.#connectTimeout = null;
  }

  #clearReconnectTimeout(): void {
    if (!this.#reconnectTimeout) return;
    this.#timers.clearTimeout(this.#reconnectTimeout);
    this.#reconnectTimeout = null;
  }

  #clearConnectionTimers(): void {
    this.#clearConnectTimeout();
    if (this.#heartbeatInterval) {
      this.#timers.clearInterval(this.#heartbeatInterval);
      this.#heartbeatInterval = null;
    }
    if (this.#heartbeatTimeout) {
      this.#timers.clearTimeout(this.#heartbeatTimeout);
      this.#heartbeatTimeout = null;
    }
    this.#awaitingPong = false;
  }

  #clearTimers(): void {
    this.#clearConnectionTimers();
    this.#clearReconnectTimeout();
  }
}
