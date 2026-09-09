import { describe, expect, it } from "vitest";
import { fixHandoffKey } from "./fix-handoff-store";

describe("fixHandoffKey", () => {
  it("keeps separate code occurrences independent", () => {
    const first = fixHandoffKey(7, "https://example.com", "code_scan.unsafe-html", {
      path: "src/view.tsx",
      line: 12,
    });
    const second = fixHandoffKey(7, "https://example.com", "code_scan.unsafe-html", {
      path: "src/view.tsx",
      line: 28,
    });

    expect(first).not.toBe(second);
  });

  it("keeps group keys stable when no occurrence is supplied", () => {
    expect(fixHandoffKey(7, "https://example.com", "security.csp")).toBe(
      "7:https://example.com:security.csp",
    );
  });
});
