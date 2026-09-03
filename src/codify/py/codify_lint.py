#!/usr/bin/env python3
"""AST forbid-list for codified tools. No network, no writes, no clocks."""
from __future__ import annotations

import ast
import sys
from pathlib import Path

ALLOWED_IMPORTS = {
    "json",
    "pathlib",
    "re",
    "sys",
    "typing",
    "dataclasses",
    "codify_rt",
    "__future__",
}

FORBIDDEN_IMPORTS = {
    "socket",
    "http",
    "urllib",
    "subprocess",
    "importlib",
    "ctypes",
    "random",
    "os",
    "eval",
    "exec",
}

WRITE_ATTRS = {
    "write_text",
    "write_bytes",
    "touch",
    "unlink",
    "rmdir",
    "symlink_to",
    "hardlink_to",
    "putenv",
    "makedirs",
    "removedirs",
    "rmtree",
    "system",
    "popen",
    "execv",
    "execve",
    "execl",
    "execle",
    "execlp",
    "execvp",
}

DECODE_ATTRS = {"b64decode", "b64encode", "unhexlify", "a2b_base64", "a2b_hex", "fromhex"}
CLOCK_ATTRS = {"now", "utcnow", "today", "time", "time_ns", "monotonic", "monotonic_ns"}
ENVIRON_ATTRS = {"environ", "putenv", "unsetenv"}
BIDI = {
    0x200B,
    0x200E,
    0x200F,
    0x202A,
    0x202B,
    0x202C,
    0x202D,
    0x202E,
    0x2066,
    0x2067,
    0x2068,
    0x2069,
    0x061C,
}
MAX_LITERAL = 200


def _mod_root(name: str) -> str:
    return name.split(".", 1)[0]


def _call_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _call_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return None


def _open_mode(node: ast.Call) -> str | None:
    if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str):
        return node.args[1].value
    for kw in node.keywords:
        if kw.arg == "mode" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
            return kw.value.value
    return None


def lint_source(source: str, filename: str = "<tool.py>") -> list[str]:
    findings: list[str] = []

    for i, ch in enumerate(source):
        o = ord(ch)
        if o > 127 or o in BIDI:
            line = source.count("\n", 0, i) + 1
            findings.append(f"{filename}:{line}: non-ASCII or bidi character U+{o:04X}")
            break

    try:
        tree = ast.parse(source, filename=filename)
    except SyntaxError as exc:
        findings.append(f"{filename}:{exc.lineno or 0}: syntax error: {exc.msg}")
        return findings

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = _mod_root(alias.name)
                if root not in ALLOWED_IMPORTS:
                    findings.append(f"{filename}:{node.lineno}: forbidden import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            root = _mod_root(mod) if mod else ""
            if node.level and node.level > 0:
                findings.append(f"{filename}:{node.lineno}: relative import is forbidden")
            elif root not in ALLOWED_IMPORTS:
                findings.append(f"{filename}:{node.lineno}: forbidden import {mod or '.'}")
        elif isinstance(node, ast.Call):
            name = _call_name(node.func)
            if name in {"eval", "exec", "__import__", "compile"}:
                findings.append(f"{filename}:{node.lineno}: forbidden call {name}")
            elif name in {"open", "pathlib.Path.open", "Path.open"}:
                mode = _open_mode(node)
                if mode is not None and any(c in mode for c in "wax+"):
                    findings.append(f"{filename}:{node.lineno}: open() for write is forbidden")
            if isinstance(node.func, ast.Attribute):
                parent = _call_name(node.func.value)
                if node.func.attr in DECODE_ATTRS:
                    findings.append(f"{filename}:{node.lineno}: decoded literal {node.func.attr} is forbidden")
                if node.func.attr in CLOCK_ATTRS and (parent or "").split(".")[0] in {
                    "datetime",
                    "time",
                    "date",
                    "random",
                }:
                    findings.append(f"{filename}:{node.lineno}: clock/random call {node.func.attr} is forbidden")
                if node.func.attr in WRITE_ATTRS:
                    findings.append(f"{filename}:{node.lineno}: write/exec attr {node.func.attr} is forbidden")
        elif isinstance(node, ast.Attribute):
            if node.attr == "environ":
                findings.append(f"{filename}:{node.lineno}: os.environ access is forbidden")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if len(node.value) >= MAX_LITERAL:
                findings.append(f"{filename}:{node.lineno}: string literal >= {MAX_LITERAL} chars")

    return findings


def lint_path(path: str) -> list[str]:
    text = Path(path).read_text(encoding="utf-8")
    return lint_source(text, filename=path)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        sys.stderr.write("usage: codify_lint.py <tool.py>\n")
        return 2
    findings = lint_path(argv[1])
    for line in findings:
        sys.stdout.write(line + "\n")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
