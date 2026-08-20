import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve("src/web/client"),
  build: {
    outDir: path.resolve("dist/web"),
    emptyOutDir: true,
  },
});
