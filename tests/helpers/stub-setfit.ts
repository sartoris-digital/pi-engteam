import type { Kind } from "../../src/config/schema.js";
import type { SetFitEncoder } from "../../src/v3/setfit.js";

/** In-memory encoder. Unit tests inject this so the uv wrapper never runs. */
export class StubEncoder implements SetFitEncoder {
  inferCalls: string[] = [];
  trainCalls: { text: string; kind: Kind }[][] = [];
  modelDir: string;
  map: Map<string, { kind: Kind; score: number }>;
  fallback: { kind: Kind; score: number };

  constructor(opts?: {
    modelDir?: string;
    map?: Iterable<[string, { kind: Kind; score: number }]>;
    fallback?: { kind: Kind; score: number };
  }) {
    this.modelDir = opts?.modelDir ?? "/tmp/stub-setfit";
    this.map = new Map(opts?.map ?? [["crash in login", { kind: "bug", score: 0.9 }]]);
    this.fallback = opts?.fallback ?? { kind: "chore", score: 0.1 };
  }

  train(labels: { text: string; kind: Kind }[]): Promise<{ modelDir: string }> {
    this.trainCalls.push(labels.map((l) => ({ ...l })));
    return Promise.resolve({ modelDir: this.modelDir });
  }

  infer(text: string): Promise<{ kind: Kind; score: number }> {
    this.inferCalls.push(text);
    return Promise.resolve(this.map.get(text) ?? this.fallback);
  }
}
