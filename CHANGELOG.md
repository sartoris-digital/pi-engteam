# Changelog

## 0.0.0 — v0 skeleton (2026-09-03)

Greenfield `@sartoris/pi-sdlc-factory` on `claude/pi-software-factory-design-51a9f9`. Retired `pi-engineering` v2.2.1 is tag `retired/pi-engineering-v2.2.1` (reference only).

Shipped: five-layer config, Layers A–D, engine, headless workers, YAML lanes, git worktrees, host git + judgedSha publish, gate RED/manifest/checks, steer, LocalAdapter, `/factory setup|enqueue|start|approve|status`.

Exit criterion: fixture chore `scope-check → plan → steer → implement → test → review → judge → publish` with signed evidence and a push only after judge PASS bound to live HEAD.

Not in v0: GitHub poller, PRs, vault, fusion, grill, codify, Jira/ADO (v1+).
