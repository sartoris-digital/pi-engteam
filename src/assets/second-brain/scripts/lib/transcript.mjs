import { access, constants, readFile } from "node:fs/promises";

/**
 * @param {unknown} content
 * @returns {string}
 */
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (part) =>
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join(" ");
}

/**
 * @param {unknown} value
 * @returns {{ role: "user" | "assistant", content: string } | null}
 */
function extractTurn(value) {
  if (!value || typeof value !== "object") return null;

  if ("role" in value && (value.role === "user" || value.role === "assistant")) {
    const content = normalizeContent(value.content);
    return content.trim() ? { role: value.role, content } : null;
  }

  if ("type" in value && value.type === "message" && "message" in value) {
    const message = value.message;
    if (!message || typeof message !== "object") return null;
    if (!("role" in message) || (message.role !== "user" && message.role !== "assistant")) return null;
    const content = normalizeContent(message.content);
    return content.trim() ? { role: message.role, content } : null;
  }

  return null;
}

/**
 * @param {string | undefined} transcriptPath
 * @param {number} n
 * @returns {Promise<string>}
 */
export async function readLastNTurns(transcriptPath, n) {
  if (!transcriptPath) return "(no transcript available)";

  try {
    await access(transcriptPath, constants.F_OK);
  } catch {
    return "(no transcript available)";
  }

  const raw = await readFile(transcriptPath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  const turns = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const turn = extractTurn(parsed);
      if (!turn) continue;
      const truncated = turn.content.length > 500;
      turns.push(`[${turn.role}]: ${turn.content.slice(0, 500)}${truncated ? " … [truncated]" : ""}`);
    } catch {
      // Skip malformed JSONL lines.
    }
  }

  return turns.slice(-n).join("\n\n") || "(no conversation turns found)";
}
