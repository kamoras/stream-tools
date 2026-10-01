/** Failure talking to an app's internal admin API. */
export class UpstreamError extends Error {
  public constructor(
    message: string,
    /** HTTP status from the app, or 0 if it could not be reached. */
    public readonly status: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamClientOptions {
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** A small JSON client for one app's internal admin API. */
export class UpstreamClient {
  public readonly name: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: UpstreamClientOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  public async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new UpstreamError(`${this.name} is not reachable (${reason})`, 0);
    }
    if (response.status === 204) return undefined as T;
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message =
        payload !== null && typeof payload === 'object' && 'error' in payload
          ? String(payload.error)
          : `HTTP ${String(response.status)}`;
      throw new UpstreamError(`${this.name}: ${message}`, response.status);
    }
    return payload as T;
  }
}
