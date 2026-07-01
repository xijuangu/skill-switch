// deployments 表 DAO
// 本切片(walking skeleton)只建表 + 基础查询,部署写入逻辑在切片 #6。
import type { DB } from '../database'
import type { Deployment } from '../../types'

/** 查所有部署记录 */
export function getAllDeployments(db: DB): Deployment[] {
  return db.prepare('SELECT * FROM deployments ORDER BY deployed_at DESC').all() as Deployment[]
}

/** 按 target_tool 查部署 */
export function getDeploymentsByTool(db: DB, targetTool: string): Deployment[] {
  return db
    .prepare('SELECT * FROM deployments WHERE target_tool = ?')
    .all(targetTool) as Deployment[]
}

/** 按 skill_id 查部署 */
export function getDeploymentsBySkillId(db: DB, skillId: number): Deployment[] {
  return db
    .prepare('SELECT * FROM deployments WHERE skill_id = ?')
    .all(skillId) as Deployment[]
}
