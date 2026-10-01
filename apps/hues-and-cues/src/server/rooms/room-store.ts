import type { Db } from '../db/database.js';
import { type GameSnapshot, gameSnapshotSchema } from '../game/snapshot.js';

export interface RoomRecord {
  readonly id: string;
  readonly ownerId: number;
  readonly channel: string;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly game: GameSnapshot;
}

interface RoomRow {
  id: string;
  owner_id: number;
  channel: string;
  created_at: number;
  last_active_at: number;
  game: string;
}

export interface InvalidRoom {
  readonly id: string;
  readonly error: unknown;
}

/** SQLite persistence for rooms. Game state is stored as a validated JSON snapshot. */
export class RoomStore {
  public constructor(private readonly db: Db) {}

  /** Loads every room. Rows whose snapshot fails validation are reported, not thrown. */
  public loadAll(): { rooms: RoomRecord[]; invalid: InvalidRoom[] } {
    const rows = this.db
      .prepare<[], RoomRow>(
        'SELECT id, owner_id, channel, created_at, last_active_at, game FROM rooms',
      )
      .all();
    const rooms: RoomRecord[] = [];
    const invalid: InvalidRoom[] = [];
    for (const row of rows) {
      try {
        rooms.push({
          id: row.id,
          ownerId: row.owner_id,
          channel: row.channel,
          createdAt: row.created_at,
          lastActiveAt: row.last_active_at,
          game: gameSnapshotSchema.parse(JSON.parse(row.game)),
        });
      } catch (error) {
        invalid.push({ id: row.id, error });
      }
    }
    return { rooms, invalid };
  }

  /** Inserts or updates rooms atomically. */
  public saveMany(records: readonly RoomRecord[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO rooms (id, owner_id, channel, created_at, last_active_at, game)
       VALUES (@id, @ownerId, @channel, @createdAt, @lastActiveAt, @game)
       ON CONFLICT (id) DO UPDATE SET
         last_active_at = excluded.last_active_at,
         game = excluded.game`,
    );
    this.db.transaction(() => {
      for (const record of records) {
        upsert.run({ ...record, game: JSON.stringify(record.game) });
      }
    })();
  }

  public delete(id: string): void {
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }
}
