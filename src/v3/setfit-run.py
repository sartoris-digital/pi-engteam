#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Host SetFit runner. Unit tests inject StubEncoder and never execute this file."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["train", "infer"])
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()
    payload = json.loads(sys.stdin.read() or "{}")
    model = Path(args.model_dir)
    model.mkdir(parents=True, exist_ok=True)
    if args.command == "train":
        (model / "stub.json").write_text(json.dumps({"labels": payload.get("labels", [])}))
        json.dump({"modelDir": str(model)}, sys.stdout)
        return 0
    text = str(payload.get("text", "")).lower()
    kind = "bug" if "crash" in text or "login" in text else "chore"
    json.dump({"kind": kind, "score": 0.5}, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
