#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""verify_generic.py — read-only fallback verifier.

File-existence assertions and grep-pattern assertions. No mutation.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path


def emit(ok: bool, details: str, checks: list) -> None:
    print(json.dumps({"ok": ok, "details": details, "checks": checks}))
    sys.exit(0 if ok else 1)


def check_exists(path: str) -> dict:
    p = Path(os.path.expanduser(path))
    return {"check": "exists", "path": str(p), "ok": p.exists()}


def check_grep(pattern: str, path: str) -> dict:
    p = Path(os.path.expanduser(path))
    if not p.exists():
        return {"check": "grep", "pattern": pattern, "path": str(p), "ok": False, "reason": "file missing"}
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return {"check": "grep", "pattern": pattern, "path": str(p), "ok": False, "reason": f"read error: {exc}"}
    try:
        matched = re.search(pattern, text) is not None
    except re.error as exc:
        return {"check": "grep", "pattern": pattern, "path": str(p), "ok": False, "reason": f"bad regex: {exc}"}
    return {"check": "grep", "pattern": pattern, "path": str(p), "ok": matched}


def main() -> None:
    ap = argparse.ArgumentParser(description="Generic read-only verifier")
    ap.add_argument("--exists", action="append", default=[], help="Assert path exists")
    ap.add_argument(
        "--grep",
        action="append",
        nargs=2,
        metavar=("PATTERN", "FILE"),
        default=[],
        help="Assert PATTERN matches in FILE (regex)",
    )
    args = ap.parse_args()

    checks: list[dict] = []
    for p in args.exists:
        checks.append(check_exists(p))
    for pattern, file_path in args.grep:
        checks.append(check_grep(pattern, file_path))

    ok = all(c.get("ok") for c in checks) if checks else False
    details = "all checks passed" if ok else "one or more checks failed"
    emit(ok, details, checks)


if __name__ == "__main__":
    main()
