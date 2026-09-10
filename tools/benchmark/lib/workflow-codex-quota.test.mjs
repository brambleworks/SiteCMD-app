import assert from "node:assert/strict";
import { test } from "node:test";
import { codexPilotWindows } from "./workflow-codex-quota.mjs";

const reading = () => ({
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      primary: { usedPercent: 58, windowDurationMins: 10080, resetsAt: 1788750017 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
    },
    base_model_inference: {
      limitId: "base_model_inference",
      limitName: "gpt-reserve",
      primary: { usedPercent: 0, resetsAt: 1 },
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 0, resetsAt: 1 },
    },
  },
});

test("the pilot keeps main Codex limits and excludes named models it does not run", () => {
  const data = reading();
  assert.deepEqual(codexPilotWindows(data), [
    { id: "codex-weekly", kind: "weekly", usedPercent: 58, resetsAt: 1788750017 },
  ]);
  data.rateLimitsByLimitId.base_model_inference.primary.resetsAt += 60;
  assert.deepEqual(codexPilotWindows(data), codexPilotWindows(reading()));
});

test("unknown buckets, changed bucket identities and extra credits fail closed", () => {
  for (const change of [
    (data) => {
      data.rateLimitsByLimitId.new_bucket = { limitId: "new_bucket" };
    },
    (data) => {
      data.rateLimitsByLimitId.base_model_inference.limitName = "gpt-6-astra";
    },
    (data) => {
      data.rateLimitsByLimitId.codex.credits.hasCredits = true;
    },
  ]) {
    const data = reading();
    change(data);
    assert.throws(() => codexPilotWindows(data));
  }
});
