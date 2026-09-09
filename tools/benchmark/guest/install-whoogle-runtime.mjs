import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chownSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { digest } from "../lib/workflow-plan.mjs";
import { runtimeTreeDigest } from "../lib/repository-runtime.mjs";
import { verifyWhoogleRuntime } from "./whoogle-runtime.mjs";

if (process.platform !== "linux" || process.arch !== "arm64" || process.getuid() !== 0)
  throw new Error("Runtime installation requires the isolated ARM64 guest controller");
const manifest = JSON.parse(
  readFileSync(new URL("../cases/whoogle-runtime.json", import.meta.url)),
);
const definition = JSON.parse(
  readFileSync(new URL("../cases/whoogle-calibration.json", import.meta.url)),
);
const id = digest(manifest);
const files = JSON.parse(readFileSync(0, "utf8"));
if (
  id !== definition.runtimeManifestSha256 ||
  Object.keys(files).join(",") !== "requirements.txt" ||
  digest(files["requirements.txt"]) !== manifest.requirementsSha256
)
  throw new Error("Runtime inputs differ from the pinned Whoogle case");
const installationId = randomBytes(12).toString("hex");
const parent = `/opt/sitecmd-benchmark/repository-runtimes/${id}`;
const root = `${parent}/${installationId}`;
const logs = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 8 * 1024 * 1024,
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
  mkdirSync(`${root}/environment`, { mode: 0o755 });
  mkdirSync(`${root}/cache`, { mode: 0o700 });
  write("project/requirements.txt", files["requirements.txt"]);
  const uid = Number(run("id", ["-u", "builder"]).trim());
  const gid = Number(run("id", ["-g", "builder"]).trim());
  for (const name of ["project", "environment", "cache"]) chownSync(`${root}/${name}`, uid, gid);
  const uv = `${root}/uv-aarch64-unknown-linux-gnu/uv`;
  const python = `${root}/python/bin/python${manifest.python.version.split(".").slice(0, 2).join(".")}`;
  const venv = `${root}/environment/venv`;
  const isolated = (args) =>
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
      "-i",
      "PATH=/usr/bin:/usr/local/bin",
      "UV_PYTHON_DOWNLOADS=never",
      `UV_CACHE_DIR=${root}/cache`,
      "UV_NO_CONFIG=1",
      "UV_LINK_MODE=copy",
      "PYTHONDONTWRITEBYTECODE=1",
      ...Object.entries(manifest.compiler).map(([key, value]) => `${key}=${value}`),
      uv,
      ...args,
    ]);
  isolated(["venv", "--python", python, venv]);
  const compileArgs = [
    "pip",
    "compile",
    `${root}/project/requirements.txt`,
    "--python",
    python,
    "--python-platform",
    "aarch64-manylinux_2_31",
    "--only-binary",
    ":all:",
    "--no-binary",
    "stem",
    "--generate-hashes",
    "--exclude-newer",
    manifest.dependencyCutoff,
    "--no-header",
    "--no-annotate",
    "--output-file",
    `${root}/project/locked-requirements.txt`,
  ];
  isolated(compileArgs);
  const lockedRequirementsSha256 = digest(readFileSync(`${root}/project/locked-requirements.txt`));
  if (lockedRequirementsSha256 !== manifest.lockSha256)
    throw new Error("Resolved Whoogle dependencies differ from the frozen lock");
  const installArgs = [
    "pip",
    "install",
    "--python",
    `${venv}/bin/python`,
    "--require-hashes",
    "--no-deps",
    "--only-binary",
    ":all:",
    "--no-binary",
    "stem",
    "--exclude-newer",
    manifest.dependencyCutoff,
    "-r",
    `${root}/project/locked-requirements.txt`,
  ];
  isolated(installArgs);
  run("chown", ["-R", "root:root", root]);
  run("chmod", ["-R", "go-w", root]);
  const inventory = JSON.parse(
    run(`${venv}/bin/python`, [
      "-B",
      "-c",
      "import json,sys; from importlib.metadata import distributions; print(json.dumps({'python':sys.version,'packages':sorted([{'name':d.metadata['Name'],'version':d.version} for d in distributions()],key=lambda x:x['name'].lower())}))",
    ]),
  );
  const installation = {
    schemaVersion: 1,
    id,
    installationId,
    directory: root,
    manifest,
    compileArgs,
    installArgs,
    lockedRequirementsSha256,
    inventory,
    createdAt: new Date().toISOString(),
  };
  write("receipt.json", JSON.stringify(installation));
  const content = { ...installation, treeSha256: runtimeTreeDigest(root, { requireRoot: true }) };
  const runtime = { ...content, sha256: digest(content) };
  write("runtime-frozen.json", JSON.stringify(runtime));
  console.log(JSON.stringify(verifyWhoogleRuntime(runtime)));
} catch (error) {
  write("failure.json", JSON.stringify({ error: error.message }));
  throw error;
} finally {
  write("setup-log.json", JSON.stringify(logs));
}
