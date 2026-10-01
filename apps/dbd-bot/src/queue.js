'use strict';

class Queue {
  constructor({ maxSize = 20, rolesMode = 'off' } = {}) {
    this.entries = [];
    this.isOpen = true;
    this.maxSize = maxSize;
    this.rolesMode = rolesMode;
  }

  get size() {
    return this.entries.length;
  }

  join(username, roleArg) {
    if (!this.isOpen) {
      return { success: false, message: `@${username}, the queue is currently closed.` };
    }

    if (this._findIndex(username) !== -1) {
      const pos = this.position(username);
      return { success: false, message: `@${username}, you're already in the queue at position #${pos}!` };
    }

    if (this.entries.length >= this.maxSize) {
      return {
        success: false,
        message: `@${username}, the queue is full (${this.maxSize}/${this.maxSize}). Try again when a spot opens up!`,
      };
    }

    let role = null;
    if (this.rolesMode === 'both') {
      const normalized = roleArg?.toLowerCase();
      if (normalized === 'killer') {
        role = 'killer';
      } else if (!normalized || normalized === 'survivor') {
        role = 'survivor'; // survivor is the default
      } else {
        return { success: false, code: 'INVALID_ROLE', message: `@${username}, unknown role. Use survivor (default) or killer.` };
      }
    } else if (this.rolesMode === 'survivor') {
      role = 'survivor';
    } else if (this.rolesMode === 'killer') {
      role = 'killer';
    }

    this.entries.push({ username, role, joinedAt: new Date() });
    const pos = this.entries.length;
    const roleText = role ? ` as ${role}` : '';
    return {
      success: true,
      message: `@${username} joined the queue${roleText}! You're #${pos} in line.`,
    };
  }

  leave(username) {
    const idx = this._findIndex(username);
    if (idx === -1) {
      return { success: false, message: `@${username}, you're not in the queue.` };
    }
    this.entries.splice(idx, 1);
    return { success: true, message: `@${username} left the queue.` };
  }

  remove(username) {
    const idx = this._findIndex(username);
    if (idx === -1) {
      return { success: false, message: `${username} is not in the queue.` };
    }
    this.entries.splice(idx, 1);
    return { success: true, message: `${username} has been removed from the queue.` };
  }

  next() {
    if (this.entries.length === 0) {
      return { success: false, message: 'The queue is empty!' };
    }
    const entry = this.entries[0];
    const roleText = entry.role ? ` (${entry.role})` : '';
    return {
      success: true,
      entry,
      message: `Next up: @${entry.username}${roleText} | ${this.entries.length} in queue`,
    };
  }

  pick(count = 1) {
    if (this.entries.length === 0) {
      return { success: false, message: 'The queue is empty!' };
    }
    const n = Math.min(Math.max(1, count), this.entries.length);
    const picked = this.entries.splice(0, n);
    const remaining = this.entries.length;
    const names = picked
      .map(e => `@${e.username}${e.role ? ` (${e.role})` : ''}`)
      .join(', ');
    return {
      success: true,
      entries: picked,
      message: `${names} — you're up! Get ready to join the lobby. (${remaining} remaining in queue)`,
    };
  }

  clear() {
    const count = this.entries.length;
    this.entries = [];
    return { success: true, message: `Queue cleared. (${count} entries removed)` };
  }

  open() {
    if (this.isOpen) {
      return { success: false, message: 'The queue is already open.' };
    }
    this.isOpen = true;
    return { success: true, message: 'Queue is now open!' };
  }

  close() {
    if (!this.isOpen) {
      return { success: false, message: 'The queue is already closed.' };
    }
    this.isOpen = false;
    this.entries = []; // clear the queue when the stream session ends
    return { success: true, message: 'Queue is now closed and cleared for next session.' };
  }

  position(username) {
    return this._findIndex(username) + 1;
  }

  list(limit = 10) {
    return this.entries.slice(0, limit);
  }

  _findIndex(username) {
    return this.entries.findIndex(
      e => e.username.toLowerCase() === username.toLowerCase()
    );
  }
}

module.exports = Queue;
