import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatMessage,
  type ChatSocket,
  TwitchChatClient,
} from '../../src/server/twitch/chat-client.js';
import { silentLogger } from '../helpers.js';

class FakeSocket extends EventEmitter implements ChatSocket {
  public readyState = 0;
  public readonly sent: string[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  public open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  public receive(...lines: string[]): void {
    this.emit('message', Buffer.from(lines.map((line) => `${line}\r\n`).join('')));
  }
}

describe('TwitchChatClient', () => {
  let sockets: FakeSocket[];
  let client: TwitchChatClient;

  const latest = (): FakeSocket => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error('no socket');
    return socket;
  };
  const welcome = (): void => {
    latest().open();
    latest().receive(':tmi.twitch.tv 001 justinfan12345 :Welcome, GLHF!');
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    client = new TwitchChatClient({
      logger: silentLogger,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      joinIntervalMs: 100,
      keepaliveMs: 1000,
    });
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  it('logs in anonymously and joins acquired channels', () => {
    client.acquire('#StreamerOne');
    client.start();
    welcome();
    expect(latest().sent.slice(0, 3)).toEqual([
      'CAP REQ :twitch.tv/tags twitch.tv/commands',
      'PASS SCHMOOPIIE',
      expect.stringMatching(/^NICK justinfan\d+$/u),
    ]);
    expect(latest().sent).toContain('JOIN #streamerone');
    expect(client.connected).toBe(true);
  });

  it('paces joins and reference-counts channels', () => {
    client.start();
    welcome();
    client.acquire('a_channel');
    client.acquire('b_channel');
    client.acquire('a_channel');
    expect(latest().sent.filter((l) => l.startsWith('JOIN'))).toEqual(['JOIN #a_channel']);
    vi.advanceTimersByTime(100);
    expect(latest().sent.filter((l) => l.startsWith('JOIN'))).toEqual([
      'JOIN #a_channel',
      'JOIN #b_channel',
    ]);
    client.release('a_channel');
    expect(latest().sent).not.toContain('PART #a_channel');
    client.release('a_channel');
    expect(latest().sent).toContain('PART #a_channel');
    expect(client.channels).toEqual(['b_channel']);
  });

  it('emits chat messages with user details', () => {
    const messages: ChatMessage[] = [];
    client.on('message', (message) => messages.push(message));
    client.start();
    welcome();
    latest().receive(
      '@color=#FF4500;display-name=Viewer;user-id=99 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #streamer :F12',
      '@color=;display-name= :anon!anon@anon.tmi.twitch.tv PRIVMSG #streamer :hello',
    );
    expect(messages).toEqual([
      {
        channel: 'streamer',
        userId: '99',
        login: 'viewer',
        displayName: 'Viewer',
        color: '#FF4500',
        text: 'F12',
      },
      {
        channel: 'streamer',
        userId: 'login:anon',
        login: 'anon',
        displayName: 'anon',
        color: null,
        text: 'hello',
      },
    ]);
  });

  it('answers PING and keeps the connection alive', () => {
    client.start();
    welcome();
    latest().receive('PING :tmi.twitch.tv');
    expect(latest().sent).toContain('PONG :tmi.twitch.tv');

    vi.advanceTimersByTime(1000);
    expect(latest().sent).toContain('PING :keepalive');
    latest().receive(':tmi.twitch.tv PONG tmi.twitch.tv :keepalive');
    expect(sockets).toHaveLength(1);
  });

  it('reconnects after a keepalive timeout and rejoins channels', () => {
    const states: string[] = [];
    client.on('connected', () => states.push('up'));
    client.on('disconnected', () => states.push('down'));
    client.acquire('streamer');
    client.start();
    welcome();
    vi.advanceTimersByTime(2000);
    expect(states).toEqual(['up', 'down']);

    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    welcome();
    expect(latest().sent).toContain('JOIN #streamer');
    expect(states).toEqual(['up', 'down', 'up']);
  });

  it('reconnects when Twitch asks it to', () => {
    client.start();
    welcome();
    latest().receive(':tmi.twitch.tv RECONNECT');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it('does not reconnect after stop()', () => {
    client.start();
    welcome();
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});
