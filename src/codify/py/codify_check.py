#!/usr/bin/env python3
"""Pre-parse the PEP 723 header, then run the host AST lint."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from codify_lint import lint_path

HEADER_START = "# /// script"
HEADER_END = "# ///"
DEP_RE = re.compile(r"^dependencies\s*=\s*\[(.*?)\]", re.S)


def extract_header(text: str) -> str | None:
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip() == HEADER_START:
            start = i
            break
    if start is None:
        return None
    block: list[str] = []
    for line in lines[start + 1 :]:
        if line.strip() == HEADER_END:
            return "\n".join(block)
        if not line.startswith("#"):
            return None
        payload = line[1:]
        if payload.startswith(" "):
            payload = payload[1:]
        block.append(payload)
    return None


def parse_deps(header: str) -> list[str]:
    match = DEP_RE.search(header)
    if match is None:
        return []
    inner = match.group(1).strip()
    if inner == "":
        return []
    deps: list[str] = []
    for part in inner.split(","):
        token = part.strip().strip(",").strip()
        if token.startswith('"') and token.endswith('"'):
            deps.append(token[1:-1])
        elif token.startswith("'") and token.endswith("'"):
            deps.append(token[1:-1])
        elif token:
            deps.append(token)
    return deps


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="codify_check.py")
    parser.add_argument("tool")
    parser.add_argument("--allow-dep", action="append", default=[], dest="allow_deps")
    args = parser.parse_args(argv[1:])
    text = Path(args.tool).read_text(encoding="utf-8")
    header = extract_header(text)
    if header is None:
        sys.stdout.write(f"{args.tool}: missing PEP 723 script header\n")
        return 1
    allow = list(args.allow_deps)
    extra = [d for d in parse_deps(header) if d not in allow]
    if extra:
        sys.stdout.write(f"{args.tool}: dependencies not on allowlist: {', '.join(extra)}\n")
        return 1
    findings = lint_path(args.tool)
    for line in findings:
        sys.stdout.write(line + "\n")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
