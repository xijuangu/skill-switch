// IPC 层:薄传透,参数校验 + 转发 service
//
// 多工具发现:scan 读取 settings,解析所有 enabled + existing 工具目录,
// 调 scanAllTools 聚合扫描。settings 读写由 settings service 负责(原子写)。
// 启动序列 runStartupSequence:平台检测 + settings 初始化 + 一次性多工具扫描
// (覆盖本次启动新出现的工具目录)。

import { ipcMain, dialog } from 'electron'
import { homedir, tmpdir } from 'os'
import { randomUUID } from 'crypto'
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
import { SETTINGS_PATH, BACKUPS_DIR, SKILLS_DIR } from '../paths'
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
import { getAllSkills, getSkillById } from '../db/dao/skills'
import {
  assertRegisteredSkillSource,
  computeConflict,
  filterSourcesByEnabledTools,
  reconcileIndexedSources,
  removeFromRegistry
} from '../services/registry'
import { listBackups, restoreBackup, deleteBackup } from '../services/backup'
import {
  deploySkill,
  detectDriftsForTool,
  inspectDeployTarget,
  redeploySkill,
  undeploySkill
} from '../services/deployer'
import { installFromGitHub, installFromZip, installFromLocalDir } from '../services/installer'
import { getDeploymentsBySkillId, deleteDeployment } from '../db/dao/deployments'
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

/** 解析目标工具的第一个存在路径(部署目标目录)。不存在抛错。 */
function resolveToolSkillDir(targetTool: string, requestedPath?: string): string {
  const safeTool = validateToolKey(targetTool)
  const settings = readSettings(SETTINGS_PATH)
  const configs = resolveToolConfigs(settings, homedir())
  const tool = configs.find((c) => c.key === safeTool && c.enabled && c.exists)
  if (!tool || tool.existingPaths.length === 0) {
    throw new Error(`tool not available: ${safeTool}`)
  }
  const existing = tool.existingPaths.map((path) =>
    assertAbsolutePath(path, 'tool skill directory')
  )
  if (requestedPath !== undefined) {
    const requested = assertAbsolutePath(requestedPath, 'target tool path')
    if (!existing.includes(requested)) {
      throw new Error(`target path is not configured for tool ${safeTool}`)
    }
    return requested
  }
  if (existing.length !== 1) {
    throw new Error(`tool ${safeTool} has multiple paths; choose an exact target path`)
  }
  return existing[0]
}

export function registerIpcHandlers(db: DB): void {
  const confirmationTtlMs = 5 * 60_000
  const maxDeployConfirmations = 100
  const deployConfirmations = new Map<
    string,
    {
      skillId: number
      targetTool: string
      sourcePath: string
      targetRoot: string
      expiresAt: number
    }
  >()

  ipcMain.handle('scan', async () => {
    const settings = readSettings(SETTINGS_PATH)
    const dirs = getActiveScanDirs(settings, homedir())
    const result: MultiScanResult = scanAllTools(db, dirs)
    return result
  })

  ipcMain.handle('getSkills', async () => {
    // issue #20:禁用预设工具后,技能页应隐藏仅来自该工具配置路径的 source,
    // 并基于过滤后的 source 重算冲突状态。DB 记录保留,重新启用工具并扫描后
    // source 自然恢复显示(过滤是只读的,不删 DB)。
    //
    // 一个 skill 的所有 source 都来自已禁用工具时,不再作为当前可部署 skill 展示。
    const settings = readSettings(SETTINGS_PATH)
    const toolConfigs = resolveToolConfigs(settings, homedir())
    const skills = getAllSkills(db)
    const out: SkillWithConflict[] = []
    for (const s of skills) {
      const visibleSources = filterSourcesByEnabledTools(s.sources, toolConfigs)
      if (visibleSources.length === 0) continue
      out.push({
        ...s,
        sources: visibleSources,
        conflict: computeConflict(visibleSources, s.id),
        deployments: getDeploymentsBySkillId(db, s.id)
      })
    }
    return out
  })

  ipcMain.handle('getSettings', async () => {
    const settings = readSettings(SETTINGS_PATH)
    return buildSettingsView(settings)
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

  ipcMain.handle('prepareDeploy', async (_e, skillId: number, targetTool: string, mode: DeployMode, sourcePath: string, targetRoot?: string) => {
    const safeSkillId = assertInteger(skillId, 'skillId')
    const safeTool = validateToolKey(targetTool)
    const safeMode = assertDeployMode(mode)
    const skill = getSkillById(db, safeSkillId)
    if (!skill) throw new Error(`skill not found: ${safeSkillId}`)
    const safeSource = assertRegisteredSkillSource(db, safeSkillId, sourcePath)
    const safeTargetRoot = resolveToolSkillDir(safeTool, targetRoot)
    const targetPath = resolveWithin(
      safeTargetRoot,
      validateSkillName(skill.name)
    )
    const kind = inspectDeployTarget(
      db,
      safeSkillId,
      safeTool,
      targetPath,
      safeMode
    )
    let confirmationToken: string | null = null
    if (kind === 'external-overwrite') {
      const now = Date.now()
      for (const [token, confirmation] of deployConfirmations) {
        if (confirmation.expiresAt <= now) deployConfirmations.delete(token)
      }
      while (deployConfirmations.size >= maxDeployConfirmations) {
        const oldestToken = deployConfirmations.keys().next().value
        if (typeof oldestToken !== 'string') break
        deployConfirmations.delete(oldestToken)
      }
      confirmationToken = randomUUID()
      deployConfirmations.set(confirmationToken, {
        skillId: safeSkillId,
        targetTool: safeTool,
        sourcePath: safeSource,
        targetRoot: safeTargetRoot,
        expiresAt: now + confirmationTtlMs
      })
    }
    return { kind, targetPath, confirmationToken }
  })

  ipcMain.handle('deploy', async (_e, skillId: number, targetTool: string, mode: DeployMode, sourcePath: string, targetRoot?: string, confirmationToken?: string) => {
    const safeSkillId = assertInteger(skillId, 'skillId')
    const safeTool = validateToolKey(targetTool)
    const safeMode = assertDeployMode(mode)
    const skill = getSkillById(db, safeSkillId)
    if (!skill) {
      throw new Error(`skill not found: ${safeSkillId}`)
    }
    const safeSource = assertRegisteredSkillSource(db, safeSkillId, sourcePath)
    const toolSkillDir = resolveToolSkillDir(safeTool, targetRoot)
    const targetDir = resolveWithin(toolSkillDir, validateSkillName(skill.name))
    const targetKind = inspectDeployTarget(
      db,
      safeSkillId,
      safeTool,
      targetDir,
      safeMode
    )
    let allowExternalOverwrite = false
    if (targetKind === 'external-overwrite') {
      const token =
        typeof confirmationToken === 'string'
          ? deployConfirmations.get(confirmationToken)
          : undefined
      if (
        !token ||
        token.expiresAt < Date.now() ||
        token.skillId !== safeSkillId ||
        token.targetTool !== safeTool ||
        token.sourcePath !== safeSource ||
        token.targetRoot !== toolSkillDir
      ) {
        throw new Error('external skill overwrite requires a valid confirmation token')
      }
      deployConfirmations.delete(confirmationToken!)
      allowExternalOverwrite = true
    }
    // #9: 从 settings 注入平台能力,deployer 据此决定 junction fallback
    const settings = readSettings(SETTINGS_PATH)
    return deploySkill(db, {
      skillId: safeSkillId,
      skillName: skill.name,
      targetTool: safeTool,
      mode: safeMode,
      sourcePath: safeSource,
      targetDir,
      backupsDir: BACKUPS_DIR,
      canSymlink: settings.platform.canSymlink,
      canJunction: settings.platform.canJunction,
      allowExternalOverwrite
    })
  })

  ipcMain.handle('undeploy', async (_e, skillId: number, targetTool: string) => {
    const safeSkillId = assertInteger(skillId, 'skillId')
    const safeTool = validateToolKey(targetTool)
    const skill = getSkillById(db, safeSkillId)
    if (!skill) {
      throw new Error(`skill not found: ${safeSkillId}`)
    }
    undeploySkill(db, safeSkillId, safeTool)
  })

  // issue #22:漂移"重新部署"——从 deployment 清单读取精确 target_path,
  // 不接收 renderer 提供的任意路径,不依赖当前工具配置重新推导。
  ipcMain.handle('redeploy', async (_e, skillId: number, targetTool: string, mode: DeployMode) => {
    const safeSkillId = assertInteger(skillId, 'skillId')
    const safeTool = validateToolKey(targetTool)
    const safeMode = assertDeployMode(mode)
    const skill = getSkillById(db, safeSkillId)
    if (!skill) {
      throw new Error(`skill not found: ${safeSkillId}`)
    }
    const settings = readSettings(SETTINGS_PATH)
    return redeploySkill(db, safeSkillId, safeTool, {
      skillName: skill.name,
      mode: safeMode,
      backupsDir: BACKUPS_DIR,
      canSymlink: settings.platform.canSymlink,
      canJunction: settings.platform.canJunction
    })
  })

  // ===== Drift actions(切片 #8)=====

  /**
   * 从清单移除(仅删 deployments 记录,不碰磁盘)。
   * 用于 ⚠️drift 状态(目标已被用户手动删了,清单与现实对齐)。
   * 与 undeploy 的区别:undeploy 同时做 fs 清理 + 删记录;removeFromManifest 只删记录。
   */
  ipcMain.handle('removeFromManifest', async (_e, skillId: number, targetTool: string) => {
    deleteDeployment(
      db,
      assertInteger(skillId, 'skillId'),
      validateToolKey(targetTool)
    )
  })

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
      backupsDir: BACKUPS_DIR
    })
  })

  ipcMain.handle('getTools', async () => {
    const settings = readSettings(SETTINGS_PATH)
    const configs = resolveToolConfigs(settings, homedir()).filter(
      (config) => config.enabled
    )
    const out: ToolWithDriftsView[] = configs.map((c) => ({
      config: c,
      drifts:
        c.enabled && c.exists
          ? detectDriftsForTool(db, c.key, c.existingPaths)
          : []
    }))
    return out
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
  const dirs = getActiveScanDirs(withPlatform, homedir())
  scanAllTools(db, dirs)
}
