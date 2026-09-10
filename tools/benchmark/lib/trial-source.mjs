import { digest } from "./workflow-plan.mjs";
import { validateRepositorySnapshot } from "./repository-snapshot.mjs";

export function loadTrialSource(source, task) {
  if (task.sourceFormat === undefined) {
    if (digest(source) !== task.sourceSha256)
      throw new Error("Case source differs from the frozen study");
    return {
      files: Object.fromEntries(
        Object.entries(source).map(([name, contents]) => [name, Buffer.from(contents)]),
      ),
      modes: Object.fromEntries(Object.keys(source).map((name) => [name, "100644"])),
    };
  }
  if (task.sourceFormat !== "git-tree-v1") throw new Error("Unknown trial source format");
  validateRepositorySnapshot(source);
  if (source.sha256 !== task.sourceSha256)
    throw new Error("Repository source differs from the frozen study");
  if (
    !Array.isArray(task.editableFiles) ||
    new Set(task.editableFiles).size !== task.editableFiles.length ||
    task.editableFiles.some((name) => !source.files.some((file) => file.name === name))
  )
    throw new Error("Repository trials require registered existing-file edit paths");
  return {
    files: Object.fromEntries(
      source.files.map((file) => [file.name, Buffer.from(file.base64, "base64")]),
    ),
    modes: Object.fromEntries(source.files.map((file) => [file.name, file.mode])),
    editableFiles: task.editableFiles,
  };
}
