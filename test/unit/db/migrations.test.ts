import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../../../src/db/migrations/runner.js";

const STATE_MIGRATIONS_DIR = path.resolve("src/db/migrations/state");
const CACHE_MIGRATIONS_DIR = path.resolve("src/db/migrations/cache");

describe("migration runner", () => {
  it("applies state.db migrations and creates the expected tables", () => {
    const db = new Database(":memory:");
    runMigrations(db, STATE_MIGRATIONS_DIR);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual([
      "_migrations",
      "entries",
      "entry_deletions",
      "ignore_policies",
      "objects",
      "storage_policies",
      "thumbnail_policies",
      "versions",
    ]);
  });

  it("applies cache.db migrations and creates the expected tables", () => {
    const db = new Database(":memory:");
    runMigrations(db, CACHE_MIGRATIONS_DIR);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(["_migrations", "entries"]);
  });

  it("records applied migrations and is idempotent when run again", () => {
    const db = new Database(":memory:");
    runMigrations(db, STATE_MIGRATIONS_DIR);

    const appliedFirst = db
      .prepare<[], { filename: string }>("SELECT filename FROM _migrations ORDER BY filename")
      .all();
    expect(appliedFirst).toEqual([
      { filename: "0001_init.sql" },
      { filename: "0002_add_normalized_path.sql" },
      { filename: "0003_add_ignore_policies.sql" },
      { filename: "0004_add_storage_policies.sql" },
      { filename: "0005_add_thumbnail_policies.sql" },
      { filename: "0006_add_object_ciphertext_checksum.sql" },
      { filename: "0007_thumbnail_policy_names_no_priority.sql" },
      { filename: "0008_thumbnail_output_types_and_resizing.sql" },
      { filename: "0009_thumbnail_output_mime_and_encoding.sql" },
      { filename: "0010_add_entry_deletions.sql" },
      { filename: "0011_object_ciphertext_checksum_not_null.sql" },
    ]);

    // Running again must not error (e.g. re-executing CREATE TABLE) and must
    // not insert a duplicate _migrations row.
    expect(() => runMigrations(db, STATE_MIGRATIONS_DIR)).not.toThrow();
    const appliedSecond = db
      .prepare<[], { filename: string }>("SELECT filename FROM _migrations")
      .all();
    // Compared against the first run rather than a hardcoded count: the
    // property is "a second pass changes nothing", which holds at any
    // number of migrations, and a literal here would have to be bumped by
    // every future migration for no gain.
    expect(appliedSecond).toEqual(appliedFirst);
  });

  it("creates the indexes named in the schema", () => {
    const db = new Database(":memory:");
    runMigrations(db, STATE_MIGRATIONS_DIR);
    const indexes = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(indexes).toEqual([
      "idx_entries_hash",
      "idx_entries_normalized_path",
      "idx_entries_state_version",
      "idx_entry_deletions_path",
    ]);
  });

  it("creates the indexes named in cache.db's schema (idx_cache_state replaced by a composite)", () => {
    const db = new Database(":memory:");
    runMigrations(db, CACHE_MIGRATIONS_DIR);
    const indexes = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(indexes).toEqual(["idx_cache_normalized_path", "idx_cache_state_path"]);
  });

  it("cache.db's entries table has a nullable size column", () => {
    const db = new Database(":memory:");
    runMigrations(db, CACHE_MIGRATIONS_DIR);
    const columns = db
      .prepare<[], { name: string; notnull: number }>("PRAGMA table_info(entries)")
      .all();
    const sizeColumn = columns.find((c) => c.name === "size");
    expect(sizeColumn).toBeDefined();
    expect(sizeColumn?.notnull).toBe(0);
  });

  /**
   * 0011 is the only migration that rebuilds a table something references
   * (`entries.hash` -> `objects.hash`), so it is also what proves the
   * runner's foreign-keys-off-plus-`foreign_key_check` approach works. The
   * obvious alternatives silently do not: `defer_foreign_keys` just moves
   * the failure to COMMIT (the deferred-violation counter that DROP's
   * implicit delete increments is never decremented by the rename putting
   * the rows back), and `legacy_alter_table` leaves `entries` pointing at
   * the renamed-aside original, which is then dropped -- a dangling
   * reference that accepts anything, i.e. corruption that looks like
   * success.
   */
  describe("0011: objects.ciphertext_checksum NOT NULL", () => {
    /**
     * A migrations dir holding everything *before* 0011, so a test can
     * seed rows the way a real pre-0011 vault held them and then migrate
     * over the top. Copying is the only honest way to get there: running
     * the real dir applies 0011 too, which is precisely what we need to
     * observe acting on existing data.
     */
    function dirWithout0011(): string {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-mig-"));
      const files = fs
        .readdirSync(STATE_MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql") && f < "0011");
      // Guards against a future 0012 quietly making this a no-op subset.
      expect(files.length).toBe(fs.readdirSync(STATE_MIGRATIONS_DIR).length - 1);
      for (const f of files) {
        fs.copyFileSync(path.join(STATE_MIGRATIONS_DIR, f), path.join(tmp, f));
      }
      return tmp;
    }

    function seededPre0011(checksum: string | null): Database.Database {
      const db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      runMigrations(db, dirWithout0011());
      db.prepare("INSERT INTO versions (version_stamp, created_at) VALUES ('v1', 'now')").run();
      db.prepare("INSERT INTO objects VALUES (?, ?, ?, ?)").run("aa", "objects/aa", 7, checksum);
      db.prepare("INSERT INTO entries (path, type, hash, state_version) VALUES (?, ?, ?, ?)").run(
        "a.txt",
        "file",
        "aa",
        "v1",
      );
      return db;
    }

    it("carries existing rows across and leaves the column NOT NULL", () => {
      const db = seededPre0011("crc1");
      runMigrations(db, STATE_MIGRATIONS_DIR);

      const checksumColumn = db
        .prepare<[], { name: string; notnull: number }>("PRAGMA table_info(objects)")
        .all()
        .find((c) => c.name === "ciphertext_checksum");
      expect(checksumColumn?.notnull).toBe(1);
      expect(db.prepare("SELECT * FROM objects").all()).toEqual([
        { hash: "aa", s3_key: "objects/aa", size: 7, ciphertext_checksum: "crc1" },
      ]);
      // The referencing row survived the drop-and-rename intact.
      expect(db.prepare("SELECT hash FROM entries WHERE path = 'a.txt'").get()).toEqual({
        hash: "aa",
      });
    });

    it("keeps the entries foreign key enforced afterwards, not merely declared", () => {
      const db = seededPre0011("crc1");
      runMigrations(db, STATE_MIGRATIONS_DIR);

      expect(db.pragma("foreign_key_check")).toEqual([]);
      // Asserting rejection, not schema text: `legacy_alter_table`'s
      // failure mode leaves the declaration looking right while pointing
      // at a table that no longer exists.
      expect(() =>
        db
          .prepare("INSERT INTO entries (path, type, hash, state_version) VALUES (?, ?, ?, ?)")
          .run("b.txt", "file", "no-such-object", "v1"),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });

    /**
     * A NULL means some object's upload was never verified against what S3
     * stored. Back-filling or dropping it would destroy exactly the
     * information needed to decide what to do about that, so the migration
     * refuses and rolls back whole.
     */
    it("fails loudly and changes nothing when an existing row has a NULL checksum", () => {
      const db = seededPre0011(null);

      expect(() => runMigrations(db, STATE_MIGRATIONS_DIR)).toThrow(
        /NOT NULL constraint failed: objects_new.ciphertext_checksum/,
      );

      // Rolled back whole: the old schema, the row, and the unapplied
      // migration record.
      const checksumColumn = db
        .prepare<[], { name: string; notnull: number }>("PRAGMA table_info(objects)")
        .all()
        .find((c) => c.name === "ciphertext_checksum");
      expect(checksumColumn?.notnull).toBe(0);
      expect(db.prepare("SELECT * FROM objects").all()).toEqual([
        { hash: "aa", s3_key: "objects/aa", size: 7, ciphertext_checksum: null },
      ]);
      const applied = db
        .prepare<[], { filename: string }>("SELECT filename FROM _migrations")
        .all()
        .map((r) => r.filename);
      expect(applied).not.toContain("0011_object_ciphertext_checksum_not_null.sql");
      // And enforcement is back on despite the failure -- the runner
      // restores it in a `finally`, so a failed migration can't leave the
      // connection silently unprotected.
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });
  });
});
