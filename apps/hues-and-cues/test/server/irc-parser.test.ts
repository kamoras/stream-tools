import { describe, expect, it } from 'vitest';
import { nickFromPrefix, parseIrcLine } from '../../src/server/twitch/irc-parser.js';

describe('parseIrcLine', () => {
  it('parses a tagged PRIVMSG', () => {
    const message = parseIrcLine(
      '@badge-info=;color=#1E90FF;display-name=Cool\\sGuy;user-id=12345 :coolguy!coolguy@coolguy.tmi.twitch.tv PRIVMSG #streamer :F12 for sure',
    );
    expect(message).not.toBeNull();
    expect(message?.command).toBe('PRIVMSG');
    expect(message?.params).toEqual(['#streamer', 'F12 for sure']);
    expect(message?.tags.get('display-name')).toBe('Cool Guy');
    expect(message?.tags.get('user-id')).toBe('12345');
    expect(message?.tags.get('badge-info')).toBe('');
    expect(nickFromPrefix(message?.prefix ?? null)).toBe('coolguy');
  });

  it('parses PING without prefix', () => {
    expect(parseIrcLine('PING :tmi.twitch.tv')).toMatchObject({
      command: 'PING',
      prefix: null,
      params: ['tmi.twitch.tv'],
    });
  });

  it('parses numerics and middle params', () => {
    expect(parseIrcLine(':tmi.twitch.tv 001 justinfan123 :Welcome, GLHF!')).toMatchObject({
      command: '001',
      params: ['justinfan123', 'Welcome, GLHF!'],
    });
  });

  it('unescapes tag values', () => {
    const message = parseIrcLine('@msg=a\\:b\\\\c\\sd :x!x@x PRIVMSG #c :hi');
    expect(message?.tags.get('msg')).toBe('a;b\\c d');
  });

  it('rejects malformed lines', () => {
    expect(parseIrcLine('')).toBeNull();
    expect(parseIrcLine('@tagsonly')).toBeNull();
    expect(parseIrcLine(':prefixonly')).toBeNull();
  });

  it('returns null nick for server prefixes', () => {
    expect(nickFromPrefix('tmi.twitch.tv')).toBeNull();
    expect(nickFromPrefix(null)).toBeNull();
  });
});
