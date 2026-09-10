import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

export function canRequestVerification(database, id, projectId) {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare("SELECT project_id, status FROM fix_attempts WHERE id = ?").get(id);
    if (!row) return false;
    if (row.project_id !== projectId)
      throw new Error("Verification must refer to this trial's project");
    return ["briefed", "verify_requested"].includes(row.status);
  } finally {
    db.close();
  }
}

export function readFix(database, id) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, project_id, check_id, status, failure_detail, verify_started_at, updated_at FROM fix_attempts WHERE id = ?",
      )
      .get(id);
  } finally {
    db.close();
  }
}

export async function observeVerification(database, id, mcp, log, deadline) {
  let final;
  do {
    final = readFix(database, id);
    if (!final || !["briefed", "verify_requested", "verifying"].includes(final.status)) break;
    await delay(1000);
  } while (Date.now() < deadline);
  const toolResponse = await mcp.call("get_fix_status", { attempt_id: id });
  log("mcp.jsonl", { observation: "final-verification", final, toolResponse });
  return final;
}
