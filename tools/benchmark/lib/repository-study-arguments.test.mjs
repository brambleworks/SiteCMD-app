import assert from "node:assert/strict";
import { test } from "node:test";
import { repositoryStudyArguments } from "./repository-study-arguments.mjs";

test("repository study preparation accepts an explicit continuation pair", () => {
  assert.deepEqual(
    repositoryStudyArguments([
      "qualification",
      "workflow",
      "next-run",
      "--continue-from",
      "prior-run",
      "--reason",
      "Redirect Python tool caches and activate the frozen runtime",
    ]),
    {
      qualificationDirectory: "qualification",
      workflowDirectory: "workflow",
      output: "next-run",
      continueFrom: "prior-run",
      reason: "Redirect Python tool caches and activate the frozen runtime",
    },
  );
});

test("repository study preparation rejects incomplete continuation metadata", () => {
  for (const args of [
    ["qualification", "workflow", "next-run", "--continue-from", "prior-run"],
    ["qualification", "workflow", "next-run", "--reason", "Runner correction"],
  ])
    assert.throws(() => repositoryStudyArguments(args), /both --continue-from and --reason/);
});
