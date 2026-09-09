import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bridgeRequest } from "../guest/bridge-client.mjs";
import { createTrialBridge } from "../guest/trial-bridge.mjs";

test("baseline has an explicit submission boundary but no SiteCMD access", async () => {
  const channel = path.join(mkdtempSync(path.join(tmpdir(), "scb-")), "channel");
  const bridge = await createTrialBridge({
    channel,
    arm: "normal",
    submit: async (summary) => ({ summary }),
  });
  try {
    assert.deepEqual(await bridgeRequest(channel, "/submit", { summary: "No changes needed" }), {
      summary: "No changes needed",
    });
    await assert.rejects(
      bridgeRequest(channel, "/mcp", { method: "tools/list" }),
      /does not expose/,
    );
  } finally {
    await bridge.close();
  }
});

test("verification snapshots precede real MCP forwarding and replies remain unchanged", async () => {
  const order = [];
  const channel = path.join(mkdtempSync(path.join(tmpdir(), "scb-")), "channel");
  const expected = { content: [{ type: "text", text: "Verification requested" }] };
  const bridge = await createTrialBridge({
    channel,
    arm: "mcp",
    submit: async () => {
      order.push("snapshot");
      return { commit: () => order.push("accepted") };
    },
    mcp: {
      request: async () => {
        order.push("server");
        return expected;
      },
    },
  });
  try {
    const result = await bridgeRequest(channel, "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "request_verification",
        arguments: { attempt_id: 1, summary: "Fixed origin validation" },
      },
    });
    assert.deepEqual(order, ["snapshot", "server", "accepted"]);
    assert.deepEqual(result, expected);
  } finally {
    await bridge.close();
  }
});

test("closed verification attempts reach the real server without consuming a submission", async () => {
  const channel = path.join(mkdtempSync(path.join(tmpdir(), "scb-")), "channel");
  const expected = { isError: true, content: [{ type: "text", text: "Attempt is closed" }] };
  let submissions = 0;
  const bridge = await createTrialBridge({
    channel,
    arm: "mcp",
    canVerify: () => false,
    submit: async () => submissions++,
    mcp: { request: async () => expected },
  });
  try {
    const result = await bridgeRequest(channel, "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "request_verification",
        arguments: { attempt_id: 1, summary: "Retry the same candidate" },
      },
    });
    assert.deepEqual(result, expected);
    assert.equal(submissions, 0);
  } finally {
    await bridge.close();
  }
});

test("a server rejection after capture does not commit a candidate", async () => {
  const channel = path.join(mkdtempSync(path.join(tmpdir(), "scb-")), "channel");
  let captured = 0;
  let committed = 0;
  const expected = {
    isError: true,
    content: [{ type: "text", text: "Attempt closed concurrently" }],
  };
  const bridge = await createTrialBridge({
    channel,
    arm: "mcp",
    submit: async () => {
      captured++;
      return { commit: () => committed++ };
    },
    mcp: { request: async () => expected },
  });
  try {
    assert.deepEqual(
      await bridgeRequest(channel, "/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "request_verification",
          arguments: { attempt_id: 1, summary: "Candidate" },
        },
      }),
      expected,
    );
    assert.equal(captured, 1);
    assert.equal(committed, 0);
  } finally {
    await bridge.close();
  }
});

test("an unknown verification response stops inference instead of authorizing a retry", async () => {
  const channel = path.join(mkdtempSync(path.join(tmpdir(), "scb-")), "channel");
  const failures = [];
  const bridge = await createTrialBridge({
    channel,
    arm: "mcp",
    submit: async () => ({
      commit: assert.fail,
      uncertain: (error) => failures.push(error.message),
    }),
    mcp: {
      request: async () => {
        throw new Error("Lost transport");
      },
    },
  });
  try {
    await assert.rejects(
      bridgeRequest(channel, "/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "request_verification",
          arguments: { attempt_id: 1, summary: "Candidate" },
        },
      }),
      /Lost transport/,
    );
    assert.deepEqual(failures, ["Lost transport"]);
  } finally {
    await bridge.close();
  }
});
