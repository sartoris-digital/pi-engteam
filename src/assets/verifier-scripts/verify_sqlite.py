#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""verify_sqlite.py — read-only SQLite verification.

Opens the DB with mode=ro, runs PRAGMA integrity_check and PRAGMA
foreign_key_check, and confirms expected schema entries. Refuses to execute any
mutating SQL.
"""
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path


def emit(ok: bool, details: str, checks: list) -> None:
    print(json.dumps({"ok": ok, "details": details, "checks": checks}))
    sys.exit(0 if ok else 1)


def open_ro(db_path: str) -> sqlite3.Connection:
    p = Path(os.path.expanduser(db_path)).resolve()
    if not p.exists():
        raise FileNotFoundError(p)
    uri = f"file:{p}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="SQLite read-only verifier")
    ap.add_argument("--db", required=True, help="Path to SQLite database")
    ap.add_argument("--integrity", action="store_true", help="Run PRAGMA integrity_check")
    ap.add_argument("--foreign-keys", action="store_true", help="Run PRAGMA foreign_key_check")
    ap.add_argument("--expect-table", action="append", default=[], help="Assert table exists")
    args = ap.parse_args()

    checks: list[dict] = []
    try:
        conn = open_ro(args.db)
    except Exception as exc:
        emit(False, f"could not open db read-only: {exc}", [])
        return

    try:
        if args.integrity:
            rows = conn.execute("PRAGMA integrity_check").fetchall()
            ok = bool(rows) and rows[0][0] == "ok"
            checks.append({"check": "integrity_check", "ok": ok, "rows": [r[0] for r in rows[:20]]})
        if args.foreign_keys:
            rows = conn.execute("PRAGMA foreign_key_check").fetchall()
            ok = len(rows) == 0
            checks.append({"check": "foreign_key_check", "ok": ok, "violations": [list(r) for r in rows[:20]]})
        for tbl in args.expect_table:
            row = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (tbl,),
            ).fetchone()
            checks.append({"check": "expect_table", "table": tbl, "ok": row is not None})
    finally:
        conn.close()

    ok = all(c.get("ok") for c in checks) if checks else False
    details = "all checks passed" if ok else "one or more checks failed"
    emit(ok, details, checks)


if __name__ == "__main__":
    main()
