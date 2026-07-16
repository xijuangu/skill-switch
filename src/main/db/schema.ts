// SQLite schema 定义 —— skill-switch Skill Library 注册表
// 四张表:source_roots / skills / skill_sources / deployments
//
// skill_sources 的 repo_url / commit_sha 列用于 GitHub 安装记录源仓库元数据
// (MVP 不做更新检查,仅留元数据)。CREATE TABLE 里的列对新建 DB 生效;
// 对已存在的旧 DB,runMigrations 用 ALTER TABLE ADD COLUMN 补列。

import { isAbsolute, relative, resolve, sep } from 'path'

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
  source_role TEXT NOT NULL DEFAULT 'candidate' CHECK (source_role IN ('candidate', 'canonical')),
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
  management TEXT NOT NULL DEFAULT 'managed' CHECK (management IN ('managed', 'observed')),
  source_path TEXT NOT NULL,
  deployed_at TEXT NOT NULL,
  source_hash_at_deploy TEXT NOT NULL,
  source_id INTEGER,
  target_id TEXT,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES skill_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS consolidation_batches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('previewed', 'completed', 'failed', 'recovery-required', 'undone')),
  phase TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  undone_at TEXT,
  failure_message TEXT,
  archive_size_bytes INTEGER,
  archive_purged_at TEXT,
  purge_confirmation_id TEXT,
  purge_previewed_at TEXT,
  purge_archive_hash TEXT
);

CREATE TABLE IF NOT EXISTS consolidation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  skill_id INTEGER NOT NULL,
  skill_name TEXT NOT NULL,
  candidate_source_snapshot TEXT NOT NULL,
  observed_deployments_snapshot TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  canonical_hash TEXT,
  phase TEXT,
  evidence_json TEXT,
  FOREIGN KEY (batch_id) REFERENCES consolidation_batches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_skill_sources_skill_id ON skill_sources(skill_id);
CREATE INDEX IF NOT EXISTS idx_deployments_skill_id ON deployments(skill_id);
CREATE INDEX IF NOT EXISTS idx_deployments_target_tool ON deployments(target_tool);
CREATE INDEX IF NOT EXISTS idx_consolidation_items_batch_id ON consolidation_items(batch_id);
CREATE TABLE IF NOT EXISTS consolidation_operation_locks (
  resource TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES consolidation_batches(id) ON DELETE CASCADE
);
`

/**
 * 对老 DB 做幂等列迁移:逐列检查 pragma table_info,缺失则 ALTER TABLE ADD COLUMN。
 * 新建 DB 的 CREATE TABLE 已含这些列,迁移会跳过。
 */
export function runMigrations(
  db: import('better-sqlite3').Database,
  canonicalRepositoryPath?: string
): void {
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
  if (!names.has('source_role')) {
    db.exec(
      "ALTER TABLE skill_sources ADD COLUMN source_role TEXT NOT NULL DEFAULT 'candidate' CHECK (source_role IN ('candidate', 'canonical'))"
    )
    if (canonicalRepositoryPath && names.has('path')) {
      const repository = resolve(canonicalRepositoryPath)
      const hasSkillId = names.has('skill_id')
      const rows = db.prepare(`SELECT id, path${hasSkillId ? ', skill_id' : ''} FROM skill_sources ORDER BY id`).all() as Array<{
        id: number
        path: string
        skill_id?: number
      }>
      const update = db.prepare("UPDATE skill_sources SET source_role = 'canonical' WHERE id = ?")
      const inside = rows.filter((row) => {
        const rel = relative(repository, resolve(row.path))
        return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
      })
      if (!hasSkillId) {
        for (const row of inside) update.run(row.id)
      } else {
        const primaryPaths = new Map<number, string>()
        try {
          for (const skill of db.prepare('SELECT id, primary_source_path FROM skills').all() as Array<{ id: number; primary_source_path: string }>) {
            primaryPaths.set(skill.id, resolve(skill.primary_source_path))
          }
        } catch {
          // A partially migrated legacy database may not expose the skills read model yet.
        }
        const selected = new Map<number, typeof inside[number]>()
        for (const row of inside) {
          const skillId = row.skill_id!
          const current = selected.get(skillId)
          if (!current || resolve(row.path) === primaryPaths.get(skillId)) selected.set(skillId, row)
        }
        for (const row of selected.values()) update.run(row.id)
      }
    }
  }
  const migratedColumns = new Set((db.prepare('PRAGMA table_info(skill_sources)').all() as { name: string }[]).map((column) => column.name))
  if (migratedColumns.has('skill_id') && migratedColumns.has('source_role')) {
    const duplicateSkills = db.prepare(`
      SELECT skill_id FROM skill_sources
      WHERE source_role = 'canonical'
      GROUP BY skill_id HAVING COUNT(*) > 1
    `).all() as Array<{ skill_id: number }>
    const demote = db.prepare("UPDATE skill_sources SET source_role = 'candidate' WHERE skill_id = ? AND source_role = 'canonical' AND id <> ?")
    for (const duplicate of duplicateSkills) {
      const candidates = db.prepare("SELECT id, path FROM skill_sources WHERE skill_id = ? AND source_role = 'canonical' ORDER BY id ASC").all(duplicate.skill_id) as Array<{ id: number; path: string }>
      let primaryPath: string | undefined
      try {
        primaryPath = (db.prepare('SELECT primary_source_path FROM skills WHERE id = ?').get(duplicate.skill_id) as { primary_source_path?: string } | undefined)?.primary_source_path
      } catch {
        // A partially migrated database can still be repaired deterministically by oldest Source ID.
      }
      const selected = candidates.find((candidate) => candidate.path === primaryPath) ?? candidates[0]
      demote.run(duplicate.skill_id, selected.id)
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_sources_one_canonical_per_skill
      ON skill_sources(skill_id) WHERE source_role = 'canonical'`)
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
  if (!deploymentCols.some((column) => column.name === 'management')) {
    db.exec("ALTER TABLE deployments ADD COLUMN management TEXT NOT NULL DEFAULT 'managed' CHECK (management IN ('managed', 'observed'))")
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
            management TEXT NOT NULL DEFAULT 'managed' CHECK (management IN ('managed', 'observed')),
            source_path TEXT NOT NULL,
            deployed_at TEXT NOT NULL,
            source_hash_at_deploy TEXT NOT NULL,
            source_id INTEGER,
            target_id TEXT,
            FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
            FOREIGN KEY (source_id) REFERENCES skill_sources(id) ON DELETE SET NULL
          );
          INSERT INTO deployments
            (id, skill_id, target_tool, target_path, mode, management, source_path, deployed_at,
             source_hash_at_deploy, source_id, target_id)
          SELECT id, skill_id, target_tool, target_path, mode, management, source_path, deployed_at,
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS consolidation_batches (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('previewed', 'completed', 'failed', 'recovery-required', 'undone')),
      phase TEXT,
      evidence_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      undone_at TEXT,
      failure_message TEXT
    );
    CREATE TABLE IF NOT EXISTS consolidation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      skill_id INTEGER NOT NULL,
      skill_name TEXT NOT NULL,
      candidate_source_snapshot TEXT NOT NULL,
      observed_deployments_snapshot TEXT NOT NULL,
      canonical_path TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      canonical_hash TEXT,
      phase TEXT,
      evidence_json TEXT,
      FOREIGN KEY (batch_id) REFERENCES consolidation_batches(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_consolidation_items_batch_id
      ON consolidation_items(batch_id);
    CREATE TABLE IF NOT EXISTS consolidation_operation_locks (
      resource TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES consolidation_batches(id) ON DELETE CASCADE
    );
  `)
  const consolidationColumns = new Set((db.prepare('PRAGMA table_info(consolidation_batches)').all() as { name: string }[]).map((column) => column.name))
  if (!consolidationColumns.has('phase')) db.exec('ALTER TABLE consolidation_batches ADD COLUMN phase TEXT')
  if (!consolidationColumns.has('evidence_json')) db.exec('ALTER TABLE consolidation_batches ADD COLUMN evidence_json TEXT')
  if (!consolidationColumns.has('archive_size_bytes')) db.exec('ALTER TABLE consolidation_batches ADD COLUMN archive_size_bytes INTEGER')
  if (!consolidationColumns.has('archive_purged_at')) db.exec('ALTER TABLE consolidation_batches ADD COLUMN archive_purged_at TEXT')
  if (!consolidationColumns.has('purge_confirmation_id')) db.exec('ALTER TABLE consolidation_batches ADD COLUMN purge_confirmation_id TEXT')
  if (!consolidationColumns.has('purge_previewed_at')) db.exec('ALTER TABLE consolidation_batches ADD COLUMN purge_previewed_at TEXT')
  if (!consolidationColumns.has('purge_archive_hash')) db.exec('ALTER TABLE consolidation_batches ADD COLUMN purge_archive_hash TEXT')
  const consolidationItemColumns = new Set((db.prepare('PRAGMA table_info(consolidation_items)').all() as { name: string }[]).map((column) => column.name))
  if (!consolidationItemColumns.has('phase')) db.exec('ALTER TABLE consolidation_items ADD COLUMN phase TEXT')
  if (!consolidationItemColumns.has('evidence_json')) db.exec('ALTER TABLE consolidation_items ADD COLUMN evidence_json TEXT')
}
