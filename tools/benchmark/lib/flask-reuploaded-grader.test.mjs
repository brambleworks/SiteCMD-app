import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeFlaskReuploaded } from "../guest/flask-reuploaded-grader.mjs";

function outcome({ result = null, error = null, inside = [], outside = [] } = {}) {
  return { result, error, inside, outside };
}

function nameBoundaryObservation(safe) {
  const confined = outcome({ result: "safe.txt", inside: ["safe.txt"] });
  const escaped = outcome({ result: "../../escape.txt", outside: ["escape.txt"] });
  return {
    publicTests: { exitCode: 0, tests: 32, log: "32 passed" },
    traversalName: safe ? confined : escaped,
    absoluteName: safe ? confined : escaped,
    traversalFolder: safe ? confined : escaped,
    symlinkFolder: safe ? outcome({ error: "ValueError" }) : escaped,
    disallowedExtension: safe
      ? outcome({ error: "UploadNotAllowed" })
      : outcome({ result: "backdoor.py", inside: ["backdoor.py"] }),
    emptyName: safe
      ? outcome({ error: "ValueError" })
      : outcome({ result: "...", inside: ["..."] }),
    windowsSeparators: safe
      ? outcome({ result: "temp_evil.txt", inside: ["temp_evil.txt"] })
      : outcome({ result: "..\\temp\\evil.txt", inside: ["..\\temp\\evil.txt"] }),
    ordinaryDefault: outcome({ result: "photo.jpg", inside: ["photo.jpg"] }),
    ordinaryCustom: outcome({ result: "renamed.txt", inside: ["renamed.txt"] }),
    explicitFolder: outcome({ result: "users/photo.jpg", inside: ["users/photo.jpg"] }),
    implicitFolder: outcome({ result: "users/avatar.jpg", inside: ["users/avatar.jpg"] }),
    placeholder: outcome({ result: "image.jpg", inside: ["image.jpg"] }),
    collision: outcome({ result: "photo_1.jpg", inside: ["photo.jpg", "photo_1.jpg"] }),
  };
}

function casefoldObservation(safe) {
  return {
    publicTests: { exitCode: 0, tests: 48, log: "48 passed" },
    blockedPhp: safe
      ? outcome({ error: "UploadNotAllowed" })
      : outcome({ result: "backdoor.PHP", inside: ["backdoor.PHP"] }),
    blockedMixedScript: safe
      ? outcome({ error: "UploadNotAllowed" })
      : outcome({ result: "backdoor.Js", inside: ["backdoor.Js"] }),
    allowedImage: safe
      ? outcome({ result: "photo.jpg", inside: ["photo.jpg"] })
      : outcome({ error: "UploadNotAllowed" }),
    defaultName: outcome({ result: "PHOTO.jpg", inside: ["PHOTO.jpg"] }),
    lowerCustom: outcome({ result: "photo.jpg", inside: ["photo.jpg"] }),
    placeholder: outcome({ result: "photo.jpg", inside: ["photo.jpg"] }),
    collision: outcome({ result: "photo_1.jpg", inside: ["photo.jpg", "photo_1.jpg"] }),
    explicitFolder: outcome({ result: "users/photo.jpg", inside: ["users/photo.jpg"] }),
  };
}

test("name-boundary grading separates escapes from ordinary upload behavior", () => {
  for (const safe of [false, true]) {
    const result = gradeFlaskReuploaded(
      "flask-reuploaded-name-boundary",
      "/not-executed",
      (_item, _candidate, input) => {
        assert.equal(input.operation, "flask-reuploaded-name-boundary");
        return nameBoundaryObservation(safe);
      },
    );
    assert.equal(result.acceptancePass, safe);
    assert.equal(result.regressionsPass, true);
  }
});

test("extension-casefold grading requires blocked scripts and normalized allowed names", () => {
  for (const safe of [false, true]) {
    const result = gradeFlaskReuploaded(
      "flask-reuploaded-extension-casefold",
      "/not-executed",
      (_item, _candidate, input) => {
        assert.equal(input.operation, "flask-reuploaded-extension-casefold");
        return casefoldObservation(safe);
      },
    );
    assert.equal(result.acceptancePass, safe);
    assert.equal(result.regressionsPass, true);
  }
});

test("the default-name control uses the repaired contract as acceptance", () => {
  const result = gradeFlaskReuploaded(
    "flask-reuploaded-default-name-control",
    "/not-executed",
    () => casefoldObservation(true),
  );
  assert.equal(result.acceptancePass, true);
  assert.equal(result.regressionsPass, true);
});

test("Flask-Reuploaded grading requires the existing test suite", () => {
  const observed = nameBoundaryObservation(true);
  observed.publicTests = { exitCode: 1, tests: 32, log: "1 failed, 31 passed" };
  const result = gradeFlaskReuploaded(
    "flask-reuploaded-name-boundary",
    "/not-executed",
    () => observed,
  );
  assert.equal(result.acceptancePass, true);
  assert.equal(result.regressionsPass, false);
});
