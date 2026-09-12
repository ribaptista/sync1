-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.

-- Global (shared, versioned) ignore policies: a GLOB pattern kept out of
-- the vault entirely. No precedence/priority column -- any match means
-- ignored, a monotonic OR across every row. See
-- docs/architecture/ignore-and-storage-policies.md.
CREATE TABLE ignore_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glob TEXT NOT NULL,
  created_at TEXT NOT NULL
);
