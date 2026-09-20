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
      // No per-test timeout, deliberately. `0` disables it outright rather
      // than meaning "instant": vitest's `withTimeout` returns the test
      // function unwrapped when the timeout is <= 0.
      //
      // These tests already detect completion -- every `runCli` awaits
      // execFile's callback -- so a timeout here is a hang backstop, not a
      // duration budget. It was sized like a budget (60s, near the observed
      // runtime) and so fired on load rather than on hangs: the whole suite
      // runs 3-5x slower under its own file parallelism, and
      // thumbnail_lifecycle.test.ts alone takes ~157s for four tests that
      // need ~40s when run on their own. Three consecutive false failures
      // and zero true ones is the record it earned.
      //
      // The unit project keeps vitest's defaults on purpose. Unit durations
      // are tight and predictable (400+ tests in ~3s), so a hung promise
      // there should fail fast; e2e durations are dominated by contention,
      // where a wall-clock ceiling can only produce noise.
      //
      // Hangs are still bounded where it counts: `waitForHealth`
      // (test/e2e/helpers/localstack.ts) keeps its own 30s deadline with a
      // named error, `lock.test.ts`'s `waitFor` keeps its polling bail-outs,
      // and `runCli` now reports a killed or unspawnable child instead of
      // disguising it as exit 1. Those are the right shape -- a condition
      // poll with an escape, not a blanket cap.
      testTimeout: 0,
      hookTimeout: 0,
    },
  },
]);
