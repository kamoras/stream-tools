import type { Logger } from 'pino';
import type { RoomSummary } from '../../shared/protocol.js';
import type { GameSnapshot } from '../game/snapshot.js';
import type { ChatMessage } from '../twitch/chat-client.js';
import { Room } from './room.js';
import type { RoomRecord, RoomStore } from './room-store.js';
import { randomId } from '../security/tokens.js';

export interface RoomRegistryOptions {
  readonly logger: Logger;
  readonly store: RoomStore;
  /** Rooms untouched for longer than this are deleted. */
  readonly retentionMs: number;
  readonly maxRooms: number;
  readonly maxRoomsPerUser: number;
  /** Coalesces bursts of game changes into one database write. */
  readonly saveDebounceMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
}

export class RoomLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RoomLimitError';
  }
}

/** Owns every room: creation, ownership, chat routing and persistence. */
export class RoomRegistry {
  private readonly logger: Logger;
  private readonly store: RoomStore;
  private readonly retentionMs: number;
  private readonly maxRooms: number;
  private readonly maxRoomsPerUser: number;
  private readonly saveDebounceMs: number;
  private readonly now: () => number;
  private readonly random: (() => number) | undefined;
  private readonly rooms = new Map<string, Room>();
  private readonly dirty = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;

  public constructor(options: RoomRegistryOptions) {
    this.logger = options.logger.child({ component: 'rooms' });
    this.store = options.store;
    this.retentionMs = options.retentionMs;
    this.maxRooms = options.maxRooms;
    this.maxRoomsPerUser = options.maxRoomsPerUser;
    this.saveDebounceMs = options.saveDebounceMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.random = options.random;
  }

  public get size(): number {
    return this.rooms.size;
  }

  public load(): void {
    const { rooms, invalid } = this.store.loadAll();
    for (const record of rooms) {
      this.rooms.set(record.id, this.instantiate(record, record.game));
    }
    for (const { id, error } of invalid) {
      this.logger.error({ err: error, room: id }, 'Skipping room with unreadable game state');
    }
    this.logger.info({ rooms: this.rooms.size }, 'Loaded rooms');
    this.prune();
  }

  /** Returns the user's room for `channel`, creating it if needed. */
  public getOrCreate(ownerId: number, channel: string): { room: Room; created: boolean } {
    const existing = this.listOwned(ownerId).find((room) => room.channel === channel);
    if (existing) return { room: existing, created: false };

    this.prune();
    if (this.listOwned(ownerId).length >= this.maxRoomsPerUser) {
      throw new RoomLimitError(
        `You can have at most ${String(this.maxRoomsPerUser)} games. Delete one first.`,
      );
    }
    if (this.rooms.size >= this.maxRooms) {
      throw new RoomLimitError('This server has reached its game limit.');
    }
    const now = this.now();
    const room = this.instantiate({
      id: randomId(12),
      ownerId,
      channel,
      createdAt: now,
      lastActiveAt: now,
    });
    this.rooms.set(room.id, room);
    this.store.saveMany([toRecord(room)]);
    this.logger.info({ room: room.id, channel, ownerId }, 'Room created');
    return { room, created: true };
  }

  public get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  /** The room, if it exists and belongs to `ownerId`. */
  public getOwned(id: string, ownerId: number): Room | undefined {
    const room = this.rooms.get(id);
    return room?.ownerId === ownerId ? room : undefined;
  }

  public listOwned(ownerId: number): Room[] {
    return [...this.rooms.values()]
      .filter((room) => room.ownerId === ownerId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  public summaries(ownerId: number): RoomSummary[] {
    return this.listOwned(ownerId).map((room) => ({
      roomId: room.id,
      channel: room.channel,
      createdAt: room.createdAt,
      lastActiveAt: room.lastActiveAt,
    }));
  }

  /** Deletes a room the user owns. Returns whether it existed. */
  public delete(id: string, ownerId: number): boolean {
    const room = this.getOwned(id, ownerId);
    if (!room) return false;
    this.remove(room);
    this.logger.info({ room: id, ownerId }, 'Room deleted');
    return true;
  }

  public routeChat(message: ChatMessage): void {
    for (const room of this.rooms.values()) {
      if (room.channel === message.channel) room.handleChat(message);
    }
  }

  public forEach(callback: (room: Room) => void): void {
    this.rooms.forEach(callback);
  }

  /** Removes rooms that have been inactive past the retention period. */
  public prune(): number {
    const cutoff = this.now() - this.retentionMs;
    let removed = 0;
    for (const room of [...this.rooms.values()]) {
      if (room.clientCount === 0 && room.lastActiveAt < cutoff) {
        this.remove(room);
        removed += 1;
      }
    }
    if (removed > 0) this.logger.info({ removed }, 'Pruned inactive rooms');
    return removed;
  }

  /** Writes all pending changes now. */
  public flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const records = [...this.dirty]
      .map((id) => this.rooms.get(id))
      .filter((room): room is Room => room !== undefined)
      .map(toRecord);
    this.dirty.clear();
    if (records.length === 0) return;
    try {
      this.store.saveMany(records);
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to persist rooms');
      for (const record of records) this.dirty.add(record.id);
    }
  }

  public shutdown(): void {
    this.flush();
    for (const room of this.rooms.values()) room.dispose();
  }

  private remove(room: Room): void {
    room.sendToAll({ type: 'error', code: 'not_found', message: 'This game was deleted.' });
    room.dispose();
    this.rooms.delete(room.id);
    this.dirty.delete(room.id);
    this.store.delete(room.id);
  }

  private markDirty(room: Room): void {
    this.dirty.add(room.id);
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.saveDebounceMs);
  }

  private instantiate(record: Omit<RoomRecord, 'game'>, snapshot?: GameSnapshot): Room {
    return new Room({
      id: record.id,
      ownerId: record.ownerId,
      channel: record.channel,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      ...(snapshot ? { snapshot } : {}),
      logger: this.logger,
      now: this.now,
      ...(this.random ? { random: this.random } : {}),
      onChange: (room) => {
        this.markDirty(room);
      },
    });
  }
}

function toRecord(room: Room): RoomRecord {
  return {
    id: room.id,
    ownerId: room.ownerId,
    channel: room.channel,
    createdAt: room.createdAt,
    lastActiveAt: room.lastActiveAt,
    game: room.snapshot(),
  };
}
