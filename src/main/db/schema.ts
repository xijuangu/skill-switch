// SQLite schema 定义 —— skill-switch 中央注册表
// 四张表:source_roots / skills / skill_sources / deployments
//
// skill_sources 的 repo_url / commit_sha 列用于 GitHub 安装记录源仓库元数据
// (MVP 不做更新检查,仅留元数据)。CREATE TABLE 里的列对新建 DB 生效;
// 对已存在的旧 DB,runMigrations 用 ALTER TABLE ADD COLUMN 补列。

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_roots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_scanned_at TEXT,
  last_scan_error TEXT
);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  primary_source_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_origin TEXT NOT NULL DEFAULT 'legacy',
  source_tool TEXT,
  source_root_id INTEGER,
  discovered_at TEXT NOT NULL,
  repo_url TEXT,
  commit_sha TEXT,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  FOREIGN KEY (source_root_id) REFERENCES source_roots(id) ON DELETE CASCADE,
  UNIQUE (skill_id, path)
);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL,
  target_tool TEXT NOT NULL,
  target_path TEXT NOT NULL,
  mode TEXT NOT NULL,
  source_path TEXT NOT NULL,
  deployed_at TEXT NOT NULL,
  source_hash_at_deploy TEXT NOT NULL,
  source_id INTEGER,
  target_id TEXT,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES skill_sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_sources_skill_id ON skill_sources(skill_id);
CREATE INDEX IF NOT EXISTS idx_deployments_skill_id ON deployments(skill_id);
CREATE INDEX IF NOT EXISTS idx_deployments_target_tool ON deployments(target_tool);
`

/**
 * 对老 DB 做幂等列迁移:逐列检查 pragma table_info,缺失则 ALTER TABLE ADD COLUMN。
 * 新建 DB 的 CREATE TABLE 已含这些列,迁移会跳过。
 */
export function runMigrations(db: import('better-sqlite3').Database): void {
  const cols = db.prepare('PRAGMA table_info(skill_sources)').all() as { name: string }[]
  const names = new Set(cols.map((c) => c.name))
  if (!names.has('repo_url')) {
    db.exec('ALTER TABLE skill_sources ADD COLUMN repo_url TEXT')
  }
  if (!names.has('commit_sha')) {
    db.exec('ALTER TABLE skill_sources ADD COLUMN commit_sha TEXT')
  }
  if (!names.has('source_origin')) {
    db.exec(
      "ALTER TABLE skill_sources ADD COLUMN source_origin TEXT NOT NULL DEFAULT 'legacy'"
    )
    db.exec(
      "UPDATE skill_sources SET source_origin = CASE WHEN source_type = 'central-repo' AND repo_url IS NOT NULL THEN 'github' WHEN source_type = 'central-repo' THEN 'zip' ELSE 'legacy' END"
    )
  }
  if (!names.has('source_tool')) {
    db.exec('ALTER TABLE skill_sources ADD COLUMN source_tool TEXT')
  }
  if (!names.has('source_root_id')) {
    db.exec('ALTER TABLE skill_sources ADD COLUMN source_root_id INTEGER')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_roots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_scanned_at TEXT,
      last_scan_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_skill_sources_source_root_id
      ON skill_sources(source_root_id);
    CREATE TRIGGER IF NOT EXISTS trg_skill_sources_root_exists_insert
    BEFORE INSERT ON skill_sources
    WHEN NEW.source_root_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM source_roots WHERE id = NEW.source_root_id)
    BEGIN
      SELECT RAISE(ABORT, 'source root not found');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_skill_sources_root_exists_update
    BEFORE UPDATE OF source_root_id ON skill_sources
    WHEN NEW.source_root_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM source_roots WHERE id = NEW.source_root_id)
    BEGIN
      SELECT RAISE(ABORT, 'source root not found');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_source_roots_delete_sources
    BEFORE DELETE ON source_roots
    BEGIN
      DELETE FROM skill_sources WHERE source_root_id = OLD.id;
    END;
  `)
  const sourceRootColumns = db.prepare('PRAGMA table_info(source_roots)').all() as { name: string }[]
  if (!sourceRootColumns.some((column) => column.name === 'last_scan_error')) {
    db.exec('ALTER TABLE source_roots ADD COLUMN last_scan_error TEXT')
  }

  let deploymentCols = db.prepare('PRAGMA table_info(deployments)').all() as {
    name: string
  }[]
  if (!deploymentCols.some((column) => column.name === 'target_path')) {
    // Existing rows remain unresolved instead of guessing from mutable tool settings.
    db.exec('ALTER TABLE deployments ADD COLUMN target_path TEXT')
  }
  if (!deploymentCols.some((column) => column.name === 'source_id')) {
    db.exec('ALTER TABLE deployments ADD COLUMN source_id INTEGER')
  }
  if (!deploymentCols.some((column) => column.name === 'target_id')) {
    db.exec('ALTER TABLE deployments ADD COLUMN target_id TEXT')
  }
  deploymentCols = db.prepare('PRAGMA table_info(deployments)').all() as { name: string }[]

  const deploymentSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deployments'").get() as
      | { sql: string }
      | undefined
  )?.sql
  const completeLegacyColumns = [
    'skill_id',
    'target_tool',
    'target_path',
    'mode',
    'source_path',
    'deployed_at',
    'source_hash_at_deploy'
  ].every((name) => deploymentCols.some((column) => column.name === name))
  if (completeLegacyColumns && /UNIQUE\s*\(\s*skill_id\s*,\s*target_tool\s*\)/i.test(deploymentSql ?? '')) {
    const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number
    db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        db.exec(`
          ALTER TABLE deployments RENAME TO deployments_legacy_identity;
          CREATE TABLE deployments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            skill_id INTEGER NOT NULL,
            target_tool TEXT NOT NULL,
            target_path TEXT,
            mode TEXT NOT NULL,
            source_path TEXT NOT NULL,
            deployed_at TEXT NOT NULL,
            source_hash_at_deploy TEXT NOT NULL,
            source_id INTEGER,
            target_id TEXT,
            FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
            FOREIGN KEY (source_id) REFERENCES skill_sources(id) ON DELETE SET NULL
          );
          INSERT INTO deployments
            (id, skill_id, target_tool, target_path, mode, source_path, deployed_at,
             source_hash_at_deploy, source_id, target_id)
          SELECT id, skill_id, target_tool, target_path, mode, source_path, deployed_at,
                 source_hash_at_deploy, source_id, target_id
          FROM deployments_legacy_identity;
          DROP TABLE deployments_legacy_identity;
        `)
      })()
    } finally {
      db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
    }
  }
  if (completeLegacyColumns) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_deployments_skill_id ON deployments(skill_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_target_tool ON deployments(target_tool);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_skill_target_id
        ON deployments(skill_id, target_id) WHERE target_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS trg_deployments_identity_pair_insert
      BEFORE INSERT ON deployments
      WHEN (NEW.source_id IS NULL) != (NEW.target_id IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'deployment source_id and target_id must resolve together');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_deployments_identity_pair_update
      BEFORE UPDATE OF source_id, target_id ON deployments
      WHEN (NEW.source_id IS NULL) != (NEW.target_id IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'deployment source_id and target_id must resolve together');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_skill_sources_unresolve_deployments_before_delete
      BEFORE DELETE ON skill_sources
      BEGIN
        UPDATE deployments
        SET source_id = NULL, target_id = NULL
        WHERE source_id = OLD.id;
      END;
    `)
  }
}
