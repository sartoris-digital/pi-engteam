import { describe, it, expect } from "vitest";
import { getDashboardHtml } from "../../../server/dashboard.js";

describe("getDashboardHtml", () => {
  const BASE_URL = "http://localhost:4747";
  let html: string;

  it("returns a string", () => {
    html = getDashboardHtml(BASE_URL);
    expect(typeof html).toBe("string");
  });

  it("contains the base URL in the script block", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html).toContain(BASE_URL);
  });

  it("is valid HTML with a DOCTYPE declaration", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it("contains a table for runs", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html).toContain("<table>");
    expect(html).toContain("runs-body");
  });

  it("contains stats placeholder", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html).toContain("id=\"stats\"");
  });

  it("renders the correct API base URL in the JS block", () => {
    html = getDashboardHtml("http://127.0.0.1:9999");
    expect(html).toContain("http://127.0.0.1:9999");
  });

  it("contains a 5-second auto-refresh interval", () => {
    html = getDashboardHtml(BASE_URL);
    expect(html).toContain("setInterval");
    expect(html).toContain("5000");
  });
});
