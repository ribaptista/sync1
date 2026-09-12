import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["test/unit/**/*.test.ts"],
      environment: "node",
    },
  },
  {
    test: {
      name: "e2e",
      include: ["test/e2e/**/*.test.ts"],
      environment: "node",
      // e2e tests spin up LocalStack and spawn the built CLI; give them room.
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
