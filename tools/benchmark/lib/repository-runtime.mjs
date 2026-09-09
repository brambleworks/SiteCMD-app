import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { digest } from "./workflow-plan.mjs";

export function runtimeTreeDigest(directory, { requireRoot = false } = {}) {
  const root = realpathSync(directory);
  if (requireRoot) {
    for (const parent of [root, path.join(root, "environment")]) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022)
        throw new Error(
          "Runtime parents must remain controller-owned and read-only to other users",
        );
    }
  }
  const roots = ["python", "environment/venv"];
  const entries = [];
  let bytes = 0;
  function visit(name) {
    const target = path.join(root, name);
    const stat = lstatSync(target);
    const mode = stat.mode & 0o7777;
    if (requireRoot && (stat.uid !== 0 || (!stat.isSymbolicLink() && mode & 0o022)))
      throw new Error(
        `Runtime entry is not controller-owned and read-only to other users: ${name}`,
      );
    if (entries.length >= 30000) throw new Error("Runtime file count exceeds its bound");
    if (stat.isSymbolicLink()) {
      const resolved = realpathSync(target);
      if (!roots.some((part) => resolved.startsWith(path.join(root, part) + path.sep)))
        throw new Error(`Runtime link points outside the isolated installation: ${name}`);
      entries.push({ name, mode, link: readlinkSync(target) });
    } else if (stat.isDirectory()) {
      entries.push({ name, mode, directory: true });
      for (const child of readdirSync(target).sort()) visit(`${name}/${child}`);
    } else if (stat.isFile() && stat.nlink === 1) {
      // One descriptor carries both the check and the read, so the bytes
      // hashed are the bytes checked. O_NOFOLLOW refuses a path swapped to a
      // symlink after the lstat above, and the inode comparison catches a
      // swap to any other file.
      const handle = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(handle);
        if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino)
          throw new Error(`Runtime entry changed while it was read: ${name}`);
        if (requireRoot && (opened.uid !== 0 || opened.mode & 0o022))
          throw new Error(
            `Runtime entry is not controller-owned and read-only to other users: ${name}`,
          );
        bytes += opened.size;
        if (bytes > 1024 * 1024 * 1024) throw new Error("Runtime exceeds its size bound");
        entries.push({ name, mode: opened.mode & 0o7777, sha256: digest(readFileSync(handle)) });
      } finally {
        closeSync(handle);
      }
    } else {
      throw new Error(`Unsupported runtime entry: ${name}`);
    }
  }
  for (const part of roots) visit(part);
  return digest(entries);
}
