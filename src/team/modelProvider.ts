// Maps an LLM model identifier to the canonical provider key used by RateLimitGuard.
// Keys MUST match what users put in ~/.pi/engineering-team/rate-limits.json.
// Hand-rolled mapping; no third-party deps.

export function modelToProvider(model: string): string {
  if (!model) return "unknown";
  const m = model.toLowerCase();

  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("o3-")) return "openai";
  if (m.startsWith("gemini-")) return "google";
  if (m.startsWith("mistral-") || m.startsWith("mixtral-")) return "mistral";

  return "unknown";
}
