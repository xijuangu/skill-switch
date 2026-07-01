// 中央仓库路径常量(跨平台)
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

export const CENTRAL_DIR = join(homedir(), '.skill-switch')
export const DB_PATH = join(CENTRAL_DIR, 'ccswitch.db')
export const SKILLS_DIR = join(CENTRAL_DIR, 'skills')
export const BACKUPS_DIR = join(CENTRAL_DIR, 'skill-backups')
export const SETTINGS_PATH = join(CENTRAL_DIR, 'settings.json')

/** 确保中央仓库目录存在 */
export function ensureCentralDir(): void {
  if (!existsSync(CENTRAL_DIR)) {
    mkdirSync(CENTRAL_DIR, { recursive: true })
  }
}
