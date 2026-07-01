// IPC 层:薄传透,参数校验 + 转发 service
// 本切片硬编码扫描 TRAE 目录(~/.trae-cn/skills),多工具发现在切片 #3。
import { ipcMain } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import type { DB } from '../db/database'
import { scanToolDir } from '../services/scanner'
import { getAllSkills } from '../db/dao/skills'

const TRAE_SKILLS_DIR = join(homedir(), '.trae-cn', 'skills')

export function registerIpcHandlers(db: DB): void {
  ipcMain.handle('scan', async () => {
    if (!existsSync(TRAE_SKILLS_DIR)) {
      return { scanned: 0, upserted: 0, error: `目录不存在: ${TRAE_SKILLS_DIR}` }
    }
    return scanToolDir(db, TRAE_SKILLS_DIR)
  })

  ipcMain.handle('getSkills', async () => {
    return getAllSkills(db)
  })
}
