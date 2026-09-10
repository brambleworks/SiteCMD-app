import { writeFileSync } from "node:fs";
import path from "node:path";
import { prepareWriteStaging } from "./write-staging.mjs";

const shellProtectionFiles = [
  ".bash_profile",
  ".bashrc",
  ".gitconfig",
  ".github",
  ".idea",
  ".mcp.json",
  ".profile",
  ".ripgreprc",
  ".vscode",
  ".zprofile",
  ".zshrc",
  "scripts",
];
const protectionFiles = new Set([
  ...shellProtectionFiles,
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
  ".gitmodules",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

export function prepareRuntimeFiles(workspace, original, { writeStaging = false } = {}) {
  for (const name of protectionFiles) {
    if (Object.keys(original).some((file) => file === name || file.startsWith(`${name}/`)))
      continue;
    try {
      // Precreate lazy shell guards while the initialized client is still waiting for its prompt.
      writeFileSync(path.join(workspace, name), "", { flag: "wx", mode: 0o444 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  if (writeStaging) {
    if (
      Object.keys(original).some(
        (name) => name === ".claude" || name.startsWith(".claude/.cc-writes"),
      )
    )
      throw new Error("Source overlaps Claude's reserved write-staging path");
    return prepareWriteStaging(workspace);
  }
}

export function captureRuntimeFiles(original, snapshot, modes = {}) {
  if (snapshot.violations.length) throw new Error("Unsafe client initialization files");
  for (const [name, contents] of Object.entries(original))
    if (!snapshot.files[name] || !Buffer.from(contents).equals(snapshot.files[name]))
      throw new Error(`Source changed during client initialization: ${name}`);
  for (const [name, mode] of Object.entries(modes))
    if (snapshot.modes?.[name] !== mode)
      throw new Error(`Source mode changed during client initialization: ${name}`);
  const additions = Object.keys(snapshot.files).filter((name) => !Object.hasOwn(original, name));
  for (const name of additions)
    if (!protectionFiles.has(name) || snapshot.files[name].length !== 0)
      throw new Error(`Unexpected client initialization file: ${name}`);
  return additions.sort();
}

export function withoutRuntimeFiles(files, runtime, modes) {
  return Object.fromEntries(
    Object.entries(files).filter(
      ([name, contents]) =>
        !runtime.includes(name) ||
        contents.length > 0 ||
        (modes !== undefined && modes[name] !== "100644"),
    ),
  );
}
