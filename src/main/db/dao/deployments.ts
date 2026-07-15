// deployments 表 DAO
import type { DB } from '../database'
import type { DeployMode, Deployment } from '../../types'

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

/** 按 mode 查部署(用于扫描时构建 skipPaths:copy 部署的目标目录要跳过) */
export function getDeploymentsByMode(db: DB, mode: DeployMode): Deployment[] {
  return db
    .prepare('SELECT * FROM deployments WHERE mode = ?')
    .all(mode) as Deployment[]
}

/** 按 (skill_id, target_tool) 唯一查部署(用于冲突检测:判断目标是否自管部署) */
export function getDeploymentBySkillAndTool(
  db: DB,
  skillId: number,
  targetTool: string
): Deployment | undefined {
  return db
    .prepare('SELECT * FROM deployments WHERE skill_id = ? AND target_tool = ?')
    .get(skillId, targetTool) as Deployment | undefined
}

export function getDeploymentBySkillAndTargetId(
  db: DB,
  skillId: number,
  targetId: string
): Deployment | undefined {
  return db
    .prepare('SELECT * FROM deployments WHERE skill_id = ? AND target_id = ?')
    .get(skillId, targetId) as Deployment | undefined
}

/**
 * Upsert 部署记录:按 (skill_id, target_tool) UNIQUE。
 * 不存在则插入;存在则更新 mode / source_path / deployed_at / source_hash_at_deploy。
 */
export function upsertDeployment(
  db: DB,
  skillId: number,
  targetTool: string,
  targetPath: string,
  mode: DeployMode,
  sourcePath: string,
  sourceHashAtDeploy: string,
  identity?: { sourceId: number; targetId: string }
): void {
  if (identity) {
    db.prepare(
      `INSERT INTO deployments
        (skill_id, target_tool, target_path, mode, source_path, deployed_at,
         source_hash_at_deploy, source_id, target_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_id, target_id) WHERE target_id IS NOT NULL DO UPDATE SET
         target_tool = excluded.target_tool,
         target_path = excluded.target_path,
         mode = excluded.mode,
         source_path = excluded.source_path,
         deployed_at = excluded.deployed_at,
         source_hash_at_deploy = excluded.source_hash_at_deploy,
         source_id = excluded.source_id`
    ).run(
      skillId,
      targetTool,
      targetPath,
      mode,
      sourcePath,
      new Date().toISOString(),
      sourceHashAtDeploy,
      identity.sourceId,
      identity.targetId
    )
    return
  }
  const existing = getDeploymentBySkillAndTool(db, skillId, targetTool)
  if (existing) {
    db.prepare(
      `UPDATE deployments SET target_path = ?, mode = ?, source_path = ?, deployed_at = ?,
       source_hash_at_deploy = ? WHERE id = ?`
    ).run(targetPath, mode, sourcePath, new Date().toISOString(), sourceHashAtDeploy, existing.id)
    return
  }
  db.prepare(
    `INSERT INTO deployments (skill_id, target_tool, target_path, mode, source_path, deployed_at, source_hash_at_deploy)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    skillId,
    targetTool,
    targetPath,
    mode,
    sourcePath,
    new Date().toISOString(),
    sourceHashAtDeploy
  )
}

/** 按 (skill_id, target_tool) 删除部署记录(幂等:不存在不报错) */
export function deleteDeployment(
  db: DB,
  skillId: number,
  targetTool: string
): void {
  db.prepare('DELETE FROM deployments WHERE skill_id = ? AND target_tool = ?').run(
    skillId,
    targetTool
  )
}
