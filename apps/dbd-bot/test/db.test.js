'use strict';

// Must be set before requiring db so the module opens an in-memory database.
process.env.DB_PATH = ':memory:';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

describe('db - invite codes', () => {
  it('validates and burns a single-use code', () => {
    db.createInviteCode('UNIT-0001');
    assert.equal(db.validateAndUseCode('UNIT-0001', 'user1'), true);
  });

  it('rejects an already-used code', () => {
    db.createInviteCode('UNIT-0002');
    db.validateAndUseCode('UNIT-0002', 'user1');
    assert.equal(db.validateAndUseCode('UNIT-0002', 'user2'), false);
  });

  it('is case-insensitive on code lookup', () => {
    db.createInviteCode('UNIT-0003');
    assert.equal(db.validateAndUseCode('unit-0003', 'user'), true);
  });

  it('rejects an unknown code', () => {
    assert.equal(db.validateAndUseCode('XXXX-XXXX', 'user'), false);
  });
});

describe('db - channels', () => {
  it('adds a channel and detects its existence', () => {
    db.addChannel('testchan', 'testchan');
    assert.equal(db.channelExists('testchan'), true);
  });

  it('returns false for unknown channels', () => {
    assert.equal(db.channelExists('notachannel'), false);
  });

  it('channelExists is case-insensitive', () => {
    db.addChannel('MixedCase', 'user');
    assert.equal(db.channelExists('mixedcase'), true);
    assert.equal(db.channelExists('MIXEDCASE'), true);
  });

  it('getActiveChannels includes newly added channels', () => {
    db.addChannel('activechan', 'activechan');
    const names = db.getActiveChannels().map(r => r.channel_name);
    assert.ok(names.includes('activechan'));
  });

  it('does not duplicate channels on repeated add', () => {
    db.addChannel('oncechan', 'user');
    assert.throws(() => db.addChannel('oncechan', 'user'));
  });
});

describe('db - settings', () => {
  it('returns null for an unset key', () => {
    assert.equal(db.getSetting('nope'), null);
  });

  it('round-trips a value and overwrites it on update', () => {
    db.setSetting('twitch_refresh_token', 'abc123');
    assert.equal(db.getSetting('twitch_refresh_token'), 'abc123');
    db.setSetting('twitch_refresh_token', 'def456');
    assert.equal(db.getSetting('twitch_refresh_token'), 'def456');
  });
});
