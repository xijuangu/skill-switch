// IPC 层:薄传透,参数校验 + 转发 service
//
// 多工具发现:scan 读取 settings,解析所有 enabled + existing 工具目录,
// 调 scanAllTools 聚合扫描。settings 读写由 settings service 负责(原子写)。
// 启动序列 runStartupSequence:平台检测 + settings 初始化 + 一次性多工具扫描
// (覆盖本次启动新出现的工具目录)。

import { ipcMain } from 'electron'
import { homedir, tmpdir } from 'os'
import type { DB } from '../db/database'
import type { AppSettings, CustomTool, MultiScanResult, PlatformInfo, SkillWithConflict, ToolConfig } from '../types'
import { SETTINGS_PATH, BACKUPS_DIR } from '../paths'
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
import { getAllSkills } from '../db/dao/skills'
import { computeConflict } from '../services/registry'
import { listBackups, restoreBackup, deleteBackup } from '../services/backup'

/** Settings 页统一视图:解析后的工具列表 + backupRetention + 平台信息 */
export interface SettingsView {
  tools: ToolConfig[]
  backupRetention: number
  platform: PlatformInfo
}

function buildSettingsView(settings: AppSettings): SettingsView {
  return {
    tools: resolveToolConfigs(settings, homedir()),
    backupRetention: settings.backupRetention,
    platform: settings.platform
  }
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
