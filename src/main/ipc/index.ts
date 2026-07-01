// IPC 层:薄传透,参数校验 + 转发 service
//
// 多工具发现:scan 读取 settings,解析所有 enabled + existing 工具目录,
// 调 scanAllTools 聚合扫描。settings 读写由 settings service 负责(原子写)。
// 启动序列 runStartupSequence:平台检测 + settings 初始化 + 一次性多工具扫描
// (覆盖本次启动新出现的工具目录)。

import { ipcMain, dialog } from 'electron'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
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
import { computeConflict, removeFromRegistry } from '../services/registry'
import { listBackups, restoreBackup, deleteBackup } from '../services/backup'
import { deploySkill, undeploySkill, detectDriftsForTool } from '../services/deployer'
import { installFromGitHub, installFromZip, installFromLocalDir } from '../services/installer'
import { getDeploymentsBySkillId, deleteDeployment } from '../db/dao/deployments'

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

/** 解析目标工具的第一个存在路径(部署目标目录)。不存在抛错。 */
function resolveToolSkillDir(targetTool: string): string {
  const settings = readSettings(SETTINGS_PATH)
  const configs = resolveToolConfigs(settings, homedir())
  const tool = configs.find((c) => c.key === targetTool && c.enabled && c.exists)
  if (!tool || tool.existingPaths.length === 0) {
    throw new Error(`tool not available: ${targetTool}`)
  }
  return tool.existingPaths[0]
}

export function registerIpcHandlers(db: DB): void {
  ipcMain.handle('scan', async () => {
    const settings = readSettings(SETTINGS_PATH)
    const dirs = getActiveScanDirs(settings, homedir())
    const result: MultiScanResult = scanAllTools(db, dirs)
    return result
  })

  ipcMain.handle('getSkills', async () => {
    // 在 IPC 边界把 sources 折算成冲突状态,UI 只读不计算
    const skills = getAllSkills(db)
    const out: SkillWithConflict[] = skills.map((s) => ({
      ...s,
      conflict: computeConflict(s.sources, s.id)
    }))
    return out
  })

  ipcMain.handle('getSettings', async () => {
    const settings = readSettings(SETTINGS_PATH)
    return buildSettingsView(settings)
  })

  ipcMain.handle('setPresetEnabled', async (_e, key: string, enabled: boolean) => {
    const settings = readSettings(SETTINGS_PATH)
    const updated = cfgSetPresetEnabled(settings, key, enabled)
    writeSettings(SETTINGS_PATH, updated)
    return buildSettingsView(updated)
  })

  ipcMain.handle('setPresetPaths', async (_e, key: string, paths: string[]) => {
    const settings = readSettings(SETTINGS_PATH)
    const updated = cfgSetPresetPaths(settings, key, paths)
    writeSettings(SETTINGS_PATH, updated)
    return buildSettingsView(updated)
  })

  ipcMain.handle('addCustomTool', async (_e, tool: CustomTool) => {
    const settings = readSettings(SETTINGS_PATH)
    const updated = cfgAddCustomTool(settings, tool)
    writeSettings(SETTINGS_PATH, updated)
    return buildSettingsView(updated)
  })

  ipcMain.handle('removeCustomTool', async (_e, key: string) => {
    const settings = readSettings(SETTINGS_PATH)
    const updated = cfgRemoveCustomTool(settings, key)
    writeSettings(SETTINGS_PATH, updated)
    return buildSettingsView(updated)
  })

  ipcMain.handle('setBackupRetention', async (_e, n: number) => {
    const settings = readSettings(SETTINGS_PATH)
    const updated: AppSettings = { ...settings, backupRetention: n }
    writeSettings(SETTINGS_PATH, updated)
    return buildSettingsView(updated)
  })

  // Backups 页:listBackups(按 backupTime DESC)/ restoreBackup(恢复到原 sourcePath)/ deleteBackup
  ipcMain.handle('listBackups', async () => {
    return listBackups(BACKUPS_DIR)
  })

  ipcMain.handle('restoreBackup', async (_e, backupId: string) => {
    // 恢复到备份元数据记录的原 sourcePath;若该路径已有内容,service 内部先建 safety-net 备份
    const metas = listBackups(BACKUPS_DIR)
    const meta = metas.find((m) => m.backupId === backupId)
    if (!meta) {
      throw new Error(`backup not found: ${backupId}`)
    }
    restoreBackup(backupId, meta.sourcePath, BACKUPS_DIR)
  })

  ipcMain.handle('deleteBackup', async (_e, backupId: string) => {
    deleteBackup(backupId, BACKUPS_DIR)
  })

  // ===== Deploy(切片 #6 + #9 junction fallback)=====

  ipcMain.handle('deploy', async (_e, skillId: number, targetTool: string, mode: DeployMode, sourcePath: string) => {
    const skill = getSkillById(db, skillId)
    if (!skill) {
      throw new Error(`skill not found: ${skillId}`)
    }
    const toolSkillDir = resolveToolSkillDir(targetTool)
    const targetDir = join(toolSkillDir, skill.name)
    // #9: 从 settings 注入平台能力,deployer 据此决定 junction fallback
    const settings = readSettings(SETTINGS_PATH)
    return deploySkill(db, {
      skillId,
      skillName: skill.name,
      targetTool,
      mode,
      sourcePath,
      targetDir,
      backupsDir: BACKUPS_DIR,
      canSymlink: settings.platform.canSymlink,
      canJunction: settings.platform.canJunction
    })
  })

  ipcMain.handle('undeploy', async (_e, skillId: number, targetTool: string) => {
    const skill = getSkillById(db, skillId)
    if (!skill) {
      throw new Error(`skill not found: ${skillId}`)
    }
    const toolSkillDir = resolveToolSkillDir(targetTool)
    const targetPath = join(toolSkillDir, skill.name)
    undeploySkill(db, skillId, targetTool, targetPath)
  })

  // ===== Drift actions(切片 #8)=====

  /**
   * 从清单移除(仅删 deployments 记录,不碰磁盘)。
   * 用于 ⚠️drift 状态(目标已被用户手动删了,清单与现实对齐)。
   * 与 undeploy 的区别:undeploy 同时做 fs 清理 + 删记录;removeFromManifest 只删记录。
   */
  ipcMain.handle('removeFromManifest', async (_e, skillId: number, targetTool: string) => {
    deleteDeployment(db, skillId, targetTool)
  })

  /**
   * 查 skill 的所有部署(用于 Skills 页 "Undeploy from..." 子菜单列出目标工具)。
   */
  ipcMain.handle('getDeploymentsForSkill', async (_e, skillId: number): Promise<Deployment[]> => {
    return getDeploymentsBySkillId(db, skillId)
  })

  /**
   * 读 skill 的 SKILL.md 原文(Skills 页 "View SKILL.md" 用)。
   * 优先读 primary_source_path/SKILL.md;不存在则读第一个 source 的 SKILL.md。
   */
  ipcMain.handle('viewSkillMd', async (_e, skillId: number): Promise<{ content: string; path: string } | null> => {
    const skill = getSkillById(db, skillId)
    if (!skill) return null
    try {
      return {
        content: readFileSync(join(skill.primary_source_path, 'SKILL.md'), 'utf-8'),
        path: join(skill.primary_source_path, 'SKILL.md')
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
    return removeFromRegistry(db, skillId, {
      centralSkillsDir: SKILLS_DIR,
      backupsDir: BACKUPS_DIR,
      resolveTargetPath: (targetTool, skillName) => {
        try {
          const dir = resolveToolSkillDir(targetTool)
          return join(dir, skillName)
        } catch {
          // 工具不可用 → 跳过 fs 清理,只删 DB 记录
          return null
        }
      }
    })
  })

  ipcMain.handle('getTools', async () => {
    const settings = readSettings(SETTINGS_PATH)
    const configs = resolveToolConfigs(settings, homedir())
    const out: ToolWithDriftsView[] = configs.map((c) => ({
      config: c,
      drifts: c.enabled && c.exists ? detectDriftsForTool(db, c.key, c.existingPaths[0]) : []
    }))
    return out
  })

  // ===== Install(切片 #7)=====

  ipcMain.handle('installFromGitHub', async (_e, url: string) => {
    return installFromGitHub(db, url, {
      centralSkillsDir: SKILLS_DIR,
      backupsDir: BACKUPS_DIR
    })
  })

  ipcMain.handle('installFromZip', async (_e, zipPath: string) => {
    return installFromZip(db, zipPath, {
      centralSkillsDir: SKILLS_DIR,
      backupsDir: BACKUPS_DIR
    })
  })

  ipcMain.handle('installFromLocalDir', async (_e, localPath: string) => {
    return installFromLocalDir(db, localPath, {
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
