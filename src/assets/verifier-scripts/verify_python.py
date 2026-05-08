#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""verify_python.py — read-only Python verification primitives.

Runs ruff check, ruff format --check, and pytest --collect-only. Format and
collect-only are explicitly non-mutating; --collect-only never executes tests.
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


def check_ruff(target: str) -> dict:
    code, out = run_cmd(["uvx", "ruff", "check", target])
    return {"check": "ruff", "target": target, "ok": code == 0, "exit": code, "output": out[-2000:]}


def check_ruff_format(target: str) -> dict:
    code, out = run_cmd(["uvx", "ruff", "format", "--check", target])
    return {"check": "ruff-format", "target": target, "ok": code == 0, "exit": code, "output": out[-2000:]}


def check_pytest_collect(target: str | None) -> dict:
    cmd = ["uvx", "pytest", "--collect-only", "-q"]
    if target:
        cmd.append(target)
    code, out = run_cmd(cmd)
    return {"check": "pytest-collect", "ok": code == 0, "exit": code, "output": out[-2000:]}


def main() -> None:
    ap = argparse.ArgumentParser(description="Python read-only verifier")
    ap.add_argument("--exists", action="append", default=[], help="Assert path exists")
    ap.add_argument("--ruff", default=None, help="Path to ruff-check")
    ap.add_argument("--ruff-format", default=None, help="Path to ruff-format-check")
    ap.add_argument("--pytest-collect", default=None, help="Path to collect tests from (no execution)")
    args = ap.parse_args()

    checks: list[dict] = []
    for p in args.exists:
        checks.append(check_exists(p))
    if args.ruff:
        checks.append(check_ruff(args.ruff))
    if args.ruff_format:
        checks.append(check_ruff_format(args.ruff_format))
    if args.pytest_collect is not None:
        checks.append(check_pytest_collect(args.pytest_collect or None))

    ok = all(c.get("ok") for c in checks) if checks else False
    details = "all checks passed" if ok else "one or more checks failed"
    emit(ok, details, checks)


if __name__ == "__main__":
    main()
