-- Append-only: never edit this file after it has been merged. Add a new
-- numbered migration instead, even for a one-line change.

-- Replaces idx_cache_state: the keyset-paginated dirty-rows queries
-- (iterateDirty, split into two single-column paginated passes -- all
-- 'deleted' rows by path, then all remaining dirty rows by path) filter on
-- `state` AND order by `path` within each state group. The old index only
-- covered the filter, forcing a separate sort step -- exactly what
-- AGENTS.md's "every keyset-paginated query must have a matching index"
-- rule exists to catch. This composite index covers both. See
-- docs/architecture/concurrency-and-progress.md.
DROP INDEX idx_cache_state;
CREATE INDEX idx_cache_state_path ON entries (state, path) WHERE state != 'unchanged';
