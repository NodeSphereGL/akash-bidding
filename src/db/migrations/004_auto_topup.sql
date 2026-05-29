-- P3 fix: track per-deployment auto-topup disable state so we can retry the
-- PATCH /v2/deployment-settings/{dseq} call when it fails mid-cycle.
-- Idempotent: guarded by INFORMATION_SCHEMA.

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE()
    AND table_name = 'deployments'
    AND column_name = 'auto_topup_disabled'
);
SET @sql := IF(@has_col = 0,
  'ALTER TABLE deployments ADD COLUMN auto_topup_disabled BOOLEAN NOT NULL DEFAULT FALSE AFTER put_attempts',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE()
    AND table_name = 'deployments'
    AND index_name = 'idx_pending_auto_topup'
);
SET @sql := IF(@has_idx = 0,
  'ALTER TABLE deployments ADD INDEX idx_pending_auto_topup (status, auto_topup_disabled)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
