import { describe, expect, it } from "vitest";
import {
  GROUP_PLACEHOLDER,
  SUBST_PLACEHOLDER,
  isWriteRedirect,
  splitSegments,
  stripAssignments,
  tokenize,
} from "../../../src/safety/shell.js";

describe("splitSegments", () => {
  it("splits on ; && || | but not inside quotes or >|", () => {
    expect(splitSegments("git status; echo x > lib/a.ts")).toEqual(["git status", "echo x > lib/a.ts"]);
    expect(splitSegments("git status && cat src/a.ts")).toEqual(["git status", "cat src/a.ts"]);
    expect(splitSegments("ls | tee src/out.txt")).toEqual(["ls", "tee src/out.txt"]);
    expect(splitSegments('echo "a|b" && true')).toEqual(['echo "a|b"', "true"]);
    expect(splitSegments("echo x >| out")).toEqual(["echo x >| out"]);
  });
});

describe("tokenize / redirects", () => {
  it("extracts write redirects and strips assignments", () => {
    expect(tokenize("echo x > src/a.ts").redirects).toEqual([{ op: ">", target: "src/a.ts" }]);
    expect(tokenize("cat a >> src/log.txt").redirects[0]).toEqual({ op: ">>", target: "src/log.txt" });
    expect(isWriteRedirect(">")).toBe(true);
    expect(isWriteRedirect("2>>")).toBe(true);
    expect(isWriteRedirect("<")).toBe(false);
    expect(stripAssignments(["FOO=bar", "git", "status"])).toEqual(["git", "status"]);
    expect(tokenize("echo $(pwd)").words).toContain(SUBST_PLACEHOLDER);
    expect(tokenize("echo (ls)").words).toContain(GROUP_PLACEHOLDER);
  });
});
