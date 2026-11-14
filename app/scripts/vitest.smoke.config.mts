import { defineConfig } from "vitest/config";
import path from "node:path";

// Real-API smoke runs only (never part of `npm test`, whose config includes tests/** only).
// The key comes from the env file named by SMOKE_ENV_FILE (scripts/smoke-env.ts loads it by path; nothing is copied
// or printed).
const root = path.resolve(import.meta.dirname, "..");
export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "server-only": path.resolve(root, "tests/stubs/server-only.ts"),
    },
  },
  test: { environment: "node", include: ["scripts/*.smoke.ts"], testTimeout: 900_000, hookTimeout: 60_000, fileParallelism: false },
});
