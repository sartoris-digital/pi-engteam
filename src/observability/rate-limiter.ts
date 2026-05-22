/**
 * Configuration options for RateLimiter.
 */
export interface RateLimiterOptions {
  /**
   * Maximum number of requests allowed within the sliding window.
   * Must be greater than 0.
   */
  maxPerWindow: number;

  /**
   * Time window duration in milliseconds.
   * Must be greater than 0.
   */
  windowMs: number;
}

/**
 * Sliding-window rate limiter for controlling request frequency.
 * 
 * Uses an array-based approach with eager cleanup: on each acquisition attempt,
 * timestamps older than the current window are pruned. This ensures O(maxPerWindow)
 * space complexity and O(n) time complexity per operation where n = maxPerWindow.
 * 
 * @example
 * ```typescript
 * const limiter = new RateLimiter({ maxPerWindow: 5, windowMs: 1000 });
 * 
 * if (limiter.tryAcquire()) {
 *   // Proceed with rate-limited operation
 * } else {
 *   // Rate limit exceeded
 * }
 * ```
 */
export class RateLimiter {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  /**
   * Creates a new RateLimiter instance.
   * 
   * @param options - Configuration for the rate limiter
   * @throws {Error} If maxPerWindow or windowMs is not greater than 0
   */
  constructor(options: RateLimiterOptions) {
    if (options.maxPerWindow <= 0) {
      throw new Error("maxPerWindow must be greater than 0");
    }
    if (options.windowMs <= 0) {
      throw new Error("windowMs must be greater than 0");
    }

    this.maxPerWindow = options.maxPerWindow;
    this.windowMs = options.windowMs;
  }

  /**
   * Attempts to acquire a request slot within the rate limit.
   * 
   * This method implements a sliding window algorithm:
   * 1. Prunes timestamps older than the current window
   * 2. Checks if the current count is below the limit
   * 3. If allowed, records the current timestamp and returns true
   * 4. Otherwise returns false without recording
   * 
   * @returns true if the request is allowed, false if rate limit is exceeded
   */
  tryAcquire(): boolean {
    const now = Date.now();
    
    // Prune expired timestamps (sliding window cleanup)
    // Keep only timestamps that fall within the current window
    this.timestamps = this.timestamps.filter(
      (timestamp) => now - timestamp < this.windowMs
    );

    // Check if we're under the limit
    if (this.timestamps.length < this.maxPerWindow) {
      this.timestamps.push(now);
      return true;
    }

    return false;
  }

  /**
   * Returns the current count of non-expired requests within the sliding window.
   * 
   * This method prunes expired timestamps before returning the count,
   * ensuring the returned value reflects the current state.
   * 
   * @returns Number of active requests in the current window
   */
  getCurrentCount(): number {
    const now = Date.now();
    
    // Prune expired timestamps before returning count
    this.timestamps = this.timestamps.filter(
      (timestamp) => now - timestamp < this.windowMs
    );

    return this.timestamps.length;
  }

  /**
   * Resets the rate limiter by clearing all recorded timestamps.
   * 
   * After calling reset(), subsequent tryAcquire() calls start from a count of zero.
   */
  reset(): void {
    this.timestamps = [];
  }
}
