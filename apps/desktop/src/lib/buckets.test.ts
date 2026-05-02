import { describe, expect, it } from "vitest";
import { bucketFor } from "./buckets";

describe("bucketFor", () => {
  // Anchor "now" at noon so day-start arithmetic is unambiguous.
  const now = new Date("2026-04-29T12:00:00Z");

  it("classifies same-day notes as Today", () => {
    expect(bucketFor("2026-04-29T08:00:00Z", now)).toBe("Today");
    expect(bucketFor("2026-04-29T23:30:00Z", now)).toBe("Today");
  });

  it("classifies the previous calendar day as Yesterday", () => {
    expect(bucketFor("2026-04-28T20:00:00Z", now)).toBe("Yesterday");
  });

  it("classifies a 3-day-old note as This week", () => {
    expect(bucketFor("2026-04-26T12:00:00Z", now)).toBe("This week");
  });

  it("classifies an 8-day-old note as Last week", () => {
    expect(bucketFor("2026-04-21T12:00:00Z", now)).toBe("Last week");
  });

  it("classifies a 20-day-old note as This month", () => {
    expect(bucketFor("2026-04-09T12:00:00Z", now)).toBe("This month");
  });

  it("classifies anything older as Older", () => {
    expect(bucketFor("2025-12-01T12:00:00Z", now)).toBe("Older");
  });

  it("returns Older for unparseable dates rather than throwing", () => {
    expect(bucketFor("garbage", now)).toBe("Older");
  });
});
