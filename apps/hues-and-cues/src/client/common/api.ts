import type {
  ApiErrorResponse,
  AuthUser,
  ChangePasswordRequest,
  CreateRoomRequest,
  LoginRequest,
  PublicConfigResponse,
  RegisterRequest,
  RoomSummary,
} from '../../shared/protocol.js';

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as T | ApiErrorResponse | null;
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? body.error
        : `Request failed (${String(response.status)})`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const api = {
  getConfig: () => request<PublicConfigResponse>('/api/config'),
  me: () => request<{ user: AuthUser }>('/api/auth/me'),
  register: (body: RegisterRequest) => post<{ user: AuthUser }>('/api/auth/register', body),
  login: (body: LoginRequest) => post<{ user: AuthUser }>('/api/auth/login', body),
  logout: () => post<undefined>('/api/auth/logout'),
  changePassword: (body: ChangePasswordRequest) => post<undefined>('/api/auth/password', body),
  listRooms: () => request<{ rooms: RoomSummary[] }>('/api/rooms'),
  createRoom: (body: CreateRoomRequest) => post<{ room: RoomSummary }>('/api/rooms', body),
  deleteRoom: (roomId: string) =>
    request<undefined>(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' }),
};

/** Sends the browser to the sign-in page, returning here afterwards. */
export function redirectToLogin(): void {
  const next = window.location.pathname + window.location.search;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}
