// src/safety/default-domains.ts
// Built-in domain policy defaults shipped with the extension.
// `${RUN_DIR}` and `${EXPERTISE_DIR}` are literal placeholders;
// substitution is performed by teams-config.ts at session start.

export type BashPolicy = {
  mode: "script-only";
  runner: string;
  allowed_scripts: string[];
};

export type DomainPolicy = {
  read: string[];
  upsert: string[];
  delete: string[];
  bash_policy?: BashPolicy;
  // When true, Layer D forces block mode on this agent's Write/Edit/Bash
  // violations regardless of the global teams.yaml mode. Used for agents whose
  // security model depends on enforcement (verifier, learner). bash_policy
  // already implies force-block on its own narrow path; force_block applies
  // the same guarantee to path-domain violations.
  force_block?: boolean;
};

export type DomainPolicyMap = Record<string, DomainPolicy>;

export const DEFAULT_DOMAINS: DomainPolicyMap = {
  // --- Orchestrator tier ---
  // Phase 6.5 round-1 C1: force_block so an out-of-domain Write/Edit is
  // hard-blocked at Layer D regardless of the default teams.yaml mode
  // (which is "warn" out of the box). Without this, a Lead/Orchestrator
  // Write outside its declared upsert would warn-and-proceed.
  orchestrator: {
    read: ["."],
    // `${RUN_ID}` is substituted per tool_call inside DomainLock from
    // PI_ENGINEERING_RUN_ID, so this is the active run's synthesis.md and
    // conversation.jsonl only — every OTHER run's same-named files are
    // out of policy. (Previously the placeholder was unsupported and we
    // had to widen this to a directory prefix that covered every run.)
    upsert: ["${RUN_DIR}/${RUN_ID}/synthesis.md", "${RUN_DIR}/${RUN_ID}/conversation.jsonl"],
    delete: [],
    force_block: true,
  },

  // --- Lead tier ---
  // Phase 6.5 round-1 C1: force_block enforced.
  // Phase 6.5 round-1 L1: removed EXPERTISE_DIR entries from upserts.
  // Layer A's isProtectedPath already hard-blocks expertise file writes
  // regardless of Layer D policy; carrying them in the policy was
  // dead/contradictory authority that misled readers about what the
  // role can actually do.
  // Lead policies are scoped to the active run only via `${RUN_ID}`,
  // resolved per tool_call inside DomainLock. The previous `${RUN_DIR}`
  // (no run-id) granted cross-run write access — a Lead executing run B
  // could overwrite run A's position files. With `${RUN_ID}` the Lead
  // can only write into its own run's directory tree.
  "planning-lead": {
    read: ["."],
    upsert: ["${RUN_DIR}/${RUN_ID}", "specs/"],
    delete: [],
    force_block: true,
  },
  "engineering-lead": {
    read: ["."],
    upsert: ["${RUN_DIR}/${RUN_ID}"],
    delete: [],
    force_block: true,
  },
  "validation-lead": {
    read: ["."],
    upsert: ["${RUN_DIR}/${RUN_ID}"],
    delete: [],
    force_block: true,
  },
  "investigation-lead": {
    read: ["."],
    upsert: ["${RUN_DIR}/${RUN_ID}"],
    delete: [],
    force_block: true,
  },

  // --- Worker tier (explicit) ---
  planner: {
    read: ["."],
    upsert: ["${RUN_DIR}/plan.md", "${RUN_DIR}/notes/"],
    delete: [],
  },
  implementer: {
    read: ["."],
    upsert: ["src/", "tests/", "scripts/", "${RUN_DIR}/notes/"],
    delete: [],
  },
  reviewer: {
    read: ["."],
    upsert: ["${RUN_DIR}/review.md", "${RUN_DIR}/notes/"],
    delete: [],
  },
  tester: {
    read: ["."],
    upsert: ["tests/", "${RUN_DIR}/notes/"],
    delete: [],
  },
  "security-auditor": {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },
  judge: {
    read: ["."],
    upsert: ["${RUN_DIR}/approvals/"],
    delete: [],
  },

  // --- Worker tier (defaults: read all, upsert run notes only) ---
  architect: {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },
  discoverer: {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },
  "codebase-cartographer": {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },
  "knowledge-retriever": {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },
  "root-cause-debugger": {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },
  "performance-analyst": {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },
  "incident-investigator": {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },
  "bug-triage": {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },
  "observability-archivist": {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },
  "issue-analyst": {
    read: ["."],
    upsert: ["${RUN_DIR}/notes/"],
    delete: [],
  },

  // --- Verifier: bash limited to script-only mode ---
  verifier: {
    read: ["."],
    upsert: ["${RUN_DIR}/verification/"],
    delete: [],
    bash_policy: {
      mode: "script-only",
      runner: "uv run --script",
      allowed_scripts: ["~/.pi/engineering-team/verifier-scripts/*.py"],
    },
  },

  // --- Learner: staging-scoped writes; force_block + script-only bash ---
  learner: {
    read: ["."],
    upsert: [
      "~/.pi/engineering-team/verifier-scripts/.staging/",
      "${RUN_DIR}/learning/",
    ],
    delete: [],
    force_block: true,
    bash_policy: {
      mode: "script-only",
      runner: "uv run --script",
      // Learner can run any verifier-script (active or staged) for fixture validation.
      allowed_scripts: [
        "~/.pi/engineering-team/verifier-scripts/*.py",
        "~/.pi/engineering-team/verifier-scripts/.staging/*.py",
      ],
    },
  },
};
