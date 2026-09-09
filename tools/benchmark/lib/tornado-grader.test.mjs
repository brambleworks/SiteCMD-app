import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeTornado } from "../guest/tornado-grader.mjs";

function observed(input, unsafe = false) {
  if (input.operation === "public-tests")
    return { exitCode: 0, stderr: "Ran 41 tests in 0.2s\n\nOK\n" };
  return {
    responses: input.requests.map((request) => {
      let status = 200;
      let headers = {};
      let body = request.path.includes("asset.txt") ? input.asset : input.index;
      if (request.path.startsWith("//")) {
        status = unsafe ? 301 : 403;
        body = "";
        if (unsafe) headers.location = request.path + "/";
      } else if (request.path === "/dir") {
        status = 301;
        headers.location = "/dir/";
        body = "";
      } else if (request.path === "/missing") {
        status = 404;
        body = "";
      } else if (request.path.includes("../")) {
        status = 403;
        body = "";
      }
      if (request.method === "HEAD") body = "";
      return { status, headers, body };
    }),
  };
}

test("Tornado qualification distinguishes the historical defect from a safe implementation", () => {
  const safe = gradeTornado("/not-executed", (_item, _candidate, input) => observed(input));
  assert.equal(safe.acceptancePass, true);
  assert.equal(safe.regressionsPass, true);
  const unsafe = gradeTornado("/not-executed", (_item, _candidate, input) => observed(input, true));
  assert.equal(unsafe.acceptancePass, false);
  assert.equal(unsafe.regressionsPass, true);
});

test("Tornado qualification rejects blocked functionality, errors and empty public suites", () => {
  for (const response of [{}, { error: "CandidateProcessError" }, { status: 500 }]) {
    const result = gradeTornado("/not-executed", () => response);
    assert.equal(result.acceptancePass, false);
    assert.equal(result.regressionsPass, false);
  }
  const blocked = gradeTornado("/not-executed", (_item, _candidate, input) =>
    input.operation === "public-tests"
      ? { exitCode: 0, stderr: "Ran 0 tests in 0s\n\nOK\n" }
      : { responses: input.requests.map(() => ({ status: 403, headers: {}, body: "" })) },
  );
  assert.equal(blocked.acceptancePass, true);
  assert.equal(blocked.regressionsPass, false);
});

test("Tornado qualification rejects protocol-relative destinations even on the same host", () => {
  const result = gradeTornado("/not-executed", (_item, _candidate, input) => {
    const result = observed(input);
    if (result.responses)
      result.responses[0] = {
        status: 301,
        headers: { location: "//sitecmd.example/dir/" },
        body: "",
      };
    return result;
  });
  assert.equal(result.acceptancePass, false);
});
