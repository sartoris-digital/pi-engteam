import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { stat, readFile, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { loadTeamsConfig } from "../safety/teams-config.js";
import { DEFAULT_DOMAINS } from "../safety/default-domains.js";

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
  pi.registerCommand("engineering-doctor", {
    description: "Check pi-engineering installation health",
    handler: async (_args: string, ctx) => {
      const home = homedir();
      const checks: CheckResult[] = [];

      checks.push(
        await checkExists(
          join(home, ".pi", "agent", "extensions", "pi-engineering.js"),
          "Extension file",
        ),
      );
      checks.push(
        await checkExists(
          join(home, ".pi", "engineering-team", "runs"),
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
            join(home, ".pi", "agent", "agents", `engineering-${name}.md`),
            `Agent: ${name}`,
          ),
        );
      }

      const safetyPath = join(home, ".pi", "engineering-team", "safety.json");
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

      // --- Wave 2 checks ---

      // Lead agent .md files
      const leadNames = ["orchestrator", "planning-lead", "engineering-lead", "validation-lead", "investigation-lead"];
      const agentsDir = join(process.cwd(), "agents");
      for (const name of leadNames) {
        checks.push(await checkExists(join(agentsDir, `${name}.md`), `Lead agent file: ${name}`));
      }

      // team: field present in every agents/*.md file
      try {
        const mdFiles = (await readdir(agentsDir)).filter(f => f.endsWith(".md"));
        let missingTeam: string[] = [];
        for (const f of mdFiles) {
          const content = await readFile(join(agentsDir, f), "utf8");
          if (!content.includes("team:")) missingTeam.push(f);
        }
        checks.push({
          name: "team: field in all agent .md files",
          ok: missingTeam.length === 0,
          message: missingTeam.length === 0
            ? `All ${mdFiles.length} agent files have team:`
            : `Missing team: in ${missingTeam.join(", ")}`,
        });
      } catch {
        checks.push({ name: "team: field in all agent .md files", ok: false, message: "Could not read agents/ directory" });
      }

      // loadTeamsConfig runs without error
      const ENGINEERING_DIR = join(home, ".pi", "engineering-team");
      const RUNS_DIR = join(ENGINEERING_DIR, "runs");
      let teamsCfg: Awaited<ReturnType<typeof loadTeamsConfig>> | undefined;
      try {
        teamsCfg = await loadTeamsConfig({
          userPath: join(ENGINEERING_DIR, "teams.yaml"),
          projectPath: join(process.cwd(), ".pi", "engineering-team", "teams.local.yaml"),
          runDir: RUNS_DIR,
          expertiseDir: join(ENGINEERING_DIR, "expertise"),
        });
        checks.push({ name: "loadTeamsConfig", ok: true, message: `Loaded; mode=${teamsCfg.mode}` });
      } catch (err) {
        checks.push({ name: "loadTeamsConfig", ok: false, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
      }

      // Default DomainLock policy resolves for every agent in DEFAULT_DOMAINS
      const allAgentNames = Object.keys(DEFAULT_DOMAINS);
      const missing = allAgentNames.filter(n => !(teamsCfg?.domains[n]));
      checks.push({
        name: "Domain policy coverage",
        ok: missing.length === 0,
        message: missing.length === 0
          ? `All ${allAgentNames.length} agents have a domain policy`
          : `No policy for: ${missing.join(", ")}`,
      });

      const passed = checks.filter(c => c.ok).length;
      const failed = checks.filter(c => !c.ok).length;

      const output = [
        `pi-engineering doctor — ${passed} passed, ${failed} issues`,
        "",
        ...checks.map(c => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.message}`),
        "",
        failed > 0
          ? "Run 'pnpm install:extension' to fix missing files."
          : "All checks passed.",
      ].join("\n");

      ctx.ui.notify(output, "info");
    },
  });
}
