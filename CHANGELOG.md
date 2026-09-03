# Changelog

## Unreleased — v1 GitHub factory (in progress)

Groups 1–9 landed on `claude/pi-software-factory-design-51a9f9` (HEAD `bac2db3`). Group 10 (labelled ticket → PR + land-reconcile e2e) is not done.

Shipped on top of v0: GitHub adapter (sanitize/screen/discovery), intake (brief, k=2 stub analyst, confidence, DoR), scheduler (lease, poll, queue, admission, claim, ledger, herdr), land-reconcile + PR body + sticky, vault (`better-sqlite3` + `@napi-rs/keyring`; tests use MemoryVaultStore + FakeKeyring), fusion, grill + `/factory remember`/`rules`, remaining agent prompts, `/factory` tree (doctor, grant, secret, resume/cancel/drop/…).

v0 leftovers already in tree: fail-closed catalog predicates, `PI_SDLC_TOOLS`, host-git env allowlist, worker `git commit` Layer A, engine `defaultVerify`.

Not yet: v1 Group 10 e2e, v1.5 codify, v2 ADO/Jira/proxy/rebase, v3.

## 0.0.0 — v0 skeleton (2026-09-03)

Greenfield `@sartoris/pi-sdlc-factory` on `claude/pi-software-factory-design-51a9f9`. Retired `pi-engineering` v2.2.1 is tag `retired/pi-engineering-v2.2.1` (reference only).

Shipped: five-layer config, Layers A–D, engine, headless workers, YAML lanes, git worktrees, host git + judgedSha publish, gate RED/manifest/checks, steer, LocalAdapter, `/factory setup|enqueue|start|approve|status`.

Exit criterion: fixture chore `scope-check → plan → steer → implement → test → review → judge → publish` with signed evidence and a push only after judge PASS bound to live HEAD.

Not in v0: GitHub poller, PRs, vault, fusion, grill, codify, Jira/ADO (v1+).
