import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostGameState, PublicGameState, ServerMessage } from '../../src/shared/protocol.js';
import { Room, type RoomClient } from '../../src/server/rooms/room.js';
import type { ChatMessage } from '../../src/server/twitch/chat-client.js';
import { seededRandom, silentLogger } from '../helpers.js';

class RecordingClient implements RoomClient {
  public readonly messages: ServerMessage[] = [];
  public closed: { code: number; reason: string } | null = null;
  public constructor(public readonly role: 'host' | 'overlay') {}
  public close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  public send(message: ServerMessage): void {
    this.messages.push(message);
  }
  public get states(): (PublicGameState | HostGameState)[] {
    return this.messages.flatMap((m) => (m.type === 'state' ? [m.state] : []));
  }
  public get last(): PublicGameState | HostGameState | undefined {
    return this.states.at(-1);
  }
}

function chat(text: string, userId = 'u1'): ChatMessage {
  return { channel: 'streamer', userId, login: userId, displayName: userId, color: null, text };
}

describe('Room', () => {
  let room: Room;
  let host: RecordingClient;
  let overlay: RecordingClient;
  let changes: number;

  beforeEach(() => {
    vi.useFakeTimers();
    changes = 0;
    room = new Room({
      id: 'room-1',
      channel: 'streamer',
      ownerId: 1,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      logger: silentLogger,
      random: seededRandom(1),
      broadcastIntervalMs: 200,
      onChange: () => {
        changes += 1;
      },
    });
    host = new RecordingClient('host');
    overlay = new RecordingClient('overlay');
    room.attach(host);
    room.attach(overlay);
    changes = 0;
  });

  afterEach(() => {
    room.dispose();
    vi.useRealTimers();
  });

  const startGuessing = (): void => {
    room.execute({ type: 'drawCard' });
    room.execute({ type: 'selectTarget', index: 0 });
    room.execute({ type: 'giveClue', clue: 'ocean' });
  };

  it('sends role-appropriate state on attach', () => {
    expect(host.last).toHaveProperty('card');
    expect(overlay.last).not.toHaveProperty('card');
  });

  it('broadcasts host commands immediately and persists them', () => {
    room.execute({ type: 'drawCard' });
    expect(host.last?.phase).toBe('picking');
    expect(overlay.last?.phase).toBe('picking');
    expect(changes).toBe(1);
  });

  it('turns chat into guesses and coalesces broadcasts', () => {
    startGuessing();
    const before = overlay.states.length;
    room.handleChat(chat('F12', 'a'));
    room.handleChat(chat('!guess B3', 'b'));
    room.handleChat(chat('just chatting', 'c'));
    expect(overlay.states.length).toBe(before);
    vi.advanceTimersByTime(200);
    expect(overlay.states.length).toBe(before + 1);
    expect(overlay.last?.totalGuesses).toBe(2);
  });

  it("ignores the broadcaster's own guesses", () => {
    startGuessing();
    room.handleChat({ ...chat('F12', 'owner'), login: 'Streamer' });
    vi.advanceTimersByTime(200);
    expect(overlay.last?.totalGuesses).toBe(0);
  });

  it("counts the broadcaster's guesses when allowed, for testing", () => {
    room.execute({ type: 'updateSettings', settings: { allowBroadcasterGuesses: true } });
    startGuessing();
    room.handleChat({ ...chat('F12', 'owner'), login: 'Streamer' });
    vi.advanceTimersByTime(200);
    expect(overlay.last?.totalGuesses).toBe(1);
  });

  it('resends the current state to an attached client only', () => {
    const before = overlay.states.length;
    room.resendState(overlay);
    expect(overlay.states.length).toBe(before + 1);
    const stranger = new RecordingClient('overlay');
    room.resendState(stranger);
    expect(stranger.messages).toEqual([]);
  });

  it('closes every client on closeAll', () => {
    room.closeAll(4404, 'Game deleted');
    expect(host.closed).toEqual({ code: 4404, reason: 'Game deleted' });
    expect(overlay.closed).toEqual({ code: 4404, reason: 'Game deleted' });
  });

  it('ignores chat when not guessing', () => {
    room.handleChat(chat('F12'));
    vi.advanceTimersByTime(1000);
    expect(changes).toBe(0);
  });

  it('honours requireGuessCommand', () => {
    room.execute({ type: 'updateSettings', settings: { requireGuessCommand: true } });
    startGuessing();
    room.handleChat(chat('F12', 'a'));
    room.handleChat(chat('!g F12', 'b'));
    vi.advanceTimersByTime(500);
    expect(overlay.last?.totalGuesses).toBe(1);
  });

  it('closes guessing automatically at the deadline', () => {
    room.execute({ type: 'updateSettings', settings: { guessDurationSeconds: 10 } });
    startGuessing();
    vi.advanceTimersByTime(10_000);
    expect(overlay.last?.phase).toBe('intermission');
  });

  it('records simulated guesses from the host', () => {
    startGuessing();
    room.execute({ type: 'simulateGuess', displayName: 'Tester', coord: { row: 1, col: 1 } });
    vi.advanceTimersByTime(300);
    expect(overlay.last?.guesses.at(-1)).toMatchObject({
      displayName: 'Tester',
      userId: 'sim:tester',
    });
  });

  it('stops sending to detached clients', () => {
    room.detach(overlay);
    const count = overlay.messages.length;
    room.execute({ type: 'drawCard' });
    expect(overlay.messages.length).toBe(count);
    expect(room.clientCount).toBe(1);
  });

  it('expires an overdue deadline restored from a snapshot', () => {
    room.execute({ type: 'updateSettings', settings: { guessDurationSeconds: 5 } });
    startGuessing();
    const snapshot = room.snapshot();
    vi.advanceTimersByTime(60_000);
    const restored = new Room({
      id: 'room-2',
      channel: 'streamer',
      ownerId: 1,
      createdAt: 0,
      lastActiveAt: 0,
      snapshot,
      logger: silentLogger,
      onChange: () => undefined,
    });
    expect(restored.snapshot().phase).toBe('intermission');
    restored.dispose();
  });
});
