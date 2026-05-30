-- Add `owner` (akash bech32 address) to deployments so the sync-live importer
-- can dedupe shared-wallet rows. Console-api lets multiple api-keys see the
-- same wallet's deployments; without the owner column we can't tell apart
-- "two accounts independently created the same dseq" (impossible — Akash
-- dseqs are unique per owner) from "one deployment is visible to N keys".
-- Idempotent: guarded by INFORMATION_SCHEMA.

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE()
    AND table_name = 'deployments'
    AND column_name = 'owner'
);
SET @sql := IF(@has_col = 0,
  'ALTER TABLE deployments ADD COLUMN owner VARCHAR(64) NULL AFTER account_id',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE()
    AND table_name = 'deployments'
    AND index_name = 'idx_owner_dseq'
);
SET @sql := IF(@has_idx = 0,
  'ALTER TABLE deployments ADD INDEX idx_owner_dseq (owner, dseq)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
