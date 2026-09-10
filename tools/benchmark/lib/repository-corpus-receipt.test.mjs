import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepositoryCorpusScreening } from "./repository-corpus-receipt.mjs";
import { digest } from "./workflow-plan.mjs";

function snapshot(commit, value) {
  const content = {
    schemaVersion: 1,
    commit,
    tree: commit,
    files: [{ name: "LICENSE", mode: "100644", base64: Buffer.from(value).toString("base64") }],
  };
  return { ...content, sha256: digest(content) };
}

test("creates a source-deduplicated screening receipt without local repository paths", () => {
  const shared = snapshot("a".repeat(40), "license");
  const corpus = { id: "held-out", cases: [{ id: "control" }, { id: "rejected" }] };
  const result = createRepositoryCorpusScreening(
    corpus,
    [
      {
        receipt: { id: "control", sourceCompatible: true },
        sources: { baseline: shared, upstream: shared },
      },
      {
        receipt: { id: "rejected", sourceCompatible: false },
        sources: { baseline: shared, upstream: null },
      },
    ],
    "2026-09-09T12:00:00.000Z",
  );
  assert.equal(result.receipt.passed, false);
  assert.equal(result.receipt.scannerObserved, false);
  assert.equal(result.receipt.modelCalls, 0);
  assert.equal(result.sources.size, 1);
  assert.equal(result.receipt.cases[0].baselineSource, `sources/${shared.sha256}.json`);
  assert.equal(result.receipt.cases[0].upstreamSource, result.receipt.cases[0].baselineSource);
  assert.equal(result.receipt.cases[1].upstreamSource, null);
  assert.doesNotMatch(JSON.stringify(result.receipt), /\/sources\//);
});

test("rejects mismatched case receipts and invalid capture times", () => {
  const corpus = { id: "held-out", cases: [{ id: "expected" }] };
  const screened = [
    {
      receipt: { id: "different", sourceCompatible: true },
      sources: { baseline: null, upstream: null },
    },
  ];
  assert.throws(
    () => createRepositoryCorpusScreening(corpus, screened, "2026-09-09T12:00:00.000Z"),
    /case order/i,
  );
  screened[0].receipt.id = "expected";
  assert.throws(
    () => createRepositoryCorpusScreening(corpus, screened, "yesterday"),
    /capture time/i,
  );
});
