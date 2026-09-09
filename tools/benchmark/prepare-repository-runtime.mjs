import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { exportPinnedTree } from "./lib/repository-snapshot.mjs";
import { deployHarness } from "./lib/vm-harness.mjs";
import { guestCommand, workRoot } from "./lib/vm-guest.mjs";
import { writeNewJson } from "./lib/workflow-store.mjs";

const [repository, destination, ...extra] = process.argv.slice(2);
if (!repository || !destination || extra.length)
  throw new Error(
    "Usage: node tools/benchmark/prepare-repository-runtime.mjs SOURCE_GIT NEW_RUNTIME_RECEIPT",
  );
const output = path.resolve(destination);
if (!output.startsWith(path.resolve(workRoot) + path.sep) || existsSync(output))
  throw new Error("Choose an unused runtime receipt path inside tools/benchmark/.work");
const definition = JSON.parse(
  readFileSync(new URL("./cases/linkding-calibration.json", import.meta.url)),
);
const source = exportPinnedTree(path.resolve(repository), definition.baseline.commit);
if (source.sha256 !== definition.baseline.sha256)
  throw new Error("Pinned Linkding source mismatch");
const files = Object.fromEntries(
  source.files
    .filter((file) => ["pyproject.toml", "uv.lock"].includes(file.name))
    .map((file) => [file.name, Buffer.from(file.base64, "base64").toString("utf8")]),
);
const harness = deployHarness();
console.log("Preparing Linkding's isolated, locked runtime; no model calls.");
const runtime = JSON.parse(
  guestCommand(
    [
      "sudo",
      "flock",
      "--nonblock",
      "/run/sitecmd-benchmark-execution.lock",
      "node",
      `${harness.directory}/install-linkding-runtime.mjs`,
    ],
    { input: JSON.stringify(files), capture: true, timeout: 1000000, maxBuffer: 8 * 1024 * 1024 },
  ),
);
writeNewJson(output, runtime);
writeNewJson(`${output}.harness.json`, harness);
console.log(`Runtime receipt: ${output}`);
