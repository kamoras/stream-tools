import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import { nickFromPrefix, parseIrcLine } from './irc-parser.js';

export const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

export interface ChatMessage {
  /** Channel login without the leading `#`. */
  readonly channel: string;
  readonly userId: string;
  readonly login: string;
  readonly displayName: string;
  /** Hex colour the user picked in Twitch, if any. */
  readonly color: string | null;
  readonly text: string;
}

export interface ChatClientEvents {
  message: [ChatMessage];
  connected: [];
  disconnected: [];
}

/** The subset of a WebSocket the client relies on; lets tests substitute a fake. */
export interface ChatSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'close', listener: () => void): this;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface TwitchChatClientOptions {
  readonly logger: Logger;
  readonly url?: string;
  readonly createSocket?: (url: string) => ChatSocket;
  /** Delay between JOIN commands; Twitch limits anonymous joins to 20 per 10 seconds. */
  readonly joinIntervalMs?: number;
  readonly maxBackoffMs?: number;
  /** Silence after which a PING is sent; if nothing arrives within a further interval, reconnect. */
  readonly keepaliveMs?: number;
}

const OPEN = 1;

/**
 * A read-only, anonymous Twitch chat connection.
 *
 * Anonymous (`justinfan`) logins can read any public channel's chat with no
 * OAuth application, which is all a guessing game needs. The client keeps a
 * reference-counted set of channels, rejoins them after reconnecting, and
 * reconnects with jittered exponential back-off.
 */
export class TwitchChatClient extends EventEmitter<ChatClientEvents> {
  private readonly logger: Logger;
  private readonly url: string;
  private readonly createSocket: (url: string) => ChatSocket;
  private readonly joinIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly keepaliveMs: number;

  private socket: ChatSocket | null = null;
  private readonly channelRefs = new Map<string, number>();
  private readonly joinQueue: string[] = [];
  private joinTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  private attempt = 0;
  private stopped = true;
  private ready = false;

  public constructor(options: TwitchChatClientOptions) {
    super();
    this.logger = options.logger.child({ component: 'twitch-chat' });
    this.url = options.url ?? TWITCH_IRC_URL;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.joinIntervalMs = options.joinIntervalMs ?? 600;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.keepaliveMs = options.keepaliveMs ?? 5 * 60_000;
  }

  public get connected(): boolean {
    return this.ready;
  }

  public get channels(): readonly string[] {
    return [...this.channelRefs.keys()];
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.setReady(false);
  }

  /** Adds a reference to `channel`, joining it if this is the first. */
  public acquire(channel: string): void {
    const name = normaliseChannel(channel);
    const refs = this.channelRefs.get(name) ?? 0;
    this.channelRefs.set(name, refs + 1);
    if (refs === 0 && this.ready) {
      this.enqueueJoin(name);
    }
  }

  /** Drops a reference to `channel`, leaving it when none remain. */
  public release(channel: string): void {
    const name = normaliseChannel(channel);
    const refs = this.channelRefs.get(name) ?? 0;
    if (refs <= 1) {
      this.channelRefs.delete(name);
      const queued = this.joinQueue.indexOf(name);
      if (queued !== -1) {
        this.joinQueue.splice(queued, 1);
      } else if (this.ready) {
        this.send(`PART #${name}`);
      }
    } else {
      this.channelRefs.set(name, refs - 1);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = this.createSocket(this.url);
    this.socket = socket;

    socket.on('open', () => {
      if (socket !== this.socket) return;
      const nick = `justinfan${String(10_000 + Math.floor(Math.random() * 89_999))}`;
      socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      socket.send('PASS SCHMOOPIIE');
      socket.send(`NICK ${nick}`);
      this.logger.debug({ nick }, 'Connecting to Twitch chat');
    });
    socket.on('message', (data) => {
      if (socket !== this.socket) return;
      this.resetKeepalive();
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
      for (const line of text.split('\r\n')) {
        if (line !== '') this.handleLine(line);
      }
    });
    socket.on('error', (error) => {
      this.logger.warn({ err: error }, 'Twitch chat socket error');
    });
    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.setReady(false);
      this.scheduleReconnect();
    });
  }

  private handleLine(line: string): void {
    const message = parseIrcLine(line);
    if (!message) return;

    switch (message.command) {
      case 'PING':
        this.send(`PONG :${message.params[0] ?? 'tmi.twitch.tv'}`);
        break;
      case 'PONG':
        this.awaitingPong = false;
        break;
      case '001':
        this.attempt = 0;
        this.setReady(true);
        this.joinQueue.length = 0;
        for (const channel of this.channelRefs.keys()) this.enqueueJoin(channel);
        break;
      case 'RECONNECT':
        this.logger.info('Twitch requested a reconnect');
        this.socket?.close();
        break;
      case 'NOTICE':
        this.logger.warn({ notice: message.params.at(-1) }, 'Twitch chat notice');
        break;
      case 'PRIVMSG': {
        const [target, text] = message.params;
        const login = nickFromPrefix(message.prefix);
        if (target?.startsWith('#') !== true || text === undefined || login === null) return;
        const color = message.tags.get('color');
        const displayName = message.tags.get('display-name');
        this.emit('message', {
          channel: target.slice(1),
          userId: message.tags.get('user-id') ?? `login:${login}`,
          login,
          displayName: displayName !== undefined && displayName !== '' ? displayName : login,
          color: color !== undefined && /^#[0-9a-f]{6}$/iu.test(color) ? color : null,
          text,
        });
        break;
      }
      default:
        break;
    }
  }

  private enqueueJoin(channel: string): void {
    if (!this.joinQueue.includes(channel)) this.joinQueue.push(channel);
    this.drainJoinQueue();
  }

  private drainJoinQueue(): void {
    if (this.joinTimer !== null) return;
    const next = this.joinQueue.shift();
    if (next === undefined || !this.ready) return;
    this.send(`JOIN #${next}`);
    this.logger.info({ channel: next }, 'Joined Twitch channel');
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null;
      this.drainJoinQueue();
    }, this.joinIntervalMs);
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    if (this.stopped) return;
    const base = Math.min(this.maxBackoffMs, 1000 * 2 ** this.attempt);
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.attempt += 1;
    this.logger.warn({ delayMs: delay, attempt: this.attempt }, 'Twitch chat disconnected');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private resetKeepalive(): void {
    this.awaitingPong = false;
    if (this.keepaliveTimer !== null) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      this.onKeepalive();
    }, this.keepaliveMs);
  }

  private onKeepalive(): void {
    if (this.awaitingPong) {
      this.logger.warn('Twitch chat keepalive timed out');
      this.socket?.close();
      return;
    }
    this.awaitingPong = true;
    this.send('PING :keepalive');
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      this.onKeepalive();
    }, this.keepaliveMs);
  }

  private send(line: string): void {
    if (this.socket?.readyState === OPEN) this.socket.send(line);
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.emit(ready ? 'connected' : 'disconnected');
  }

  private clearTimers(): void {
    for (const timer of [this.joinTimer, this.reconnectTimer, this.keepaliveTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.joinTimer = null;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
  }
}

function normaliseChannel(channel: string): string {
  return channel.replace(/^#/u, '').toLowerCase();
}
