// skill_sources 表 DAO
import type { DB } from '../database'
import { getCanonicalRepositoryPath } from '../database'
import { isAbsolute, relative, resolve, sep } from 'path'
import type { SkillSource, SourceOrigin, SourceRole, SourceType } from '../../types'

/**
 * Upsert 一个 source:按 (skill_id, path) UNIQUE 约束。
 * 不存在则插入;存在则更新可变元数据。discovered_at 表示首次发现时间，重复扫描不得刷新。
 * repo_url / commit_sha 可选,仅 GitHub 安装的 source 带值;未传时写 null(不覆盖已有 null)。
 */
export function upsertSource(
  db: DB,
  skillId: number,
  path: string,
  hash: string,
  mtime: number,
  sourceType: SourceType,
  metadata: {
    repoUrl?: string
    commitSha?: string
    origin?: SourceOrigin
    role?: SourceRole
    tool?: string | null
    rootId?: number | null
  } = {}
): void {
  const sourceOrigin = metadata.origin ?? 'legacy'
  const repository = getCanonicalRepositoryPath(db)
  const relativeToRepository = repository ? relative(resolve(repository), resolve(path)) : null
  const isInsideCanonicalRepository = relativeToRepository !== null && relativeToRepository.length > 0 &&
    relativeToRepository !== '..' && !relativeToRepository.startsWith(`..${sep}`) && !isAbsolute(relativeToRepository)
  const sourceRole = isInsideCanonicalRepository ? 'canonical' : (metadata.role ?? 'candidate')
  const sourceTool = metadata.tool ?? null
  const sourceRootId = metadata.rootId ?? null
  db.prepare(
    `INSERT INTO skill_sources (skill_id, path, hash, mtime, source_type, source_role, source_origin, source_tool, source_root_id, discovered_at, repo_url, commit_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(skill_id, path) DO UPDATE SET
       hash = excluded.hash,
       mtime = excluded.mtime,
       source_type = CASE
         WHEN skill_sources.source_role = 'canonical' AND (excluded.source_role = 'candidate' OR excluded.source_type = 'indexed')
           THEN skill_sources.source_type
         ELSE excluded.source_type
       END,
       source_role = CASE
         WHEN skill_sources.source_role = 'canonical' AND (excluded.source_role = 'candidate' OR excluded.source_type = 'indexed')
           THEN skill_sources.source_role
         ELSE excluded.source_role
       END,
       source_origin = CASE
         WHEN skill_sources.source_role = 'canonical' AND (excluded.source_role = 'candidate' OR excluded.source_type = 'indexed')
           THEN skill_sources.source_origin
         WHEN skill_sources.source_root_id IS NOT NULL AND excluded.source_root_id IS NULL
           THEN skill_sources.source_origin
         ELSE excluded.source_origin
       END,
       source_tool = CASE
         WHEN skill_sources.source_role = 'canonical' AND (excluded.source_role = 'candidate' OR excluded.source_type = 'indexed')
           THEN skill_sources.source_tool
         WHEN skill_sources.source_root_id IS NOT NULL AND excluded.source_root_id IS NULL
           THEN skill_sources.source_tool
         ELSE excluded.source_tool
       END,
       source_root_id = CASE
         WHEN skill_sources.source_role = 'canonical' AND (excluded.source_role = 'candidate' OR excluded.source_type = 'indexed')
           THEN skill_sources.source_root_id
         ELSE COALESCE(excluded.source_root_id, skill_sources.source_root_id)
       END,
       repo_url = CASE
         WHEN skill_sources.source_role = 'canonical' AND (excluded.source_role = 'candidate' OR excluded.source_type = 'indexed')
           THEN skill_sources.repo_url
         ELSE excluded.repo_url
       END,
       commit_sha = CASE
         WHEN skill_sources.source_role = 'canonical' AND (excluded.source_role = 'candidate' OR excluded.source_type = 'indexed')
           THEN skill_sources.commit_sha
         ELSE excluded.commit_sha
       END`
  ).run(
    skillId,
    path,
    hash,
    mtime,
    sourceType,
    sourceRole,
    sourceOrigin,
    sourceTool,
    sourceRootId,
    new Date().toISOString(),
    metadata.repoUrl ?? null,
    metadata.commitSha ?? null
  )
}

export function getSourcesByRootId(db: DB, rootId: number): SkillSource[] {
  return db
    .prepare('SELECT * FROM skill_sources WHERE source_root_id = ? ORDER BY path ASC')
    .all(rootId) as SkillSource[]
}

export function moveSourceToSkill(
  db: DB,
  sourceId: number,
  skillId: number,
  hash: string,
  mtime: number,
  rootId: number
): void {
  db.prepare(
    `UPDATE skill_sources
     SET skill_id = ?, hash = ?, mtime = ?, source_type = 'indexed',
         source_role = 'candidate', source_origin = 'local', source_tool = NULL, source_root_id = ?,
         repo_url = NULL, commit_sha = NULL
     WHERE id = ?`
  ).run(skillId, hash, mtime, rootId, sourceId)
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

export function getSourceById(db: DB, id: number): SkillSource | undefined {
  return db.prepare('SELECT * FROM skill_sources WHERE id = ?').get(id) as SkillSource | undefined
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
