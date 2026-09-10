import { requireCondition } from "./workflow-contract.mjs";
import { validatePilotStudy } from "./workflow-pilot.mjs";
import { repositoryStudyPolicy, validateRepositoryStudy } from "./workflow-repository-study.mjs";
import {
  confirmatoryStudyPolicy,
  validateConfirmatoryStudy,
} from "./workflow-confirmatory-study.mjs";
import { requireStudyRunnable } from "./workflow-study-validity.mjs";

export const pilotStudyId = "subscription-calibration";

export function validateRunnableStudy(study) {
  requireStudyRunnable(study);
  if (study?.id === pilotStudyId) return validatePilotStudy(study);
  if (study?.id === repositoryStudyPolicy.studyId) return validateRepositoryStudy(study);
  if (study?.id === confirmatoryStudyPolicy.studyId) return validateConfirmatoryStudy(study);
  requireCondition(false, "study has no registered execution policy");
}
