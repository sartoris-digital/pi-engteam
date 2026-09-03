/** Lifecycle names for registry transitions (spec §8.15 / §9.3). */
export const CODIFIED_STATE_EVENTS = [
  "factory.codified.staged",
  "factory.codified.probationary",
  "factory.codified.active",
  "factory.codified.assist",
  "factory.codified.demoted",
  "factory.codified.retired",
  "factory.codified.rejected",
  "factory.codified.drifted",
] as const;

/** Host-stage outcome types (mine / assess / generate / validate). */
export const CODIFIED_OUTCOME_EVENTS = [
  "factory.codified.mine",
  "factory.codified.assess",
  "factory.codified.generate",
  "factory.codified.validate",
] as const;

export const CODIFIED_EVENTS = [
  ...CODIFIED_STATE_EVENTS,
  ...CODIFIED_OUTCOME_EVENTS,
  "factory.codified.blocked",
] as const;

export type CodifiedEventName = (typeof CODIFIED_EVENTS)[number];
export type CodifiedStateEvent = (typeof CODIFIED_STATE_EVENTS)[number];

export function eventNameForState(state: string): `factory.codified.${string}` {
  return `factory.codified.${state}`;
}
