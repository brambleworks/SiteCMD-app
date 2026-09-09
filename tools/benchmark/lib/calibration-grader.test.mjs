import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeCase } from "../guest/calibration-grader.mjs";
import { calibrationCases } from "./calibration-cases.mjs";

function gradeRedirect(destination) {
  return gradeCase({ id: "redirect-destination" }, "/not-executed", (_item, _path, input) => {
    if (input.operation === "public-tests") return { exitCode: 0 };
    const url = new URL(input.url);
    return { status: 302, headers: { location: destination(url).href } };
  });
}

test("redirect grading detects an external destination introduced by a second URL resolution", () => {
  const result = gradeRedirect((url) => {
    const next = url.searchParams.get("next") ?? "/dashboard";
    if (!/^\/(?![/\\])/.test(next)) return new URL("/dashboard", url.origin);
    const parsed = new URL(next, url.origin);
    if (parsed.origin !== url.origin) return new URL("/dashboard", url.origin);
    return new URL(parsed.pathname + parsed.search + parsed.hash, url.origin);
  });
  assert.equal(result.regressionsPass, false);
});

test("redirect grading rejects normalized same-origin network paths and leading controls", () => {
  for (const stripFirst of [false, true]) {
    const result = gradeRedirect((url) => {
      const raw = url.searchParams.get("next") ?? "/dashboard";
      const next = stripFirst ? raw.replace(/[\t\n\r]/g, "") : raw;
      const fallback = new URL("/dashboard", url.origin);
      if (!/^\/(?![/\\])/.test(next)) return fallback;
      const parsed = new URL(next, url.origin);
      return parsed.origin === url.origin ? parsed : fallback;
    });
    assert.equal(result.acceptancePass, false, `stripFirst=${stripFirst}`);
  }
});

test("download grading preserves filesystem roots and literal POSIX filenames", () => {
  for (const incompatible of [
    (input) => input.root === "/",
    (input) => input.args.path.includes("\\"),
    (input) => input.args.path.startsWith("C:"),
  ]) {
    const result = gradeCase(
      { id: "document-download" },
      "/not-executed",
      (_item, _path, input) => {
        if (input.operation === "public-tests") return { exitCode: 0 };
        if (incompatible(input)) return { error: "ValueError" };
        const name = input.args.path;
        if (name === "missing.txt") return { error: "FileNotFoundError" };
        if (
          ["../outside.txt", "nested/../../outside.txt", "/tmp/outside.txt", "escape"].includes(
            name,
          )
        )
          return { error: "PermissionError" };
        const suffix = name === "nested/guide.txt" ? " nested" : "";
        return { result: input.text + suffix };
      },
    );
    assert.equal(result.regressionsPass, false);
  }
});

test("download grading rejects non-regular files without accepting process failures", () => {
  const result = gradeCase({ id: "document-download" }, "/not-executed", (_item, _path, input) => {
    if (input.operation === "public-tests") return { exitCode: 0 };
    if (["nested", "pipe"].includes(input.args.path)) return { error: "CandidateProcessError" };
    return { error: "ValueError" };
  });
  assert.equal(result.acceptancePass, false);
});

test("every case rejects invalid output without dropping failed checks", () => {
  for (const item of calibrationCases) {
    const result = gradeCase(item, "/not-executed", () => ({}));
    assert.equal(result.acceptancePass, false);
    assert.equal(result.regressionsPass, false);
    assert.ok(result.acceptance.length >= 3);
    assert.ok(result.regressions.length >= 2);
  }
});

test("the negative control checks query behavior and record preservation", () => {
  const item = calibrationCases.find((item) => item.kind === "negative_control");
  const safe = gradeCase(item, "/not-executed", (_item, _path, input) =>
    input.operation === "public-tests"
      ? { exitCode: 0 }
      : {
          result: input.users.filter((row) => row[1] === input.args.name),
          remaining: input.users,
        },
  );
  assert.equal(safe.acceptancePass, true);
  assert.equal(safe.regressionsPass, true);
  const broken = gradeCase(item, "/not-executed", (_item, _path, input) =>
    input.operation === "public-tests"
      ? { exitCode: 0 }
      : {
          result: input.users.filter((row) => row[1] === input.args.name),
          remaining: [],
        },
  );
  assert.equal(broken.regressionsPass, false);
});
