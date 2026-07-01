// SQLite schema 定义 —— skill-switch 中央注册表
// 三张表:skills / skill_sources / deployments
//
// skill_sources 的 repo_url / commit_sha 列用于 GitHub 安装记录源仓库元数据
// (MVP 不做更新检查,仅留元数据)。CREATE TABLE 里的列对新建 DB 生效;
// 对已存在的旧 DB,runMigrations 用 ALTER TABLE ADD COLUMN 补列。

export const SCHEMA = `
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
  discovered_at TEXT NOT NULL,
  repo_url TEXT,
  commit_sha TEXT,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  UNIQUE (skill_id, path)
);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL,
  target_tool TEXT NOT NULL,
  mode TEXT NOT NULL,
  source_path TEXT NOT NULL,
  deployed_at TEXT NOT NULL,
  source_hash_at_deploy TEXT NOT NULL,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  UNIQUE (skill_id, target_tool)
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
}
