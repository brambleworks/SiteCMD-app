import assert from "node:assert/strict";
import { test } from "node:test";
import { claudePilotWindows } from "./workflow-claude-quota.mjs";

const NOW = Date.parse("2026-09-06T01:10:00.412Z");
const reading = () => ({
  extra_usage: { is_enabled: false },
  spend: { enabled: false },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 0,
      resets_at: null,
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 4,
      resets_at: "2026-09-12T06:59:59.707924+00:00",
      scope: null,
      is_active: false,
    },
  ],
});

test("Claude's explicit inactive session remains present without a fabricated reset", () => {
  assert.deepEqual(claudePilotWindows(reading(), NOW), [
    { id: "session", kind: "session", usedPercent: 0, resetsAt: null, inactive: true },
    {
      id: "weekly_all",
      kind: "weekly",
      usedPercent: 4,
      resetsAt: "2026-09-12T07:00:00.000Z",
    },
  ]);
});

test("missing resets are rejected without an explicit inactive zero-usage session", () => {
  for (const change of [
    (limit) => {
      limit.is_active = true;
    },
    (limit) => {
      delete limit.is_active;
    },
    (limit) => {
      limit.percent = 1;
    },
    (limit) => {
      limit.percent = null;
    },
    (limit) => {
      limit.group = "weekly";
    },
    (limit) => {
      delete limit.resets_at;
    },
  ]) {
    const data = reading();
    change(data.limits[0]);
    assert.throws(() => claudePilotWindows(data, NOW));
  }
});

test("active sessions retain their real reset and disabled paid-usage checks", () => {
  const data = reading();
  Object.assign(data.limits[0], {
    percent: 2,
    is_active: true,
    resets_at: "2026-09-06T06:10:00.000Z",
  });
  assert.deepEqual(claudePilotWindows(data, NOW)[0], {
    id: "session",
    kind: "session",
    usedPercent: 2,
    resetsAt: "2026-09-06T06:10:00.000Z",
  });
  data.limits[0].resets_at = "2026-09-06T01:09:59.759938+00:00";
  assert.throws(() => claudePilotWindows(data, NOW), /expired/);
  for (const field of ["extra_usage", "spend"]) {
    const paid = reading();
    delete paid[field];
    assert.throws(() => claudePilotWindows(paid, NOW), /paid usage disabled/);
  }
});
