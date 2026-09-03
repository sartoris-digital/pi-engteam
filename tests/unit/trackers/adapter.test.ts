import { describe, it, expect } from "vitest";
import {
  isTicketKind,
  refToString,
  TICKET_KINDS,
  type Ticket,
  type TrackerAdapter,
} from "../../../src/trackers/adapter.js";

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

  it("keeps v0 Ticket fields required and treats spec §3.4/§3.5 extras as optional", () => {
    const ticket: Ticket = {
      ref: { tracker: "github", id: "acme/widgets#42" },
      title: "Fix the widgets",
      body: "They rattle.",
      labels: ["factory:ready"],
      author: "ada",
    };
    expect(ticket.state).toBeUndefined();
    expect(ticket.assignees).toBeUndefined();
    expect(ticket.updatedAt).toBeUndefined();
    expect(ticket.priority).toBeUndefined();
    expect(ticket.similar).toBeUndefined();
    expect(ticket.raw).toBeUndefined();
  });

  it("requires the spec §3.1 adapter methods on TrackerAdapter", () => {
    const required: (keyof TrackerAdapter)[] = [
      "id",
      "capabilities",
      "detect",
      "parseRef",
      "fetch",
      "list",
      "search",
      "getComments",
      "labelerOf",
      "isAuthorized",
      "acknowledge",
      "comment",
      "addLabel",
      "removeLabel",
      "transition",
      "assign",
      "linkPR",
    ];
    expect(required).toContain("capabilities");
    expect(required).toContain("list");
  });
});
