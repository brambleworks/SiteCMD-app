import assert from "node:assert/strict";
import { test } from "node:test";
import { watchProviderEvents } from "../guest/trial-events.mjs";

test("startup selection is not proof that a model answered", () => {
  const observer = watchProviderEvents("claude-opus-5", assert.fail, "claude");
  observer.write(Buffer.from('{"type":"system","subtype":"init","model":"claude-opus-5"}\n'));
  observer.end();
  assert.deepEqual(observer.models(), []);
});

test("provider event observation preserves split UTF-8 and rejects model fallback", () => {
  const failures = [];
  const observer = watchProviderEvents(
    "claude-opus-5",
    (reason) => failures.push(reason),
    "claude",
  );
  const raw = Buffer.from(
    `${JSON.stringify({ type: "assistant", message: { id: "message-1", model: "claude-opus-5", content: "café" } })}\n`,
  );
  const split = raw.indexOf(Buffer.from("é")) + 1;
  observer.write(raw.subarray(0, split));
  observer.write(raw.subarray(split));
  assert.deepEqual(observer.models(), ["claude-opus-5"]);
  assert.deepEqual(failures, []);
  observer.write(
    Buffer.from('{"type":"assistant","message":{"id":"message-2","model":"another-model"}}\n'),
  );
  assert.match(failures[0], /model differs/);
});

test("rate limits stop execution and an absent model remains unknown", () => {
  const failures = [];
  const observer = watchProviderEvents("gpt-5.6-sol", (reason) => failures.push(reason), "codex");
  observer.write(Buffer.from('{"type":"turn.completed","usage":{"input_tokens":1}}\n'));
  assert.deepEqual(observer.models(), []);
  observer.write(
    Buffer.from('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\n'),
  );
  assert.match(failures[0], /rate limit/);
});

test("a conflicting startup configuration stops the trial without claiming a response", () => {
  const failures = [];
  const observer = watchProviderEvents(
    "claude-opus-5",
    (reason) => failures.push(reason),
    "claude",
  );
  observer.write(Buffer.from('null\n{"type":"system","subtype":"init","model":"different-model"}'));
  observer.end();
  assert.deepEqual(observer.models(), []);
  assert.match(failures[0], /selection differs/);
});
