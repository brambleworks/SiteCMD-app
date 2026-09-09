import { readFileSync, realpathSync } from "node:fs";
import { runtimeTreeDigest } from "../lib/repository-runtime.mjs";
import { digest } from "../lib/workflow-plan.mjs";

export function verifyFlaskReuploadedRuntime(runtime) {
  const manifest = JSON.parse(
    readFileSync(new URL("../cases/flask-reuploaded-runtime.json", import.meta.url)),
  );
  const id = digest(manifest);
  if (!/^[a-f0-9]{24}$/.test(runtime?.installationId))
    throw new Error(
      "Flask-Reuploaded qualification requires a distinct runtime installation identity",
    );
  const directory = `/opt/sitecmd-benchmark/repository-runtimes/${id}/${runtime.installationId}`;
  const packages = Object.fromEntries(
    (runtime.inventory?.packages ?? []).map((item) => [item.name, item.version]),
  );
  if (
    runtime.schemaVersion !== 1 ||
    runtime.id !== id ||
    runtime.directory !== directory ||
    runtime.lockedRequirementsSha256 !== manifest.lockSha256 ||
    digest(packages) !== digest(manifest.expectedPackages)
  )
    throw new Error("Flask-Reuploaded qualification requires its frozen runtime receipt");
  const { sha256, treeSha256, ...installation } = runtime;
  if (
    sha256 !== digest({ ...installation, treeSha256 }) ||
    digest(runtime.manifest) !== id ||
    realpathSync(directory) !== directory ||
    digest(JSON.parse(readFileSync(`${directory}/receipt.json`))) !== digest(installation) ||
    runtimeTreeDigest(directory, { requireRoot: true }) !== treeSha256
  )
    throw new Error("Flask-Reuploaded runtime changed after it was frozen");
  return runtime;
}
