#!/usr/bin/env bash
# Phase D item 23 — CoPilot smoke test.
#
# Drives `triage` against a known fixture goal and asserts the
# observable artifacts of a successful Phase A+B+C run:
#   - per-run feature-decisions.json present + frozen
#   - per-run state.json reached terminal status
#   - at least one classified activity event when
#     PI_ENGINEERING_ACTIVITY_STREAM=1
#   - capability bundle exists for the configured provider (the
#     probe must have been run first)
#   - wall time under cap
#
# Usage:
#   PI_ENGINEERING_PROVIDER=copilot \
#     PI_ENGINEERING_MODEL=claude-opus-4-6 \
#     scripts/copilot-smoke.sh [--goal "<custom goal>"]
#
# Exits non-zero on any failed assertion.
set -euo pipefail

GOAL="bug-triage smoke: investigate the README's first paragraph and recommend severity"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --goal) shift; GOAL="$1" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

PROVIDER="${PI_ENGINEERING_PROVIDER:-copilot}"
MODEL="${PI_ENGINEERING_MODEL:-claude-opus-4-6}"
RUNS_DIR="${PI_ENGINEERING_RUNS_DIR:-$HOME/.pi/engineering-team/runs}"
CAPS_DIR="${PI_ENGINEERING_CAPABILITIES_DIR:-$HOME/.pi/engineering-team/capabilities}"
WALL_CAP_SECONDS="${PI_ENGINEERING_SMOKE_WALL_CAP:-1200}"

echo "[smoke] provider=$PROVIDER model=$MODEL"
echo "[smoke] runs_dir=$RUNS_DIR"

assert_capability_bundle() {
  local dir="$CAPS_DIR/$PROVIDER"
  if [ ! -d "$dir" ]; then
    echo "[smoke FAIL] no capability bundle for provider=$PROVIDER at $dir" >&2
    echo "             run \`pnpm probe-pi-provider --provider $PROVIDER --model $MODEL\` first." >&2
    exit 3
  fi
  local count
  count="$(find "$dir" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$count" -lt 1 ]; then
    echo "[smoke FAIL] capability dir $dir is empty" >&2
    exit 3
  fi
  echo "[smoke ok] capability bundle present ($count file(s))"
}

assert_phase_a_flags() {
  echo "[smoke] active Phase A flags:"
  for var in PI_ENGINEERING_LEGACY_MODE PI_ENGINEERING_CAPABILITY_MODE \
             PI_ENGINEERING_VERDICT_SLOT_HOSTOWNED PI_ENGINEERING_ACCEPT_PREDICATES \
             PI_ENGINEERING_FORCED_RETRIES PI_ENGINEERING_FORCED_RETRY_BUDGET \
             PI_ENGINEERING_TELEMETRY PI_ENGINEERING_ACTIVITY_STREAM; do
    eval "val=\"\${$var:-<unset>}\""
    printf "  %-44s = %s\n" "$var" "$val"
  done
}

run_triage() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[smoke] --dry-run, skipping actual /run-start"
    return 0
  fi
  echo "[smoke] running pi engineering run-start triage \"$GOAL\""
  local start_ts run_id
  start_ts="$(date +%s)"
  # `pi engineering run-start` is the operator-facing CLI; output
  # includes the runId on stdout.
  run_id="$(pi engineering run-start triage "$GOAL" 2>&1 | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
  if [ -z "$run_id" ]; then
    echo "[smoke FAIL] could not parse runId from pi-engineering run-start output" >&2
    exit 4
  fi
  echo "[smoke ok] runId=$run_id"
  # Wait until the run reaches a terminal status (succeeded/failed)
  # or wall-cap.
  local elapsed status
  while :; do
    elapsed=$(( $(date +%s) - start_ts ))
    if [ "$elapsed" -gt "$WALL_CAP_SECONDS" ]; then
      echo "[smoke FAIL] run exceeded wall cap of ${WALL_CAP_SECONDS}s" >&2
      exit 5
    fi
    status="$(jq -r '.status' "$RUNS_DIR/$run_id/state.json" 2>/dev/null || echo "missing")"
    case "$status" in
      succeeded|failed|halted) break ;;
      missing) echo "[smoke FAIL] $RUNS_DIR/$run_id/state.json missing" >&2; exit 6 ;;
      *) sleep 3 ;;
    esac
  done
  echo "[smoke] run terminal status: $status"
  echo "$run_id"
}

assert_frozen_decisions() {
  local run_id="$1"
  local path="$RUNS_DIR/$run_id/feature-decisions.json"
  if [ ! -f "$path" ]; then
    echo "[smoke FAIL] missing $path" >&2
    exit 7
  fi
  if ! jq -e '.features and .cohortHash and .frozenAt' "$path" >/dev/null 2>&1; then
    echo "[smoke FAIL] feature-decisions.json missing required fields" >&2
    cat "$path" >&2
    exit 7
  fi
  echo "[smoke ok] feature-decisions.json present + valid"
}

assert_activity_stream() {
  local run_id="$1"
  if [ "${PI_ENGINEERING_ACTIVITY_STREAM:-0}" != "1" ]; then
    echo "[smoke skip] activity stream disabled; not asserting JSONL"
    return 0
  fi
  local path="$RUNS_DIR/_activity/$run_id/agent-activity.jsonl"
  if [ ! -f "$path" ]; then
    echo "[smoke FAIL] missing activity JSONL: $path" >&2
    exit 8
  fi
  local lines
  lines="$(wc -l < "$path" | tr -d ' ')"
  if [ "$lines" -lt 1 ]; then
    echo "[smoke FAIL] activity JSONL is empty" >&2
    exit 8
  fi
  echo "[smoke ok] activity JSONL has $lines line(s)"
}

assert_capability_bundle
assert_phase_a_flags
RUN_ID="$(run_triage)"
if [ -n "$RUN_ID" ] && [ "$DRY_RUN" -ne 1 ]; then
  assert_frozen_decisions "$RUN_ID"
  assert_activity_stream "$RUN_ID"
fi
echo "[smoke ok] all assertions passed"
