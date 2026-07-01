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

/**
 * 删除失效的 indexed source:在 scannedToolDirs 目录下但不在 keepSourcePaths 里的 source。
 * central-repo 的 source 不删(那是用户安装的,与扫描路径无关)。
 * 不在 scannedToolDirs 下的 source 也不删(可能是别的工具的,本次扫描不负责)。
 *
 * @param scannedToolDirs 本次扫描的工具目录列表(确定清理范围)
 * @param keepSourcePaths 本次扫描实际 upsert 的 source 路径(这些保留)
 */
export function deleteStaleIndexedSources(
  db: DB,
  scannedToolDirs: string[],
  keepSourcePaths: string[]
): number {
  if (scannedToolDirs.length === 0) return 0
  // 构建 OR 条件:source path 在某个 scannedToolDir 下(path LIKE 'dir/%')
  const scopeClauses = scannedToolDirs.map(() => 'path LIKE ?').join(' OR ')
  const scopeParams = scannedToolDirs.map((dir) => `${dir}/%`)

  // keepSourcePaths 为空 → 删除范围内的所有 indexed source
  if (keepSourcePaths.length === 0) {
    const result = db
      .prepare(
        `DELETE FROM skill_sources
         WHERE source_type = 'indexed'
           AND (${scopeClauses})`
      )
      .run(...scopeParams)
    return result.changes
  }

  // 不在 keepSourcePaths 里的 → 删除
  const keepPlaceholders = keepSourcePaths.map(() => '?').join(',')
  const result = db
    .prepare(
      `DELETE FROM skill_sources
       WHERE source_type = 'indexed'
         AND (${scopeClauses})
         AND path NOT IN (${keepPlaceholders})`
    )
    .run(...scopeParams, ...keepSourcePaths)
  return result.changes
}
