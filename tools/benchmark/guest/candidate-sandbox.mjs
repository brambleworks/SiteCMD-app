import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyLinkdingRuntime } from "./linkding-runtime.mjs";
import { verifyWhoogleRuntime } from "./whoogle-runtime.mjs";
import { verifyFlaskReuploadedRuntime } from "./flask-reuploaded-runtime.mjs";
import { verifyBrowserRuntime } from "./browser-runtime.mjs";
import { leaseBrowserInputs } from "./browser-inputs.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
export function executeCandidate(item, candidate, input) {
  if (process.platform !== "linux" || process.getuid() !== 0)
    throw new Error("Candidate execution requires the isolated guest controller");
  const node = item.runtime === "node";
  const linkding = item.id === "linkding-asset-sandbox";
  const whoogle = item.id === "whoogle-named-config-path";
  const flaskReuploaded = item.repository === "flask-reuploaded";
  const confirmatory = item.confirmatory === true;
  const browser = linkding && input.operation === "browser";
  const runtime = linkding
    ? verifyLinkdingRuntime(item.repositoryRuntime)
    : whoogle
      ? verifyWhoogleRuntime(item.repositoryRuntime)
      : flaskReuploaded
        ? verifyFlaskReuploadedRuntime(item.repositoryRuntime)
        : null;
  if (browser) verifyBrowserRuntime(item.browserRuntime);
  const lease = browser ? leaseBrowserInputs(candidate) : null;
  const unit = browser ? `sitecmd-browser-${randomBytes(12).toString("hex")}` : null;
  const adapter = linkding
    ? "linkding-candidate.py"
    : whoogle
      ? "whoogle-candidate.py"
      : flaskReuploaded
        ? "flask-reuploaded-candidate.py"
        : confirmatory
          ? node
            ? "confirmatory-node-candidate.mjs"
            : "confirmatory-python-candidate.py"
          : item.id === "tornado-static-redirect"
            ? "tornado-candidate.py"
            : node
              ? "node-candidate.mjs"
              : "python-candidate.py";
  const args = [
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    ...(browser ? ["--property=User=grader", `--unit=${unit}`] : []),
    `--property=MemoryMax=${browser ? "1G" : "512M"}`,
    `--property=TasksMax=${browser ? 256 : 32}`,
    `--property=RuntimeMaxSec=${browser ? 90 : linkding ? 40 : whoogle || flaskReuploaded ? 30 : confirmatory ? 20 : 8}`,
    "bwrap",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/lib",
    "/lib",
    "--ro-bind",
    lease?.source ?? candidate,
    "/work",
    "--ro-bind",
    path.join(lease?.directory ?? directory, adapter),
    "/adapter",
    ...(node ? ["--ro-bind", realpathSync("/usr/local/bin/node"), "/node"] : []),
    ...(confirmatory && node
      ? [
          "--dir",
          "/compiler",
          "--ro-bind",
          path.join(directory, "../vendor/typescript.cjs"),
          "/compiler/typescript.cjs",
        ]
      : []),
    ...(runtime
      ? ["python", "environment/venv"].flatMap((part) => [
          "--ro-bind",
          `${runtime.directory}/${part}`,
          `${runtime.directory}/${part}`,
        ])
      : []),
    ...(browser
      ? [
          "--symlink",
          "usr/bin",
          "/bin",
          ...["block", "bus", "class", "dev", "devices"].flatMap((name) => [
            "--dir",
            `/sys/${name}`,
          ]),
          ...["/etc/fonts", "/etc/passwd", "/etc/group"].flatMap((file) => [
            "--ro-bind",
            file,
            file,
          ]),
          ...["linkding-browser", "webdriver-session"].flatMap((name) => [
            "--ro-bind",
            path.join(lease.directory, `${name}.py`),
            `/probes/${name.replaceAll("-", "_")}.py`,
          ]),
          ...["pids.events", "memory.events", "memory.peak"].flatMap((name) => [
            "--ro-bind",
            `/sys/fs/cgroup/system.slice/${unit}.service/${name}`,
            `/probes/${name}`,
          ]),
        ]
      : []),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--chdir",
    "/work",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/usr/local/bin",
    "--uid",
    "65534",
    "--gid",
    "65534",
    "--",
    ...(node
      ? ["/node", "--max-old-space-size=256", "/adapter"]
      : [
          runtime ? `${runtime.directory}/environment/venv/bin/python` : "/usr/bin/python3",
          "-B",
          "/adapter",
        ]),
  ];
  let result;
  try {
    result = spawnSync("systemd-run", args, {
      input: JSON.stringify({ ...input, entry: item.entry }),
      encoding: "utf8",
      timeout: browser
        ? 95000
        : linkding
          ? 45000
          : whoogle || flaskReuploaded
            ? 35000
            : confirmatory
              ? 25000
              : 12000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    });
  } finally {
    lease?.close();
  }
  if (browser) verifyBrowserRuntime(item.browserRuntime);
  if (result.status !== 0)
    return {
      error: "CandidateProcessError",
      message: `${result.error?.message ?? result.status}: ${result.stderr}`,
    };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: "InvalidCandidateOutput", message: result.stdout };
  }
}
