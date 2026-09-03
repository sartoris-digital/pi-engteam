"""Host-provided runtime for codified tools. Only allowed non-stdlib import."""
from __future__ import annotations

import hashlib
import json
import sys
from difflib import unified_diff as _unified_diff
from pathlib import Path
from typing import Any, Iterable, Mapping, NoReturn

READ_ERROR = 2
INTERNAL_ERROR = 3
ALREADY_APPLIED = 4


def load(argv: list[str] | None = None) -> tuple[str, dict[str, Any]]:
    args = list(sys.argv[1:] if argv is None else argv)
    workspace: str | None = None
    input_path: str | None = None
    i = 0
    while i < len(args):
        tok = args[i]
        if tok in ("--workspace", "-w") and i + 1 < len(args):
            workspace = args[i + 1]
            i += 2
            continue
        if tok in ("--input", "-i") and i + 1 < len(args):
            input_path = args[i + 1]
            i += 2
            continue
        i += 1
    positionals = [a for a in args if not a.startswith("-")]
    if workspace is None and positionals:
        workspace = positionals[0]
    if input_path is None and len(positionals) >= 2:
        input_path = positionals[1]
    if workspace is None:
        workspace = "."
    payload: dict[str, Any] = {}
    if input_path is not None:
        payload = json.loads(Path(input_path).read_text(encoding="utf-8"))
    return workspace, payload


def _matches(rel: str, globs: Iterable[str]) -> bool:
    rel = rel.replace("\\", "/").lstrip("./")
    for glob in globs:
        g = glob.replace("\\", "/").lstrip("./")
        if g in ("**", "*") or rel == g:
            return True
        if g.endswith("/**"):
            prefix = g[:-3]
            if rel == prefix or rel.startswith(prefix + "/"):
                return True
        if g.endswith("/*"):
            prefix = g[:-2]
            rest = rel[len(prefix) + 1 :] if rel.startswith(prefix + "/") else None
            if rest is not None and "/" not in rest:
                return True
    return False


def read_text(workspace: str, relpath: str, read_globs: Iterable[str] | None = None) -> str:
    rel = relpath.replace("\\", "/").lstrip("./")
    if ".." in Path(rel).parts:
        emit_precondition(f"path escapes workspace: {rel}")
    if read_globs is not None and not _matches(rel, read_globs):
        emit_precondition(f"path outside readGlobs: {rel}")
    path = Path(workspace) / rel
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        emit_precondition(f"missing file: {rel}")
        raise


def unified_diff(path: str, old: str, new: str) -> str:
    old_lines = old.splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    if old_lines and not old_lines[-1].endswith("\n"):
        old_lines[-1] = old_lines[-1] + "\n"
    if new_lines and not new_lines[-1].endswith("\n"):
        new_lines[-1] = new_lines[-1] + "\n"
    return "".join(_unified_diff(old_lines, new_lines, fromfile=f"a/{path}", tofile=f"b/{path}"))


def emit(payload: Mapping[str, Any], exit_code: int) -> NoReturn:
    sys.stdout.write(json.dumps(dict(payload), separators=(",", ":")) + "\n")
    raise SystemExit(exit_code)


def emit_patch(patch: str, changed_files: list[str], postconditions: list[str] | None = None) -> NoReturn:
    digest = hashlib.sha256(patch.encode("utf-8")).hexdigest()
    emit(
        {
            "ok": True,
            "code": 0,
            "patchSha256": digest,
            "changedFiles": changed_files,
            "postconditions": postconditions or [],
            "patch": patch,
        },
        0,
    )


def emit_precondition(message: str) -> NoReturn:
    emit({"ok": False, "code": READ_ERROR, "message": message}, READ_ERROR)


def emit_already_applied() -> NoReturn:
    emit({"ok": True, "code": ALREADY_APPLIED, "changedFiles": []}, ALREADY_APPLIED)


def emit_internal(message: str) -> NoReturn:
    emit({"ok": False, "code": INTERNAL_ERROR, "message": message}, INTERNAL_ERROR)
