import { describe, expect, it } from "vitest";
import { deriveTitle, formatRelative, truncate } from "./format";

describe("formatRelative", () => {
  const NOW = Date.parse("2026-04-29T12:00:00Z");

  it("returns 'Just now' inside the first minute", () => {
    expect(formatRelative("2026-04-29T11:59:30Z", NOW)).toBe("Just now");
  });

  it("returns Nm ago for sub-hour deltas", () => {
    expect(formatRelative("2026-04-29T11:30:00Z", NOW)).toBe("30m ago");
  });

  it("returns Nh ago for sub-day deltas", () => {
    expect(formatRelative("2026-04-29T08:00:00Z", NOW)).toBe("4h ago");
  });

  it("returns Nd ago up to a week", () => {
    expect(formatRelative("2026-04-25T12:00:00Z", NOW)).toBe("4d ago");
  });

  it("returns a localized date past a week", () => {
    const out = formatRelative("2026-04-01T12:00:00Z", NOW);
    expect(out).toMatch(/Apr\s*1/);
  });

  it("appends the year for prior years", () => {
    const out = formatRelative("2025-04-01T12:00:00Z", NOW);
    expect(out).toMatch(/2025/);
  });

  it("returns empty string for non-parseable input", () => {
    expect(formatRelative("not-a-date", NOW)).toBe("");
  });
});

describe("deriveTitle", () => {
  it("takes the first non-empty line", () => {
    expect(deriveTitle("\n\n  Hello\nWorld")).toBe("Hello");
  });

  it("caps at 120 chars", () => {
    const long = "x".repeat(200);
    expect(deriveTitle(long).length).toBe(120);
  });

  it("returns empty for empty content", () => {
    expect(deriveTitle("")).toBe("");
    expect(deriveTitle("\n\n  \n")).toBe("");
  });
});

describe("truncate", () => {
  it("returns input unchanged when within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates with ellipsis when over", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });
});
