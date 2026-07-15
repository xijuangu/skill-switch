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
import { join, resolve } from 'path'
import type { DB } from '../db/database'
import type { ConflictStatus, SkillSource, ToolConfig } from '../types'
import {
  deleteSourceById,
  deleteSourcesBySkillId,
  getAllIndexedSources,
  getSourcesBySkillId
} from '../db/dao/skill-sources'
import {
  deleteSkill,
  getSkillById,
  updatePrimarySourcePath
} from '../db/dao/skills'
import {
  getDeploymentsBySkillId
} from '../db/dao/deployments'
import { runInTransaction } from '../db/database'
import { createBackup } from './backup'
import {
  assertAbsolutePath,
  isPathWithin,
  resolveWithin,
  validateSkillName
} from './path-safety'

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
 * issue #20:根据当前已启用的工具配置过滤 source 列表(纯函数,只读过滤,不删 DB)。
 *
 * 禁用一个预设工具后,技能页不应继续把该工具路径下扫描得到的 source 当作当前可用
 * source 展示。但禁用只改变可见性,不应误删本地文件;重新启用并扫描后应能恢复发现。
 *
 * 规则:
 * - central-repo source 始终保留(中央仓库不依赖任何工具配置)
 * - indexed source 的 path 在某个 enabled 工具的 paths 下 → 保留
 * - indexed source 的 path 不在任何工具(enabled 或 disabled)的 paths 下 → 保留
 *   (用户通过"添加本地目录"登记的 source,不因禁用无关工具而隐藏)
 * - indexed source 的 path 仅在 disabled 工具的 paths 下(不在任何 enabled 工具下)→ 隐藏
 *
 * 该函数只过滤,不删除 DB 记录。重新启用工具后,source 自然重新显示(DB 记录从未删除,
 * 只是过滤后不再隐藏)。调用方应在过滤后用 `computeConflict` 基于可见 source 重算冲突。
 *
 * @param sources 某 skill 的全部 source(按 discovered_at ASC)
 * @param toolConfigs 当前解析出的全部工具配置(enabled + disabled,预设 + 自定义)
 * @returns 过滤后的 source 列表(保持原顺序)
 */
export function filterSourcesByEnabledTools(
  sources: SkillSource[],
  toolConfigs: ToolConfig[]
): SkillSource[] {
  const enabledTools = new Set(
    toolConfigs.filter((config) => config.enabled).map((config) => config.key)
  )
  const enabledRoots = toolConfigs
    .filter((config) => config.enabled)
    .flatMap((config) => config.paths)
    .map((path) => resolve(path))

  return sources.filter((source) => {
    if (source.source_origin !== 'scan' || source.source_tool == null) {
      return true
    }
    if (enabledTools.has(source.source_tool)) return true
    const sourcePath = resolve(source.path)
    return enabledRoots.some(
      (root) => root === sourcePath || isPathWithin(root, sourcePath)
    )
  })
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

/** Resolve a renderer-provided path only when it belongs to this skill. */
export function assertRegisteredSkillSource(
  db: DB,
  skillId: number,
  sourcePath: string
): string {
  const candidate = assertAbsolutePath(sourcePath, 'sourcePath')
  const registered = getSourcesBySkillId(db, skillId).some(
    (source) => assertAbsolutePath(source.path, 'registered source path') === candidate
  )
  if (!registered) {
    throw new Error(`source path is not registered for skill ${skillId}`)
  }
  return candidate
}

/**
 * Reconcile indexed sources beneath directories whose contents are known.
 * Callers must only pass successfully scanned or explicitly removed directories.
 */
export function reconcileIndexedSources(
  db: DB,
  scopedDirs: string[],
  keepSourcePaths: string[]
): number {
  if (scopedDirs.length === 0) return 0
  const keep = new Set(
    keepSourcePaths.map((path) => assertAbsolutePath(path, 'source path'))
  )
  const stale = getAllIndexedSources(db).filter((source) => {
    const sourcePath = assertAbsolutePath(source.path, 'indexed source path')
    return (
      scopedDirs.some((dir) => isPathWithin(dir, sourcePath)) &&
      !keep.has(sourcePath)
    )
  })

  let removed = 0
  runInTransaction(db, () => {
    for (const source of stale) {
      const skill = getSkillById(db, source.skill_id)
      if (!skill) continue
      const remaining = getSourcesBySkillId(db, source.skill_id).filter(
        (candidate) => candidate.id !== source.id
      )
      const deployments = getDeploymentsBySkillId(db, source.skill_id)

      if (remaining.length === 0 && deployments.length > 0) {
        // Keep the last source as a missing-source record until deployments are removed.
        continue
      }
      if (remaining.length === 0) {
        deleteSkill(db, source.skill_id)
        removed++
        continue
      }

      deleteSourceById(db, source.id)
      if (
        assertAbsolutePath(skill.primary_source_path, 'primary source path') ===
        assertAbsolutePath(source.path, 'source path')
      ) {
        updatePrimarySourcePath(db, source.skill_id, remaining[0].path)
      }
      removed++
    }
  })
  return removed
}

/**
 * removeFromRegistry 入参:显式注入中央仓库与备份路径。
 * - centralSkillsDir:中央仓库 skills 目录(~/.skill-switch/skills)。
 *   中央实体 = {centralSkillsDir}/{skill.name}/,删除前先备份。
 * - backupsDir:备份目录(~/.skill-switch/skill-backups),中央实体备份到这里。
 */
export interface RemoveFromRegistryOptions {
  centralSkillsDir: string
  backupsDir: string
  /** Production callers route every deployment mutation through the Facade. */
  undeployDeployment: (deploymentId: number) => Promise<{
    status: 'completed' | 'rejected' | 'recovery-required'
    message?: string
  }>
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
 * 2. 逐个把 Deployment ID 交给 Facade 卸载(生产路径共享目标锁与补偿)。
 * 3. (事务内)deleteSourcesBySkillId
 * 4. (事务内)deleteSkill(ON DELETE CASCADE 兜底,但此处已显式清理)
 * 5. (事务外)rmSync 中央实体目录(备份已先拷贝,删除不影响备份)
 *
 * 若某个 Facade mutation 返回 busy / recovery-required，停止级联并保留注册表；
 * 已完成的取消部署代表真实状态，下次调用会继续处理剩余记录。
 *
 * @throws skill 不存在时抛错(skillId 无效)
 */
export async function removeFromRegistry(
  db: DB,
  skillId: number,
  opts: RemoveFromRegistryOptions
): Promise<RemoveFromRegistryResult> {
  // Step 1: 查 skill,不存在则抛错
  const skill = getSkillById(db, skillId)
  if (!skill) {
    throw new Error(`skill not found: id=${skillId}`)
  }

  const centralEntityPath = resolveWithin(
    opts.centralSkillsDir,
    validateSkillName(skill.name)
  )
  const centralEntityExists = existsSync(centralEntityPath)

  // Step 2 (事务外):备份 skill 内容
  // - 中央实体存在 → 备份中央实体(常规场景)
  // - 中央实体不存在 → 备份 primary source(从外部索引的 skill,无中央实体)
  //   保证无论 skill 来自哪里,Remove from Registry 前都有备份兜底
  let backedUp = false
  const backupSourcePath = centralEntityExists
    ? centralEntityPath
    : skill.primary_source_path
  if (backupSourcePath && existsSync(backupSourcePath)) {
    createBackup({
      skillName: skill.name,
      targetTool: 'registry',
      sourcePath: backupSourcePath,
      backupsDir: opts.backupsDir
    })
    backedUp = true
  }

  // Step 3: each filesystem mutation completes through the Deployment Facade
  // before registry metadata is removed. Do not hold a SQLite transaction
  // across awaited target locks.
  const undeployedTools: string[] = []
  const deployments = getDeploymentsBySkillId(db, skillId)
  for (const dep of deployments) {
    const outcome = await opts.undeployDeployment(dep.id)
    if (outcome.status !== 'completed') {
      throw new Error(outcome.message ?? `unable to undeploy deployment ${dep.id}`)
    }
    undeployedTools.push(dep.target_tool)
  }

  // Step 4-5: metadata deletion remains atomic after all target mutations.
  runInTransaction(db, () => {
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
