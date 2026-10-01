'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'invite.js');

function runInvite(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-test-'));
  try {
    const dbPath = path.join(dir, 'bot.db');
    // Run from a directory with a .env file, as on the server, so dotenv is active.
    fs.writeFileSync(path.join(dir, '.env'), 'BOT_PREFIX=!dbd \n');
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
    });
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const codes = db.prepare('SELECT code FROM invite_codes').all().map((row) => row.code);
    db.close();
    return { stdout, codes };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('scripts/invite.js', () => {
  it('--raw prints only the stored code, so automation can capture it', () => {
    const { stdout, codes } = runInvite(['--raw']);
    assert.match(stdout, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.deepEqual(codes, [stdout]);
  });

  it('prints a human-readable message by default', () => {
    const { stdout, codes } = runInvite([]);
    assert.equal(codes.length, 1);
    assert.ok(stdout.includes(codes[0]));
    assert.ok(!stdout.includes('injected env'));
  });
});
