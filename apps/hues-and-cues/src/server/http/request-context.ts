import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse, ErrorCode } from '../../shared/protocol.js';
import type { User } from '../auth/user-repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, resolved from the session cookie. */
    user: User | null;
    /** The raw session token from the cookie, if any. */
    sessionToken: string | null;
  }
}

export interface CookieSettings {
  readonly secure: boolean;
  readonly ttlMs: number;
}

/**
 * The `__Host-` prefix makes browsers refuse the cookie unless it is Secure,
 * host-only and path `/`, which blocks subdomain cookie injection. It needs
 * HTTPS, so plain-HTTP development uses an unprefixed name.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-hc_session' : 'hc_session';
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  settings: CookieSettings,
): void {
  void reply.setCookie(sessionCookieName(settings.secure), token, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(settings.ttlMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, settings: CookieSettings): void {
  void reply.clearCookie(sessionCookieName(settings.secure), {
    httpOnly: true,
    secure: settings.secure,
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * Whether the request's `Origin` header names this server. Used to reject
 * cross-site requests (CSRF) and cross-site WebSocket hijacking.
 */
export function isSameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host === request.host;
  } catch {
    return false;
  }
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
): FastifyReply {
  return reply.status(status).send({ error: message, code } satisfies ApiErrorResponse);
}

/** Route guard: 401 unless signed in. Use as a `preHandler`. */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user === null) {
    await sendError(reply, 401, 'unauthorized', 'Please sign in.');
  }
}

/** The signed-in user; only valid on routes guarded by {@link requireUser}. */
export function currentUser(request: FastifyRequest): User {
  if (request.user === null) throw new Error('requireUser guard missing');
  return request.user;
}
