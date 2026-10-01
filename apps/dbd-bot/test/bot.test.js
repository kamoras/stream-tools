'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBot } = require('../src/bot');

// Builds a bot with the tmi client's network methods stubbed so we can assert
// on what the bot says without connecting to Twitch.
function makeBot(overrides = {}) {
  const bot = createBot({
    botUsername: 'queuebot',
    botToken: 'oauth:test',
    prefix: '!dbd ',
    rolesMode: 'off',
    queueMaxSize: 20,
    debug: false,
    ...overrides,
  });
  const says = [];
  bot.client.say = async (channel, message) => { says.push({ channel, message }); };
  bot.client.join = async () => {};
  bot.client.part = async () => {};
  return { bot, says };
}

describe('bot entrance announcement', () => {
  it('announces once when joining a channel', async () => {
    const { bot, says } = makeBot();
    await bot.joinChannel('foggywoods');
    assert.equal(says.length, 1);
    assert.equal(says[0].channel, 'foggywoods');
    assert.match(says[0].message, /fog rolls in/);
  });

  it('does not re-announce on repeat joins (reconnect / duplicate webhook)', async () => {
    const { bot, says } = makeBot();
    await bot.joinChannel('foggywoods');
    await bot.joinChannel('foggywoods');     // e.g. reconcile re-join
    await bot.onStreamOnline('foggywoods');  // e.g. duplicate stream.online
    assert.equal(says.length, 1);
  });

  it('announces again after leaving and rejoining (a new session)', async () => {
    const { bot, says } = makeBot();
    await bot.joinChannel('foggywoods');
    bot.onStreamOffline('foggywoods');       // clears the per-session flag
    await bot.joinChannel('foggywoods');
    assert.equal(says.length, 2);
  });

  it('re-announces after a manual leave', async () => {
    const { bot, says } = makeBot();
    await bot.joinChannel('foggywoods');
    await bot.leaveChannel('foggywoods');
    await bot.joinChannel('foggywoods');
    assert.equal(says.length, 2);
  });

  it('honours a custom join message', async () => {
    const { bot, says } = makeBot({ joinMessage: 'A new trial begins.' });
    await bot.joinChannel('foggywoods');
    assert.deepEqual(says.map(s => s.message), ['A new trial begins.']);
  });
});
