import { defineConfig } from "vitest/config";
import path from "node:path";

// Mirrors the "@/*" path alias from tsconfig.json so qa-tester's specs can
// import route handlers / lib modules the same way the app does.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", ".next"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
