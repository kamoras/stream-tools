/**
 * Minimal IRCv3 message parser covering what Twitch chat sends.
 * @see https://dev.twitch.tv/docs/chat/irc/
 */

export interface IrcMessage {
  readonly tags: ReadonlyMap<string, string>;
  readonly prefix: string | null;
  readonly command: string;
  readonly params: readonly string[];
}

const TAG_ESCAPES: Readonly<Record<string, string>> = {
  ':': ';',
  s: ' ',
  '\\': '\\',
  r: '\r',
  n: '\n',
};

function unescapeTagValue(value: string): string {
  return value.replace(/\\(.?)/gu, (_match, char: string) => TAG_ESCAPES[char] ?? char);
}

function parseTags(raw: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const pair of raw.split(';')) {
    if (pair === '') continue;
    const separator = pair.indexOf('=');
    if (separator === -1) {
      tags.set(pair, '');
    } else {
      tags.set(pair.slice(0, separator), unescapeTagValue(pair.slice(separator + 1)));
    }
  }
  return tags;
}

/** Parses a single IRC line (without the trailing CRLF). Returns `null` if malformed. */
export function parseIrcLine(line: string): IrcMessage | null {
  let rest = line.trimEnd();
  if (rest === '') return null;

  let tags = new Map<string, string>();
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    if (end === -1) return null;
    tags = parseTags(rest.slice(1, end));
    rest = rest.slice(end + 1).trimStart();
  }

  let prefix: string | null = null;
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    if (end === -1) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1).trimStart();
  }

  const params: string[] = [];
  const trailingStart = rest.indexOf(' :');
  let trailing: string | undefined;
  if (trailingStart !== -1) {
    trailing = rest.slice(trailingStart + 2);
    rest = rest.slice(0, trailingStart);
  }
  const [command, ...middle] = rest.split(' ').filter((part) => part !== '');
  if (command === undefined) return null;
  params.push(...middle);
  if (trailing !== undefined) params.push(trailing);

  return { tags, prefix, command: command.toUpperCase(), params };
}

/** Extracts the nickname from a `nick!user@host` prefix. */
export function nickFromPrefix(prefix: string | null): string | null {
  if (prefix === null) return null;
  const bang = prefix.indexOf('!');
  return bang === -1 ? null : prefix.slice(0, bang);
}
