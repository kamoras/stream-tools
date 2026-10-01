'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bot.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_name TEXT    UNIQUE NOT NULL,
    added_by     TEXT,
    active       INTEGER NOT NULL DEFAULT 1,
    added_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT    UNIQUE NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    used       INTEGER NOT NULL DEFAULT 0,
    used_by    TEXT,
    used_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

module.exports = {
  getActiveChannels() {
    return db.prepare('SELECT channel_name FROM channels WHERE active = 1').all();
  },

  channelExists(channelName) {
    return !!db.prepare('SELECT 1 FROM channels WHERE channel_name = ?').get(channelName.toLowerCase());
  },

  addChannel(channelName, addedBy) {
    db.prepare('INSERT INTO channels (channel_name, added_by) VALUES (?, ?)').run(
      channelName.toLowerCase(),
      addedBy || null
    );
  },

  validateAndUseCode(code, usedBy) {
    const row = db.prepare('SELECT id FROM invite_codes WHERE code = ? AND used = 0').get(code.toUpperCase());
    if (!row) return false;
    db.prepare(
      `UPDATE invite_codes SET used = 1, used_by = ?, used_at = datetime('now') WHERE id = ?`
    ).run(usedBy, row.id);
    return true;
  },

  createInviteCode(code) {
    db.prepare('INSERT INTO invite_codes (code) VALUES (?)').run(code.toUpperCase());
  },

  getChannelList() {
    return db.prepare(
      'SELECT channel_name, added_at FROM channels WHERE active = 1 ORDER BY added_at DESC'
    ).all();
  },

  getPendingCodes() {
    return db.prepare(
      'SELECT id, code, created_at FROM invite_codes WHERE used = 0 ORDER BY created_at DESC'
    ).all();
  },

  removeChannel(channelName) {
    db.prepare('DELETE FROM channels WHERE channel_name = ?').run(channelName.toLowerCase());
  },

  deleteInviteCode(id) {
    db.prepare('DELETE FROM invite_codes WHERE id = ? AND used = 0').run(id);
  },

  getSetting(key) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  },

  setSetting(key, value) {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  },

  close() {
    db.close();
  },
};
