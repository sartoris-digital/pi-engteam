import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { stat, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

type CheckResult = { name: string; ok: boolean; message: string };

async function checkExists(path: string, label: string): Promise<CheckResult> {
  try {
    await stat(path);
    return { name: label, ok: true, message: `Found: ${path}` };
  } catch {
    return { name: label, ok: false, message: `Missing: ${path}` };
  }
}

export function registerDoctorCommand(pi: ExtensionAPI): void {
  pi.registerCommand("engteam-doctor", {
    description: "Check pi-engteam installation health",
    handler: async (_args: string, _ctx) => {
      const home = homedir();
      const checks: CheckResult[] = [];

      checks.push(
        await checkExists(
          join(home, ".pi", "agent", "extensions", "pi-engteam.js"),
          "Extension file",
        ),
      );
      checks.push(
        await checkExists(
          join(home, ".pi", "engteam", "runs"),
          "Runs directory",
        ),
      );

      const agentNames = [
        "planner",
        "implementer",
        "reviewer",
        "architect",
        "codebase-cartographer",
        "tester",
        "security-auditor",
        "performance-analyst",
        "bug-triage",
        "incident-investigator",
        "root-cause-debugger",
        "judge",
        "knowledge-retriever",
        "observability-archivist",
      ];

      for (const name of agentNames) {
        checks.push(
          await checkExists(
            join(home, ".pi", "agent", "agents", `engteam-${name}.md`),
            `Agent: ${name}`,
          ),
        );
      }

      const safetyPath = join(home, ".pi", "engteam", "safety.json");
      try {
        const raw = await readFile(safetyPath, "utf8");
        JSON.parse(raw);
        checks.push({ name: "safety.json", ok: true, message: "Valid JSON" });
      } catch {
        checks.push({
          name: "safety.json",
          ok: false,
          message: "Missing or invalid (using defaults)",
        });
      }

      const passed = checks.filter(c => c.ok).length;
      const failed = checks.filter(c => !c.ok).length;

      const lines = [
        `pi-engteam doctor — ${passed} passed, ${failed} issues`,
        "",
        ...checks.map(c => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.message}`),
        "",
        failed > 0
          ? "Run 'pnpm install:extension' to fix missing files."
          : "All checks passed.",
      ];

      return { message: lines.join("\n") };
    },
  });
}
