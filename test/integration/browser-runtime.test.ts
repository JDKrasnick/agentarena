import { execa } from "execa";
import { describe, expect, it } from "vitest";

describe.runIf(process.env.ARENA_REAL_BROWSER === "1")(
  "real browser runtime",
  () => {
    it("launches the preinstalled Chromium binary without downloading one", async () => {
      const executable = process.env.CHROME_BIN ?? "google-chrome";
      const version = await execa(executable, ["--version"]);
      expect(version.stdout).toMatch(/Chrom(?:e|ium)/u);

      const page = encodeURIComponent(
        "<!doctype html><title>Arena browser probe</title><main role='main'>browser-ready</main>",
      );
      const result = await execa(executable, [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--dump-dom",
        `data:text/html,${page}`,
      ]);
      expect(result.stdout).toContain("browser-ready");
      expect(result.stdout).toContain('role="main"');
    });
  },
);
