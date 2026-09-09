import { executeCandidate } from "./candidate-sandbox.mjs";

function writesAreContained(observation) {
  return (
    observation &&
    Array.isArray(observation.inside) &&
    Array.isArray(observation.outside) &&
    observation.outside.length === 0
  );
}

function safeRelativeResult(result) {
  return (
    typeof result === "string" &&
    result.length > 0 &&
    !result.startsWith("/") &&
    !result.includes("\\") &&
    result.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function confined(observation) {
  if (!writesAreContained(observation)) return false;
  if (observation.error) return observation.inside.length === 0;
  return safeRelativeResult(observation.result) && observation.inside.includes(observation.result);
}

function rejected(observation, error) {
  return (
    writesAreContained(observation) &&
    observation.inside.length === 0 &&
    observation.error === error
  );
}

function saved(observation, result, files = [result]) {
  return (
    writesAreContained(observation) &&
    observation.error === null &&
    observation.result === result &&
    JSON.stringify(observation.inside) === JSON.stringify(files)
  );
}

function check(name, actual, pass) {
  return { name, actual, pass };
}

function publicTests(observed) {
  return check(
    "Existing Flask-Reuploaded tests",
    observed.publicTests,
    observed.publicTests?.exitCode === 0 &&
      Number.isInteger(observed.publicTests.tests) &&
      observed.publicTests.tests >= 20,
  );
}

function gradeNameBoundary(observed) {
  const acceptance = [
    check(
      "Traversal name stays inside the destination",
      observed.traversalName,
      confined(observed.traversalName),
    ),
    check(
      "Absolute name stays inside the destination",
      observed.absoluteName,
      confined(observed.absoluteName),
    ),
    check(
      "Traversal folder stays inside the destination",
      observed.traversalFolder,
      confined(observed.traversalFolder),
    ),
    check(
      "Symlink folder cannot escape the destination",
      observed.symlinkFolder,
      confined(observed.symlinkFolder),
    ),
    check(
      "A custom name cannot bypass extension policy",
      observed.disallowedExtension,
      rejected(observed.disallowedExtension, "UploadNotAllowed"),
    ),
    check(
      "An empty sanitized name is rejected",
      observed.emptyName,
      rejected(observed.emptyName, "ValueError"),
    ),
    check(
      "Windows path separators are not retained",
      observed.windowsSeparators,
      confined(observed.windowsSeparators),
    ),
  ];
  const regressions = [
    publicTests(observed),
    check(
      "Default names remain supported",
      observed.ordinaryDefault,
      saved(observed.ordinaryDefault, "photo.jpg"),
    ),
    check(
      "Custom names remain supported",
      observed.ordinaryCustom,
      saved(observed.ordinaryCustom, "renamed.txt"),
    ),
    check(
      "Explicit folders remain supported",
      observed.explicitFolder,
      saved(observed.explicitFolder, "users/photo.jpg"),
    ),
    check(
      "Folders embedded in names remain supported",
      observed.implicitFolder,
      saved(observed.implicitFolder, "users/avatar.jpg"),
    ),
    check(
      "Trailing-dot placeholders retain the source extension",
      observed.placeholder,
      saved(observed.placeholder, "image.jpg"),
    ),
    check(
      "Filename collisions receive a stable suffix",
      observed.collision,
      saved(observed.collision, "photo_1.jpg", ["photo.jpg", "photo_1.jpg"]),
    ),
  ];
  return { acceptance, regressions };
}

function gradeCasefold(observed) {
  const acceptance = [
    check(
      "Uppercase script extensions remain blocked",
      observed.blockedPhp,
      rejected(observed.blockedPhp, "UploadNotAllowed"),
    ),
    check(
      "Mixed-case script extensions remain blocked",
      observed.blockedMixedScript,
      rejected(observed.blockedMixedScript, "UploadNotAllowed"),
    ),
    check(
      "Allowed mixed-case extensions are normalized",
      observed.allowedImage,
      saved(observed.allowedImage, "photo.jpg"),
    ),
  ];
  const regressions = [
    publicTests(observed),
    check(
      "Default-name normalization remains supported",
      observed.defaultName,
      saved(observed.defaultName, "PHOTO.jpg"),
    ),
    check(
      "Lowercase custom names remain supported",
      observed.lowerCustom,
      saved(observed.lowerCustom, "photo.jpg"),
    ),
    check(
      "Trailing-dot placeholders remain supported",
      observed.placeholder,
      saved(observed.placeholder, "photo.jpg"),
    ),
    check(
      "Normalized names retain collision handling",
      observed.collision,
      saved(observed.collision, "photo_1.jpg", ["photo.jpg", "photo_1.jpg"]),
    ),
    check(
      "Explicit folders remain supported",
      observed.explicitFolder,
      saved(observed.explicitFolder, "users/photo.jpg"),
    ),
  ];
  return { acceptance, regressions };
}

export function gradeFlaskReuploaded(id, candidate, execute = executeCandidate, repositoryRuntime) {
  const observed = execute(
    { id, repository: "flask-reuploaded", runtime: "python", repositoryRuntime },
    candidate,
    { operation: id },
  );
  const grades =
    id === "flask-reuploaded-name-boundary"
      ? gradeNameBoundary(observed)
      : id === "flask-reuploaded-extension-casefold" ||
          id === "flask-reuploaded-default-name-control"
        ? gradeCasefold(observed)
        : (() => {
            throw new Error("Unsupported Flask-Reuploaded grader");
          })();
  return {
    ...grades,
    acceptancePass: grades.acceptance.every((item) => item.pass),
    regressionsPass: grades.regressions.every((item) => item.pass),
  };
}
