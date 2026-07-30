import { describe, expect, it } from "vitest";
import {
  compareManifest,
  unknownManifest,
} from "../../src/quality/manifest-adapters.js";

describe("manifest adapters", () => {
  it("separates npm runtime, development, and optional additions", () => {
    expect(
      compareManifest(
        "package.json",
        '{"dependencies":{"a":"1"}}',
        '{"dependencies":{"a":"1","b":"1"},"devDependencies":{"vitest":"1"},"optionalDependencies":{"fsevents":"1"}}',
      ),
    ).toMatchObject({
      status: "known",
      runtimeAdded: ["b"],
      developmentAdded: ["vitest"],
      optionalAdded: ["fsevents"],
    });
  });

  it("marks unsupported manifests unknown", () => {
    expect(unknownManifest("custom.toml")).toMatchObject({
      status: "unknown",
      evidence: ["custom.toml"],
    });
  });
});
