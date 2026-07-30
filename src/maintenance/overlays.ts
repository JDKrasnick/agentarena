import { stableId } from "../core/ids.js";
import type { CheckResult, HarnessOverlay } from "../core/types.js";

const ALLOWED_SCOPE = [
  /^service_(?:startup|readiness|reset|teardown)$/,
  /^worktree_(?:setup|cleanup)$/,
  /^environment_(?:construction|redaction)$/,
  /^capability_broker$/,
  /^timeout$/,
  /^resource_limit$/,
  /^retry$/,
  /^diagnostic$/,
];

const PROTECTED_SCOPE =
  /(contestant|production_patch|attack_(?:assertion|claim)|oracle|severity|health|ranking)/;

export interface OverlayProposal {
  failureId: string;
  patchPath: string;
  scopes: string[];
  permissionChanges: string[];
}

export function validateHarnessOverlay(
  proposal: OverlayProposal,
  options: {
    symmetric: boolean;
    validationChecks: CheckResult[];
    materialPermissionApproved: boolean;
  },
): HarnessOverlay {
  const invalidScope = proposal.scopes.find(
    (scope) =>
      PROTECTED_SCOPE.test(scope) ||
      !ALLOWED_SCOPE.some((allowed) => allowed.test(scope)),
  );
  const checksPass =
    options.validationChecks.length > 0 &&
    options.validationChecks.every((check) => check.status === "passed");
  const permissionsPass =
    proposal.permissionChanges.length === 0 ||
    options.materialPermissionApproved;
  const approved =
    !invalidScope && options.symmetric && checksPass && permissionsPass;
  return {
    id: stableId("overlay", proposal.failureId, proposal.patchPath),
    failureId: proposal.failureId,
    patchPath: proposal.patchPath,
    scopes: proposal.scopes,
    permissionChanges: proposal.permissionChanges,
    validationChecks: options.validationChecks,
    status: approved ? "approved" : "rejected",
  };
}
