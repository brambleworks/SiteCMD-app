import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTrialItem } from "./trial-item.mjs";

const targetFinding = {
  checkId: "code_scan.unsafe-html",
  relativePath: "src/render.tsx",
  fingerprint: `sha256:${"a".repeat(64)}`,
};
const targetIssue = {
  ...targetFinding,
  title: "Unsafe rendering",
  description: "Untrusted markup reaches a sink.",
  severity: "high",
  line: 12,
};

test("confirmatory trial items preserve the exact scanner target and control identity", () => {
  const task = {
    id: "control-case",
    repository: "public-repository",
    runtime: "node",
    kind: "negative_control",
    confirmatory: true,
    targetFinding,
  };
  const item = {
    ...task,
    entry: targetFinding.relativePath,
    targetIssue,
    controlSourceSha256: "b".repeat(64),
    baselineFiles: { not: "forwarded" },
  };
  assert.deepEqual(buildTrialItem(item, task), {
    id: task.id,
    repository: task.repository,
    entry: item.entry,
    runtime: task.runtime,
    rule: undefined,
    kind: task.kind,
    confirmatory: true,
    targetFinding,
    targetIssue,
    controlSourceSha256: item.controlSourceSha256,
  });
});

test("confirmatory trial items reject a changed target", () => {
  const task = {
    id: "repair-case",
    repository: "public-repository",
    runtime: "node",
    kind: "repair",
    confirmatory: true,
    targetFinding,
  };
  assert.throws(
    () =>
      buildTrialItem(
        {
          ...task,
          entry: targetFinding.relativePath,
          targetFinding: { ...targetFinding, relativePath: "src/other.tsx" },
          targetIssue,
        },
        task,
      ),
    /target differs/,
  );
});
