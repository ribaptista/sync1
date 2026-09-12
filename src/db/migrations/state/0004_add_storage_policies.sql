-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.

-- Global (shared, versioned) storage-class policies: a GLOB pattern paired
-- with a target S3 storage class. Unlike ignore_policies, overlapping
-- non-default policies need an explicit priority to resolve which one
-- wins -- lower `priority` is checked first. Exactly one default row
-- (is_default = 1, glob NULL, priority NULL) always exists from vault
-- creation onward, seeded below -- it's never part of the priority
-- ordering, structurally always the last resort for a path no other
-- policy matches. See docs/architecture/ignore-and-storage-policies.md.
CREATE TABLE storage_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glob TEXT,
  target_class TEXT NOT NULL CHECK (target_class IN ('STANDARD', 'GLACIER', 'DEEP_ARCHIVE')),
  priority INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
);

INSERT INTO storage_policies (glob, target_class, priority, is_default)
VALUES (NULL, 'STANDARD', NULL, 1);
