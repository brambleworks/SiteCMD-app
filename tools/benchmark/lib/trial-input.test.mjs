import assert from "node:assert/strict";
import { test } from "node:test";
import { trialInput } from "../guest/trial-input.mjs";

test("Claude receives the repair prompt only after successful initialization is captured", () => {
  const output = [];
  const input = trialInput({
    agent: "claude",
    stdin: {
      write: (data) => output.push(JSON.parse(data)),
      end: (data) => output.push(JSON.parse(data)),
    },
    prompt: "Repair this fixture",
    initialized: () => output.push("captured"),
    fail: assert.fail,
  });
  assert.equal(output.length, 1);
  assert.equal(output[0].type, "control_request");
  const response =
    JSON.stringify({
      type: "control_response",
      response: { request_id: "benchmark-initialize", subtype: "success" },
    }) + "\n";
  input.write(Buffer.from(response.slice(0, 17)));
  assert.equal(output.length, 1);
  input.write(Buffer.from(response.slice(17)));
  assert.equal(output[1], "captured");
  assert.equal(output[2].message.content, "Repair this fixture");
  input.write(Buffer.from(response));
  assert.equal(output.length, 3);
});

test("initialization failure cannot release the prompt", () => {
  const failures = [];
  const input = trialInput({
    agent: "claude",
    stdin: { write() {}, end: () => assert.fail("Prompt released") },
    prompt: "Do not release",
    initialized: () => assert.fail("Unexpected success"),
    fail: (message) => failures.push(message),
  });
  input.write(
    Buffer.from(
      JSON.stringify({
        type: "control_response",
        response: {
          request_id: "benchmark-initialize",
          subtype: "error",
          error: "Not initialized",
        },
      }) + "\n",
    ),
  );
  assert.deepEqual(failures, ["Not initialized"]);
});
