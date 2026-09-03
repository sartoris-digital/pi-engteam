import { describe, it, expect } from "vitest";
import { createUlidGenerator, decodeTime, encodeTime, ulid, ULID_PATTERN } from "../../../src/trackers/ulid.js";

describe("trackers/ulid", () => {
  it("produces 26 Crockford base32 characters", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(ULID_PATTERN);
  });

  it("encodes the millisecond timestamp in the first 10 characters", () => {
    expect(encodeTime(0)).toBe("0000000000");
    expect(encodeTime(1)).toBe("0000000001");
    expect(encodeTime(32)).toBe("0000000010");
    const gen = createUlidGenerator(() => 1_756_800_000_000);
    const id = gen();
    expect(id.slice(0, 10)).toBe(encodeTime(1_756_800_000_000));
    expect(decodeTime(id)).toBe(1_756_800_000_000);
  });

  it("rejects out-of-range times and malformed ids", () => {
    expect(() => encodeTime(-1)).toThrow(RangeError);
    expect(() => encodeTime(2 ** 48)).toThrow(RangeError);
    expect(() => decodeTime("not-a-ulid")).toThrow(/malformed/);
  });

  it("is strictly monotonic within one millisecond", () => {
    const gen = createUlidGenerator(() => 1_756_800_000_000);
    const ids = Array.from({ length: 500 }, () => gen());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
      expect(ids[i]!.slice(0, 10)).toBe(ids[0]!.slice(0, 10));
    }
  });

  it("orders later milliseconds after earlier ones", () => {
    let t = 1_756_800_000_000;
    const gen = createUlidGenerator(() => t);
    const a = gen();
    t += 1;
    const b = gen();
    expect(b > a).toBe(true);
    expect(decodeTime(b)).toBe(decodeTime(a) + 1);
  });

  it("does not go backwards when the clock does", () => {
    let t = 1_756_800_000_005;
    const gen = createUlidGenerator(() => t);
    const a = gen();
    t -= 3;
    const b = gen();
    expect(b > a).toBe(true);
    expect(b.slice(0, 10)).toBe(a.slice(0, 10));
  });
});
