import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateIdentity, candidateRecord, decodeCandidateRecord } from "./trial-candidate.mjs";

test("candidate records round-trip bytes and modes and reject malformed evidence", () => {
  const snapshot = {
    files: { "asset.bin": Buffer.from([0, 255]) },
    modes: { "asset.bin": "100755" },
    violations: [],
  };
  const record = candidateRecord(snapshot);
  assert.deepEqual(decodeCandidateRecord(record), snapshot);
  assert.equal(candidateIdentity(decodeCandidateRecord(record)), candidateIdentity(snapshot));
  for (const change of [
    (value) => delete value.modes["asset.bin"],
    (value) => (value.modes["asset.bin"] = "120000"),
    (value) => (value.files["asset.bin"] += "!"),
    (value) => (value.files["../escape"] = ""),
    (value) => (value.modes.extra = "100644"),
    (value) => (value.violations = false),
    (value) => (value.unrecorded = true),
  ]) {
    const changed = structuredClone(record);
    change(changed);
    assert.throws(() => decodeCandidateRecord(changed));
  }
});
