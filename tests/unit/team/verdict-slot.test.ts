import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, statSync, writeFileSync, existsSync, symlinkSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSlot, disposeSlot, isOwnSlot, readSlot, sealSlot, slotPath } from "../../../src/team/verdict-slot.js";

describe("verdict-slot", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "verdict-slot-"));
  });

  it("slotPath composes a path under <runDir>/_verdicts/", () => {
    const p = slotPath(runDir, "bug-triage", "classify", "tok123");
    expect(p).toBe(join(runDir, "_verdicts", "bug-triage-classify-tok123.json"));
  });

  it("createSlot pre-creates the file with mode 0o600 and returns a canonical descriptor", () => {
    const slot = createSlot(runDir, "bug-triage", "classify", "tok123");
    expect(existsSync(slot.canonicalPath)).toBe(true);
    const st = statSync(slot.canonicalPath);
    expect(st.isFile()).toBe(true);
    // Mode masking — check the user bits.
    expect((st.mode & 0o777)).toBe(0o600);
    expect(slot.inode).toBe(st.ino);
    expect(slot.agent).toBe("bug-triage");
    expect(slot.step).toBe("classify");
    expect(slot.token).toBe("tok123");
  });

  it("createSlot refuses to overwrite an existing file (O_EXCL)", () => {
    const path = slotPath(runDir, "agent", "step", "tok");
    // Pre-create
    createSlot(runDir, "agent", "step", "tok");
    // Second create should throw EEXIST
    expect(() => createSlot(runDir, "agent", "step", "tok")).toThrow();
  });

  it("createSlot pre-fills with `{}` so the model's `edit` tool can operate", () => {
    const slot = createSlot(runDir, "agent", "step", "tok-edit");
    const content = readFileSync(slot.canonicalPath, "utf8");
    expect(content).toBe("{}\n");
  });

  it("readSlot returns the file content when inode matches", () => {
    const slot = createSlot(runDir, "agent", "step", "tok-r");
    writeFileSync(slot.canonicalPath, '{"step":"step","verdict":"PASS"}\n');
    const content = readSlot(slot);
    expect(JSON.parse(content).verdict).toBe("PASS");
  });

  it("readSlot throws when the file inode changes (delete + recreate)", () => {
    const slot = createSlot(runDir, "agent", "step", "tok-swap");
    // Remove + recreate to get a new inode.
    unlinkSync(slot.canonicalPath);
    writeFileSync(slot.canonicalPath, '{"step":"step","verdict":"FORGED"}');
    expect(() => readSlot(slot)).toThrow(/inode mismatch/);
  });

  it("sealSlot makes the file read-only", () => {
    const slot = createSlot(runDir, "agent", "step", "tok-seal");
    sealSlot(slot);
    const st = statSync(slot.canonicalPath);
    expect((st.mode & 0o777)).toBe(0o400);
  });

  it("disposeSlot removes the file when inode still matches", () => {
    const slot = createSlot(runDir, "agent", "step", "tok-dispose");
    disposeSlot(slot);
    expect(existsSync(slot.canonicalPath)).toBe(false);
  });

  it("disposeSlot is a no-op when the inode has changed", () => {
    const slot = createSlot(runDir, "agent", "step", "tok-d2");
    unlinkSync(slot.canonicalPath);
    writeFileSync(slot.canonicalPath, "outsider", { mode: 0o600 });
    disposeSlot(slot);
    // The outsider file remains because the inode mismatched.
    expect(existsSync(slot.canonicalPath)).toBe(true);
  });

  it("isOwnSlot returns true for the canonical path and false for sibling slots", () => {
    const slot = createSlot(runDir, "agent", "step", "tok-own");
    const sibling = createSlot(runDir, "agent", "step", "tok-sibling");
    expect(isOwnSlot(slot.canonicalPath, slot)).toBe(true);
    expect(isOwnSlot(sibling.canonicalPath, slot)).toBe(false);
  });
});
