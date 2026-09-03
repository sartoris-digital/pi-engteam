import type { Brief } from "../../src/intake/brief-schema.js";
import type { AnalystPort, AnalystSlot } from "../../src/intake/analyze.js";

export interface FakeAnalystCall {
  slot: AnalystSlot;
  blindedTicket: string;
}

export type FakeAnalystBrief =
  | Brief
  | ((input: { blindedTicket: string; slot: AnalystSlot }) => Brief | Promise<Brief>);

export interface FakeAnalystScript {
  A?: FakeAnalystBrief;
  B?: FakeAnalystBrief;
  tiebreak?: FakeAnalystBrief;
  throwOn?: Partial<Record<AnalystSlot, unknown>>;
}

function defaultBrief(slot: AnalystSlot): Brief {
  return {
    kind: "bug",
    flags: [],
    size: "M",
    reproSteps: "present",
    acceptanceCriteria: [
      { id: "AC1", text: `widgets no longer rattle (${slot})`, source: "quoted", quote: "widgets no longer rattle" },
    ],
    likelyPaths: ["src/widgets.ts"],
    questions: [],
    goal: "stop the rattle",
    samples: { n: 1, kinds: ["bug"], acAgreement: 1 },
    prior: { from: "none" },
    confidence: "LOW",
    tier: "low",
    lane: "bug",
  };
}

async function resolveBrief(
  spec: FakeAnalystBrief | undefined,
  input: { blindedTicket: string; slot: AnalystSlot },
): Promise<Brief> {
  if (spec === undefined) return defaultBrief(input.slot);
  if (typeof spec === "function") return await spec(input);
  return spec;
}

/** Injectable AnalystPort. Never talks to a model; records the blinded payload per slot. */
export function makeFakeAnalyst(script: FakeAnalystScript = {}): AnalystPort & { calls: FakeAnalystCall[] } {
  const calls: FakeAnalystCall[] = [];
  const port: AnalystPort & { calls: FakeAnalystCall[] } = {
    calls,
    async sample(input) {
      calls.push({ slot: input.slot, blindedTicket: input.blindedTicket });
      const boom = script.throwOn?.[input.slot];
      if (boom !== undefined) throw boom === true ? new Error(`fake analyst ${input.slot} failed`) : boom;
      const spec = input.slot === "A" ? script.A : input.slot === "B" ? script.B : script.tiebreak;
      return resolveBrief(spec, input);
    },
  };
  return port;
}
