import { randomBytes } from "node:crypto";

export const FENCE_MAX_BYTES = 4000;

export function makeNonce(): string {
  return randomBytes(16).toString("hex");
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_-]/g, "") || "DATA";
}

function stripControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x0a || cp === 0x09) {
      out += ch;
      continue;
    }
    if (cp < 0x20 || cp === 0x7f) continue;
    out += ch;
  }
  return out.replace(/<<<UNTRUSTED/g, "<<< UNTRUSTED");
}

function chunkUtf8(text: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return [text];
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += maxBytes) {
    chunks.push(decoder.decode(bytes.slice(offset, offset + maxBytes)));
  }
  return chunks;
}

export function fenceData(text: string, nonce: string, label: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  const safe = stripControls(text);
  const safeLabel = sanitizeLabel(label);
  const chunks = chunkUtf8(safe, FENCE_MAX_BYTES);
  return chunks
    .map((chunk, i) => {
      const chunkTag = chunks.length > 1 ? ` chunk=${i + 1}/${chunks.length}` : "";
      const opener = `<<<UNTRUSTED_${safeLabel}_${nonce}_BEGIN${chunkTag}>>>`;
      const closer = `<<<UNTRUSTED_${safeLabel}_${nonce}_END>>>`;
      return `${opener}\n${chunk}\n${closer}`;
    })
    .join("\n");
}

export function fenceArray(items: string[] | undefined, nonce: string, label: string): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.map((item, i) => fenceData(item, nonce, `${label}-${i + 1}`)).filter(Boolean).join("\n");
}
