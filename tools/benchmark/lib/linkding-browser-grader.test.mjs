import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeLinkdingBrowser } from "../guest/linkding-browser-grader.mjs";

const assets = Array.from({ length: 4 }, (_, i) => ({ marker: `nonce-${i}`, base64: `body-${i}` }));
function observation() {
  return {
    capabilities: { browserName: "MiniBrowser", browserVersion: "2.52.6" },
    sandbox: [{ seccomp: "2", noNewPrivileges: "1", separateMountNamespace: true }],
    resources: { "pids.events": "max 0\n", "memory.events": "max 0\noom 0\noom_kill 0\n" },
    control: {
      marker: "control-nonce",
      executed: true,
      cookieAccessible: true,
      storageAccessible: true,
    },
    assets: [...assets, assets[0], assets[0]].map((asset) => ({
      marker: asset.marker,
      rendered: true,
      executed: false,
      cookieError: "SecurityError",
      storageError: "SecurityError",
      http: { status: 200, base64: asset.base64 },
    })),
  };
}

test("Browser grading requires rendered Django assets, live controls and actual sandbox enforcement", () => {
  const fixed = gradeLinkdingBrowser(observation(), assets, "nonce");
  assert.equal(fixed.acceptancePass, true);
  assert.equal(fixed.regressionsPass, true);
  const broken = observation();
  broken.assets[0] = { ...broken.assets[0], executed: true, cookieError: null, storageError: null };
  const grade = gradeLinkdingBrowser(broken, assets, "nonce");
  assert.equal(grade.acceptancePass, false);
  assert.equal(grade.regressionsPass, true);
});

test("Browser failure, a nonfunctional control or a blank page cannot count as a repair", () => {
  for (const observed of [
    {},
    { error: "BrowserLaunchError" },
    ...[
      (value) => {
        value.control.executed = false;
      },
      (value) => {
        value.control.storageAccessible = false;
      },
      (value) => {
        value.assets.pop();
      },
      (value) => {
        value.assets[0].marker = "";
      },
      (value) => {
        value.assets[0].http.status = 404;
      },
      (value) => {
        value.assets[0].http.base64 = "";
      },
      (value) => {
        value.assets[0].rendered = false;
      },
      (value) => {
        value.capabilities.browserVersion = "unknown";
      },
      (value) => {
        value.sandbox = [];
      },
      (value) => {
        value.sandbox[0].seccomp = "0";
      },
      (value) => {
        value.sandbox[0].separateMountNamespace = false;
      },
      (value) => {
        value.error = "IncompleteObservation";
      },
      (value) => {
        value.resources["pids.events"] = "max 1\n";
      },
      (value) => {
        value.resources["memory.events"] = "max 0\noom 1\noom_kill 1\n";
      },
      (value) => {
        delete value.resources;
      },
    ].map((mutate) => {
      const value = observation();
      mutate(value);
      return value;
    }),
  ]) {
    const grade = gradeLinkdingBrowser(observed, assets, "nonce");
    assert.equal(grade.acceptancePass, false);
    assert.equal(grade.regressionsPass, false);
  }
});

test("Baseline reproduction requires every asset to execute and access both storage controls", () => {
  const baseline = observation();
  for (const asset of baseline.assets) {
    Object.assign(asset, {
      executed: true,
      cookieAccessible: true,
      storageAccessible: true,
      cookieError: null,
      storageError: null,
    });
  }
  assert.equal(gradeLinkdingBrowser(baseline, assets, "nonce").unprotected, true);
  baseline.assets[1].cookieAccessible = false;
  assert.equal(gradeLinkdingBrowser(baseline, assets, "nonce").unprotected, false);
});
