import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { SecretResolver } from "./SecretResolver.js";
import { defaultSpawn } from "./spawn.js";

type SpawnFn = (opts: { cmd: string; env: Record<string, string>; cwd?: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

function scrub(text: string, secret: string, name: string): string {
  if (!secret) return text;
  return text.split(secret).join(`[REDACTED:${name}]`);
}

export function createUseSecretTool(opts: {
  resolver: SecretResolver;
  spawnSubprocess?: SpawnFn;
}) {
  const spawnFn: SpawnFn = opts.spawnSubprocess ?? defaultSpawn;
  const agentName = process.env["PI_ENGINEERING_AGENT_NAME"] ?? "unknown";

  return defineTool({
    name: "UseSecret",
    label: "Use Secret",
    description: "Run a shell command with a named secret injected as $SECRET in the subprocess environment. The secret value is never visible in agent context.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the secret to inject" }),
      target: Type.Literal("bash", { description: "Execution target (only 'bash' supported in v1)" }),
      command: Type.String({ description: "Shell command to run; use $SECRET to reference the injected value" }),
    }),
    // Pi marks tool failures only when execute throws — returning a value with isError
    // does NOT mark failure. See @mariozechner/pi-coding-agent docs/extensions.md.
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const { name, command } = params;
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("UseSecret: missing or empty field 'name'. Provide the secret name as a non-empty string.");
      }
      if (typeof command !== "string" || command.trim() === "") {
        throw new Error("UseSecret: missing or empty field 'command'. Provide the shell command as a non-empty string.");
      }

      let secretValue: string;
      try {
        secretValue = opts.resolver.resolve(name, { agent: agentName, target: "bash" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`UseSecret: ${msg}. Ensure the secret '${name}' has been stored via /secret-set.`);
      }

      const result = await spawnFn({
        cmd: command,
        env: { SECRET: secretValue },
      });

      // scrub plaintext from subprocess output before returning to agent
      const stdout = scrub(result.stdout, secretValue, name);
      const stderr = scrub(result.stderr, secretValue, name);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ stdout, stderr, exitCode: result.exitCode }) }],
        details: {},
      };
    },
  });
}
