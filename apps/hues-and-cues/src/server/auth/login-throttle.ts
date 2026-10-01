/**
 * Counts failed sign-ins per key (for example username + IP). After
 * `maxFailures` failures within `windowMs`, further attempts for that key are
 * refused until the window passes.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  public constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until another attempt is allowed, or 0 if allowed now. */
  public retryAfterSeconds(key: string): number {
    const recent = this.recent(key);
    if (recent.length < this.maxFailures) return 0;
    const oldest = recent[0] ?? this.now();
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  public recordFailure(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.failures.set(key, recent);
  }

  /** Removes the most recent failure (an attempt counted up front that succeeded). */
  public forgiveOne(key: string): void {
    const recent = this.recent(key);
    recent.pop();
    if (recent.length === 0) this.failures.delete(key);
  }

  public reset(key: string): void {
    this.failures.delete(key);
  }

  /** Drops stale entries so memory stays bounded. */
  public prune(): void {
    for (const key of this.failures.keys()) this.recent(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length === 0) this.failures.delete(key);
    else this.failures.set(key, recent);
    return recent;
  }
}
