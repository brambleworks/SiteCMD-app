import { validateRepositorySnapshot } from "./repository-snapshot.mjs";
import { digest } from "./workflow-plan.mjs";

export function deriveRepositoryReference(baseline, upstream, editableFiles) {
  validateRepositorySnapshot(baseline);
  validateRepositorySnapshot(upstream);
  const replacements = new Map(upstream.files.map((file) => [file.name, file]));
  const originals = new Map(baseline.files.map((file) => [file.name, file]));
  if (
    !Array.isArray(editableFiles) ||
    !editableFiles.length ||
    new Set(editableFiles).size !== editableFiles.length ||
    editableFiles.some((name) => !originals.has(name) || !replacements.has(name))
  )
    throw new Error("Reference edit scope must name distinct existing files in both sources");
  for (const name of editableFiles)
    if (originals.get(name).mode !== replacements.get(name).mode)
      throw new Error(`Reference changes an executable mode: ${name}`);
  const content = {
    schemaVersion: 1,
    kind: "implementation-only",
    baselineSha256: baseline.sha256,
    upstreamSha256: upstream.sha256,
    editableFiles,
    files: baseline.files.map((file) =>
      editableFiles.includes(file.name) ? replacements.get(file.name) : file,
    ),
  };
  return { ...content, sha256: digest(content) };
}
