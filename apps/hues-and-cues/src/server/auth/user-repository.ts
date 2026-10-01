import type { AdminUserSummary } from '../../shared/protocol.js';
import type { Db } from '../db/database.js';

export interface User {
  readonly id: number;
  readonly username: string;
  readonly createdAt: number;
}

export interface UserWithHash extends User {
  readonly passwordHash: string;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
}

export class UsernameTakenError extends Error {
  public constructor() {
    super('That username is already taken.');
    this.name = 'UsernameTakenError';
  }
}

/** Usernames are unique case-insensitively; the chosen casing is kept for display. */
export function normalizeUsername(username: string): string {
  return username.normalize('NFKC').toLowerCase();
}

function toUser(row: UserRow): UserWithHash {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

export class UserRepository {
  public constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  public create(username: string, passwordHash: string): User {
    const now = this.now();
    try {
      const result = this.db
        .prepare(
          `INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(username, normalizeUsername(username), passwordHash, now, now);
      return { id: Number(result.lastInsertRowid), username, createdAt: now };
    } catch (error) {
      if (isUniqueViolation(error)) throw new UsernameTakenError();
      throw error;
    }
  }

  public findByUsername(username: string): UserWithHash | undefined {
    const row = this.db
      .prepare<[string], UserRow>(
        'SELECT id, username, password_hash, created_at FROM users WHERE username_normalized = ?',
      )
      .get(normalizeUsername(username));
    return row ? toUser(row) : undefined;
  }

  public findById(id: number): UserWithHash | undefined {
    const row = this.db
      .prepare<[number], UserRow>(
        'SELECT id, username, password_hash, created_at FROM users WHERE id = ?',
      )
      .get(id);
    return row ? toUser(row) : undefined;
  }

  public updatePasswordHash(id: number, passwordHash: string): void {
    this.db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, this.now(), id);
  }

  public recordLogin(id: number): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(this.now(), id);
  }

  /** Every account with its activity and channels, newest first (admin view). */
  public listForAdmin(): AdminUserSummary[] {
    return this.db
      .prepare<
        [],
        {
          id: number;
          username: string;
          created_at: number;
          last_login_at: number | null;
          channels: string | null;
        }
      >(
        `SELECT u.id, u.username, u.created_at, u.last_login_at,
                (SELECT group_concat(r.channel, ',') FROM rooms r WHERE r.owner_id = u.id) AS channels
           FROM users u
          ORDER BY u.created_at DESC, u.id DESC`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        username: row.username,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        channels: row.channels === null ? [] : row.channels.split(',').sort(),
      }));
  }

  public count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}
