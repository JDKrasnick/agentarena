import { describe, expect, it } from "vitest";
import { validateHarnessOverlay } from "../../src/maintenance/overlays.js";
import type { CheckResult } from "../../src/core/types.js";

const passing: CheckResult = {
  id: "symmetric-replay",
  kind: "service_health",
  status: "passed",
};

describe("harness run overlays", () => {
  it("accepts only validated symmetric infrastructure scopes", () => {
    expect(
      validateHarnessOverlay(
        {
          failureId: "failure",
          patchPath: "overlay.diff",
          scopes: ["service_readiness", "diagnostic"],
          permissionChanges: [],
        },
        {
          symmetric: true,
          validationChecks: [passing],
          materialPermissionApproved: false,
        },
      ).status,
    ).toBe("approved");
  });

  it("rejects referee changes to contestant or scoring state", () => {
    expect(
      validateHarnessOverlay(
        {
          failureId: "failure",
          patchPath: "overlay.diff",
          scopes: ["health"],
          permissionChanges: [],
        },
        {
          symmetric: true,
          validationChecks: [passing],
          materialPermissionApproved: true,
        },
      ).status,
    ).toBe("rejected");
  });
});
