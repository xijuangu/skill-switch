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
  realpathSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  readFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { DB } from '../db/database'
import type {
  DeployAction,
  DeployMode,
  PreparedDeploymentPlan,
  DeployResult,
  DriftStatus
} from '../types'
import type { RecoveryEvidence } from '../types'
import {
  deleteDeploymentById,
  getDeploymentBySkillAndTargetId,
  getDeploymentsByTool,
  restoreDeploymentSnapshot,
  upsertDeployment
} from '../db/dao/deployments'
import { getSkillById } from '../db/dao/skills'
import { hashDir } from './hash'
import { createBackup } from './backup'
import { assertAbsolutePath, assertSafeDeployTarget } from './path-safety'

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

function pathEntryExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath)
    return true
  } catch {
    return false
  }
}

export class RecoveryRequiredError extends Error {
  constructor(
    message: string,
    readonly evidence: RecoveryEvidence,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'RecoveryRequiredError'
  }
}

export class ModeDegradationRequiredError extends Error {
  constructor(
    readonly from: DeployMode,
    readonly to: 'copy',
    readonly reason: string,
    options?: { cause?: unknown }
  ) {
    super(reason, options)
    this.name = 'ModeDegradationRequiredError'
  }
}

function markerForTarget(targetPath: string, operationId: string): RecoveryEvidence {
  const parent = dirname(targetPath)
  const name = basename(targetPath)
  return {
    operationId,
    targetPath,
    markerPath: join(parent, `.skill-switch-operation-${name}-${operationId}.json`),
    stagingPath: join(parent, `.skill-switch-staging-${name}-${operationId}`),
    rollbackPath: join(parent, `.skill-switch-rollback-${name}-${operationId}`),
    phase: 'prepared'
  }
}

function writeMarker(evidence: RecoveryEvidence, phase: string): void {
  evidence.phase = phase
  writeFileSync(evidence.markerPath, JSON.stringify(evidence, null, 2) + '\n', 'utf-8')
}

export function inspectRecoveryEvidence(targetPath: string): RecoveryEvidence | null {
  const parent = dirname(targetPath)
  const prefix = `.skill-switch-operation-${basename(targetPath)}-`
  if (!existsSync(parent)) return null
  for (const entry of readdirSync(parent)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue
    const markerPath = join(parent, entry)
    try {
      const evidence = JSON.parse(readFileSync(markerPath, 'utf-8')) as RecoveryEvidence
      if (evidence.targetPath === targetPath) return evidence
    } catch {
      return {
        operationId: entry.slice(prefix.length, -'.json'.length),
        targetPath,
        markerPath,
        stagingPath: '',
        rollbackPath: '',
        phase: 'marker-unreadable'
      }
    }
  }
  for (const kind of ['staging', 'rollback'] as const) {
    const artifactPrefix = `.skill-switch-${kind}-${basename(targetPath)}-`
    const artifact = readdirSync(parent).find((entry) => entry.startsWith(artifactPrefix))
    if (artifact) {
      const operationId = artifact.slice(artifactPrefix.length)
      const evidence = markerForTarget(targetPath, operationId)
      evidence.phase = `orphan-${kind}`
      return evidence
    }
  }
  return null
}

export function targetMatchesDeployment(
  targetPath: string,
  mode: DeployMode,
  sourcePath: string,
  sourceHash: string
): boolean {
  if (!pathEntryExists(targetPath)) return false
  try {
    if (mode === 'copy') {
      return !lstatSync(targetPath).isSymbolicLink() && hashDir(targetPath) === sourceHash
    }
    return (
      lstatSync(targetPath).isSymbolicLink() &&
      realpathSync(targetPath) === realpathSync(sourcePath)
    )
  } catch {
    return false
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
 *   它是 symlink 不可用时的预期回退;失败再降级 copy,由 Facade 重新规划并确认)。
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
    // 尝试 junction;实际成功/失败由底层执行器调用 symlinkSync 时判定
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
/** Facade-only filesystem executor. Callers must pass a fully resolved and confirmed plan. */
export function executePreparedDeployment(db: DB, opts: PreparedDeploymentPlan): DeployResult {
  // Step 0 (issue #24): 拒绝自部署 / 父子目录重叠,在任何备份、清理、清单写入之前。
  // 该校验由主进程 service 强制执行,不依赖 UI。
  //
  // 先查现有部署记录:若存在 managed symlink/junction 部署,target 的 realpath
  // 合法地等于 source(链接就是指向源的)。此时 mode-switch / 更新是合法操作
  // (cleanup 会先 unlink 旧链接,不会删源),因此传 allowExistingSymlinkToSource
  // 跳过 realpath-自部署 检查。lexical 包含检查始终执行。
  const existing = getDeploymentBySkillAndTargetId(db, opts.skillId, opts.identity.targetId)
  assertSafeDeployTarget(opts.sourcePath, opts.targetDir, {
    // 仅当现有部署是 symlink/junction 时,target 的 realpath 才合法地等于源
    // (链接指向源);copy 模式的 target 是独立目录,realpath 不同于源,无需豁免,
    // 且不应豁免以保持语义精确。
    allowExistingSymlinkToSource:
      existing != null &&
      (existing.mode === 'symlink' || existing.mode === 'junction')
  })

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
  if (actualMode === 'copy' && opts.approvedModeDegradation) {
    degradedFrom = opts.approvedModeDegradation.from
    degradeReason = opts.approvedModeDegradation.reason
  }
  if (actualMode === 'copy' && degradedFrom != null) {
    const approval = opts.approvedModeDegradation
    if (approval?.from !== degradedFrom || approval.to !== 'copy') {
      throw new ModeDegradationRequiredError(
        degradedFrom,
        'copy',
        degradeReason ?? 'linked deployment is unavailable; copy is required'
      )
    }
  }

  // Step 3: 目标是否存在(existing 已在 Step 0 查过)
  const targetExists = pathEntryExists(opts.targetDir)
  if (
    existing?.target_path != null &&
    existing.target_path !== opts.targetDir
  ) {
    throw new Error(
      `skill is already deployed to ${existing.target_path}; undeploy it before choosing another target path`
    )
  }
  if (existing && existing.target_path == null) {
    throw new Error(
      'existing deployment target path is unresolved; remove it from the manifest before redeploying'
    )
  }

  // Step 4: determine the semantic action without mutating the target.
  let action: DeployAction
  let previousMode: DeployMode | undefined
  let needDeploy = true

  if (existing) {
    if (existing.mode !== actualMode) {
      action = 'mode-switched'
      previousMode = existing.mode
    } else if (
      existing.source_hash_at_deploy === sourceHash &&
      targetMatchesDeployment(
        opts.targetDir,
        existing.mode,
        opts.sourcePath,
        sourceHash
      )
    ) {
      // 幂等跳过:同 mode + source hash 没变 + 目标仍与清单一致
      action = 'skipped'
      needDeploy = false
    } else {
      action = 'updated'
    }
  } else if (targetExists) {
    if (opts.allowExternalOverwrite !== true) {
      throw new Error('prepared deployment plan does not authorize target replacement')
    }
    action = 'external-overwritten'
  } else {
    // 全新部署
    action = 'created'
  }

  // Step 5: stage beside the target, switch by rename, then persist the manifest.
  if (needDeploy) {
    const evidence = markerForTarget(
      opts.targetDir,
      opts.mutationHooks?.operationId?.() ?? randomUUID()
    )
    let markerWritten = false
    let switched = false
    let rolledBack = false
    let manifestChanged = false
    let committed = false
    try {
      if (actualMode === 'junction') {
        try {
          opts.mutationHooks?.beforeJunctionStage?.()
          deployFiles('junction', opts.sourcePath, evidence.stagingPath)
        } catch (error) {
          cleanupUnknown(evidence.stagingPath)
          const reason = 'junction creation failed (possibly cross-volume); copy is required.'
          if (opts.approvedModeDegradation?.from !== opts.mode) {
            throw new ModeDegradationRequiredError(opts.mode, 'copy', reason, { cause: error })
          }
          deployFiles('copy', opts.sourcePath, evidence.stagingPath)
          actualMode = 'copy'
          degradedFrom = opts.mode
          degradeReason = reason
        }
      } else {
        deployFiles(actualMode, opts.sourcePath, evidence.stagingPath)
      }
      opts.mutationHooks?.afterStaging?.()
      writeMarker(evidence, 'staged')
      markerWritten = true
      opts.mutationHooks?.afterMarker?.()

      if (action === 'external-overwritten') {
        createBackup({
          skillName: opts.skillName,
          targetTool: opts.targetTool,
          sourcePath: opts.targetDir,
          backupsDir: opts.backupsDir
        })
        opts.mutationHooks?.afterBackup?.()
      }
      if (pathEntryExists(opts.targetDir)) {
        renameSync(opts.targetDir, evidence.rollbackPath)
        rolledBack = true
        writeMarker(evidence, 'rollback-created')
      }
      opts.mutationHooks?.afterRollback?.()

      renameSync(evidence.stagingPath, opts.targetDir)
      switched = true
      writeMarker(evidence, 'switched')
      opts.mutationHooks?.afterSwitch?.()
      opts.mutationHooks?.beforeManifest?.()
      upsertDeployment(
        db,
        opts.skillId,
        opts.targetTool,
        opts.targetDir,
        actualMode,
        opts.sourcePath,
        sourceHash,
        opts.identity
      )
      manifestChanged = true
      writeMarker(evidence, 'manifest-written')
      rmSync(evidence.markerPath, { force: true })
      markerWritten = false
      committed = true
      cleanupUnknown(evidence.rollbackPath)
    } catch (error) {
      if (committed) {
        try {
          writeMarker(evidence, 'cleanup-required')
        } catch {
          // The rollback artifact itself still remains as diagnostic evidence.
        }
        throw new RecoveryRequiredError(
          'deployment committed but transaction artifact cleanup failed',
          evidence,
          { cause: error }
        )
      }
      try {
        opts.mutationHooks?.beforeCompensate?.()
        if (manifestChanged) {
          restoreDeploymentSnapshot(db, existing, {
            skillId: opts.skillId,
            targetId: opts.identity.targetId
          })
        }
        if (switched && pathEntryExists(opts.targetDir)) cleanupUnknown(opts.targetDir)
        if (rolledBack && pathEntryExists(evidence.rollbackPath)) {
          renameSync(evidence.rollbackPath, opts.targetDir)
        } else if (rolledBack) {
          throw new Error('rollback evidence is missing')
        }
        cleanupUnknown(evidence.stagingPath)
        if (markerWritten) rmSync(evidence.markerPath, { force: true })
      } catch (compensationError) {
        throw new RecoveryRequiredError(
          `deployment failed and compensation failed: ${String(compensationError)}`,
          evidence,
          { cause: error }
        )
      }
      throw error
    }
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
 * Remove one Deployment by its stable identity using the same marker/rollback
 * protocol as deploy. The manifest is deleted only after the target has been
 * moved aside, and any pre-commit failure restores the exact target.
 */
export function executePreparedUndeployment(
  db: DB,
  deployment: import('../types').Deployment,
  hooks?: import('../types').DeploymentMutationHooks
): void {
  if (deployment.target_path == null) {
    throw new Error('deployment target path is unresolved; refusing destructive cleanup')
  }
  const targetPath = assertAbsolutePath(deployment.target_path, 'recorded target_path')
  if (!pathEntryExists(targetPath)) {
    deleteDeploymentById(db, deployment.id)
    return
  }
  const evidence = markerForTarget(targetPath, hooks?.operationId?.() ?? randomUUID())
  let markerWritten = false
  let rolledBack = false
  let manifestDeleted = false
  try {
    writeMarker(evidence, 'prepared')
    markerWritten = true
    hooks?.afterMarker?.()
    renameSync(targetPath, evidence.rollbackPath)
    rolledBack = true
    writeMarker(evidence, 'rollback-created')
    hooks?.afterRollback?.()
    hooks?.beforeManifest?.()
    deleteDeploymentById(db, deployment.id)
    manifestDeleted = true
    writeMarker(evidence, 'manifest-written')
    cleanupUnknown(evidence.rollbackPath)
    rolledBack = false
    rmSync(evidence.markerPath, { force: true })
    markerWritten = false
  } catch (error) {
    if (manifestDeleted) {
      // The old content may already be partially removed, so preserve evidence
      // instead of guessing a recovery direction.
      throw new RecoveryRequiredError('undeploy committed but cleanup failed', evidence, { cause: error })
    }
    try {
      hooks?.beforeCompensate?.()
      if (rolledBack && pathEntryExists(evidence.rollbackPath)) renameSync(evidence.rollbackPath, targetPath)
      if (markerWritten) rmSync(evidence.markerPath, { force: true })
    } catch (compensationError) {
      throw new RecoveryRequiredError(
        `undeploy failed and compensation failed: ${String(compensationError)}`,
        evidence,
        { cause: error }
      )
    }
    throw error
  }
}

/**
 * 扫描某工具目录下所有 skill 子目录,结合清单生成漂移列表(Tools 页用)。
 *
 * - 清单中的部署:统一委托 Facade.inspect
 * - 磁盘上有但清单无记录的子目录:标记为 external
 * - 清单中 skill 已被删(getSkillById 返回 undefined):跳过
 *   (ON DELETE CASCADE 理论已删 deployments,此处为防御性检查)
 */
export function readToolDrifts(
  db: DB,
  targetTool: string,
  toolSkillDirs: string | string[],
  inspectDeployment: (deploymentId: number) => DriftStatus | null
): DriftStatus[] {
  const directories = Array.isArray(toolSkillDirs)
    ? toolSkillDirs
    : [toolSkillDirs]
  const deployments = getDeploymentsByTool(db, targetTool)
  const results: DriftStatus[] = []
  const managedTargetPaths = new Set<string>()

  // 清单中的部署
  for (const dep of deployments) {
    const skill = getSkillById(db, dep.skill_id)
    if (!skill) continue // skill 已删,跳过(防御性)
    const targetPath =
      dep.target_path ?? join(directories[0] ?? '', skill.name)
    managedTargetPaths.add(targetPath)
    const inspected = inspectDeployment(dep.id)
    if (inspected) results.push(inspected)
  }

  // 磁盘上的外部 skill(不在清单中的子目录)
  for (const toolSkillDir of directories) {
    if (!existsSync(toolSkillDir)) continue
    for (const entry of readdirSync(toolSkillDir, { withFileTypes: true })) {
      // skill 目录可能是真实目录(copy 部署)或符号链接(symlink 部署)
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const targetPath = join(toolSkillDir, entry.name)
      if (managedTargetPaths.has(targetPath)) continue
      results.push({
        skillId: -1,
        skillName: entry.name,
        targetTool,
        targetPath,
        deployment: null,
        targetExists: true,
        currentSourceHash: null,
        currentTargetHash: null,
        kind: 'external'
      })
    }
  }

  return results
}
