import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt (built into Node, no native dependency).
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's scrypt option
 * N=2^15, r=8, p=3 (~32 MiB per hash) — strong, yet gentle enough for a
 * 1 GB free-tier VM. Hashes are self-describing
 * (`scrypt$N$r$p$salt$hash`), so parameters can be raised later and old
 * hashes upgraded transparently on login via {@link needsRehash}.
 */

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r + 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return [
    PREFIX,
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseHash(encoded: string): ParsedHash | null {
  const [prefix, n, r, p, salt, key, ...rest] = encoded.split('$');
  if (prefix !== PREFIX || rest.length > 0 || salt === undefined || key === undefined) return null;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return null;
  }
  return { params, salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') };
}

/** Verifies `password` against a stored hash in constant time. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (parsed?.key.length !== KEY_LENGTH) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

/** Whether a stored hash uses weaker parameters than the current defaults. */
export function needsRehash(
  encoded: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): boolean {
  const parsed = parseHash(encoded);
  return (
    parsed === null ||
    parsed.params.N < params.N ||
    parsed.params.r < params.r ||
    parsed.params.p < params.p
  );
}
