// IPC 层:薄传透,参数校验 + 转发 service
//
// 多工具发现:scan 读取 settings,解析所有 enabled + existing 工具目录,
// 调 scanAllTools 聚合扫描。settings 读写由 settings service 负责(原子写)。
// 启动序列 runStartupSequence:平台检测 + settings 初始化 + 一次性多工具扫描
// (覆盖本次启动新出现的工具目录)。

import { ipcMain, dialog } from 'electron'
import { homedir, tmpdir } from 'os'
import { readFileSync } from 'fs'
import type { DB } from '../db/database'
import type {
  AppSettings,
  CustomTool,
  DeployMode,
  Deployment,
  DriftStatus,
  MultiScanResult,
  PlatformInfo,
  SkillWithConflict,
  ToolConfig
} from '../types'
import { SETTINGS_PATH, BACKUPS_DIR, SKILLS_DIR, SOURCE_ARCHIVE_DIR } from '../paths'
import { readSettings, writeSettings } from '../services/settings'
import { detectPlatform } from '../services/platform'
import {
  resolveToolConfigs,
  setPresetEnabled as cfgSetPresetEnabled,
  setPresetPaths as cfgSetPresetPaths,
  addCustomTool as cfgAddCustomTool,
  removeCustomTool as cfgRemoveCustomTool,
  getActiveScanDirs
} from '../services/tools-config'
import { scanAllTools } from '../services/scan-all'
import { reconcileDeploymentIdentities } from '../services/deployment-identities'
import {
  assessDeploymentTargetOption,
  createDeploymentFacade,
  type DeploymentFacade
} from '../services/deployment-facade'
import { getAllSkills, getSkillById } from '../db/dao/skills'
import { getSourceById } from '../db/dao/skill-sources'
import {
  assertRegisteredSkillSource,
  computeConflict,
  filterSourcesByEnabledTools,
  reconcileIndexedSources,
  removeFromRegistry
} from '../services/registry'
import { listBackups, restoreBackup, deleteBackup } from '../services/backup'
import { readToolDrifts } from '../services/deployer'
import { installFromGitHub, installFromZip, installFromLocalDir } from '../services/installer'
import { createSkillLibraryFacade } from '../services/skill-library-facade'
import {
  detachSourceRoot,
  listSourceRoots,
  registerAndScanSourceRoot,
  rescanSourceRoot
} from '../services/source-roots'
import { markSourceRootScanFailed } from '../db/dao/source-roots'
import {
  deleteDeploymentById,
  getDeploymentBySkillAndTargetId,
  getDeploymentsBySkillId
} from '../db/dao/deployments'
import {
  assertAbsolutePath,
  resolveWithin,
  validateBackupId,
  validateSkillName,
  validateToolKey
} from '../services/path-safety'

/** Settings 页统一视图:解析后的工具列表 + backupRetention + 平台信息 */
export interface SettingsView {
  tools: ToolConfig[]
  backupRetention: number
  platform: PlatformInfo
}

/** Tools 页视图:工具配置 + 漂移状态列表 */
export interface ToolWithDriftsView {
  config: ToolConfig
  drifts: DriftStatus[]
}

export interface DeployTargetOption {
  targetId: string
  targetTool: string
  displayName: string
  eligible: boolean
  reason: string | null
}

export function readDeployTargetOptions(
  db: DB,
  sourceId: number,
  toolConfigs: ToolConfig[]
): DeployTargetOption[] {
  const source = getSourceById(db, sourceId)
  if (!source) throw new Error(`source not found: ${sourceId}`)
  const skill = getSkillById(db, source.skill_id)
  if (!skill) throw new Error(`skill not found for source: ${sourceId}`)
  return toolConfigs
    .filter((tool) => tool.enabled && tool.exists)
    .flatMap((tool) =>
      tool.existingTargets.map(({ id: targetId, path: targetRoot }, index) => {
        const targetPath = resolveWithin(
          targetRoot,
          validateSkillName(skill.name)
        )
        const existing = getDeploymentBySkillAndTargetId(db, skill.id, targetId)
        const assessment = assessDeploymentTargetOption(source.path, targetPath, existing)
        return {
          targetId,
          targetTool: tool.key,
          displayName: tool.existingTargets.length > 1 ? `${tool.displayName} (${index + 1})` : tool.displayName,
          ...assessment
        }
      })
    )
}

/**
 * issue #21:抽取出 getSkills IPC handler 的纯读逻辑,使其可独立测试。
 * 输入 db + 已解析的 toolConfigs,返回 Skills 页权威视图(含 issue #20 source 过滤)。
 * 不读 settings、不碰磁盘扫描,只读 DB — 对应 renderer refresh 的数据契约。
 * 每条 deployment 复用工具页的完整 drift 状态。
 */
export function readSkillsView(
  db: DB,
  toolConfigs: ToolConfig[],
  inspectDeployment: DeploymentFacade['inspect']
): SkillWithConflict[] {
  const skills = getAllSkills(db)
  const out: SkillWithConflict[] = []
  for (const s of skills) {
    const visibleSources = filterSourcesByEnabledTools(s.sources, toolConfigs)
    if (visibleSources.length === 0) continue
    out.push({
      ...s,
      sources: visibleSources,
      conflict: computeConflict(visibleSources, s.id),
      deployments: getDeploymentsBySkillId(db, s.id).map((d) => ({
        ...d,
        status: inspectDeployment(d.id)?.kind ?? 'unresolved'
      }))
    })
  }
  return out
}

/**
 * issue #21:抽取出 getTools IPC handler 的纯读逻辑,使其可独立测试。
 * 输入 db + 已解析的 toolConfigs,返回 Tools 页权威视图(含 drift 检测)。
 * readToolDrifts 会读磁盘枚举 external target；managed 状态统一委托 Facade.inspect。
 * 不是全量 skill 扫描 — refresh 调用此函数不会触发 scanAllTools。
 */
export function readToolsView(
  db: DB,
  toolConfigs: ToolConfig[],
  inspectDeployment: DeploymentFacade['inspect']
): ToolWithDriftsView[] {
  return toolConfigs
    .filter((config) => config.enabled)
    .map((config) => ({
      config,
      drifts:
        config.enabled && config.exists
          ? readToolDrifts(db, config.key, config.existingPaths, inspectDeployment)
          : []
    }))
}

function buildSettingsView(settings: AppSettings): SettingsView {
  return {
    tools: resolveToolConfigs(settings, homedir()),
    backupRetention: settings.backupRetention,
    platform: settings.platform
  }
}

function configuredPaths(settings: AppSettings): Set<string> {
  return new Set(
    resolveToolConfigs(settings, homedir()).flatMap((tool) =>
      tool.paths.map((path) => assertAbsolutePath(path, 'configured tool path'))
    )
  )
}

function cleanupRemovedConfiguredPaths(
  db: DB,
  before: AppSettings,
  after: AppSettings
): void {
  const previous = configuredPaths(before)
  const current = configuredPaths(after)
  const removed = [...previous].filter((path) => !current.has(path))
  reconcileIndexedSources(db, removed, [])
}

function assertInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return value
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`)
  }
  return value
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

function assertAbsolutePaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain at least one path`)
  }
  return value.map((item) =>
    assertAbsolutePath(assertNonEmptyString(item, label), label)
  )
}

function assertDeployMode(value: unknown): DeployMode {
  if (value !== 'copy' && value !== 'symlink' && value !== 'junction') {
    throw new Error(`invalid deploy mode: ${String(value)}`)
  }
  return value
}

export function registerIpcHandlers(db: DB): void {
  const skillLibraryFacade = createSkillLibraryFacade({
    db,
    canonicalRepositoryPath: SKILLS_DIR,
    sourceArchivePath: SOURCE_ARCHIVE_DIR,
    backupsDir: BACKUPS_DIR
  })
  const deploymentFacade = createDeploymentFacade({
    db,
    backupsDir: BACKUPS_DIR,
    getRuntime: () => {
      const settings = readSettings(SETTINGS_PATH)
      return {
        tools: resolveToolConfigs(settings, homedir()),
        platform: settings.platform
      }
    }
  })

  ipcMain.handle('scan', async () => {
    const settings = readSettings(SETTINGS_PATH)
    const dirs = getActiveScanDirs(settings, homedir())
    const result: MultiScanResult = scanAllTools(db, dirs)
    return result
  })

  ipcMain.handle('getSkills', async () => {
    // issue #21: 读逻辑抽到 readSkillsView,与测试共用同一函数(不再本地重实现)。
    // issue #20: 禁用工具后 source 过滤逻辑在 readSkillsView 内执行。
    const settings = readSettings(SETTINGS_PATH)
    const toolConfigs = resolveToolConfigs(settings, homedir())
    return readSkillsView(db, toolConfigs, deploymentFacade.inspect)
  })

  ipcMain.handle('getSkillLibrary', async () => skillLibraryFacade.read())

  ipcMain.handle('skillLibrary:previewConsolidation', async (_e, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('consolidation request must be an object')
    const dto = request as Record<string, unknown>
    return skillLibraryFacade.previewConsolidation({
      candidateSourceId: assertInteger(dto.candidateSourceId, 'candidateSourceId'),
      canonicalRelativeParent: assertString(dto.canonicalRelativeParent, 'canonicalRelativeParent')
    })
  })
  ipcMain.handle('skillLibrary:previewConsolidationBatch', async (_e, request: unknown) => {
    if (typeof request !== 'object' || request === null || !Array.isArray((request as { items?: unknown }).items)) {
      throw new Error('consolidation batch request must contain items')
    }
    return skillLibraryFacade.previewConsolidationBatch({
      items: (request as { items: unknown[] }).items.map((item) => {
        if (typeof item !== 'object' || item === null) throw new Error('consolidation batch item must be an object')
        const dto = item as Record<string, unknown>
        return {
          candidateSourceId: assertInteger(dto.candidateSourceId, 'candidateSourceId'),
          canonicalRelativeParent: assertString(dto.canonicalRelativeParent, 'canonicalRelativeParent')
        }
      })
    })
  })
  ipcMain.handle('skillLibrary:confirmConsolidation', async (_e, confirmationId: unknown) =>
    skillLibraryFacade.confirmConsolidation(assertNonEmptyString(confirmationId, 'confirmationId'))
  )
  ipcMain.handle('skillLibrary:undoConsolidation', async (_e, batchId: unknown) =>
    skillLibraryFacade.undoConsolidation(assertNonEmptyString(batchId, 'batchId'))
  )
  ipcMain.handle('skillLibrary:restoreConsolidation', async (_e, batchId: unknown) =>
    skillLibraryFacade.restoreConsolidation(assertNonEmptyString(batchId, 'batchId'))
  )
  ipcMain.handle('skillLibrary:previewSourceArchivePurge', async (_e, batchId: unknown) =>
    skillLibraryFacade.previewSourceArchivePurge(assertNonEmptyString(batchId, 'batchId'))
  )
  ipcMain.handle('skillLibrary:confirmSourceArchivePurge', async (_e, confirmationId: unknown) =>
    skillLibraryFacade.confirmSourceArchivePurge(assertNonEmptyString(confirmationId, 'confirmationId'))
  )

  ipcMain.handle('getSettings', async () => {
    const settings = readSettings(SETTINGS_PATH)
    return buildSettingsView(settings)
  })

  ipcMain.handle('getSourceRoots', async () => listSourceRoots(db))

  ipcMain.handle('registerSourceRoot', async (_e, path: string) => {
    return registerAndScanSourceRoot(db, assertAbsolutePath(path, 'Source Root path'))
  })

  ipcMain.handle('rescanSourceRoot', async (_e, rootId: number) =>
    rescanSourceRoot(db, assertInteger(rootId, 'Source Root ID'))
  )

  ipcMain.handle('detachSourceRoot', async (_e, rootId: number) =>
    detachSourceRoot(db, assertInteger(rootId, 'Source Root ID'))
  )

  ipcMain.handle('getDeployTargets', async (_e, sourceId: number) => {
    const safeSourceId = assertInteger(sourceId, 'sourceId')
    const settings = readSettings(SETTINGS_PATH)
    return readDeployTargetOptions(
      db,
      safeSourceId,
      resolveToolConfigs(settings, homedir())
    )
  })

  ipcMain.handle('setPresetEnabled', async (_e, key: string, enabled: boolean) => {
    const safeKey = validateToolKey(key)
    const safeEnabled = assertBoolean(enabled, 'enabled')
    const settings = readSettings(SETTINGS_PATH)
    const updated = cfgSetPresetEnabled(settings, safeKey, safeEnabled)
    writeSettings(SETTINGS_PATH, updated)
    return buildSettingsView(updated)
  })

  ipcMain.handle('setPresetPaths', async (_e, key: string, paths: string[]) => {
    const safeKey = validateToolKey(key)
    const safePaths = assertAbsolutePaths(paths, 'preset paths')
    const settings = readSettings(SETTINGS_PATH)
    const updated = cfgSetPresetPaths(settings, safeKey, safePaths)
    writeSettings(SETTINGS_PATH, updated)
    cleanupRemovedConfiguredPaths(db, settings, updated)
    return buildSettingsView(updated)
  })

  ipcMain.handle('addCustomTool', async (_e, tool: CustomTool) => {
    if (typeof tool !== 'object' || tool === null) {
      throw new Error('custom tool must be an object')
    }
    const safeTool: CustomTool = {
      key: validateToolKey(tool.key),
      displayName: assertNonEmptyString(tool.displayName, 'displayName'),
      paths: assertAbsolutePaths(tool.paths, 'custom tool paths')
    }
    const settings = readSettings(SETTINGS_PATH)
    const updated = cfgAddCustomTool(settings, safeTool)
    writeSettings(SETTINGS_PATH, updated)
    cleanupRemovedConfiguredPaths(db, settings, updated)
    return buildSettingsView(updated)
  })

  ipcMain.handle('removeCustomTool', async (_e, key: string) => {
    const safeKey = validateToolKey(key)
    const settings = readSettings(SETTINGS_PATH)
    const updated = cfgRemoveCustomTool(settings, safeKey)
    writeSettings(SETTINGS_PATH, updated)
    cleanupRemovedConfiguredPaths(db, settings, updated)
    return buildSettingsView(updated)
  })

  ipcMain.handle('setBackupRetention', async (_e, n: number) => {
    const retention = assertInteger(n, 'backup retention')
    if (retention < 1 || retention > 10_000) {
      throw new Error('backup retention must be between 1 and 10000')
    }
    const settings = readSettings(SETTINGS_PATH)
    const updated: AppSettings = { ...settings, backupRetention: retention }
    writeSettings(SETTINGS_PATH, updated)
    return buildSettingsView(updated)
  })

  // Backups 页:listBackups(按 backupTime DESC)/ restoreBackup(恢复到原 sourcePath)/ deleteBackup
  ipcMain.handle('listBackups', async () => {
    return listBackups(BACKUPS_DIR)
  })

  ipcMain.handle('restoreBackup', async (_e, backupId: string) => {
    const safeId = validateBackupId(backupId)
    // 恢复到备份元数据记录的原 sourcePath;若该路径已有内容,service 内部先建 safety-net 备份
    const metas = listBackups(BACKUPS_DIR)
    const meta = metas.find((m) => m.backupId === safeId)
    if (!meta) {
      throw new Error(`backup not found: ${safeId}`)
    }
    restoreBackup(safeId, meta.sourcePath, BACKUPS_DIR)
  })

  ipcMain.handle('deleteBackup', async (_e, backupId: string) => {
    const safeId = validateBackupId(backupId)
    const exists = listBackups(BACKUPS_DIR).some((meta) => meta.backupId === safeId)
    if (!exists) {
      throw new Error(`backup not found: ${safeId}`)
    }
    deleteBackup(safeId, BACKUPS_DIR)
  })

  // ===== Deploy(切片 #6 + #9 junction fallback)=====

  ipcMain.handle('deployment:deploy', async (_e, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('deployment request must be an object')
    const dto = request as Record<string, unknown>
    return deploymentFacade.deploy({
      sourceId: assertInteger(dto.sourceId, 'sourceId'),
      targetId: assertNonEmptyString(dto.targetId, 'targetId'),
      requestedMode: assertDeployMode(dto.requestedMode)
    })
  })

  ipcMain.handle('deployment:confirm', async (_e, confirmationId: unknown) =>
    deploymentFacade.confirm(assertNonEmptyString(confirmationId, 'confirmationId'))
  )

  ipcMain.handle('undeploy', async (_e, deploymentId: number) =>
    deploymentFacade.undeploy(assertInteger(deploymentId, 'deploymentId'))
  )

  ipcMain.handle('adoptDeployment', async (_e, deploymentId: number) =>
    deploymentFacade.adopt(assertInteger(deploymentId, 'deploymentId'))
  )

  ipcMain.handle('previewBulkAdoption', async () =>
    deploymentFacade.previewBulkAdoption()
  )

  ipcMain.handle('getBulkAdoptionFacts', async () =>
    deploymentFacade.getBulkAdoptionFacts()
  )

  ipcMain.handle('confirmBulkAdoption', async (_e, confirmationId: unknown) =>
    deploymentFacade.confirmBulkAdoption(assertNonEmptyString(confirmationId, 'confirmationId'))
  )

  // issue #22:漂移"重新部署"——从 deployment 清单读取精确 target_path,
  // 不接收 renderer 提供的任意路径,不依赖当前工具配置重新推导。
  ipcMain.handle('redeploy', async (_e, deploymentId: number) =>
    deploymentFacade.redeploy(assertInteger(deploymentId, 'deploymentId'))
  )

  // ===== Drift actions(切片 #8)=====

  /**
   * 从清单移除(仅删 deployments 记录,不碰磁盘)。
   * 用于 ⚠️drift 状态(目标已被用户手动删了,清单与现实对齐)。
   * 与 undeploy 的区别:undeploy 同时做 fs 清理 + 删记录;removeFromManifest 只删记录。
   */
  ipcMain.handle('removeFromManifest', async (_e, deploymentId: number) =>
    deleteDeploymentById(db, assertInteger(deploymentId, 'deploymentId'))
  )

  /**
   * 查 skill 的所有部署(用于 Skills 页 "Undeploy from..." 子菜单列出目标工具)。
   */
  ipcMain.handle('getDeploymentsForSkill', async (_e, skillId: number): Promise<Deployment[]> => {
    return getDeploymentsBySkillId(db, assertInteger(skillId, 'skillId'))
  })

  /**
   * 读 skill 的 SKILL.md 原文(Skills 页 "View SKILL.md" 用)。
   * @param skillId skill id
   * @param sourcePath 可选,指定从哪个 source path 读 SKILL.md。
   *                   未传则用 primary_source_path。
   *                   conflict 时 UI 先让用户选 source,再把选中的 path 传进来。
   */
  ipcMain.handle('viewSkillMd', async (_e, skillId: number, sourcePath?: string): Promise<{ content: string; path: string } | null> => {
    const safeSkillId = assertInteger(skillId, 'skillId')
    const skill = getSkillById(db, safeSkillId)
    if (!skill) return null
    const baseDir = assertRegisteredSkillSource(
      db,
      safeSkillId,
      sourcePath ?? skill.primary_source_path
    )
    try {
      const skillMdPath = resolveWithin(baseDir, 'SKILL.md')
      return {
        content: readFileSync(skillMdPath, 'utf-8'),
        path: skillMdPath
      }
    } catch {
      return null
    }
  })

  /**
   * Remove from Registry(切片 #8):删中央仓库实体 + 所有部署 + 注册表记录,删前备份。
   * 与 undeploy 明确分开:undeploy 只删某工具的部署,Remove from Registry 彻底移除 skill。
   */
  ipcMain.handle('removeFromRegistry', async (_e, skillId: number) => {
    return removeFromRegistry(db, assertInteger(skillId, 'skillId'), {
      centralSkillsDir: SKILLS_DIR,
      backupsDir: BACKUPS_DIR,
      undeployDeployment: (deploymentId) => deploymentFacade.undeploy(deploymentId)
    })
  })

  ipcMain.handle('getTools', async () => {
    // issue #21: 读逻辑抽到 readToolsView,与测试共用同一函数。
    const settings = readSettings(SETTINGS_PATH)
    const toolConfigs = resolveToolConfigs(settings, homedir())
    return readToolsView(db, toolConfigs, deploymentFacade.inspect)
  })

  // ===== Install(切片 #7)=====

  ipcMain.handle('installFromGitHub', async (_e, url: string) => {
    return installFromGitHub(db, assertNonEmptyString(url, 'GitHub URL'), {
      centralSkillsDir: SKILLS_DIR,
      backupsDir: BACKUPS_DIR
    })
  })

  ipcMain.handle('installFromZip', async (_e, zipPath: string) => {
    return installFromZip(db, assertAbsolutePath(zipPath, 'ZIP path'), {
      centralSkillsDir: SKILLS_DIR,
      backupsDir: BACKUPS_DIR
    })
  })

  ipcMain.handle('installFromLocalDir', async (_e, localPath: string) => {
    return installFromLocalDir(db, assertAbsolutePath(localPath, 'local directory'), {
      centralSkillsDir: SKILLS_DIR,
      backupsDir: BACKUPS_DIR
    })
  })

  // 文件选择对话框(渲染进程无法直接调 electron dialog)
  ipcMain.handle('selectZipFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('selectLocalDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
}

/**
 * 启动序列:平台能力检测 + settings 初始化(写回 platform)+ 一次性多工具扫描。
 * 多工具扫描覆盖本次启动所有 enabled + existing 目录,自然包含新出现的目录。
 */
export function runStartupSequence(db: DB): void {
  const platform = detectPlatform(tmpdir())
  const settings = readSettings(SETTINGS_PATH)
  const withPlatform: AppSettings = { ...settings, platform }
  writeSettings(SETTINGS_PATH, withPlatform)
  reconcileDeploymentIdentities(db, resolveToolConfigs(withPlatform, homedir()))
  const dirs = getActiveScanDirs(withPlatform, homedir())
  scanAllTools(db, dirs)
  for (const root of listSourceRoots(db)) {
    try {
      rescanSourceRoot(db, root.id)
    } catch (error) {
      // A temporarily unavailable external Source Root must not block app startup,
      // but its stale state must remain visible to the user.
      markSourceRootScanFailed(db, root.id, error instanceof Error ? error.message : String(error))
    }
  }
}
