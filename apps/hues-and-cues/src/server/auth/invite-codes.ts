import { randomInt } from 'node:crypto';
import type { InviteStatus, InviteSummary } from '../../shared/protocol.js';
import type { Db } from '../db/database.js';
import { hashToken } from '../security/tokens.js';

/**
 * Single-use invite codes, as in the dbd-bot: an admin generates a code, the
 * new user enters it once at sign-up, and it can never be used again.
 *
 * Codes are 12 Crockford base-32 characters (60 bits) shown as `XXXX-XXXX-XXXX`.
 * Only a SHA-256 hash and a short hint are stored, so the full code is visible
 * exactly once, to the admin who generated it. Input is normalised so dashes,
 * spaces, case and the look-alikes O/I/L don't matter.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const GROUP = 4;

export function generateInviteCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) raw += ALPHABET.charAt(randomInt(ALPHABET.length));
  return raw.replace(new RegExp(`(.{${String(GROUP)}})(?!$)`, 'gu'), '$1-');
}

/** Canonical form for hashing; returns `null` if it can't be a code. */
export function normalizeInviteCode(input: string): string | null {
  const canonical = input
    .toUpperCase()
    .replace(/[\s-]/gu, '')
    .replace(/O/gu, '0')
    .replace(/[IL]/gu, '1');
  if (canonical.length !== CODE_LENGTH) return null;
  for (const char of canonical) if (!ALPHABET.includes(char)) return null;
  return canonical;
}

interface InviteRow {
  id: number;
  hint: string;
  note: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  used_at: number | null;
  used_by_username: string | null;
}

export type ConsumeResult = 'ok' | 'invalid';

export class InviteRepository {
  public constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Creates a code valid for `ttlMs`. The returned plain code is never stored. */
  public create(ttlMs: number, note?: string): { code: string; invite: InviteSummary } {
    const code = generateInviteCode();
    const canonical = normalizeInviteCode(code);
    if (canonical === null) throw new Error('generated an invalid invite code');
    const now = this.now();
    const hint = code.slice(0, GROUP);
    const trimmedNote = note?.trim() ?? '';
    const result = this.db
      .prepare(
        `INSERT INTO invite_codes (code_hash, hint, note, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashToken(canonical), hint, trimmedNote === '' ? null : trimmedNote, now, now + ttlMs);
    const invite = this.get(Number(result.lastInsertRowid));
    if (!invite) throw new Error('invite vanished after insert');
    return { code, invite };
  }

  public list(): InviteSummary[] {
    return this.db
      .prepare<[], InviteRow>(
        `SELECT ${COLUMNS} FROM invite_codes ORDER BY created_at DESC, id DESC`,
      )
      .all()
      .map((row) => this.toSummary(row));
  }

  public get(id: number): InviteSummary | undefined {
    const row = this.db
      .prepare<[number], InviteRow>(`SELECT ${COLUMNS} FROM invite_codes WHERE id = ?`)
      .get(id);
    return row ? this.toSummary(row) : undefined;
  }

  /** Whether `code` could be redeemed right now (no side effects). */
  public isRedeemable(code: string): boolean {
    const canonical = normalizeInviteCode(code);
    if (canonical === null) return false;
    const row = this.db
      .prepare<[string, number], { id: number }>(
        `SELECT id FROM invite_codes
          WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(hashToken(canonical), this.now());
    return row !== undefined;
  }

  /**
   * Marks the code used by `userId`. Must run in the same transaction as the
   * user's creation; the conditional UPDATE makes double redemption impossible.
   */
  public consume(code: string, userId: number, username: string): ConsumeResult {
    const canonical = normalizeInviteCode(code);
    if (canonical === null) return 'invalid';
    const now = this.now();
    const { changes } = this.db
      .prepare(
        `UPDATE invite_codes SET used_at = ?, used_by_user_id = ?, used_by_username = ?
          WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(now, userId, username, hashToken(canonical), now);
    return changes === 1 ? 'ok' : 'invalid';
  }

  /** Revokes an unused code. Returns false if it doesn't exist or was already used. */
  public revoke(id: number): boolean {
    const { changes } = this.db
      .prepare(
        'UPDATE invite_codes SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
      )
      .run(this.now(), id);
    return changes === 1;
  }

  private toSummary(row: InviteRow): InviteSummary {
    let status: InviteStatus = 'unused';
    if (row.used_at !== null) status = 'used';
    else if (row.revoked_at !== null) status = 'revoked';
    else if (row.expires_at <= this.now()) status = 'expired';
    return {
      id: row.id,
      hint: row.hint,
      note: row.note,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status,
      usedAt: row.used_at,
      usedBy: row.used_by_username,
    };
  }
}

const COLUMNS = 'id, hint, note, created_at, expires_at, revoked_at, used_at, used_by_username';
