import { describe, it, expect } from "vitest";
import { isTicketKind, refToString, TICKET_KINDS } from "../../../src/trackers/adapter.js";

describe("trackers/adapter", () => {
  it("lists the four ticket kinds", () => {
    expect([...TICKET_KINDS]).toEqual(["feature", "enhancement", "bug", "chore"]);
  });

  it("isTicketKind accepts only the four kinds", () => {
    for (const kind of TICKET_KINDS) expect(isTicketKind(kind)).toBe(true);
    expect(isTicketKind("epic")).toBe(false);
    expect(isTicketKind(undefined)).toBe(false);
    expect(isTicketKind(3)).toBe(false);
  });

  it("refToString renders local refs bare and other trackers as tracker:id", () => {
    expect(refToString({ tracker: "local", id: "local-01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toBe(
      "local-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    expect(refToString({ tracker: "github", id: "acme/widgets#42" })).toBe("github:acme/widgets#42");
  });
});
