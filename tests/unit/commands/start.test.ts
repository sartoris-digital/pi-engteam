import { describe, it, expect } from "vitest";
import { queueStateFor } from "../../../src/commands/start.js";

describe("queueStateFor", () => {
  it("maps engine statuses onto queue states without re-queuing a pause", () => {
    expect(queueStateFor("running")).toBe("running");
    expect(queueStateFor("waiting_user")).toBe("waiting_user");
    expect(queueStateFor("paused")).toBe("waiting_user");
    expect(queueStateFor("succeeded")).toBe("published");
    expect(queueStateFor("failed")).toBe("failed");
    expect(queueStateFor("cancelled")).toBe("cancelled");
    expect(queueStateFor("pending")).toBe("running");
  });
});
