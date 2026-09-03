# v3 recorded fixtures

Skeleton for spec §10.4 gate 3. Full phase e2e (Task 8.4) is skipped until v1.5 Group 5 / v2 e2e are complete. Unit tests under `tests/unit/codify/` and `tests/unit/learner/` cover the v3 Groups 7–8 contracts with stubs (no network, no real CLI, no model).

When the flags-off chore path is recorded, copy `events.jsonl` into `flags-off/` from the observer output. Do not commit secrets.

## flags-off

Default `operator.v3.*.enabled` is false. Expected dispatch equals the v0 chore lane:

`scope-check → plan → steer → implement → test → review → judge → publish`

Assertions the later e2e should lock:

- catalog length 13; `learner` absent
- `selectTool` never returns a `collaborate-exec` tool
- shared registry is write-only (`exactDispatchAllowed` is false)
- encoder not called; no sibling worktrees; no webhook listen; no merge-queue enqueue
