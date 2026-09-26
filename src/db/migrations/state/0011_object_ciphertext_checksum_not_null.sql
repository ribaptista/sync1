-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.
--
-- Makes `ciphertext_checksum` mandatory. 0006 introduced it nullable, for
-- objects committed before the column existed, with NULL meaning "unknown".
-- That concession has outlived its purpose and is now actively harmful.
--
-- The column does not merely hold a value to compare against later: it is
-- the record of an end-to-end proof that S3 received the bytes we sent.
-- The client computes CRC64NVME as the ciphertext streams past, S3 computes
-- it independently, and `verifyStoredChecksum` (src/s3/client.ts) compares
-- the two. A NULL does not mean "we have no copy of the answer" -- it means
-- that comparison never happened, and nothing ever confirmed the upload
-- landed intact.
--
-- That matters most exactly where it is least visible. `stubify` deletes
-- the only local plaintext once a file is committed, on the strength of the
-- remote copy being good; an object whose write was never corroborated
-- would only be found out on a later `materialize`, long after the local
-- copy was gone. Closing that window is what 0006 and the checksum
-- machinery were for, and a tolerated NULL silently reopens it.
--
-- Deliberately NOT solved by computing a substitute locally when S3 stays
-- silent. Convergent encryption means we *could* re-derive the same
-- ciphertext and checksum without a download -- but storing that would
-- record a number nothing corroborated while making it indistinguishable
-- from a verified one. An unverified upload laundered into an
-- apparently-verified row is strictly worse than an honest NULL. The
-- callers now raise instead (see src/s3/client.ts and
-- src/sync/apply-local-changes.ts), so no new NULL can be created; this
-- migration closes the door behind them.
--
-- Consequence, stated plainly: an S3-compatible backend that does not
-- implement CRC64NVME is unsupported for writing. That was already true in
-- practice -- test/e2e/helpers/localstack.ts pins 4.9 for exactly this
-- reason -- and is now enforced rather than assumed.
--
-- SQLite cannot add a column constraint in place, hence the
-- create-copy-drop-rename dance. `entries.hash` references `objects(hash)`,
-- so this only works with foreign key enforcement off for the pass; the
-- runner handles that and runs `foreign_key_check` afterwards. See the
-- comment on `runMigrations` in src/db/migrations/runner.ts for why the
-- obvious alternatives (defer_foreign_keys, legacy_alter_table) do not work.
--
-- If any row still holds a NULL, the INSERT below fails and the whole
-- migration rolls back. That is intended: it means the vault contains
-- objects whose uploads were never verified, and silently dropping or
-- back-filling them would destroy exactly the information the operator
-- needs in order to decide what to do about it.

CREATE TABLE objects_new (
  hash TEXT PRIMARY KEY,
  s3_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  ciphertext_checksum TEXT NOT NULL
);

INSERT INTO objects_new (hash, s3_key, size, ciphertext_checksum)
  SELECT hash, s3_key, size, ciphertext_checksum FROM objects;

DROP TABLE objects;

ALTER TABLE objects_new RENAME TO objects;
