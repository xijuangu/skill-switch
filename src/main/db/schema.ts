// SQLite schema 定义 —— skill-switch 中央注册表
// 三张表:skills / skill_sources / deployments

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
