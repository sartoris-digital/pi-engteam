# pi-sdlc-factory

A [Pi](https://github.com/earendil-works/pi) extension that turns a ticket, a freeform task or a finished plan
into a judged, evidence-backed pull request with a human in the loop at two points: the steer stage before
implementation, and the PR merge.

Status: v0 skeleton. One freeform chore runs `scope-check -> plan -> steer -> implement -> test -> review -> judge -> publish`
in a git worktree of a fixture repo, with host checkpoint commits at every stage boundary, signed evidence for
every stage, and a push that happens only after a judge PASS bound to the judged commit.

## Layout

- `src/` extension source; `src/index.ts` is the entry Pi loads (`"pi": { "extensions": ["./src/index.ts"] }`).
- `agents/` agent prompts. `tests/unit`, `tests/integration` vitest suites; `tests/helpers` fixture repo and stub `pi`.
- State lives under `~/.pi/sdlc-factory/` (override with `PI_SDLC_HOME`). Nothing generated is ever committed.

## Develop

    pnpm install && pnpm typecheck && pnpm test

Node >= 22 (`.nvmrc`), pnpm. Unit tests never touch the network, a real `pi` or a model.
The retired `pi-engineering` v2.2.1 code is tagged `retired/pi-engineering-v2.2.1` for reference only.
