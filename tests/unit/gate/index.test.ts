import { describe, it, expect } from "vitest";
import * as gate from "../../../src/gate/index.js";

describe("gate module surface", () => {
  it("exports the public functions and constants", () => {
    const fns = [
      "globToRegExp", "matchGlob", "matchesAny", "normalizeRelPath",
      "parseJunit", "junitCaseId", "findCase",
      "runChecks",
      "verifyRedBaseline",
      "snapshotTree", "diffSnapshots", "diffOutsideRoots", "listWorkingTree", "sha256File",
      "recordManifest", "verifyManifestUnchanged", "countSkipMarkers",
      "generatedMarkerLine", "findGeneratedDocs",
      "finalize", "changedFilesSince", "diffLineCount",
    ] as const;
    for (const name of fns) {
      expect(typeof gate[name], name).toBe("function");
    }
    expect(gate.OUTPUT_TAIL_BYTES).toBe(4096);
    expect(gate.GENERATED_MARKER).toBe("<!-- pi-sdlc-factory generated · run");
    expect(gate.GENERATED_DOC_PATTERNS.length).toBe(15);
    expect(Array.isArray(gate.SKIP_MARKER_PATTERNS)).toBe(true);
  });

  it("does not leak internal helpers", () => {
    const surface = gate as Record<string, unknown>;
    expect(surface["decodeXml"]).toBeUndefined();
    expect(surface["tailOf"]).toBeUndefined();
    expect(surface["firstLineHasMarker"]).toBeUndefined();
  });
});
