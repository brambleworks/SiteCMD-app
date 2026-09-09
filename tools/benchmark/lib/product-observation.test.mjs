import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { canRequestVerification } from "../guest/product-observation.mjs";

test("only the trial project's requestable attempts can consume verification submissions", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sitecmd-verification-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = path.join(directory, "test.db");
  const db = new DatabaseSync(database);
  t.after(() => db.close());
  db.exec("CREATE TABLE fix_attempts (id INTEGER, project_id INTEGER, status TEXT)");
  const statuses = [
    "briefed",
    "verify_requested",
    "verifying",
    "verified",
    "verify_failed",
    "expired",
    "canceled",
  ];
  for (const [index, status] of statuses.entries()) {
    db.prepare("INSERT INTO fix_attempts VALUES (?, ?, ?)").run(index + 1, 1, status);
    assert.equal(canRequestVerification(database, index + 1, 1), index < 2);
    assert.throws(() => canRequestVerification(database, index + 1, 2), /trial's project/);
  }
  assert.equal(canRequestVerification(database, 99, 1), false);
  assert.equal(canRequestVerification(database, "1", 1), false);
});
