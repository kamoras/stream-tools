import { type Coord, parseCoord } from '../../shared/board.js';

const COMMAND_PATTERN = /^!(?:guess|g|hue)\s+(.+)$/iu;

/**
 * Extracts a board guess from a chat message, e.g. `F12`, `12f`, `!guess F12`.
 * When `requireCommand` is set, bare coordinates are ignored so ordinary chat
 * ("a1 stream!") is never mistaken for a guess.
 */
export function parseChatGuess(text: string, requireCommand: boolean): Coord | null {
  // Chat clients append invisible characters to repeat a message Twitch would
  // otherwise block as a duplicate ("F12" then "F12\u{E0000}"); ignore them.
  const trimmed = text.replace(/[\p{Default_Ignorable_Code_Point}\p{M}]/gu, '').trim();
  const command = COMMAND_PATTERN.exec(trimmed);
  if (command?.[1] !== undefined) {
    return parseCoord(command[1]);
  }
  return requireCommand ? null : parseCoord(trimmed);
}
