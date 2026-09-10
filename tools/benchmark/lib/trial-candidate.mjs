import { digest } from "./workflow-plan.mjs";
import { validateRepositoryFiles } from "./repository-snapshot.mjs";

export function validateCandidateFiles(files, modes = {}) {
  validateRepositoryFiles(
    Object.entries(files).map(([name, contents]) => ({
      name,
      base64: Buffer.from(contents).toString("base64"),
      mode: Object.hasOwn(modes, name) ? modes[name] : "100644",
    })),
    { allowEmpty: true },
  );
}

export function decodeCandidateRecord(record) {
  if (
    !record ||
    Object.keys(record).sort().join(",") !== "files,modes,violations" ||
    !record.files ||
    typeof record.files !== "object" ||
    Array.isArray(record.files) ||
    !record.modes ||
    typeof record.modes !== "object" ||
    Array.isArray(record.modes) ||
    !Array.isArray(record.violations) ||
    record.violations.some((value) => typeof value !== "string") ||
    Object.keys(record.files).sort().join("\0") !== Object.keys(record.modes).sort().join("\0")
  )
    throw new Error("Malformed candidate record");
  const entries = Object.entries(record.files).map(([name, base64]) => ({
    name,
    base64,
    mode: record.modes[name],
  }));
  validateRepositoryFiles(entries, { allowEmpty: true });
  return {
    files: Object.fromEntries(
      entries.map((file) => [file.name, Buffer.from(file.base64, "base64")]),
    ),
    modes: record.modes,
    violations: record.violations,
  };
}

export function candidateRecord(snapshot) {
  const names = Object.keys(snapshot.files);
  for (const name of names)
    if (
      !Object.hasOwn(snapshot.modes ?? {}, name) ||
      !["100644", "100755"].includes(snapshot.modes[name])
    )
      throw new Error(`Missing or unsupported snapshot mode: ${name}`);
  return {
    files: Object.fromEntries(names.map((name) => [name, snapshot.files[name].toString("base64")])),
    modes: Object.fromEntries(names.map((name) => [name, snapshot.modes[name]])),
    violations: snapshot.violations,
  };
}

export function candidateIdentity(snapshot) {
  return digest(candidateRecord(snapshot));
}

export function compareCandidate(
  original,
  candidate,
  violations = [],
  { editableFiles, originalModes = {}, candidateModes = {} } = {},
) {
  const reasons = [...violations];
  for (const name of Object.keys(candidate)) {
    const mode = Object.hasOwn(candidateModes, name) ? candidateModes[name] : "100644";
    const expected = Object.hasOwn(originalModes, name) ? originalModes[name] : "100644";
    if (mode !== expected) reasons.push(`Executable mode changed: ${name}`);
  }
  if (editableFiles !== undefined) {
    if (!Array.isArray(editableFiles)) throw new Error("Invalid repository edit policy");
    for (const name of new Set([...Object.keys(original), ...Object.keys(candidate)])) {
      const changed =
        !Object.hasOwn(original, name) ||
        !Object.hasOwn(candidate, name) ||
        !Buffer.from(original[name]).equals(candidate[name]);
      if (changed && !editableFiles.includes(name))
        reasons.push(`Outside the registered edit scope: ${name}`);
    }
    return {
      passed: reasons.length === 0,
      reason: reasons.join("; ") || "Only registered implementation files changed",
    };
  }
  for (const [name, contents] of Object.entries(original)) {
    if (
      /(?:^|\/)(?:README\.md|package\.json|.*\.test\.[cm]?js|test_.*\.py)$/.test(name) &&
      (!Object.hasOwn(candidate, name) || !Buffer.from(contents).equals(candidate[name]))
    )
      reasons.push(`Protected contract or test changed: ${name}`);
  }
  for (const name of Object.keys(candidate)) {
    if (
      name.split("/").some((part) => part.startsWith(".")) ||
      /(?:^|\/)(?:AGENTS\.md|CLAUDE\.md)$/.test(name)
    )
      reasons.push(`Agent configuration or hidden path added: ${name}`);
  }
  return {
    passed: reasons.length === 0,
    reason:
      reasons.join("; ") ||
      "No test, contract, suppression, link, or agent-configuration tampering detected",
  };
}
