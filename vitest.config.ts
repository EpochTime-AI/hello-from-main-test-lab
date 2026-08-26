import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/unit/**/*.test.ts",
      "test/local/**/*.test.ts",
      "test/adapters/**/*.test.ts",
      "test/runtime/**/*.test.ts",
    ],
  },
});
