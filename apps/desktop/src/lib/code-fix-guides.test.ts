import { describe, expect, it } from "vitest";
import { getCodeFixGuide } from "./code-fix-guides";

describe("getCodeFixGuide", () => {
  it("returns null for unknown code scan checks", () => {
    expect(getCodeFixGuide("does-not-exist")).toBeNull();
  });

  it("returns exact producer-rule matches with effort metadata", () => {
    const guide = getCodeFixGuide("ai-timeout");
    expect(guide).not.toBeNull();
    expect(guide!.steps.length).toBeGreaterThan(0);
    expect(guide!.effortMinutes).toBeGreaterThan(0);
  });

  it("uses the explicit producer rule without parsing an occurrence ID", () => {
    const guide = getCodeFixGuide("ai-timeout");
    expect(guide).not.toBeNull();
    expect(guide!.steps.join("\n")).toContain("timeout");
  });

  it("warns path repairs not to silently rewrite persisted names", () => {
    const guide = getCodeFixGuide("python-path-traversal");
    expect(guide).not.toBeNull();
    const guidance = guide!.steps.join("\n");
    expect(guidance).toMatch(/persisted name/i);
    expect(guidance).toMatch(/reject.*silently rewriting/i);
    expect(guidance).toMatch(/compatibility/i);
  });

  it("keeps unsafe HTML repairs scoped to the reported value", () => {
    const guide = getCodeFixGuide("unsafe-html");
    expect(guide).not.toBeNull();
    const guidance = guide!.steps.join("\n");
    expect(guidance).toMatch(/reported sink/i);
    expect(guidance).toMatch(/trusted generated markup/i);
    expect(guidance).toMatch(/preserve that path/i);
    expect(guidance).toMatch(/sanitize only.*attacker-influenced/i);
  });
});
