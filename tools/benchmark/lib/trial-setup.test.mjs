import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareProject } from "../guest/trial-setup.mjs";

test("an unmapped repair never invents a check ID or claims an MCP rejection", async () => {
  const calls = [];
  let closed = false;
  const mcp = {
    request: async () => ({}),
    notify() {},
    close() {
      closed = true;
    },
    async call(name, args) {
      calls.push({ name, args });
      return { content: [{ text: "Code scan complete: execution #1 (complete)" }] };
    },
  };
  await assert.rejects(
    prepareProject(
      { invoke: async () => 9, database: "/isolated.db" },
      { path: "/source" },
      { id: "linkding-asset-sandbox", kind: "repair" },
      { mcp: "/mcp.mjs" },
      { agent: "codex" },
      "mcp",
      () => {},
      { connect: () => mcp },
    ),
    (error) => {
      assert.equal(error.name, "UnmappedHandoffError");
      assert.equal(error.stage, "handoff");
      assert.equal(error.projectId, 9);
      assert.equal(error.response, undefined);
      assert.match(error.message, /no registered SiteCMD check/i);
      return true;
    },
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    ["run_scan"],
  );
  assert.equal(closed, true);
});

test("a missing repair handoff preserves the product response and never returns a ready project", async () => {
  const calls = [];
  let closed = false;
  const rejected = { isError: true, content: [{ type: "text", text: "Check is not open" }] };
  const mcp = {
    request: async () => ({}),
    notify() {},
    close() {
      closed = true;
    },
    async call(name, args) {
      calls.push({ name, args });
      return name === "run_scan"
        ? { content: [{ text: "Code scan complete: execution #1 (complete)" }] }
        : rejected;
    },
  };
  await assert.rejects(
    prepareProject(
      { invoke: async () => 9, database: "/isolated.db" },
      { path: "/source" },
      { id: "historical-case", kind: "repair", rule: "open-redirect" },
      { mcp: "/mcp.mjs" },
      { agent: "codex" },
      "mcp",
      () => {},
      { connect: () => mcp },
    ),
    (error) => {
      assert.equal(error.stage, "handoff");
      assert.equal(error.projectId, 9);
      assert.deepEqual(error.response, rejected);
      return true;
    },
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    ["run_scan", "start_fix"],
  );
  assert.equal(calls[1].args.check_id, "code_scan.open-redirect");
  assert.equal(closed, true);
});
