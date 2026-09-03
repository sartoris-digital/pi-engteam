#!/usr/bin/env node
// tests/helpers/stub-cli-runtime.mjs — fixture-backed az/jira stub (no network).
//
// Reads PI_SDLC_STUB_DIR/<cli>/<key>.json. Missing fixture → exit 2.
// Every invocation appends { cli, argv, at } to PI_SDLC_STUB_DIR/_log.jsonl.
// PI_SDLC_STUB_SCENARIO=fail-auth makes `az account show` / `jira me` exit 1.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VALUE_FLAGS = new Set([
  "--id",
  "-i",
  "--expand",
  "-o",
  "--output",
  "--org",
  "--organization",
  "--project",
  "-p",
  "--wiql",
  "--fields",
  "--method",
  "--uri",
  "--source-branch",
  "--target-branch",
  "--title",
  "--description",
  "--work-items",
  "--add-label",
  "--remove-label",
  "--assigned-to",
  "--state",
  "-q",
  "--query",
  "--body-file",
  "--template",
  "--detect",
  "--subject",
  "--token",
  "--namespace",
  "--body",
  "-b",
]);

function sanitize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function localPart(value) {
  return sanitize(String(value).split("@")[0] ?? value);
}

function querySlug(q) {
  const key = /\bkey\s*=\s*([A-Z][A-Z0-9]+-\d+)/i.exec(q);
  if (key?.[1]) return `key-${key[1].toLowerCase()}`;
  if (/labels\s*=/i.test(q)) return "labels";
  return "";
}

function uriSlug(uri) {
  const comments = /workItems\/(\d+)\/comments(?:\/(\d+))?/i.exec(uri);
  if (comments) {
    return comments[2] ? `comments-${comments[1]}-${comments[2]}` : `comments-${comments[1]}`;
  }
  const updates = /workItems\/(\d+)\/updates/i.exec(uri);
  if (updates?.[1]) return `updates-${updates[1]}`;
  const members = /members\/([^/?]+)/i.exec(uri);
  if (members?.[1]) return `role-${localPart(decodeURIComponent(members[1]))}`;
  const subject = /[?&](?:subject|accountId|accountid|query|user)=([^&]+)/i.exec(uri);
  if (/permission|graph|membership|mypermissions/i.test(uri)) {
    return subject?.[1] ? `role-${localPart(decodeURIComponent(subject[1]))}` : "role";
  }
  if (subject?.[1] && /role|permission|member/i.test(uri)) {
    return `role-${localPart(decodeURIComponent(subject[1]))}`;
  }
  return "rest";
}

export function stubFixtureKey(argv) {
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "--id" || a === "-i") {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("-")) {
        parts.push(sanitize(v));
        i += 1;
      }
      continue;
    }
    if (a === "--method") {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("-")) {
        parts.push(sanitize(v));
        i += 1;
      }
      continue;
    }
    if (a === "-q") {
      const v = argv[i + 1] ?? "";
      i += 1;
      const q = querySlug(v);
      if (q) parts.push(q);
      continue;
    }
    if (a === "--wiql") {
      i += 1;
      continue;
    }
    if (a === "--uri") {
      const v = argv[i + 1] ?? "";
      i += 1;
      const u = uriSlug(v);
      if (u) parts.push(u);
      continue;
    }
    if (a === "--fields") {
      const v = argv[i + 1] ?? "";
      i += 1;
      if (/System\.Tags/i.test(v)) parts.push("tags");
      else if (/System\.State/i.test(v)) parts.push("state");
      continue;
    }
    if (a === "--add-label" || a === "--remove-label") {
      parts.push(a.slice(2));
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("-")) i += 1;
      continue;
    }
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) i += 1;
      continue;
    }
    if (/^https?:\/\//i.test(a)) continue;
    parts.push(sanitize(a));
  }
  return parts.filter(Boolean).join("-") || "unknown";
}

function detectCommand(cli, argv) {
  if (cli === "az" && argv[0] === "account" && argv[1] === "show") return true;
  if (cli === "jira" && argv[0] === "me") return true;
  return false;
}

export function runStub(cli, argv = process.argv.slice(2)) {
  const stubDir = process.env.PI_SDLC_STUB_DIR;
  if (!stubDir) {
    process.stderr.write("stub: PI_SDLC_STUB_DIR is not set\n");
    process.exit(4);
  }
  const at = new Date().toISOString();
  appendFileSync(join(stubDir, "_log.jsonl"), `${JSON.stringify({ cli, argv, at })}\n`);

  if (process.env.PI_SDLC_STUB_SCENARIO === "fail-auth" && detectCommand(cli, argv)) {
    process.stderr.write(`stub: ${cli} auth failed (fail-auth)\n`);
    process.exit(1);
  }

  const key = stubFixtureKey(argv);
  const file = join(stubDir, cli, `${key}.json`);
  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    process.stderr.write(`stub: no fixture for ${cli} ${argv.join(" ")} (${key})\n`);
    process.exit(2);
  }
  process.stdout.write(body);
  process.exit(0);
}
