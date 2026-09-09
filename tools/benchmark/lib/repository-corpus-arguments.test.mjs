import assert from "node:assert/strict";
import { test } from "node:test";
import { repositoryCorpusArguments } from "./repository-corpus-arguments.mjs";

test("repository corpus screening maps every repository explicitly", () => {
  const result = repositoryCorpusArguments(
    [
      "cases.json",
      "screening-output",
      "--repository",
      "application-one=/sources/application-one.git",
      "--repository",
      "application-two=/sources/application-two.git",
    ],
    ["application-one", "application-two"],
  );
  assert.equal(result.intake, "cases.json");
  assert.equal(result.output, "screening-output");
  assert.deepEqual(
    [...result.repositories],
    [
      ["application-one", "/sources/application-one.git"],
      ["application-two", "/sources/application-two.git"],
    ],
  );
});

test("repository corpus screening rejects missing, extra, duplicate, or malformed mappings", () => {
  const repositoryIds = ["application-one", "application-two"];
  for (const args of [
    ["cases.json", "output", "--repository", "application-one=/sources/one.git"],
    [
      "cases.json",
      "output",
      "--repository",
      "application-one=/sources/one.git",
      "--repository",
      "application-two=/sources/two.git",
      "--repository",
      "application-three=/sources/three.git",
    ],
    [
      "cases.json",
      "output",
      "--repository",
      "application-one=/sources/one.git",
      "--repository",
      "application-one=/sources/other.git",
    ],
    [
      "cases.json",
      "output",
      "--repository",
      "application-one",
      "--repository",
      "application-two=/sources/two.git",
    ],
  ])
    assert.throws(() => repositoryCorpusArguments(args, repositoryIds), /repository mapping/i);
});

test("repository corpus screening requires intake and new output paths", () => {
  assert.throws(() => repositoryCorpusArguments([], []), /Usage:/);
  assert.throws(() => repositoryCorpusArguments(["cases.json"], []), /Usage:/);
});
