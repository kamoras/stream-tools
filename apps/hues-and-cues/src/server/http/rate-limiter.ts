/** A token bucket: allows bursts up to `capacity`, refilling at `refillPerSecond`. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  public constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  public tryRemove(): boolean {
    const now = this.now();
    const elapsedSeconds = (now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
