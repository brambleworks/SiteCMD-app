import { readFileSync, realpathSync } from "node:fs";
import { runtimeTreeDigest } from "../lib/repository-runtime.mjs";
import { digest } from "../lib/workflow-plan.mjs";

export function verifyWhoogleRuntime(runtime) {
  const definition = JSON.parse(
    readFileSync(new URL("../cases/whoogle-calibration.json", import.meta.url)),
  );
  const id = definition.runtimeManifestSha256;
  if (!/^[a-f0-9]{24}$/.test(runtime?.installationId))
    throw new Error("Whoogle qualification requires a distinct runtime installation identity");
  const directory = `/opt/sitecmd-benchmark/repository-runtimes/${id}/${runtime.installationId}`;
  if (
    runtime.schemaVersion !== 1 ||
    runtime.id !== id ||
    runtime.directory !== directory ||
    runtime.lockedRequirementsSha256 !== runtime.manifest?.lockSha256
  )
    throw new Error("Whoogle qualification requires its frozen runtime receipt");
  const { sha256, treeSha256, ...installation } = runtime;
  if (
    sha256 !== digest({ ...installation, treeSha256 }) ||
    digest(runtime.manifest) !== id ||
    runtime.manifest.sourceSha256 !== definition.baseline.sha256 ||
    realpathSync(directory) !== directory ||
    digest(JSON.parse(readFileSync(`${directory}/receipt.json`))) !== digest(installation) ||
    runtimeTreeDigest(directory, { requireRoot: true }) !== treeSha256
  )
    throw new Error("Whoogle runtime changed after it was frozen");
  return runtime;
}
