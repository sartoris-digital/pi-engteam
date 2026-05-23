import { describe, it, expect, beforeEach, vi } from "vitest";
import { RateLimiter, RateLimiterOptions } from "../../../src/observability/rate-limiter.js";

describe("RateLimiter", () => {
  describe("constructor validation", () => {
    it("should throw on maxPerWindow <= 0", () => {
      expect(() => new RateLimiter({ maxPerWindow: 0, windowMs: 1000 })).toThrow(
        "maxPerWindow must be > 0"
      );
      expect(() => new RateLimiter({ maxPerWindow: -1, windowMs: 1000 })).toThrow(
        "maxPerWindow must be > 0"
      );
    });

    it("should throw on windowMs <= 0", () => {
      expect(() => new RateLimiter({ maxPerWindow: 10, windowMs: 0 })).toThrow(
        "windowMs must be > 0"
      );
      expect(() => new RateLimiter({ maxPerWindow: 10, windowMs: -1 })).toThrow(
        "windowMs must be > 0"
      );
    });

    it("should accept valid options", () => {
      expect(() => new RateLimiter({ maxPerWindow: 10, windowMs: 1000 })).not.toThrow();
    });
  });

  describe("tryAcquire - basic flow", () => {
    it("should return true when under limit", () => {
      const limiter = new RateLimiter({ maxPerWindow: 3, windowMs: 1000 });
      
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
    });

    it("should return false when limit reached", () => {
      const limiter = new RateLimiter({ maxPerWindow: 3, windowMs: 1000 });
      
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });

    it("should not increment count when limit exceeded", () => {
      const limiter = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
      
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.getCurrentCount()).toBe(2);
      
      // This should fail and not increment
      expect(limiter.tryAcquire()).toBe(false);
      expect(limiter.getCurrentCount()).toBe(2);
    });
  });

  describe("tryAcquire - window behavior", () => {
    it("should allow new acquisitions after window expires", async () => {
      const limiter = new RateLimiter({ maxPerWindow: 2, windowMs: 100 });
      
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
      
      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 110));
      
      expect(limiter.tryAcquire()).toBe(true);
    });

    it("should handle window boundary behavior correctly", () => {
      const limiter = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
      
      const mockNow = vi.spyOn(Date, 'now');
      
      // First acquisition at t=0
      mockNow.mockReturnValue(0);
      expect(limiter.tryAcquire()).toBe(true);
      
      // Second acquisition at t=500
      mockNow.mockReturnValue(500);
      expect(limiter.tryAcquire()).toBe(true);
      
      // Should reject at t=900 (both still in window)
      mockNow.mockReturnValue(900);
      expect(limiter.tryAcquire()).toBe(false);
      
      // At exactly t=1000, first timestamp should be pruned (1000 - 0 = 1000, not < 1000)
      mockNow.mockReturnValue(1000);
      expect(limiter.tryAcquire()).toBe(true);
      
      mockNow.mockRestore();
    });
  });

  describe("getCurrentCount", () => {
    it("should return 0 initially", () => {
      const limiter = new RateLimiter({ maxPerWindow: 10, windowMs: 1000 });
      expect(limiter.getCurrentCount()).toBe(0);
    });

    it("should accurately reflect active window size", () => {
      const limiter = new RateLimiter({ maxPerWindow: 10, windowMs: 1000 });
      
      expect(limiter.getCurrentCount()).toBe(0);
      limiter.tryAcquire();
      expect(limiter.getCurrentCount()).toBe(1);
      limiter.tryAcquire();
      expect(limiter.getCurrentCount()).toBe(2);
      limiter.tryAcquire();
      expect(limiter.getCurrentCount()).toBe(3);
    });

    it("should prune expired timestamps before returning count", async () => {
      const limiter = new RateLimiter({ maxPerWindow: 5, windowMs: 100 });
      
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.getCurrentCount()).toBe(2);
      
      await new Promise(resolve => setTimeout(resolve, 110));
      
      expect(limiter.getCurrentCount()).toBe(0);
    });
  });

  describe("reset", () => {
    it("should clear all acquisitions", () => {
      const limiter = new RateLimiter({ maxPerWindow: 3, windowMs: 1000 });
      
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.getCurrentCount()).toBe(3);
      
      limiter.reset();
      expect(limiter.getCurrentCount()).toBe(0);
    });

    it("should allow immediate reuse after reset", () => {
      const limiter = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
      
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.tryAcquire()).toBe(false);
      
      limiter.reset();
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should work with maxPerWindow = 1", () => {
      const limiter = new RateLimiter({ maxPerWindow: 1, windowMs: 1000 });
      
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
      expect(limiter.getCurrentCount()).toBe(1);
    });

    it("should handle concurrent calls within same millisecond", () => {
      const limiter = new RateLimiter({ maxPerWindow: 5, windowMs: 1000 });
      
      // Mock Date.now() to return the same timestamp
      const mockNow = vi.spyOn(Date, 'now');
      const fixedTime = 1000000;
      mockNow.mockReturnValue(fixedTime);
      
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.getCurrentCount()).toBe(3);
      
      mockNow.mockRestore();
    });

    it("should handle large maxPerWindow (stress test)", () => {
      const limiter = new RateLimiter({ maxPerWindow: 1000, windowMs: 60000 });
      
      // Acquire 1000 times
      for (let i = 0; i < 1000; i++) {
        expect(limiter.tryAcquire()).toBe(true);
      }
      
      // 1001st should fail
      expect(limiter.tryAcquire()).toBe(false);
      expect(limiter.getCurrentCount()).toBe(1000);
    });

    it("should work with very short windowMs", async () => {
      const limiter = new RateLimiter({ maxPerWindow: 2, windowMs: 1 });
      
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
      
      // Wait 2ms to ensure window has expired
      await new Promise(resolve => setTimeout(resolve, 2));
      
      expect(limiter.tryAcquire()).toBe(true);
    });
  });
});
