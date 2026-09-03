import type { FactoryDeps } from "../controller/lane-runner.js";
import { runEnqueue } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runGrill(parsed: ParsedFactoryArgs, deps: FactoryDeps) {
  const task =
    typeof parsed.flags.task === "string" && parsed.flags.task.trim().length > 0
      ? parsed.flags.task
      : parsed.args.join(" ").trim();
  if (task.length === 0) throw new Error("grill: idea text is required");
  return runEnqueue(
    {
      verb: "enqueue",
      args: [],
      flags: { ...parsed.flags, task, lane: "grill" },
    },
    deps,
  );
}
