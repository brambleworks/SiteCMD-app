import { chmodSync, copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { systemCommand } from "./desktop-session.mjs";

export function leaseBrowserInputs(candidate) {
  const directory = mkdtempSync("/tmp/sitecmd-browser-inputs-");
  const source = `${directory}/source`;
  mkdirSync(source, { mode: 0o755 });
  let mounted = false;
  const close = () => {
    if (mounted) systemCommand("umount", [source]);
    chmodSync(directory, 0o700);
  };
  try {
    systemCommand("mount", ["--bind", candidate, source]);
    mounted = true;
    systemCommand("mount", ["-o", "remount,bind,ro,nosuid,nodev", source]);
    for (const name of ["linkding-candidate", "linkding-browser", "webdriver-session"]) {
      copyFileSync(new URL(`./${name}.py`, import.meta.url), `${directory}/${name}.py`);
      chmodSync(`${directory}/${name}.py`, 0o444);
    }
    chmodSync(directory, 0o711);
    return { directory, source, close };
  } catch (error) {
    close();
    throw error;
  }
}
