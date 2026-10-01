import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserRepository } from '../../src/server/auth/user-repository.js';
import { type Db, openDatabase } from '../../src/server/db/database.js';
import { RoomLimitError, RoomRegistry } from '../../src/server/rooms/room-registry.js';
import { RoomStore } from '../../src/server/rooms/room-store.js';
import { fakeClock, silentLogger } from '../helpers.js';

describe('RoomRegistry', () => {
  let dir: string;
  let dbFile: string;
  let db: Db;
  let clock: ReturnType<typeof fakeClock>;
  let alice: number;
  let bob: number;
  const registries: RoomRegistry[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hues-rooms-'));
    dbFile = join(dir, 'hues.db');
    db = openDatabase(dbFile, silentLogger);
    clock = fakeClock();
    const users = new UserRepository(db);
    alice = users.create('alice', 'x').id;
    bob = users.create('bob', 'x').id;
  });

  afterEach(async () => {
    for (const registry of registries.splice(0)) registry.shutdown();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const createRegistry = (
    options: { maxRooms?: number; maxRoomsPerUser?: number; database?: Db } = {},
  ) => {
    const registry = new RoomRegistry({
      logger: silentLogger,
      store: new RoomStore(options.database ?? db),
      retentionMs: 1000,
      maxRooms: options.maxRooms ?? 10,
      maxRoomsPerUser: options.maxRoomsPerUser ?? 3,
      now: clock.now,
    });
    registries.push(registry);
    return registry;
  };

  it('scopes rooms to their owner and reuses a room per channel', () => {
    const registry = createRegistry();
    const first = registry.getOrCreate(alice, 'streamer');
    expect(first.created).toBe(true);
    const again = registry.getOrCreate(alice, 'streamer');
    expect(again).toEqual({ room: first.room, created: false });

    expect(registry.getOwned(first.room.id, alice)).toBe(first.room);
    expect(registry.getOwned(first.room.id, bob)).toBeUndefined();
    expect(registry.getOrCreate(bob, 'streamer').room).not.toBe(first.room);
    expect(registry.summaries(alice).map((r) => r.channel)).toEqual(['streamer']);
  });

  it('persists rooms and game state across restarts', () => {
    const first = createRegistry();
    const { room } = first.getOrCreate(alice, 'streamer');
    room.execute({ type: 'drawCard' });
    first.shutdown();
    db.close();

    db = openDatabase(dbFile, silentLogger);
    const second = createRegistry();
    second.load();
    const restored = second.getOwned(room.id, alice);
    expect(restored?.channel).toBe('streamer');
    expect(restored?.snapshot().phase).toBe('picking');
  });

  it('skips rooms whose stored state is corrupt', () => {
    const registry = createRegistry();
    const { room } = registry.getOrCreate(alice, 'streamer');
    db.prepare("UPDATE rooms SET game = '{not json' WHERE id = ?").run(room.id);
    const reloaded = createRegistry();
    reloaded.load();
    expect(reloaded.get(room.id)).toBeUndefined();
  });

  it('deletes only rooms the user owns', () => {
    const registry = createRegistry();
    const { room } = registry.getOrCreate(alice, 'streamer');
    expect(registry.delete(room.id, bob)).toBe(false);
    expect(registry.delete(room.id, alice)).toBe(true);
    expect(registry.get(room.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM rooms').get()).toEqual({ n: 0 });
  });

  it('routes chat only to rooms on that channel', () => {
    const registry = createRegistry();
    const a = registry.getOrCreate(alice, 'alpha').room;
    const b = registry.getOrCreate(alice, 'beta').room;
    for (const room of [a, b]) {
      room.execute({ type: 'updateSettings', settings: { guessDurationSeconds: 0 } });
      room.execute({ type: 'drawCard' });
      room.execute({ type: 'selectTarget', index: 0 });
      room.execute({ type: 'giveClue', clue: 'sky' });
    }
    registry.routeChat({
      channel: 'alpha',
      userId: '1',
      login: 'x',
      displayName: 'x',
      color: null,
      text: 'A1',
    });
    expect(a.snapshot().round?.guesses).toHaveLength(1);
    expect(b.snapshot().round?.guesses).toHaveLength(0);
  });

  it('prunes idle rooms without connected clients', () => {
    const registry = createRegistry();
    const idle = registry.getOrCreate(alice, 'idle_room').room;
    const watched = registry.getOrCreate(alice, 'watched').room;
    watched.attach({ role: 'overlay', send: () => undefined });
    clock.advance(5000);
    expect(registry.prune()).toBe(1);
    expect(registry.get(idle.id)).toBeUndefined();
    expect(registry.get(watched.id)).toBe(watched);
  });

  it('enforces per-user and global limits', () => {
    const perUser = createRegistry({ maxRoomsPerUser: 1 });
    perUser.getOrCreate(alice, 'one');
    expect(() => perUser.getOrCreate(alice, 'two')).toThrow(RoomLimitError);
    expect(() => perUser.getOrCreate(bob, 'two')).not.toThrow();

    const global = createRegistry({ maxRooms: 3 });
    global.load();
    global.getOrCreate(bob, 'three');
    expect(() => global.getOrCreate(bob, 'four')).toThrow(/server has reached/u);
  });
});
