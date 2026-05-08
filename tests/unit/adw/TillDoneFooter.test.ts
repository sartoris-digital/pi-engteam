import { describe, it, expect } from "vitest";
import { formatTillDoneFooter, formatTillDoneDetailed } from "../../../src/adw/TillDoneFooter.js";
import type { Task } from "../../../src/team/tools/TaskList.js";

function task(p: Partial<Task>): Task {
  return {
    taskId: p.taskId ?? "t-1",
    status: p.status ?? "pending",
    notes: p.notes,
    owner: p.owner,
    team: p.team,
    updatedAt: p.updatedAt ?? "x",
  };
}

describe("formatTillDoneFooter — Phase 5.6 §9.2 single-line", () => {
  it("returns workflow + goal when no tasks", () => {
    const out = formatTillDoneFooter({
      workflow: "consult",
      goal: "dark mode strategy",
      tasks: [],
    });
    expect(out).toBe("consult · dark mode strategy");
  });

  it("renders done/total + per-team summary in stable order", () => {
    const out = formatTillDoneFooter({
      workflow: "consult",
      goal: "Dark mode rollout",
      tasks: [
        task({ taskId: "p1", status: "completed", team: "planning" }),
        task({ taskId: "e1", status: "completed", team: "engineering" }),
        task({ taskId: "e2", status: "in_progress", team: "engineering" }),
        task({ taskId: "v1", status: "pending", team: "validation" }),
      ],
    });
    expect(out).toContain("[2/4]");
    expect(out).toContain("PLN 1/1");
    expect(out).toContain("ENG 1/2");
    expect(out).toContain("VAL 0/1");
    // Stable order: PLN before ENG before VAL.
    expect(out.indexOf("PLN")).toBeLessThan(out.indexOf("ENG"));
    expect(out.indexOf("ENG")).toBeLessThan(out.indexOf("VAL"));
  });

  it("renders unassigned tasks under '?' bucket as UNA", () => {
    const out = formatTillDoneFooter({
      workflow: "consult",
      goal: "x",
      tasks: [
        task({ taskId: "u1", status: "pending" }),
        task({ taskId: "u2", status: "completed" }),
      ],
    });
    expect(out).toContain("UNA 1/2");
  });

  it("clips long goals", () => {
    const longGoal = "a".repeat(200);
    const out = formatTillDoneFooter({
      workflow: "wf",
      goal: longGoal,
      tasks: [task({})],
    });
    expect(out.length).toBeLessThan(150);
    expect(out).toContain("…");
  });

  it("clips goals at 40 chars in the empty-tasks fallback (round-1 L1)", () => {
    const longGoal = "a".repeat(80);
    const out = formatTillDoneFooter({
      workflow: "wf",
      goal: longGoal,
      tasks: [],
    });
    // 40-char goal cap: "wf · " (5) + clipped goal (≤40) = ~45 chars max.
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toContain("…");
  });

  it("renders all six bucket labels in stable order in one call", () => {
    const out = formatTillDoneFooter({
      workflow: "wf",
      goal: "g",
      tasks: [
        task({ taskId: "p1", status: "pending", team: "planning" }),
        task({ taskId: "e1", status: "pending", team: "engineering" }),
        task({ taskId: "v1", status: "pending", team: "validation" }),
        task({ taskId: "i1", status: "pending", team: "investigation" }),
        task({ taskId: "c1", status: "pending", team: "cross-functional" }),
        task({ taskId: "u1", status: "pending" }),
      ],
    });
    const order = ["PLN", "ENG", "VAL", "INV", "CFN", "UNA"];
    let last = -1;
    for (const label of order) {
      const idx = out.indexOf(label);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("caps the rendered single-line at MAX_STATUS_LINE (round-1 L2)", () => {
    const tasks = Array.from({ length: 200 }, (_, i) => task({ taskId: `t${i}`, status: "pending", team: "engineering" }));
    const out = formatTillDoneFooter({ workflow: "wf", goal: "g", tasks });
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("formatTillDoneDetailed — multi-line variant", () => {
  it("groups tasks by team with status markers", () => {
    const out = formatTillDoneDetailed({
      workflow: "consult",
      goal: "dark mode",
      tasks: [
        task({ taskId: "e1", status: "completed", team: "engineering" }),
        task({ taskId: "e2", status: "in_progress", team: "engineering", notes: "in progress" }),
        task({ taskId: "v1", status: "blocked", team: "validation" }),
      ],
    });
    expect(out).toContain("Tasks: 1/3 complete");
    expect(out).toContain("[engineering]");
    expect(out).toContain("✓ e1");
    expect(out).toContain("● e2");
    expect(out).toContain("[validation]");
    expect(out).toContain("✗ v1");
  });

  it("returns '(no tasks)' when list is empty", () => {
    const out = formatTillDoneDetailed({
      workflow: "wf",
      goal: "g",
      tasks: [],
    });
    expect(out).toContain("(no tasks)");
  });

  it("sanitizes notes/taskId control bytes (round-1 M1)", () => {
    const out = formatTillDoneDetailed({
      workflow: "wf",
      goal: "g",
      tasks: [
        task({
          taskId: "t-1",
          status: "pending",
          team: "engineering",
          // Newlines + ANSI escape would otherwise corrupt /run-status output.
          notes: "line1\nline2\x1b[31mEVIL\x1b[0m\rmid",
        }),
      ],
    });
    // Newlines in notes must NOT add new lines to the rendered output
    // (apart from the existing per-task formatting). The sanitized
    // notes should be on a single output line.
    const evilLine = out.split("\n").find((l) => l.includes("EVIL"));
    expect(evilLine).toBeDefined();
    expect(evilLine).not.toContain("\x1b");
    expect(evilLine).not.toContain("\r");
  });

  it("renders pending tasks with ○ marker", () => {
    const out = formatTillDoneDetailed({
      workflow: "wf",
      goal: "g",
      tasks: [task({ taskId: "p1", status: "pending", team: "planning" })],
    });
    expect(out).toContain("○ p1");
  });
});
