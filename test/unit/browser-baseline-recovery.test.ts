import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/store.js";
import { attributeBrowserResult } from "../../src/browser/results.js";
import { BrowserValidationResultSchema } from "../../src/contracts/browser.js";
import {
  readBrowserBaseline,
  writeBrowserBaseline,
} from "../../src/recovery/durable.js";

describe("browser baseline recovery", () => {
  it("restores baseline identity and preserves contestant-only failure attribution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-browser-base-"));
    const store = new ArtifactStore(root, "browser-resume-run");
    await store.initialize();
    const identity = {
      runId: "browser-resume-run",
      baseCommit: "a".repeat(40),
      runSpecHash: "b".repeat(64),
      browserValidation: {
        version: 1,
        decision: "approved",
        capabilityId: "browser_dom_validation",
      },
    };
    const baseline = BrowserValidationResultSchema.parse({
      status: "verified",
      provisionAttempts: 1,
      probes: [],
      artifacts: [],
    });
    await writeBrowserBaseline({ store, identity, result: baseline });

    const restored = await readBrowserBaseline(store, identity);
    const attributed = attributeBrowserResult(
      restored,
      BrowserValidationResultSchema.parse({
        status: "unverified",
        provisionAttempts: 2,
        reason: "health_failure",
        probes: [],
        artifacts: [],
        failureAttribution: "harness_configuration",
      }),
    );

    expect(attributed).toMatchObject({
      status: "failed",
      reason: "health_failure",
      failureAttribution: "contestant_application",
    });
    await expect(
      readBrowserBaseline(store, {
        ...identity,
        browserValidation: {
          ...identity.browserValidation,
          decision: "denied",
        },
      }),
    ).rejects.toThrow("Browser baseline identity mismatch");
  });
});
