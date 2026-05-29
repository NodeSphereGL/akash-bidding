-- B1 fix: Akash dseqs are unique per owner (managed-wallet), not globally.
-- Allow the same dseq value across different account_id rows.
-- Idempotent: guarded by INFORMATION_SCHEMA so re-runs are no-ops.

SET @has_uniq := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE()
    AND table_name = 'deployments'
    AND index_name = 'dseq'
    AND non_unique = 0
);
SET @sql := IF(@has_uniq > 0, 'ALTER TABLE deployments DROP INDEX dseq', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_new := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE()
    AND table_name = 'deployments'
    AND index_name = 'uniq_account_dseq'
);
SET @sql := IF(@has_new = 0,
  'ALTER TABLE deployments ADD UNIQUE KEY uniq_account_dseq (account_id, dseq)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
