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
  orchestrator: {
    read: ["."],
    upsert: ["${RUN_DIR}/conversation.jsonl", "${RUN_DIR}/synthesis.md"],
    delete: [],
  },

  // --- Lead tier ---
  "planning-lead": {
    read: ["."],
    upsert: ["${RUN_DIR}", "specs/", "${EXPERTISE_DIR}/planning.md"],
    delete: [],
  },
  "engineering-lead": {
    read: ["."],
    upsert: ["${RUN_DIR}", "${EXPERTISE_DIR}/engineering.md"],
    delete: [],
  },
  "validation-lead": {
    read: ["."],
    upsert: ["${RUN_DIR}", "${EXPERTISE_DIR}/validation.md"],
    delete: [],
  },
  "investigation-lead": {
    read: ["."],
    upsert: ["${RUN_DIR}", "${EXPERTISE_DIR}/investigation.md"],
    delete: [],
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
