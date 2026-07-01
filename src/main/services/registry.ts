// registry 服务:多 source 身份 + 冲突检测
//
// 身份主键 = skill name(skills 表 UNIQUE);一个 skill 可有多个 source path。
// 多 source 内容一致性 = 对比各 source 的 hash:
//   - 全部相同 → 无冲突,primarySource = 第一个发现的 source(getSourcesBySkillId 按 discovered_at ASC)
//   - 存在不同 → 冲突,primarySource = undefined,UI 必须让用户选一个 source
// 不自动合并:冲突时所有 source 保留,仅标记状态,等用户在 UI 选。
//
// 本服务纯函数 + DB 查询,无副作用,便于对着临时 DB 测外部行为。
// (removeFromRegistry 有副作用:备份 + 卸载部署 + 删文件,但通过 opts 注入路径,无 Electron 依赖)

import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/database'
import type { ConflictStatus, SkillSource } from '../types'
import { getSourcesBySkillId, deleteSourcesBySkillId } from '../db/dao/skill-sources'
import { getSkillById, deleteSkill } from '../db/dao/skills'
import {
  getDeploymentsBySkillId,
  deleteDeployment
} from '../db/dao/deployments'
import { runInTransaction } from '../db/database'
import { undeploySkill } from './deployer'
import { createBackup } from './backup'

/**
 * 基于已加载的 sources 计算冲突状态(纯函数,不查 DB)。
 * @param sources 已按 discovered_at ASC 排序的 source 列表
 * @param skillId 所属 skill id
 */
export function computeConflict(
  sources: SkillSource[],
  skillId: number
): ConflictStatus {
  const sourceCount = sources.length
  const distinctHashCount = new Set(sources.map((s) => s.hash)).size
  const hasConflict = sourceCount > 1 && distinctHashCount > 1
  // 无冲突时:有 source 则取第一个;冲突或无 source 时为 null
  const primarySource = hasConflict || sourceCount === 0 ? null : sources[0]
  return { skillId, sourceCount, distinctHashCount, hasConflict, primarySource }
}

/** 按 skill_id 查 source 并计算冲突状态 */
export function getConflictStatus(db: DB, skillId: number): ConflictStatus {
  const sources = getSourcesBySkillId(db, skillId)
  return computeConflict(sources, skillId)
}

/**
 * 返回所有存在冲突的 skill 的 ConflictStatus(sourceCount > 1 且 distinctHashCount > 1)。
 * 用于全局扫描冲突提示;无冲突的 skill 不在结果中。
 * @param skillIds 待检查的 skill id 列表(通常来自 getAllSkills 的结果)
 */
export function getAllConflicts(db: DB, skillIds: number[]): ConflictStatus[] {
  const out: ConflictStatus[] = []
  for (const id of skillIds) {
    const status = getConflictStatus(db, id)
    if (status.hasConflict) {
      out.push(status)
    }
  }
  return out
}

/**
 * removeFromRegistry 入参(Option A:显式注入路径 + 回调,无 Electron/settings.json 依赖)。
 * - centralSkillsDir:中央仓库 skills 目录(~/.skill-switch/skills)。
 *   中央实体 = {centralSkillsDir}/{skill.name}/,删除前先备份。
 * - backupsDir:备份目录(~/.skill-switch/skill-backups),中央实体备份到这里。
 * - resolveTargetPath:把 (targetTool, skillName) 解析成磁盘上的目标路径。
 *   返回绝对路径,或 null(工具不可用 → 跳过 fs 清理,只删 DB 记录)。
 *   把路径解析留给 IPC 调用方(从 settings.json 解析),服务层保持纯函数式。
 */
export interface RemoveFromRegistryOptions {
  centralSkillsDir: string
  backupsDir: string
  resolveTargetPath: (targetTool: string, skillName: string) => string | null
}

/** removeFromRegistry 返回结果 */
export interface RemoveFromRegistryResult {
  skillName: string
  /** 是否创建了中央实体备份(中央实体存在时为 true) */
  backedUp: boolean
  /** 已卸载的工具列表(无论是否做了 fs 清理,只要清单有记录就计入) */
  undeployedTools: string[]
}

/**
 * 从注册表移除 skill:删中央仓库实体 + 所有部署 + 清单记录,删前先备份中央实体。
 *
 * 顺序(保证 DB 与磁盘一致性):
 * 1. (事务外)若中央实体存在 → createBackup(拷贝),backedUp=true
 * 2. (事务内)逐个卸载部署:resolveTargetPath 可解析 → undeploySkill(清理 + 删记录);
 *    返回 null(工具不可用)→ 直接 deleteDeployment(跳过 fs 清理,目标可能已不在)
 * 3. (事务内)deleteSourcesBySkillId
 * 4. (事务内)deleteSkill(ON DELETE CASCADE 兜底,但此处已显式清理)
 * 5. (事务外)rmSync 中央实体目录(备份已先拷贝,删除不影响备份)
 *
 * 若事务失败,磁盘上的中央实体保持不变(备份步骤已先执行,但备份是额外的拷贝,
 * 不影响原目录;rmSync 在事务提交后执行,所以事务回滚不会误删中央实体)。
 *
 * @throws skill 不存在时抛错(skillId 无效)
 */
export function removeFromRegistry(
  db: DB,
  skillId: number,
  opts: RemoveFromRegistryOptions
): RemoveFromRegistryResult {
  // Step 1: 查 skill,不存在则抛错
  const skill = getSkillById(db, skillId)
  if (!skill) {
    throw new Error(`skill not found: id=${skillId}`)
  }

  const centralEntityPath = join(opts.centralSkillsDir, skill.name)
  const centralEntityExists = existsSync(centralEntityPath)

  // Step 2 (事务外):中央实体存在 → 备份(拷贝,不动原目录)
  let backedUp = false
  if (centralEntityExists) {
    createBackup({
      skillName: skill.name,
      targetTool: 'registry',
      sourcePath: centralEntityPath,
      backupsDir: opts.backupsDir
    })
    backedUp = true
  }

  // Step 3-5 (事务内):卸载部署 + 删 sources + 删 skill
  const undeployedTools: string[] = []
  runInTransaction(db, () => {
    const deployments = getDeploymentsBySkillId(db, skillId)
    for (const dep of deployments) {
      const targetPath = opts.resolveTargetPath(dep.target_tool, skill.name)
      if (targetPath !== null) {
        // 路径可解析:undeploySkill 做 fs 清理 + 删清单记录
        try {
          undeploySkill(db, skillId, dep.target_tool, targetPath)
        } catch {
          // 防御性:若记录已被删(理论不会,每个 deployment 不同 target_tool),兜底删记录
          deleteDeployment(db, skillId, dep.target_tool)
        }
      } else {
        // 工具不可用:跳过 fs 清理,只删清单记录(目标可能已不在,幂等)
        deleteDeployment(db, skillId, dep.target_tool)
      }
      undeployedTools.push(dep.target_tool)
    }

    // Step 4: 删 skill_sources 记录
    deleteSourcesBySkillId(db, skillId)

    // Step 5: 删 skill 记录(ON DELETE CASCADE 兜底,但已显式清理)
    deleteSkill(db, skillId)
  })

  // Step 6 (事务外):删中央实体目录(备份已先拷贝,安全删除原目录)
  if (centralEntityExists) {
    rmSync(centralEntityPath, { recursive: true, force: true })
  }

  return { skillName: skill.name, backedUp, undeployedTools }
}
