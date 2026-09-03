import { describe, expect, it } from "vitest";
import {
  GROUP_PLACEHOLDER,
  SUBST_PLACEHOLDER,
  isWriteRedirect,
  splitSegments,
  stripAssignments,
  tokenize,
  unquote,
  unsupportedShellConstruct,
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

  it("parses redirects attached to the preceding word without whitespace", () => {
    expect(tokenize("echo pwned>/tmp/out")).toEqual({
      words: ["echo", "pwned"],
      redirects: [{ op: ">", target: "/tmp/out" }],
    });
    expect(tokenize("echo pwned>>/tmp/out").redirects).toEqual([{ op: ">>", target: "/tmp/out" }]);
    expect(tokenize("echo x>src/a.ts").redirects).toEqual([{ op: ">", target: "src/a.ts" }]);
    expect(tokenize("cmd 2>/dev/null").redirects).toEqual([{ op: "2>", target: "/dev/null" }]);
    expect(tokenize('echo x>"/tmp/out"').redirects).toEqual([{ op: ">", target: "/tmp/out" }]);
    expect(unquote('"--force"')).toBe("--force");
  });
});

describe("unsupportedShellConstruct", () => {
  it("fails closed on unquoted newlines, background &, substitutions, and process substitution", () => {
    expect(unsupportedShellConstruct("echo ok & rm -rf src")).toMatch(/background/i);
    expect(unsupportedShellConstruct("echo ok\ngit push origin HEAD")).toMatch(/newline/i);
    expect(unsupportedShellConstruct("echo $(gh pr create --fill)")).toMatch(/command substitution/i);
    expect(unsupportedShellConstruct("echo `env`")).toMatch(/backtick/i);
    expect(unsupportedShellConstruct("cat <(echo x)")).toMatch(/process substitution/i);
    expect(unsupportedShellConstruct("tee >(cat)")).toMatch(/process substitution/i);
    expect(unsupportedShellConstruct("ls -la")).toBeNull();
    expect(unsupportedShellConstruct("echo 'ok & rm'")).toBeNull();
    expect(unsupportedShellConstruct("echo hi > /dev/null")).toBeNull();
    expect(unsupportedShellConstruct("git status && cat src/a.ts")).toBeNull();
    expect(unsupportedShellConstruct("cmd 2>&1")).toBeNull();
    expect(unsupportedShellConstruct("cmd &> /dev/null")).toBeNull();
  });
});
