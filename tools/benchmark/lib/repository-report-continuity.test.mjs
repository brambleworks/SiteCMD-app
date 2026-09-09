import assert from "node:assert/strict";
import { test } from "node:test";
import { retainRepositoryReport } from "./repository-report-continuity.mjs";

test("a continuation retains the original report when only capture time changed", () => {
  const original = JSON.stringify({ checkedAt: "first", issues: [{ checkId: "target" }] });
  const current = JSON.stringify({ checkedAt: "second", issues: [{ checkId: "target" }] });
  assert.equal(retainRepositoryReport(original, current), original);
});

test("a continuation rejects substantive scanner report changes", () => {
  const original = JSON.stringify({ checkedAt: "first", issues: [{ checkId: "target" }] });
  const current = JSON.stringify({ checkedAt: "second", issues: [] });
  assert.throws(() => retainRepositoryReport(original, current), /scanner report changed/);
});
