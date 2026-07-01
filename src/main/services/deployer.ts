// deployer 服务:把 skill 从源目录部署到目标工具目录
//
// 设计要点:
// 1. 纯函数 + DB 操作,无 Electron 依赖,便于测试用 temp fs 驱动
// 2. 所有路径参数显式传入(sourcePath / targetDir / backupsDir),不读真实 ~/.skill-switch
// 3. 清理旧部署时基于旧 mode 选择清理方式:
//    - symlink/junction → unlinkSync 只删链接本身
//    - copy → rmSync recursive 删真实目录
//    这是关键安全点:rmSync recursive 会跟随符号链接,误删链接目标(源目录)的内容。
//    unlinkSync 只删链接本身,不跟随。
// 4. 外部 skill(清单无记录但目标存在)覆盖前先走 backup 服务备份,不直接删用户的东西

import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from 'fs'
import { join } from 'path'
import type { DB } from '../db/database'
import type {
  DeployAction,
  DeployMode,
  DeployOptions,
  DeployResult,
  DriftKind,
  DriftStatus
} from '../types'
import {
  deleteDeployment,
  getDeploymentBySkillAndTool,
  getDeploymentsByTool,
  upsertDeployment
} from '../db/dao/deployments'
import { getSkillById } from '../db/dao/skills'
import { hashDir } from './hash'
import { createBackup } from './backup'

/**
 * 按已知 mode 清理 targetPath。
 * - symlink/junction:unlinkSync 只删链接本身(不跟随,不删源目录)
 * - copy:rmSync recursive 删真实目录
 *
 * 基于 mode 选择清理方式是关键安全点:rmSync recursive 在符号链接上可能跟随链接,
 * 误删链接目标(源目录)的内容。unlinkSync 只删链接本身。
 */
function cleanupByMode(targetPath: string, mode: DeployMode): void {
  if (mode === 'symlink' || mode === 'junction') {
    // 链接类型:只删链接,不跟随。不存在则忽略(幂等)。
    try {
      unlinkSync(targetPath)
    } catch {
      // 目标已不存在,无需清理
    }
  } else {
    // copy:真实目录,递归删除
    rmSync(targetPath, { recursive: true, force: true })
  }
}

/**
 * 清理未知类型的 targetPath(外部 skill 场景,不知道旧 mode)。
 * 先 lstatSync 判断(不跟随符号链接):是 symlink 则 unlinkSync,否则 rmSync recursive。
 */
function cleanupUnknown(targetPath: string): void {
  try {
    const stat = lstatSync(targetPath)
    if (stat.isSymbolicLink()) {
      try {
        unlinkSync(targetPath)
      } catch {
        // 已不存在
      }
    } else {
      rmSync(targetPath, { recursive: true, force: true })
    }
  } catch {
    // 不存在,无需清理
  }
}

/**
 * 按新 mode 部署文件到 targetDir(调用前需确保 targetDir 已清理)。
 * - copy:cpSync recursive
 * - symlink:symlinkSync
 * - junction:symlinkSync + 'junction' 类型(Windows 目录连接;非 Windows 退化为普通 symlink)
 */
function deployFiles(mode: DeployMode, sourcePath: string, targetDir: string): void {
  if (mode === 'copy') {
    cpSync(sourcePath, targetDir, { recursive: true, force: true })
  } else if (mode === 'symlink') {
    symlinkSync(sourcePath, targetDir)
  } else {
    // junction(Windows 目录连接):symlinkSync + 'junction' 类型,
    // 在非 Windows 平台 type 参数被忽略,退化为普通 symlink
    symlinkSync(sourcePath, targetDir, 'junction')
  }
}

/**
 * 解析实际部署 mode(issue #9 junction fallback 决策,纯函数)。
 *
 * 当请求 symlink 但平台无法创建 symlink(Windows 普通用户 canSymlink=false):
 * - canJunction=true 且 source 是目录 → 尝试 junction(junction 成功不算降级,
 *   它是 symlink 不可用时的预期回退;失败再降级 copy,由 deploySkill 的 try/catch 处理)。
 * - canJunction=false 或 source 不是目录 → 直接降级 copy。
 * 其余情况(非 symlink 请求,或 canSymlink=true)按请求 mode 原样使用。
 */
export function resolveActualMode(
  requested: DeployMode,
  canSymlink: boolean,
  canJunction: boolean,
  sourceIsDir: boolean
): { actualMode: DeployMode; degradedFrom?: DeployMode; degradeReason?: string } {
  if (requested !== 'symlink' || canSymlink) {
    // 非 symlink 请求,或 symlink 可用 → 原样使用
    return { actualMode: requested }
  }
  // 请求 symlink 但 canSymlink=false(Windows 普通用户)
  if (canJunction && sourceIsDir) {
    // 尝试 junction;实际成功/失败由 deploySkill 调用 symlinkSync 时判定
    return { actualMode: 'junction' }
  }
  // 无法 junction → 降级 copy
  return {
    actualMode: 'copy',
    degradedFrom: 'symlink',
    degradeReason: 'symlink is unavailable on this platform; used copy instead.'
  }
}

/**
 * 把 skill 从 opts.sourcePath 部署到 opts.targetDir。
 *
 * 五种 action:
 * - created:全新部署(目标不存在 + 清单无记录)
 * - updated:自管覆盖(清单有记录,同 mode,源 hash 变了)
 * - skipped:幂等跳过(清单有记录,同 mode,源 hash 没变)— 不动文件不动 DB
 * - mode-switched:模式切换(清单有记录,mode 变了,先按旧 mode 清理再按新 mode 部署)
 * - external-overwritten:外部 skill 覆盖(清单无记录但目标存在,先备份再覆盖)
 */
export function deploySkill(db: DB, opts: DeployOptions): DeployResult {
  // Step 1: 算源 hash(源不存在则抛错,与原行为一致)
  const sourceHash = hashDir(opts.sourcePath)

  // Step 2: 解析实际 mode(junction fallback, issue #9)
  //   canSymlink=false + canJunction=true + source 是目录 → 尝试 junction
  //   canSymlink=false + (canJunction=false 或 source 不是目录) → 降级 copy
  //   其他 → 用 requested mode
  const sourceIsDir = lstatSync(opts.sourcePath).isDirectory()
  const resolved = resolveActualMode(opts.mode, opts.canSymlink, opts.canJunction, sourceIsDir)
  let actualMode = resolved.actualMode
  let degradedFrom = resolved.degradedFrom
  let degradeReason = resolved.degradeReason

  // Step 3: 查现有部署 + 目标是否存在
  const existing = getDeploymentBySkillAndTool(db, opts.skillId, opts.targetTool)
  const targetExists = existsSync(opts.targetDir)

  // Step 4: 判断 action 并执行清理(如需)— 基于实际 mode 比较(existing.mode vs actualMode)
  let action: DeployAction
  let previousMode: DeployMode | undefined
  let needDeploy = true

  if (existing) {
    if (existing.mode !== actualMode) {
      // 模式切换:按旧 mode 清理,按新 mode 部署
      action = 'mode-switched'
      previousMode = existing.mode
      cleanupByMode(opts.targetDir, existing.mode)
    } else if (existing.source_hash_at_deploy === sourceHash) {
      // 幂等跳过:同 mode + hash 没变,不动文件不动 DB
      action = 'skipped'
      needDeploy = false
    } else {
      // 自管覆盖:同 mode + hash 变了,清理旧 target 后重新部署
      action = 'updated'
      cleanupByMode(opts.targetDir, existing.mode)
    }
  } else if (targetExists) {
    // 外部 skill:清单无记录但目标存在 → 备份后覆盖
    action = 'external-overwritten'
    createBackup({
      skillName: opts.skillName,
      targetTool: opts.targetTool,
      sourcePath: opts.targetDir,
      backupsDir: opts.backupsDir
    })
    cleanupUnknown(opts.targetDir)
  } else {
    // 全新部署
    action = 'created'
  }

  // Step 5: 部署文件 + 记录清单(skipped 不执行)
  if (needDeploy) {
    if (actualMode === 'junction' && opts.mode === 'symlink' && !opts.canSymlink) {
      // junction fallback(issue #9):symlink 不可用 → 尝试 junction,失败则降级 copy。
      // 注:junction 创建失败(如跨卷)→catch→copy 的路径在 Mac 上无法可靠触发
      // (symlinkSync(...,'junction') 在非 Windows 退化为普通 symlink,总是成功)。
      // 该降级路径由 resolveActualMode 纯函数测试 + 此处 try/catch 保证逻辑正确。
      try {
        deployFiles('junction', opts.sourcePath, opts.targetDir)
      } catch {
        // junction 创建失败(如跨卷)→ 清理半成品后降级 copy
        cleanupUnknown(opts.targetDir)
        deployFiles('copy', opts.sourcePath, opts.targetDir)
        actualMode = 'copy'
        degradedFrom = 'symlink'
        degradeReason = 'junction creation failed (possibly cross-volume); used copy instead.'
      }
    } else {
      deployFiles(actualMode, opts.sourcePath, opts.targetDir)
    }
    upsertDeployment(db, opts.skillId, opts.targetTool, actualMode, opts.sourcePath, sourceHash)
  }

  return {
    action,
    mode: actualMode,
    targetPath: opts.targetDir,
    sourceHashAtDeploy: sourceHash,
    ...(previousMode !== undefined ? { previousMode } : {}),
    ...(degradedFrom !== undefined ? { degradedFrom } : {}),
    ...(degradeReason !== undefined ? { degradeReason } : {})
  }
}

/**
 * 从目标工具卸载 skill。
 *
 * 按 deployment.mode 清理 targetPath:
 * - symlink/junction → unlinkSync(只删链接,不删源)
 * - copy → rmSync recursive(删真实目录)
 *
 * 然后删除清单记录。如果清单无记录(外部 skill),抛错 — 不擅自删用户手动放的东西。
 */
export function undeploySkill(
  db: DB,
  skillId: number,
  targetTool: string,
  targetPath: string
): void {
  const deployment = getDeploymentBySkillAndTool(db, skillId, targetTool)
  if (!deployment) {
    throw new Error('not deployed by this tool, cannot undeploy external skill; please remove it manually')
  }
  cleanupByMode(targetPath, deployment.mode)
  deleteDeployment(db, skillId, targetTool)
}

/**
 * 检测单个部署点的漂移状态(清单 vs 实际磁盘)。
 *
 * 四种 kind:
 * - normal:清单有 + 目录有 + hash 一致(copy),或 symlink 模式(链接透明,源更新自动生效)
 * - source-updated:清单有 + 目录有 + 源 hash 变了(copy 模式,"源已更新,可重新部署")
 * - drift:清单有 + 目录无(用户手动删了)
 * - external:清单无 + 目录有(外部 skill)
 *
 * 注意:existsSync 跟随符号链接。对 broken symlink(源被删)返回 false → 视为 drift。
 */
export function detectDrift(
  db: DB,
  skillId: number,
  skillName: string,
  targetTool: string,
  targetPath: string
): DriftStatus {
  const deployment = getDeploymentBySkillAndTool(db, skillId, targetTool)
  const targetExists = existsSync(targetPath)

  let kind: DriftKind
  let currentSourceHash: string | null = null

  if (deployment == null && targetExists) {
    // 外部 skill:清单无记录但目录存在
    kind = 'external'
  } else if (deployment == null && !targetExists) {
    // 无部署无文件:正常空位,不算漂移
    kind = 'normal'
  } else if (deployment != null && !targetExists) {
    // 漂移:清单有记录但目录被删了
    kind = 'drift'
  } else {
    // deployment != null && targetExists
    // 重算源 hash(源目录可能已删)
    currentSourceHash = existsSync(deployment!.source_path)
      ? hashDir(deployment!.source_path)
      : null

    if (deployment!.mode === 'symlink' || deployment!.mode === 'junction') {
      // 链接透明:源更新自动生效,不算漂移
      kind = 'normal'
    } else {
      // copy 模式:对比源 hash
      if (currentSourceHash != null && currentSourceHash !== deployment!.source_hash_at_deploy) {
        kind = 'source-updated'
      } else {
        // hash 一致 → normal;源被删(currentSourceHash == null)→ normal(部署还在,只是源没了)
        kind = 'normal'
      }
    }
  }

  return {
    skillId,
    skillName,
    targetTool,
    targetPath,
    deployment: deployment ?? null,
    targetExists,
    currentSourceHash,
    kind
  }
}

/**
 * 扫描某工具目录下所有 skill 子目录,结合清单生成漂移列表(Tools 页用)。
 *
 * - 清单中的部署:逐个调 detectDrift(可能 normal / source-updated / drift)
 * - 磁盘上有但清单无记录的子目录:标记为 external
 * - 清单中 skill 已被删(getSkillById 返回 undefined):跳过
 *   (ON DELETE CASCADE 理论已删 deployments,此处为防御性检查)
 */
export function detectDriftsForTool(
  db: DB,
  targetTool: string,
  toolSkillDir: string
): DriftStatus[] {
  const deployments = getDeploymentsByTool(db, targetTool)
  const results: DriftStatus[] = []
  const managedNames = new Set<string>()

  // 清单中的部署
  for (const dep of deployments) {
    const skill = getSkillById(db, dep.skill_id)
    if (!skill) continue // skill 已删,跳过(防御性)
    managedNames.add(skill.name)
    const targetPath = join(toolSkillDir, skill.name)
    results.push(detectDrift(db, dep.skill_id, skill.name, targetTool, targetPath))
  }

  // 磁盘上的外部 skill(不在清单中的子目录)
  if (existsSync(toolSkillDir)) {
    for (const entry of readdirSync(toolSkillDir, { withFileTypes: true })) {
      // skill 目录可能是真实目录(copy 部署)或符号链接(symlink 部署)
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (managedNames.has(entry.name)) continue
      const targetPath = join(toolSkillDir, entry.name)
      results.push({
        skillId: -1,
        skillName: entry.name,
        targetTool,
        targetPath,
        deployment: null,
        targetExists: true,
        currentSourceHash: null,
        kind: 'external'
      })
    }
  }

  return results
}
