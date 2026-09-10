import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chownSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { digest } from "../lib/workflow-plan.mjs";
import { runtimeTreeDigest } from "../lib/repository-runtime.mjs";
import { verifyLinkdingRuntime } from "./linkding-runtime.mjs";

if (process.platform !== "linux" || process.arch !== "arm64" || process.getuid() !== 0)
  throw new Error("Runtime installation requires the isolated ARM64 guest controller");
const manifest = JSON.parse(
  readFileSync(new URL("../cases/linkding-runtime.json", import.meta.url)),
);
const definition = JSON.parse(
  readFileSync(new URL("../cases/linkding-calibration.json", import.meta.url)),
);
const id = digest(manifest);
const files = JSON.parse(readFileSync(0, "utf8"));
if (
  id !== definition.runtimeManifestSha256 ||
  Object.keys(files).sort().join(",") !== "pyproject.toml,uv.lock" ||
  digest(files["pyproject.toml"]) !== manifest.pyprojectSha256 ||
  digest(files["uv.lock"]) !== manifest.lockSha256
)
  throw new Error("Runtime inputs differ from the pinned Linkding case");
const installationId = randomBytes(12).toString("hex");
const parent = `/opt/sitecmd-benchmark/repository-runtimes/${id}`;
const root = `${parent}/${installationId}`;
const logs = [];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  logs.push({
    command,
    args,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
function write(name, content) {
  writeFileSync(`${root}/${name}`, content, { flag: "wx", mode: 0o644 });
}
mkdirSync(parent, { recursive: true, mode: 0o755 });
mkdirSync(root, { mode: 0o755 });
try {
  for (const [name, artifact] of Object.entries({ uv: manifest.uv, python: manifest.python })) {
    const result = spawnSync("curl", ["-fsSL", "--max-time", "180", artifact.url], {
      timeout: 190000,
      maxBuffer: 100 * 1024 * 1024,
    });
    if (result.status !== 0 || digest(result.stdout) !== artifact.sha256)
      throw new Error(`Download integrity failed: ${name}`);
    write(`${name}.tar.gz`, result.stdout);
    run("tar", ["-xzf", `${root}/${name}.tar.gz`, "-C", root]);
  }
  mkdirSync(`${root}/project`, { mode: 0o755 });
  for (const [name, content] of Object.entries(files)) write(`project/${name}`, content);
  write("build-requirements.txt", manifest.buildRequirements);
  mkdirSync(`${root}/environment`, { mode: 0o755 });
  chownSync(
    `${root}/environment`,
    Number(run("id", ["-u", "builder"]).trim()),
    Number(run("id", ["-g", "builder"]).trim()),
  );
  const uv = `${root}/uv-aarch64-unknown-linux-gnu/uv`;
  const uvRun = (args) =>
    run("systemd-run", [
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
      "--property=User=builder",
      "--property=MemoryMax=2G",
      "--property=TasksMax=64",
      "--property=RuntimeMaxSec=600",
      "env",
      "UV_PYTHON_DOWNLOADS=never",
      `UV_PROJECT_ENVIRONMENT=${root}/environment/venv`,
      `UV_CACHE_DIR=${root}/environment/cache`,
      "UV_NO_CONFIG=1",
      "PYTHONDONTWRITEBYTECODE=1",
      "UV_LINK_MODE=copy",
      `LIBRARY_PATH=${root}/${manifest.pythonLibraryDirectory}`,
      ...Object.entries(manifest.compiler).map(([key, value]) => `${key}=${value}`),
      uv,
      ...args,
    ]);
  uvRun(["venv", "--python", `${root}/python/bin/python3.13`, `${root}/environment/venv`]);
  uvRun([
    "pip",
    "install",
    "--python",
    `${root}/environment/venv/bin/python`,
    "--require-hashes",
    "--no-deps",
    "--only-binary",
    ":all:",
    "-r",
    `${root}/build-requirements.txt`,
  ]);
  const syncArgs = [
    "sync",
    "--locked",
    "--no-install-project",
    "--no-build-isolation",
    "--inexact",
    "--python",
    `${root}/python/bin/python3.13`,
    "--project",
    `${root}/project`,
  ];
  uvRun(syncArgs);
  run("chown", ["-R", "root:root", `${root}/environment`]);
  run("chmod", ["-R", "go-w", root]);
  const inventory = JSON.parse(
    run(`${root}/environment/venv/bin/python`, [
      "-B",
      "-c",
      "import json, sys, sqlite3; from importlib.metadata import distributions; print(json.dumps({'python':sys.version,'sqlite':sqlite3.sqlite_version,'packages':sorted([{'name':x.metadata['Name'],'version':x.version} for x in distributions()],key=lambda x:x['name'])}))",
    ]),
  );
  const installation = {
    schemaVersion: 1,
    id,
    installationId,
    directory: root,
    manifest,
    syncArgs,
    inventory,
    createdAt: new Date().toISOString(),
  };
  write("receipt.json", JSON.stringify(installation));
  const content = { ...installation, treeSha256: runtimeTreeDigest(root, { requireRoot: true }) };
  const runtime = { ...content, sha256: digest(content) };
  write("runtime-frozen.json", JSON.stringify(runtime));
  console.log(JSON.stringify(verifyLinkdingRuntime(runtime)));
} finally {
  write("setup-log.json", JSON.stringify(logs));
}
