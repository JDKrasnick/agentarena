import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAJOR_PROVIDER_BRANDS,
  providerBrand,
} from "../../src/dashboard/provider-logos.js";

describe("provider brand marks", () => {
  it("resolves the supported arena providers", () => {
    expect(providerBrand("codex")?.owner).toBe("OpenAI");
    expect(providerBrand("claude")?.owner).toBe("Anthropic");
    expect(providerBrand("gemini")?.owner).toBe("Google");
  });

  it("ships raster marks for the major provider registry", () => {
    expect(MAJOR_PROVIDER_BRANDS.map((brand) => brand.id)).toEqual([
      "openai",
      "anthropic",
      "google",
      "xai",
      "mistral",
      "deepseek",
      "cohere",
      "perplexity",
      "meta",
      "copilot",
      "bedrock",
      "qwen",
      "nvidia",
      "azure",
      "groq",
      "huggingface",
      "together",
      "fireworks",
      "openrouter",
      "cursor",
    ]);
    expect(
      MAJOR_PROVIDER_BRANDS.every((brand) => existsSync(brand.iconPath)),
    ).toBe(true);
    expect(
      MAJOR_PROVIDER_BRANDS.every((brand) => brand.iconPath.includes("/dark/")),
    ).toBe(true);
  });
});
