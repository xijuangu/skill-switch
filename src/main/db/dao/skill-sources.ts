// skill_sources 表 DAO
import type { DB } from '../database'
import type { SkillSource, SourceType } from '../../types'

/**
 * Upsert 一个 source:按 (skill_id, path) UNIQUE 约束。
 * 不存在则插入;存在则更新 hash / mtime / source_type / discovered_at / repo_url / commit_sha。
 * repo_url / commit_sha 可选,仅 GitHub 安装的 source 带值;未传时写 null(不覆盖已有 null)。
 */
export function upsertSource(
  db: DB,
  skillId: number,
  path: string,
  hash: string,
  mtime: number,
  sourceType: SourceType,
  repoUrl?: string,
  commitSha?: string
): void {
  db.prepare(
    `INSERT INTO skill_sources (skill_id, path, hash, mtime, source_type, discovered_at, repo_url, commit_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(skill_id, path) DO UPDATE SET
       hash = excluded.hash,
       mtime = excluded.mtime,
       source_type = excluded.source_type,
       discovered_at = excluded.discovered_at,
       repo_url = excluded.repo_url,
       commit_sha = excluded.commit_sha`
  ).run(
    skillId,
    path,
    hash,
    mtime,
    sourceType,
    new Date().toISOString(),
    repoUrl ?? null,
    commitSha ?? null
  )
}

/** 按 skill_id 查所有 source */
export function getSourcesBySkillId(db: DB, skillId: number): SkillSource[] {
  return db
    .prepare('SELECT * FROM skill_sources WHERE skill_id = ? ORDER BY discovered_at ASC')
    .all(skillId) as SkillSource[]
}

/** 按 path 查 source(判断某路径是否已登记) */
export function getSourceByPath(db: DB, path: string): SkillSource | undefined {
  return db
    .prepare('SELECT * FROM skill_sources WHERE path = ?')
    .get(path) as SkillSource | undefined
}

/** 按 skill_id 删除所有 source */
export function deleteSourcesBySkillId(db: DB, skillId: number): void {
  db.prepare('DELETE FROM skill_sources WHERE skill_id = ?').run(skillId)
}

/** 返回全部 indexed source,由 service 用跨平台路径逻辑决定清理范围。 */
export function getAllIndexedSources(db: DB): SkillSource[] {
  return db
    .prepare(
      "SELECT * FROM skill_sources WHERE source_type = 'indexed' ORDER BY discovered_at ASC"
    )
    .all() as SkillSource[]
}

/** 按 id 删除单个 source。 */
export function deleteSourceById(db: DB, sourceId: number): void {
  db.prepare('DELETE FROM skill_sources WHERE id = ?').run(sourceId)
}
