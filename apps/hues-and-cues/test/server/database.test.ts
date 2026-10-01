import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../../src/server/db/database.js';
import { MIGRATIONS } from '../../src/server/db/migrations.js';
import { silentLogger } from '../helpers.js';

describe('database', () => {
  it('applies all migrations and is idempotent', () => {
    const db = openDatabase(':memory:', silentLogger);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    migrate(db, silentLogger);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('refuses a schema newer than the code', () => {
    const db = openDatabase(':memory:', silentLogger);
    db.pragma(`user_version = ${String(MIGRATIONS.length + 1)}`);
    expect(() => {
      migrate(db, silentLogger);
    }).toThrow(/newer than this build/u);
  });

  it('deletes a user’s rooms and sessions with the user', () => {
    const db = openDatabase(':memory:', silentLogger);
    db.prepare(
      "INSERT INTO users (id, username, username_normalized, password_hash, created_at, updated_at) VALUES (1, 'a', 'a', 'h', 0, 0)",
    ).run();
    db.prepare("INSERT INTO sessions VALUES ('t', 1, 0, 0, 1)").run();
    db.prepare("INSERT INTO rooms VALUES ('r', 1, 'chan', 0, 0, '{}')").run();
    db.prepare('DELETE FROM users WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM rooms').get()).toEqual({ n: 0 });
  });
});
