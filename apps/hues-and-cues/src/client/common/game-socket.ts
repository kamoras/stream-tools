import type {
  HelloMessage,
  HostCommand,
  HostGameState,
  PublicGameState,
  ServerMessage,
} from '../../shared/protocol.js';
import { WS_PATH } from '../../shared/endpoints.js';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'failed';

export interface GameSocketHandlers<State> {
  onState(state: State, serverTime: number): void;
  onStatus?(status: ConnectionStatus, detail?: string, closeCode?: number): void;
  onChatStatus?(connected: boolean): void;
  onError?(message: string): void;
}

/** Close codes after which retrying is pointless. Mirrors the server's CloseCode. */
export const UNAUTHORIZED_CLOSE_CODE = 4401;

const FATAL_CLOSE_CODES = new Map<number, string>([
  [4400, 'The server rejected this client.'],
  [UNAUTHORIZED_CLOSE_CODE, 'Please sign in again.'],
  [4403, 'That game belongs to a different account.'],
  [4404, 'This game no longer exists.'],
]);

/**
 * Reconnecting WebSocket client for one room.
 *
 * Browser sources in OBS stay open for hours, so the socket reconnects
 * forever with capped, jittered back-off — except after an authorisation or
 * not-found close, which no amount of retrying will fix.
 */
export class GameSocket<State extends PublicGameState | HostGameState> {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: number | null = null;
  private closed = false;

  public constructor(
    private readonly hello: HelloMessage,
    private readonly handlers: GameSocketHandlers<State>,
  ) {}

  public connect(): void {
    this.closed = false;
    this.open();
  }

  public close(): void {
    this.closed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.socket?.close();
  }

  public send(command: HostCommand): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.handlers.onError?.('Not connected to the server — retrying…');
      return false;
    }
    this.socket.send(JSON.stringify(command));
    return true;
  }

  private open(): void {
    this.handlers.onStatus?.(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}${WS_PATH}`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(this.hello));
    });
    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.dispatch(message);
    });
    socket.addEventListener('close', (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      const fatal = FATAL_CLOSE_CODES.get(event.code);
      if (fatal !== undefined) {
        this.closed = true;
        this.handlers.onStatus?.('failed', fatal, event.code);
        return;
      }
      if (!this.closed) this.scheduleRetry();
    });
  }

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.attempt = 0;
        this.handlers.onStatus?.('open');
        break;
      case 'state':
        this.handlers.onState(message.state as State, message.serverTime);
        break;
      case 'chatStatus':
        this.handlers.onChatStatus?.(message.connected);
        break;
      case 'error':
        this.handlers.onError?.(message.message);
        break;
      default:
        break;
    }
  }

  private scheduleRetry(): void {
    this.attempt += 1;
    const base = Math.min(15_000, 500 * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.handlers.onStatus?.('reconnecting');
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }
}

/** Tracks the offset between this browser's clock and the server's. */
export class ServerClock {
  private offsetMs = 0;

  public sync(serverTime: number): void {
    this.offsetMs = serverTime - Date.now();
  }

  public now(): number {
    return Date.now() + this.offsetMs;
  }

  public secondsUntil(deadline: number): number {
    return (deadline - this.now()) / 1000;
  }
}
