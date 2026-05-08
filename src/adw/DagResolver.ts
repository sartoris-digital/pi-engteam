import type { Workflow, Step } from "../workflows/types.js";

export type DagLevel = {
  parallel: Step[];
  sequential: Step[];
};

/**
 * Topologically sort workflow steps into "levels". Steps in the same level
 * have the same set of completed dependencies and can run in parallel.
 * Within a level, steps with parallel === false are deferred to the
 * `sequential` slot, run after the parallel siblings in declaration order.
 *
 * Backward compatibility: a step with no dependsOn declared inherits the
 * previous step (in declaration order) as its sole dependency, preserving
 * the linear-chain semantics of pre-Phase-4 workflows.
 */
export function resolveDag(workflow: Workflow): DagLevel[] {
  const stepMap = new Map<string, Step>();
  for (const s of workflow.steps) stepMap.set(s.name, s);

  const anyDeclares = workflow.steps.some((s) => Array.isArray(s.dependsOn));

  const deps = new Map<string, string[]>();
  if (anyDeclares) {
    for (const s of workflow.steps) {
      const dep = Array.isArray(s.dependsOn) ? s.dependsOn : [];
      for (const d of dep) {
        if (!stepMap.has(d)) {
          throw new Error(
            `Workflow '${workflow.name}': step '${s.name}' declares unknown dependency '${d}'`,
          );
        }
      }
      deps.set(s.name, dep);
    }
  } else {
    for (let i = 0; i < workflow.steps.length; i++) {
      const s = workflow.steps[i];
      deps.set(s.name, i === 0 ? [] : [workflow.steps[i - 1].name]);
    }
  }

  detectCycles(workflow.name, stepMap, deps);

  const remaining = new Set<string>(stepMap.keys());
  const completed = new Set<string>();
  const levels: DagLevel[] = [];

  while (remaining.size > 0) {
    const ready: Step[] = [];
    for (const name of remaining) {
      const ds = deps.get(name) ?? [];
      if (ds.every((d) => completed.has(d))) {
        ready.push(stepMap.get(name)!);
      }
    }
    if (ready.length === 0) {
      throw new Error(
        `Workflow '${workflow.name}': DAG resolver stuck with remaining=[${[...remaining].join(",")}]`,
      );
    }
    ready.sort(
      (a, b) => workflow.steps.indexOf(a) - workflow.steps.indexOf(b),
    );
    const parallel = ready.filter((s) => s.parallel !== false);
    const sequential = ready.filter((s) => s.parallel === false);
    levels.push({ parallel, sequential });
    for (const s of ready) {
      completed.add(s.name);
      remaining.delete(s.name);
    }
  }

  return levels;
}

function detectCycles(
  workflowName: string,
  stepMap: Map<string, Step>,
  deps: Map<string, string[]>,
): void {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const name of stepMap.keys()) color.set(name, WHITE);

  const visit = (name: string, stack: string[]): void => {
    color.set(name, GRAY);
    for (const d of deps.get(name) ?? []) {
      const c = color.get(d);
      if (c === GRAY) {
        const cycle = [...stack.slice(stack.indexOf(d)), d].join(" -> ");
        throw new Error(
          `Workflow '${workflowName}': cycle detected (${cycle})`,
        );
      }
      if (c === WHITE) visit(d, [...stack, d]);
    }
    color.set(name, BLACK);
  };

  for (const name of stepMap.keys()) {
    if (color.get(name) === WHITE) visit(name, [name]);
  }
}

/**
 * Validate workflow at registration: cycles throw immediately so a misdeclared
 * workflow is rejected at boot rather than at first run.
 */
export function validateWorkflow(workflow: Workflow): void {
  resolveDag(workflow);
}
