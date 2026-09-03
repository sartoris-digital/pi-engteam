import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_V3_POLICY, type V3Policy } from "../../../src/v3/dispatch.js";
import {
  exactDispatchAllowed,
  importToRepo,
  loadImported,
  shareToGlobal,
  sharedArtifactPath,
} from "../../../src/v3/cross-repo.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

function cfg(enabled = false): { v3: V3Policy; codify: { shadowAgreeToActivate: number } } {
  const v3 = structuredClone(DEFAULT_V3_POLICY);
  v3.crossRepoTools.enabled = enabled;
  return { v3, codify: { shadowAgreeToActivate: 2 } };
}

const ARTIFACT = {
  name: "bump-pkg",
  version: 1,
  fromRepo: "acme/source",
  payload: { tool: "print('bump')" },
};

describe("shareToGlobal / importToRepo", () => {
  it("copies an artifact into the shared registry with tmp+rename", async () => {
    await withTmpHome(async (home) => {
      const shared = await shareToGlobal({
        home,
        nameVersion: "bump-pkg@1",
        fromRepo: "acme/source",
        artifact: ARTIFACT,
      });
      const raw = JSON.parse(await readFile(shared.path, "utf8")) as typeof ARTIFACT;
      expect(shared.path).toBe(sharedArtifactPath(home, "bump-pkg@1"));
      expect(raw.name).toBe("bump-pkg");
      expect(raw.fromRepo).toBe("acme/source");
    });
  });

  it("imports as probationary and never active, even when the flag is on", async () => {
    await withTmpHome(async (home) => {
      await shareToGlobal({
        home,
        nameVersion: "bump-pkg@1",
        fromRepo: "acme/source",
        artifact: ARTIFACT,
      });
      const imported = await importToRepo({
        home,
        nameVersion: "bump-pkg@1",
        toRepo: "acme/target",
      });
      expect(imported.entry.state).toBe("probationary");
      expect(imported.entry.state).not.toBe("active");
      const listed = await loadImported(home, "acme/target");
      expect(listed["bump-pkg@1"]?.state).toBe("probationary");
    });
  });

  it("still allows import when the flag is off (write-only shared registry)", async () => {
    await withTmpHome(async (home) => {
      await shareToGlobal({
        home,
        nameVersion: "bump-pkg@1",
        fromRepo: "acme/source",
        artifact: ARTIFACT,
      });
      const imported = await importToRepo({
        home,
        nameVersion: "bump-pkg@1",
        toRepo: "acme/target",
        cfg: cfg(false),
      });
      expect(imported.entry.state).toBe("probationary");
      expect(exactDispatchAllowed(cfg(false), "acme/target", "bump-pkg@1", { shadowAgree: 9 })).toBe(false);
    });
  });
});

describe("exactDispatchAllowed", () => {
  it("is false when the flag is off regardless of shadow agreements", () => {
    expect(exactDispatchAllowed(cfg(false), "acme/target", "bump-pkg@1", { shadowAgree: 9 })).toBe(false);
  });

  it("is false when the flag is on but this repo has not earned shadowAgreeToActivate", () => {
    expect(exactDispatchAllowed(cfg(true), "acme/target", "bump-pkg@1", { shadowAgree: 0 })).toBe(false);
    expect(exactDispatchAllowed(cfg(true), "acme/target", "bump-pkg@1", { shadowAgree: 1 })).toBe(false);
  });

  it("is true only when the flag is on and this repo has its own shadow agreements", () => {
    expect(exactDispatchAllowed(cfg(true), "acme/target", "bump-pkg@1", { shadowAgree: 2 })).toBe(true);
  });
});

describe("shared registry durability", () => {
  it("does not tear JSON when two shares race via tmp+rename", async () => {
    await withTmpHome(async (home) => {
      await Promise.all([
        shareToGlobal({ home, nameVersion: "a@1", fromRepo: "r1", artifact: { ...ARTIFACT, name: "a", version: 1 } }),
        shareToGlobal({ home, nameVersion: "b@1", fromRepo: "r2", artifact: { ...ARTIFACT, name: "b", version: 1 } }),
      ]);
      JSON.parse(await readFile(sharedArtifactPath(home, "a@1"), "utf8"));
      JSON.parse(await readFile(sharedArtifactPath(home, "b@1"), "utf8"));
    });
  });

  it("refuses to import a missing shared artifact", async () => {
    await withTmpHome(async (home) => {
      await expect(importToRepo({ home, nameVersion: "missing@1", toRepo: "acme/target" })).rejects.toThrow(
        /not found/,
      );
    });
  });
});

describe("share writes under factory home Layer A path", () => {
  it("lands under runs/_factory/codify/shared/", async () => {
    await withTmpHome(async (home) => {
      const shared = await shareToGlobal({
        home,
        nameVersion: "bump-pkg@1",
        fromRepo: "acme/source",
        artifact: ARTIFACT,
      });
      expect(shared.path.startsWith(join(home, "runs", "_factory", "codify", "shared"))).toBe(true);
      await mkdir(dirname(shared.path), { recursive: true });
      await writeFile(join(home, "runs", "_factory", "codify", "shared", "probe.txt"), "ok");
    });
  });
});
