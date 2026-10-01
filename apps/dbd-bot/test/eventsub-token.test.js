'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const eventsub = require('../src/eventsub');

describe('eventsub - createChatTokenProvider', () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = global.fetch;
    calls = 0;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockRefresh(responses) {
    global.fetch = async () => {
      const body = responses[calls] || responses[responses.length - 1];
      calls += 1;
      return { ok: true, json: async () => body };
    };
  }

  it('fetches once and caches until near expiry', async () => {
    mockRefresh([{ access_token: 'tok1', refresh_token: 'r1', expires_in: 3600 }]);
    const getToken = eventsub.createChatTokenProvider({
      refreshToken: 'seed', clientId: 'id', clientSecret: 'secret', onRotate: () => {},
    });
    assert.equal(await getToken(), 'tok1');
    assert.equal(await getToken(), 'tok1');
    assert.equal(calls, 1);
  });

  it('persists a rotated refresh token via onRotate', async () => {
    mockRefresh([{ access_token: 'tok1', refresh_token: 'r2', expires_in: 3600 }]);
    let rotatedTo = null;
    const getToken = eventsub.createChatTokenProvider({
      refreshToken: 'r1', clientId: 'id', clientSecret: 'secret', onRotate: t => { rotatedTo = t; },
    });
    await getToken();
    assert.equal(rotatedTo, 'r2');
  });

  it('re-fetches once the cached token is near expiry', async () => {
    mockRefresh([
      { access_token: 'tok1', refresh_token: 'r1', expires_in: 60 }, // < 5min buffer, treated as already stale
      { access_token: 'tok2', refresh_token: 'r1', expires_in: 3600 },
    ]);
    const getToken = eventsub.createChatTokenProvider({
      refreshToken: 'seed', clientId: 'id', clientSecret: 'secret', onRotate: () => {},
    });
    assert.equal(await getToken(), 'tok1');
    assert.equal(await getToken(), 'tok2');
    assert.equal(calls, 2);
  });
});
