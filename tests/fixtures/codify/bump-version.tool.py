# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
from __future__ import annotations

import json

import codify_rt


def main() -> None:
    workspace, payload = codify_rt.load()
    pkg = payload["pkg"]
    version = payload["version"]
    path = "package.json"
    raw = codify_rt.read_text(workspace, path)
    data = json.loads(raw)
    if data.get("name") != pkg:
        codify_rt.emit_precondition("package name mismatch")
    current = str(data.get("version", ""))
    if current == version:
        codify_rt.emit_already_applied()
    data["version"] = version
    new_raw = json.dumps(data, indent=2) + "\n"
    patch = codify_rt.unified_diff(path, raw, new_raw)
    codify_rt.emit_patch(patch, changed_files=[path], postconditions=["checks:lint"])


if __name__ == "__main__":
    main()
