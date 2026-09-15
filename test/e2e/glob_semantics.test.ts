import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startLocalStack,
  createTestS3Client,
  createFreshBucket,
  type LocalStackHandle,
} from "./helpers/localstack.js";
import { runCli } from "./helpers/cli.js";

const PASSWORD = "correct horse battery staple";

function mkTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync1-e2e-glob-semantics-"));
}

interface UpdateCacheStats {
  ok: boolean;
  created: number;
  modified: number;
  deleted: number;
  unchanged: number;
  ignored: number;
}

/**
 * End-to-end coverage for the range of glob syntax minimatch now supports,
 * exercised through real commands rather than glob-match.ts's own unit
 * tests -- proving the whole pipeline (CLI parsing, policy storage in
 * state.db, cache.db's literal-prefix-seeded scan, and the final
 * matchesAnyGlob test) agrees end to end. See src/fs/glob-match.ts and
 * docs/README.md's "Glob syntax" section for the semantics themselves.
 */
describe("glob semantics: end-to-end pattern coverage", () => {
  let localstack: LocalStackHandle;

  beforeAll(async () => {
    localstack = await startLocalStack();
  });

  afterAll(async () => {
    await localstack.stop();
  });

  async function initRoot(): Promise<string> {
    const s3 = createTestS3Client(localstack.endpoint);
    const bucket = await createFreshBucket(s3);
    const root = mkTempRoot();
    await runCli(
      [
        "init_remote",
        "--bucket",
        bucket,
        "--root",
        root,
        "--endpoint",
        localstack.endpoint,
        "--json",
      ],
      { env: { SYNC1_PASSWORD: PASSWORD } },
    );
    return root;
  }

  it("a '**' ignore policy reaches a nested file -- impossible before this change for a non-thumbnail policy", async () => {
    const root = await initRoot();
    await runCli(["ignore", "create", "**/*.log", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });

    fs.mkdirSync(path.join(root, "logs"));
    fs.writeFileSync(path.join(root, "keep.txt"), "kept");
    fs.writeFileSync(path.join(root, "logs", "nested.log"), "noisy");

    const result = await runCli(["update_cache", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    const stats = JSON.parse(result.stdout) as UpdateCacheStats;
    expect(stats.ignored).toBe(1); // logs/nested.log
    expect(stats.created).toBe(2); // the "logs" dir itself, plus keep.txt

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a bare '*.log' ignore policy does NOT reach a nested file -- the accepted segment-bound behavior change", async () => {
    const root = await initRoot();
    await runCli(["ignore", "create", "*.log", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });

    fs.mkdirSync(path.join(root, "logs"));
    fs.writeFileSync(path.join(root, "root.log"), "root-level, ignored");
    fs.writeFileSync(path.join(root, "logs", "nested.log"), "nested, NOT ignored -- tracked");

    const result = await runCli(["update_cache", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    const stats = JSON.parse(result.stdout) as UpdateCacheStats;
    expect(stats.ignored).toBe(1); // root.log only
    expect(stats.created).toBe(2); // the "logs" dir, plus logs/nested.log (tracked, not ignored)

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("brace expansion in a real ignore policy ignores every listed extension", async () => {
    const root = await initRoot();
    await runCli(["ignore", "create", "*.{tmp,bak}", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });

    fs.writeFileSync(path.join(root, "a.tmp"), "scratch");
    fs.writeFileSync(path.join(root, "a.bak"), "backup");
    fs.writeFileSync(path.join(root, "a.txt"), "kept");

    const result = await runCli(["update_cache", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    const stats = JSON.parse(result.stdout) as UpdateCacheStats;
    expect(stats.ignored).toBe(2); // a.tmp, a.bak
    expect(stats.created).toBe(1); // a.txt

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("dotfiles are matched by a bare '*' ignore policy, same as any other name", async () => {
    const root = await initRoot();
    await runCli(["ignore", "create", "*", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });

    fs.writeFileSync(path.join(root, ".env"), "secret");
    fs.writeFileSync(path.join(root, "visible.txt"), "visible");

    const result = await runCli(["update_cache", "--root", root, "--json"]);
    expect(result.exitCode).toBe(0);
    const stats = JSON.parse(result.stdout) as UpdateCacheStats;
    // If dotfiles weren't matched, ".env" would show up as created instead.
    expect(stats.ignored).toBe(2);
    expect(stats.created).toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a character-class pattern selects exactly the matching files through materialize/stubify", async () => {
    const root = await initRoot();
    fs.writeFileSync(path.join(root, "file1.txt"), "one");
    fs.writeFileSync(path.join(root, "file2.txt"), "two");
    fs.writeFileSync(path.join(root, "file3.txt"), "three");
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    const stubify = await runCli(["stubify", "file[12].txt", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(stubify.exitCode).toBe(0);
    const stubifyParsed = JSON.parse(stubify.stdout) as { stubified: number };
    expect(stubifyParsed.stubified).toBe(2);
    expect(fs.existsSync(path.join(root, "file1.txt.stub"))).toBe(true);
    expect(fs.existsSync(path.join(root, "file2.txt.stub"))).toBe(true);
    expect(fs.existsSync(path.join(root, "file3.txt"))).toBe(true); // untouched

    const materialize = await runCli(["materialize", "file[12].txt", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(materialize.exitCode).toBe(0);
    const materializeParsed = JSON.parse(materialize.stdout) as { materialized: number };
    expect(materializeParsed.materialized).toBe(2);
    expect(fs.readFileSync(path.join(root, "file1.txt"), "utf8")).toBe("one");
    expect(fs.readFileSync(path.join(root, "file2.txt"), "utf8")).toBe("two");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a directory-anchored pattern selects only files under that directory, end to end through cache.db", async () => {
    const root = await initRoot();
    // A handful of root-level files, plus a distinct subtree sorting near
    // the end of the tree ("zzz/") -- exercises the same literal-prefix
    // seeding (src/db/glob-scan.ts) a real vault relies on, not just the
    // synthetic in-memory coverage in glob-scan.test.ts.
    fs.writeFileSync(path.join(root, "aaa.txt"), "a");
    fs.writeFileSync(path.join(root, "bbb.txt"), "b");
    fs.mkdirSync(path.join(root, "zzz"));
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(root, "zzz", `f${i}.txt`), `zzz content ${i}`);
    }
    await runCli(["sync", "--root", root, "--json"], { env: { SYNC1_PASSWORD: PASSWORD } });

    const stubify = await runCli(["stubify", "zzz/*.txt", "--root", root, "--json"], {
      env: { SYNC1_PASSWORD: PASSWORD },
    });
    expect(stubify.exitCode).toBe(0);
    const stubifyParsed = JSON.parse(stubify.stdout) as { stubified: number };
    expect(stubifyParsed.stubified).toBe(5);

    for (let i = 0; i < 5; i++) {
      expect(fs.existsSync(path.join(root, "zzz", `f${i}.txt.stub`))).toBe(true);
    }
    // Root-level files, sorting well before the "zzz/" prefix, are untouched.
    expect(fs.existsSync(path.join(root, "aaa.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "bbb.txt"))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
