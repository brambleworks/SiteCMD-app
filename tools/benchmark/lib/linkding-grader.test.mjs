import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeLinkding } from "../guest/linkding-grader.mjs";

function observation(input, policy = "sandbox") {
  if (input.operation === "public-tests")
    return {
      testsRun: 28,
      failures: 0,
      errors: 0,
      skipped: 0,
      unexpectedSuccesses: 0,
      expectedFailures: 0,
    };
  const asset = (item) => ({
    status: 200,
    headers: {
      "content-security-policy": policy,
      "content-type": item.contentType,
      "content-disposition": `inline; filename="${item.filename}"`,
    },
    base64: item.base64,
  });
  return {
    assets: input.assets.map(asset),
    privateOther: { status: 404 },
    privateGuest: { status: 404 },
    missing: { status: 404 },
    missingFile: { status: 404 },
    shared: asset(input.assets[0]),
    public: asset(input.assets[0]),
    head: { ...asset(input.assets[0]), base64: "" },
  };
}

test("Linkding grading separates sandbox protection from working asset delivery", () => {
  const execute = (policy) => (_item, _candidate, input) => observation(input, policy);
  const fixed = gradeLinkding("/not-executed", execute("sandbox"));
  assert.equal(fixed.acceptancePass, true);
  assert.equal(fixed.regressionsPass, true);
  const broken = gradeLinkding("/not-executed", execute("default-src 'self'"));
  assert.equal(broken.acceptancePass, false);
  assert.equal(broken.regressionsPass, true);
});

test("Linkding grading rejects weakened policies, missing responses and incomplete public suites", () => {
  for (const policy of [
    undefined,
    "sandbox allow-scripts",
    "sandbox allow-same-origin",
    "sandbox allow-forms; sandbox",
  ])
    assert.equal(
      gradeLinkding("/not-executed", (_item, _path, input) => observation(input, policy ?? ""))
        .acceptancePass,
      false,
    );
  for (const response of [{}, { error: "CandidateProcessError" }]) {
    const grade = gradeLinkding("/not-executed", () => response);
    assert.equal(grade.acceptancePass, false);
    assert.equal(grade.regressionsPass, false);
  }
  for (const update of [
    { testsRun: 0 },
    { testsRun: 27 },
    { skipped: 1 },
    { expectedFailures: 1 },
  ]) {
    const grade = gradeLinkding("/not-executed", (_item, _path, input) => {
      const result = observation(input);
      return input.operation === "public-tests" ? { ...result, ...update } : result;
    });
    assert.equal(grade.regressionsPass, false);
  }
});

test("Linkding grading honors separate enforced policies and the first repeated directive", () => {
  for (const policy of [
    "sandbox, default-src 'self'",
    "sandbox allow-scripts, sandbox",
    " SANDBOX ; sandbox allow-scripts",
  ])
    assert.equal(
      gradeLinkding("/not-executed", (_item, _path, input) => observation(input, policy))
        .acceptancePass,
      true,
    );
  for (const policy of [
    "sandbox allow-scripts; sandbox",
    "sandbox allow-downloads",
    "sandbox\u00a0",
    "sandboxed",
  ])
    assert.equal(
      gradeLinkding("/not-executed", (_item, _path, input) => observation(input, policy))
        .acceptancePass,
      false,
    );
});

test("A report-only policy or an unprotected HEAD response does not satisfy the header contract", () => {
  for (const transform of [
    (value) => {
      for (const response of [...value.assets, value.head, value.shared, value.public]) {
        response.headers["content-security-policy-report-only"] = "sandbox";
        delete response.headers["content-security-policy"];
      }
    },
    (value) => {
      delete value.head.headers["content-security-policy"];
    },
  ]) {
    const grade = gradeLinkding("/not-executed", (_item, _path, input) => {
      const value = observation(input);
      if (input.operation === "assets") transform(value);
      return value;
    });
    assert.equal(grade.acceptancePass, false);
    assert.equal(grade.regressionsPass, true);
  }
});
