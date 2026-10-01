import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

/**
 * Opens (creating if needed) the SQLite database and applies pending
 * migrations. Pass `':memory:'` for an ephemeral database in tests.
 */
export function openDatabase(filePath: string, logger: Logger): Db {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, logger);
  return db;
}

export function migrate(db: Db, logger: Logger): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema v${String(current)} is newer than this build supports (v${String(MIGRATIONS.length)}).`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) continue;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${String(version + 1)}`);
    })();
    logger.info({ version: version + 1 }, 'Applied database migration');
  }
}
