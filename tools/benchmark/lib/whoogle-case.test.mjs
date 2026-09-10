import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const definition = JSON.parse(
  readFileSync(new URL("../cases/whoogle-calibration.json", import.meta.url)),
);

test("Whoogle task states the persisted-name compatibility contract", () => {
  assert.match(definition.task, /reject names/i);
  assert.match(definition.task, /plus/i);
  assert.match(definition.task, /instead of silently rewriting/i);
  assert.match(definition.task, /preserve the exact accepted name/i);
});
