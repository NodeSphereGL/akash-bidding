-- Workspace scoping. Adds workspace column to groups and accounts, swaps
-- the groups status index for a (workspace, status, name) composite.
-- Idempotent via INFORMATION_SCHEMA guards (db-migrate.js re-runs every file).

-- 1. groups.workspace
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'groups'
               AND COLUMN_NAME = 'workspace');
SET @sql := IF(@col = 0,
  "ALTER TABLE `groups` ADD COLUMN workspace VARCHAR(64) NOT NULL DEFAULT 'DEFAULT' AFTER branch",
  "SELECT 1");
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. drop legacy idx_status_name if present
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'groups'
               AND INDEX_NAME = 'idx_status_name');
SET @sql := IF(@idx > 0,
  "ALTER TABLE `groups` DROP INDEX idx_status_name",
  "SELECT 1");
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. add composite index (workspace, status, name)
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'groups'
               AND INDEX_NAME = 'idx_workspace_status_name');
SET @sql := IF(@idx = 0,
  "ALTER TABLE `groups` ADD INDEX idx_workspace_status_name (workspace, status, name)",
  "SELECT 1");
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. accounts.workspace
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'accounts'
               AND COLUMN_NAME = 'workspace');
SET @sql := IF(@col = 0,
  "ALTER TABLE accounts ADD COLUMN workspace VARCHAR(64) NOT NULL DEFAULT 'DEFAULT' AFTER proxy",
  "SELECT 1");
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
