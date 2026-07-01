// skills 表 DAO
import type { DB } from '../database'
import type { Skill, SkillWithSources } from '../../types'
import { getSourcesBySkillId } from './skill-sources'

/**
 * 按 name upsert skill(返回 skill id)。name 是 UNIQUE 主键。
 * 不存在则插入(primary_source_path 初始设为传入的 path),存在则返回已有 id。
 */
export function upsertSkill(
  db: DB,
  name: string,
  primarySourcePath: string
): number {
  const existing = db
    .prepare('SELECT id FROM skills WHERE name = ?')
    .get(name) as { id: number } | undefined

  if (existing) {
    return existing.id
  }

  const result = db
    .prepare(
      'INSERT INTO skills (name, primary_source_path, created_at) VALUES (?, ?, ?)'
    )
    .run(name, primarySourcePath, new Date().toISOString())
  return result.lastInsertRowid as number
}

/** 更新 primary_source_path */
export function updatePrimarySourcePath(
  db: DB,
  skillId: number,
  path: string
): void {
  db.prepare('UPDATE skills SET primary_source_path = ? WHERE id = ?').run(
    path,
    skillId
  )
}

/** 按 name 查 skill */
export function getSkillByName(db: DB, name: string): Skill | undefined {
  return db
    .prepare('SELECT * FROM skills WHERE name = ?')
    .get(name) as Skill | undefined
}

/** 按 id 查 skill */
export function getSkillById(db: DB, id: number): Skill | undefined {
  return db
    .prepare('SELECT * FROM skills WHERE id = ?')
    .get(id) as Skill | undefined
}

/** 获取所有 skill(含 sources,按 name 排序) */
export function getAllSkills(db: DB): SkillWithSources[] {
  const skills = db
    .prepare('SELECT * FROM skills ORDER BY name ASC')
    .all() as Skill[]
  return skills.map((s) => ({
    ...s,
    sources: getSourcesBySkillId(db, s.id)
  }))
}

/** 删除 skill(ON DELETE CASCADE 会自动删 skill_sources 和 deployments) */
export function deleteSkill(db: DB, skillId: number): void {
  db.prepare('DELETE FROM skills WHERE id = ?').run(skillId)
}
