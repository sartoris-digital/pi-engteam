import type { SecretResolver } from "./SecretResolver.js";
import { defaultSpawn } from "./spawn.js";

type SpawnFn = (opts: { cmd: string; env: Record<string, string>; cwd?: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

interface UseSecretInput {
  name: string;
  target: "bash";
  command: string;
}

function validateInput(raw: unknown): { ok: true; value: UseSecretInput } | { ok: false; error: string; hint: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "Input must be an object", hint: "Provide { name, target, command }" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["name"] !== "string" || obj["name"].trim() === "") {
    return { ok: false, error: "Missing or empty field: name", hint: "Provide the secret name as a non-empty string" };
  }
  if (typeof obj["command"] !== "string" || obj["command"].trim() === "") {
    return { ok: false, error: "Missing or empty field: command", hint: "Provide the shell command as a non-empty string" };
  }
  if (obj["target"] !== "bash") {
    return { ok: false, error: `Unsupported target: ${String(obj["target"])}`, hint: "Only target 'bash' is supported in v1" };
  }
  return { ok: true, value: { name: obj["name"] as string, target: "bash", command: obj["command"] as string } };
}

export function createUseSecretTool(opts: {
  resolver: SecretResolver;
  spawnSubprocess?: SpawnFn;
}): { name: "UseSecret"; description: string; inputSchema: object; execute: (input: unknown) => Promise<unknown> } {
  const spawnFn: SpawnFn = opts.spawnSubprocess ?? defaultSpawn;
  const agentName = process.env["PI_ENGINEERING_AGENT_NAME"] ?? "unknown";

  return {
    name: "UseSecret",
    description: "Run a shell command with a named secret injected as $SECRET in the subprocess environment. The secret value is never visible in agent context.",
    inputSchema: {
      type: "object",
      required: ["name", "target", "command"],
      properties: {
        name: { type: "string", description: "Name of the secret to inject" },
        target: { type: "string", enum: ["bash"], description: "Execution target (only 'bash' supported in v1)" },
        command: { type: "string", description: "Shell command to run; use $SECRET to reference the injected value" },
      },
      additionalProperties: false,
    },
    async execute(input: unknown) {
      const validation = validateInput(input);
      if (!validation.ok) {
        return { error: validation.error, hint: validation.hint };
      }
      const { name, command } = validation.value;

      let secretValue: string;
      try {
        secretValue = opts.resolver.resolve(name, { agent: agentName, target: "bash" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: msg, hint: `Ensure the secret '${name}' has been stored in the vault` };
      }

      const result = await spawnFn({
        cmd: command,
        env: { SECRET: secretValue },
      });

      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  };
}
