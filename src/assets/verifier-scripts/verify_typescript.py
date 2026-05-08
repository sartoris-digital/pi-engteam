#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""verify_typescript.py — read-only TypeScript verification primitives.

Wraps tsc --noEmit, eslint --check, and file-existence assertions. The script
itself only spawns external read-only checkers; it never writes source files.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def emit(ok: bool, details: str, checks: list) -> None:
    print(json.dumps({"ok": ok, "details": details, "checks": checks}))
    sys.exit(0 if ok else 1)


def run_cmd(cmd: list[str], cwd: str | None = None) -> tuple[int, str]:
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=180)
    except FileNotFoundError as exc:
        return 127, f"command not found: {exc}"
    except subprocess.TimeoutExpired:
        return 124, "timeout"
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def check_exists(path: str) -> dict:
    p = Path(os.path.expanduser(path))
    return {"check": "exists", "path": str(p), "ok": p.exists()}


def check_tsc(target: str | None) -> dict:
    cmd = ["uvx", "--from", "typescript", "tsc", "--noEmit"]
    if target:
        cmd.append(target)
    code, out = run_cmd(cmd)
    return {"check": "tsc", "ok": code == 0, "exit": code, "output": out[-2000:]}


def check_eslint(files: list[str]) -> dict:
    if not files:
        return {"check": "eslint", "ok": True, "output": "no files supplied"}
    cmd = ["uvx", "--from", "eslint", "eslint", "--no-eslintrc", *files]
    code, out = run_cmd(cmd)
    return {"check": "eslint", "ok": code == 0, "exit": code, "output": out[-2000:]}


def main() -> None:
    ap = argparse.ArgumentParser(description="TypeScript read-only verifier")
    ap.add_argument("--exists", action="append", default=[], help="Assert path exists")
    ap.add_argument("--tsc-target", default=None, help="File or project path for tsc --noEmit")
    ap.add_argument("--eslint", action="append", default=[], help="File to lint")
    ap.add_argument("--no-tsc", action="store_true", help="Skip tsc")
    args = ap.parse_args()

    checks: list[dict] = []
    for p in args.exists:
        checks.append(check_exists(p))
    if not args.no_tsc:
        checks.append(check_tsc(args.tsc_target))
    if args.eslint:
        checks.append(check_eslint(args.eslint))

    ok = all(c.get("ok") for c in checks) if checks else False
    details = "all checks passed" if ok else "one or more checks failed"
    emit(ok, details, checks)


if __name__ == "__main__":
    main()
