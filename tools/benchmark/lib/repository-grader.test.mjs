import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeRepository } from "../guest/repository-grader.mjs";

function observation(input, header, browser) {
  if (input.operation === "public-tests")
    return {
      testsRun: 28,
      failures: 0,
      errors: 0,
      skipped: 0,
      unexpectedSuccesses: 0,
      expectedFailures: 0,
    };
  if (input.operation === "browser")
    return {
      capabilities: { browserName: "MiniBrowser", browserVersion: "2.52.6" },
      sandbox: [{ seccomp: "2", noNewPrivileges: "1", separateMountNamespace: true }],
      resources: { "pids.events": "max 0\n", "memory.events": "max 0\noom 0\noom_kill 0\n" },
      control: {
        marker: `control-${input.nonce}`,
        executed: true,
        cookieAccessible: true,
        storageAccessible: true,
      },
      assets: [...input.assets, input.assets[0], input.assets[0]].map((asset) => ({
        marker: asset.marker,
        rendered: true,
        executed: !browser,
        cookieError: browser ? "SecurityError" : null,
        storageError: browser ? "SecurityError" : null,
        cookieAccessible: !browser,
        storageAccessible: !browser,
        http: { status: 200, base64: asset.base64 },
      })),
    };
  const asset = (item) => ({
    status: 200,
    headers: {
      "content-security-policy": header ? "sandbox" : "",
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

test("repository grading requires both Linkding response and browser protection", () => {
  const item = {
    id: "linkding-asset-sandbox",
    repositoryRuntime: { fixture: "Python identity" },
    browserRuntime: { fixture: "browser identity" },
  };
  for (const [header, browser] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ]) {
    const result = gradeRepository(item, "/not-executed", (context, _candidate, input) => {
      assert.deepEqual(context.repositoryRuntime, item.repositoryRuntime);
      if (input.operation === "browser")
        assert.deepEqual(context.browserRuntime, item.browserRuntime);
      return observation(input, header, browser);
    });
    assert.equal(result.acceptancePass, header && browser);
    assert.equal(result.regressionsPass, true);
    assert.equal(result.browser.unprotected, !browser);
    assert.equal(result.runtimeSha256.length, 64);
    assert.equal(result.browserRuntimeSha256.length, 64);
  }
});

function whoogleObservation(input, safe) {
  assert.equal(input.operation, "config-paths");
  const response = (status, body = "", location = null) => ({ status, body, location });
  return {
    security: {
      traversalWrite: { response: response(safe ? 400 : 302), outsideExists: !safe },
      absoluteWrite: { response: response(safe ? 400 : 302), outsideExists: !safe },
      traversalRead: response(safe ? 400 : 200, safe ? "" : input.readMarker),
      absoluteRead: response(safe ? 400 : 200, safe ? "" : input.readMarker),
      invalidNames: [response(safe ? 400 : 500), response(safe ? 400 : 302)],
    },
    ordinary: {
      unnamedSave: response(302, "", "/ordinary"),
      unnamedGet: response(200, JSON.stringify({ url: "/ordinary", theme: "dark" })),
      namedSave: { response: response(302), insideExists: true },
      namedLoad: response(200, JSON.stringify({ url: "/named", theme: "light" })),
      disabled: response(403),
      afterRejected: response(200, JSON.stringify({ url: "/named", theme: "light" })),
    },
  };
}

test("repository grading recognizes Whoogle path confinement without weakening normal config use", () => {
  const runtime = { fixture: "Python identity" };
  for (const safe of [false, true]) {
    const result = gradeRepository(
      { id: "whoogle-named-config-path", repositoryRuntime: runtime },
      "/not-executed",
      (item, _candidate, input) => {
        assert.deepEqual(item.repositoryRuntime, runtime);
        return whoogleObservation(input, safe);
      },
    );
    assert.equal(result.acceptancePass, safe);
    assert.equal(result.regressionsPass, true);
    assert.equal(result.runtimeSha256.length, 64);
  }
});

test("repository grading dispatches Flask-Reuploaded controls through their frozen runtime", () => {
  const saved = (result, inside = [result]) => ({
    result,
    error: null,
    inside,
    outside: [],
  });
  const blocked = { result: null, error: "UploadNotAllowed", inside: [], outside: [] };
  const runtime = { fixture: "Flask-Reuploaded runtime" };
  const result = gradeRepository(
    {
      id: "flask-reuploaded-default-name-control",
      repository: "flask-reuploaded",
      repositoryRuntime: runtime,
    },
    "/not-executed",
    (item) => {
      assert.deepEqual(item.repositoryRuntime, runtime);
      return {
        publicTests: { exitCode: 0, tests: 48, log: "48 passed" },
        blockedPhp: blocked,
        blockedMixedScript: blocked,
        allowedImage: saved("photo.jpg"),
        defaultName: saved("PHOTO.jpg"),
        lowerCustom: saved("photo.jpg"),
        placeholder: saved("photo.jpg"),
        collision: saved("photo_1.jpg", ["photo.jpg", "photo_1.jpg"]),
        explicitFolder: saved("users/photo.jpg"),
      };
    },
  );
  assert.equal(result.acceptancePass, true);
  assert.equal(result.regressionsPass, true);
  assert.equal(result.runtimeSha256.length, 64);
});
