/**
 * Creates a single-use invite code directly in the database, for local
 * development or recovery when the admin dashboard isn't available.
 *
 *   npm run invite -- [note]
 */
import { pino } from 'pino';
import { InviteRepository } from './auth/invite-codes.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';

const config = loadConfig();
const db = openDatabase(config.databaseFile, pino({ level: 'warn' }));
try {
  const note = process.argv.slice(2).join(' ');
  const { code, invite } = new InviteRepository(db).create(config.inviteTtlMs, note);
  process.stdout.write(
    `Invite code: ${code}\nValid until ${new Date(invite.expiresAt).toISOString()} (single use).\n`,
  );
} finally {
  db.close();
}
