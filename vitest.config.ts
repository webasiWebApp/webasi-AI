import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

// Test files that start a Postgres inside the process (PGlite). Each one holds a database in memory, so they run one at a
// time: left to run side by side on a machine with little memory they kill each other's workers part-way through.
const withDatabase = ["server/migrations.test.ts", "server/pipeline.*.test.ts", "client/src/**/*.test.tsx"];

export default defineConfig({
  root: templateRoot,
  // The tsconfig keeps JSX as written for Vite's React plugin; the tests need it compiled.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    projects: [
      { extends: true, test: { name: "unit", include: ["server/**/*.test.ts", "server/**/*.spec.ts", "shared/**/*.test.ts"], exclude: ["**/node_modules/**", ...withDatabase], maxWorkers: 4 } },
      { extends: true, test: { name: "database", include: withDatabase, fileParallelism: false } },
    ],
  },
});
