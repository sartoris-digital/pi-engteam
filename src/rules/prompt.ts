import type { RuleClass, RuleRecord } from "./schema.js";

const MAX_RULES = 40;
const MAX_BYTES = 6 * 1024;

function live(rule: RuleRecord): boolean {
  return rule.status === "active" || rule.status === "locked";
}

function stageMatch(rule: RuleRecord, stage: string): boolean {
  const stages = rule.scope.stage;
  return stages.length === 0 || stages.includes("*") || stages.includes(stage);
}

function kindMatch(rule: RuleRecord, kind: string): boolean {
  return rule.scope.kind === "*" || rule.scope.kind === kind;
}

function classAllowed(stage: string, klass: RuleClass): boolean {
  if (stage === "review" || stage === "judge") return klass === "constraint" || klass === "predicate";
  return klass === "guidance" || klass === "constraint" || klass === "predicate";
}

/** Higher is more specific. `repo: "*"` scores lowest so it is dropped first at the cap. */
export function ruleSpecificity(rule: RuleRecord): number {
  let n = 0;
  if (rule.scope.repo !== "*") n += 8;
  if (rule.scope.lane !== "*") n += 4;
  if (rule.scope.kind !== "*") n += 2;
  if (rule.scope.stage.length > 0 && !rule.scope.stage.includes("*")) n += 1;
  if (rule.scope.paths.length > 0) n += 1;
  return n;
}

function formatRule(rule: RuleRecord): string {
  return `- \`${rule.id}\` (${rule.class}) ${rule.text}`;
}

function render(rules: RuleRecord[]): string {
  return rules.map(formatRule).join("\n");
}

/** The rules in scope for a stage, most specific first. One definition, shared by the prompt block and facts.json. */
export function applicableRules(rules: RuleRecord[], stage: string, kind: string): RuleRecord[] {
  const applicable = rules.filter(
    (rule) => live(rule) && stageMatch(rule, stage) && kindMatch(rule, kind) && classAllowed(stage, rule.class),
  );
  applicable.sort((a, b) => ruleSpecificity(b) - ruleSpecificity(a) || a.id.localeCompare(b.id));
  return applicable;
}

export function operatorRulesBlock(rules: RuleRecord[], stage: string, kind: string): string {
  const selected = applicableRules(rules, stage, kind);
  while (selected.length > 0) {
    const overCount = selected.length > MAX_RULES;
    const overBytes = Buffer.byteLength(render(selected), "utf8") > MAX_BYTES;
    if (!overCount && !overBytes) break;
    selected.pop();
  }
  return render(selected);
}
