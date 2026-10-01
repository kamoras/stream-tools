'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Queue = require('../src/queue');

describe('Queue', () => {
  it('starts open and empty', () => {
    const q = new Queue();
    assert.equal(q.size, 0);
    assert.equal(q.isOpen, true);
  });

  it('join adds a user and returns position', () => {
    const q = new Queue();
    const result = q.join('alice');
    assert.equal(result.success, true);
    assert.equal(q.size, 1);
    assert.match(result.message, /#1/);
  });

  it('join twice returns an error with current position', () => {
    const q = new Queue();
    q.join('alice');
    const result = q.join('alice');
    assert.equal(result.success, false);
    assert.match(result.message, /already in the queue/);
  });

  it('join is case-insensitive for duplicate detection', () => {
    const q = new Queue();
    q.join('Alice');
    const result = q.join('alice');
    assert.equal(result.success, false);
  });

  it('leave removes user from queue', () => {
    const q = new Queue();
    q.join('alice');
    const result = q.leave('alice');
    assert.equal(result.success, true);
    assert.equal(q.size, 0);
  });

  it('leave when not in queue returns error', () => {
    const q = new Queue();
    const result = q.leave('alice');
    assert.equal(result.success, false);
  });

  it('closed queue rejects joins', () => {
    const q = new Queue();
    q.close();
    const result = q.join('alice');
    assert.equal(result.success, false);
    assert.match(result.message, /closed/i);
  });

  it('open re-opens a closed queue', () => {
    const q = new Queue();
    q.close();
    const result = q.open();
    assert.equal(result.success, true);
    assert.equal(q.isOpen, true);
  });

  it('maxSize is enforced', () => {
    const q = new Queue({ maxSize: 2 });
    q.join('alice');
    q.join('bob');
    const result = q.join('charlie');
    assert.equal(result.success, false);
    assert.match(result.message, /full/);
  });

  it('pick returns and removes the first entry', () => {
    const q = new Queue();
    q.join('alice');
    q.join('bob');
    const result = q.pick();
    assert.equal(result.success, true);
    assert.equal(result.entries[0].username, 'alice');
    assert.equal(q.size, 1);
    assert.equal(q.entries[0].username, 'bob');
  });

  it('pick on empty queue returns error', () => {
    const q = new Queue();
    const result = q.pick();
    assert.equal(result.success, false);
  });

  it('pick(n) removes up to n entries in order', () => {
    const q = new Queue();
    q.join('alice');
    q.join('bob');
    q.join('charlie');
    const result = q.pick(2);
    assert.equal(result.success, true);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].username, 'alice');
    assert.equal(result.entries[1].username, 'bob');
    assert.equal(q.size, 1);
  });

  it('pick(n) caps at queue size', () => {
    const q = new Queue();
    q.join('alice');
    const result = q.pick(10);
    assert.equal(result.success, true);
    assert.equal(result.entries.length, 1);
    assert.equal(q.size, 0);
  });

  it('next previews without removing', () => {
    const q = new Queue();
    q.join('alice');
    const result = q.next();
    assert.equal(result.success, true);
    assert.equal(result.entry.username, 'alice');
    assert.equal(q.size, 1);
  });

  it('remove takes out a specific user', () => {
    const q = new Queue();
    q.join('alice');
    q.join('bob');
    const result = q.remove('alice');
    assert.equal(result.success, true);
    assert.equal(q.size, 1);
    assert.equal(q.entries[0].username, 'bob');
  });

  it('close clears the queue for next session', () => {
    const q = new Queue();
    q.join('alice');
    q.join('bob');
    const result = q.close();
    assert.equal(result.success, true);
    assert.equal(q.size, 0);
    assert.equal(q.isOpen, false);
  });

  it('clear empties the queue', () => {
    const q = new Queue();
    q.join('alice');
    q.join('bob');
    const result = q.clear();
    assert.equal(result.success, true);
    assert.equal(q.size, 0);
  });

  it('position returns 1-based index', () => {
    const q = new Queue();
    q.join('alice');
    q.join('bob');
    assert.equal(q.position('alice'), 1);
    assert.equal(q.position('bob'), 2);
  });

  it('position returns 0 when user is not in queue', () => {
    const q = new Queue();
    assert.equal(q.position('alice'), 0);
  });

  describe('rolesMode: both', () => {
    it('defaults to survivor when no role is given', () => {
      const q = new Queue({ rolesMode: 'both' });
      const result = q.join('alice');
      assert.equal(result.success, true);
      assert.equal(q.entries[0].role, 'survivor');
    });

    it('rejects unknown role arguments', () => {
      const q = new Queue({ rolesMode: 'both' });
      const result = q.join('alice', 'healer');
      assert.equal(result.success, false);
      assert.equal(result.code, 'INVALID_ROLE');
    });

    it('accepts explicit survivor role', () => {
      const q = new Queue({ rolesMode: 'both' });
      const result = q.join('alice', 'survivor');
      assert.equal(result.success, true);
      assert.equal(q.entries[0].role, 'survivor');
    });

    it('accepts killer role', () => {
      const q = new Queue({ rolesMode: 'both' });
      const result = q.join('alice', 'killer');
      assert.equal(result.success, true);
      assert.equal(q.entries[0].role, 'killer');
    });
  });

  describe('rolesMode: survivor', () => {
    it('assigns survivor role automatically', () => {
      const q = new Queue({ rolesMode: 'survivor' });
      q.join('alice');
      assert.equal(q.entries[0].role, 'survivor');
    });
  });

  describe('rolesMode: killer', () => {
    it('assigns killer role automatically', () => {
      const q = new Queue({ rolesMode: 'killer' });
      q.join('alice');
      assert.equal(q.entries[0].role, 'killer');
    });
  });

  describe('rolesMode: off', () => {
    it('assigns no role', () => {
      const q = new Queue({ rolesMode: 'off' });
      q.join('alice');
      assert.equal(q.entries[0].role, null);
    });
  });
});
