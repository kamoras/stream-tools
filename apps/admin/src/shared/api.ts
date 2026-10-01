/**
 * Types shared by the admin dashboard's server and browser code. The
 * per-app shapes mirror each app's internal admin API.
 */

// --- dbd-bot (apps/dbd-bot/src/admin-api.js) ---------------------------------

export interface BotWebhookEvent {
  readonly channel: string;
  /** 'online' | 'offline' | 'revoked' (others shown verbatim). */
  readonly type: string;
  readonly time: number;
}

export interface BotStatus {
  readonly botName: string;
  readonly prefix: string;
  readonly connected: boolean;
  readonly uptimeMs: number;
  readonly chatSelfRefreshing: boolean;
  readonly twitch: { readonly configured: boolean; readonly clientId: string | null };
  readonly webhook: {
    readonly enabled: boolean;
    readonly received?: number;
    readonly verified?: number;
    readonly rejected?: number;
    readonly online?: number;
    readonly offline?: number;
    readonly revoked?: number;
    readonly lastReceivedAt?: number | null;
    readonly recentEvents?: readonly BotWebhookEvent[];
  };
}

export interface BotChannel {
  readonly channel: string;
  readonly addedAt: number | null;
  readonly queueSize: number;
  readonly queueOpen: boolean;
  readonly inChat: boolean;
}

export interface BotInvite {
  readonly id: number;
  readonly code: string;
  readonly createdAt: number | null;
}

export interface BotOverview {
  readonly status: BotStatus;
  readonly channels: readonly BotChannel[];
  readonly invites: readonly BotInvite[];
}

// --- hues-and-cues (apps/hues-and-cues/src/server/http/internal-api.ts) ------

export type HuesInviteStatus = 'unused' | 'used' | 'expired' | 'revoked';

export interface HuesInvite {
  readonly id: number;
  readonly hint: string;
  readonly note: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: HuesInviteStatus;
  readonly usedAt: number | null;
  readonly usedBy: string | null;
}

export interface HuesUser {
  readonly id: number;
  readonly username: string;
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
  readonly channels: readonly string[];
}

export interface HuesOverview {
  readonly invites: readonly HuesInvite[];
  readonly users: readonly HuesUser[];
  readonly inviteTtlDays: number;
}

export interface HuesCreatedInvite {
  readonly invite: HuesInvite;
  readonly code: string;
}

// --- dashboard API -------------------------------------------------------------

export interface ApiError {
  readonly error: string;
}

export const APP_KEYS = ['dbd-bot', 'hues-and-cues'] as const;
export type AppKey = (typeof APP_KEYS)[number];
