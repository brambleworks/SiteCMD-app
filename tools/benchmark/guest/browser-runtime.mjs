import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { digest } from "../lib/workflow-plan.mjs";

export function captureBrowserRuntime() {
  if (process.platform !== "linux" || process.getuid() !== 0)
    throw new Error("Browser identity requires the isolated guest controller");
  const inventory = execFileSync("dpkg-query", ["-W", "-f=${binary:Package}=${Version}\n"], {
    encoding: "utf8",
    timeout: 10000,
  })
    .trim()
    .split("\n")
    .sort();
  for (const name of ["webkit2gtk-driver", "libwebkit2gtk-4.1-0:arm64"])
    if (!inventory.includes(`${name}=2.52.6-0ubuntu0.24.04.1`))
      throw new Error(
        "Linkding browser qualification requires the pinned WebKitGTK package version",
      );
  const paths = [
    "/usr/bin/WebKitWebDriver",
    "/usr/bin/Xvfb",
    "/usr/bin/dbus-run-session",
    "/usr/bin/dbus-daemon",
    "/usr/bin/xdg-dbus-proxy",
    "/usr/bin/bwrap",
    "/usr/lib/aarch64-linux-gnu/libwebkit2gtk-4.1.so.0",
    "/usr/lib/aarch64-linux-gnu/libjavascriptcoregtk-4.1.so.0",
    ...[
      "MiniBrowser",
      "WebKitWebProcess",
      "WebKitNetworkProcess",
      "WebKitGPUProcess",
      "injected-bundle/libwebkit2gtkinjectedbundle.so",
    ].map((name) => `/usr/lib/aarch64-linux-gnu/webkit2gtk-4.1/${name}`),
  ];
  const files = paths.map((file) => {
    const resolved = realpathSync(file);
    // One descriptor carries both the ownership check and the read, so the
    // bytes hashed are the bytes checked. Checking a path and then reading it
    // describes two different moments, and the identity is only worth as much
    // as the guarantee that they saw the same file.
    const handle = openSync(resolved, "r");
    try {
      const stat = fstatSync(handle);
      if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
        throw new Error(
          "Browser binaries must remain controller-owned and read-only to other users",
        );
      return { path: file, resolved, sha256: digest(readFileSync(handle)) };
    } finally {
      closeSync(handle);
    }
  });
  const identity = { schemaVersion: 1, engine: "WebKitGTK", version: "2.52.6", inventory, files };
  return { ...identity, sha256: digest(identity) };
}

export function verifyBrowserRuntime(expected) {
  if (digest(captureBrowserRuntime()) !== digest(expected))
    throw new Error("Browser environment changed during qualification");
}
