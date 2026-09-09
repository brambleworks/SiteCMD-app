import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmatoryStudyArguments } from "./confirmatory-study-arguments.mjs";

const required = ["screen", "eligible", "qualified", "workflow", "output", "product"];

test("confirmatory preparation accepts an explicit continuation pair", () => {
  assert.deepEqual(
    confirmatoryStudyArguments([
      ...required,
      "--continue-from",
      "prior",
      "--reason",
      "Quota controller correction",
    ]),
    {
      screeningDirectory: "screen",
      eligibilityDirectory: "eligible",
      qualificationDirectory: "qualified",
      workflowDirectory: "workflow",
      output: "output",
      productFile: "product",
      continueFrom: "prior",
      reason: "Quota controller correction",
    },
  );
});

test("confirmatory preparation rejects incomplete continuation metadata", () => {
  assert.throws(
    () => confirmatoryStudyArguments([...required, "--continue-from", "prior"]),
    /requires both/,
  );
  assert.throws(
    () => confirmatoryStudyArguments([...required, "--reason", "correction"]),
    /requires both/,
  );
});
