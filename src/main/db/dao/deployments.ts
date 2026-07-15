// deployments 表 DAO
import type { DB } from '../database'
import type { DeployMode, Deployment } from '../../types'

/** 查所有部署记录 */
export function getAllDeployments(db: DB): Deployment[] {
  return db.prepare('SELECT * FROM deployments ORDER BY deployed_at DESC').all() as Deployment[]
}

/** Stable primary-key lookup used by the Deployment Facade. */
export function getDeploymentById(db: DB, deploymentId: number): Deployment | undefined {
  return db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId) as Deployment | undefined
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
  identity: { sourceId: number; targetId: string }
): void {
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
}

/** Delete exactly one semantic Deployment, independent of tool/path aliases. */
export function deleteDeploymentById(db: DB, deploymentId: number): void {
  db.prepare('DELETE FROM deployments WHERE id = ?').run(deploymentId)
}

/** Restore the exact manifest snapshot after a failed filesystem transaction. */
export function restoreDeploymentSnapshot(
  db: DB,
  snapshot: Deployment | undefined,
  identity: { skillId: number; targetId: string }
): void {
  if (!snapshot) {
    db.prepare('DELETE FROM deployments WHERE skill_id = ? AND target_id = ?').run(identity.skillId, identity.targetId)
    return
  }
  db.prepare(`UPDATE deployments SET
    skill_id = ?, target_tool = ?, target_path = ?, mode = ?, source_path = ?, deployed_at = ?,
    source_hash_at_deploy = ?, source_id = ?, target_id = ? WHERE id = ?`).run(
    snapshot.skill_id,
    snapshot.target_tool,
    snapshot.target_path,
    snapshot.mode,
    snapshot.source_path,
    snapshot.deployed_at,
    snapshot.source_hash_at_deploy,
    snapshot.source_id,
    snapshot.target_id,
    snapshot.id
  )
}
