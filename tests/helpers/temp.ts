// 测试 helper:临时文件系统 + 临时 SQLite DB,每个用例独立互不污染
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDatabase, type DB } from '../../src/main/db/database'

/** 创建临时目录,返回 { dir, cleanup } */
export function createTempDir(prefix = 'skill-switch-test-'): {
  dir: string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** 创建临时 SQLite DB(内存或文件),返回 { db, cleanup } */
export function createTempDb(): { db: DB; cleanup: () => void } {
  const { dir, cleanup } = createTempDir('skill-switch-db-')
  const dbPath = join(dir, 'test.db')
  const db = createDatabase(dbPath)
  return {
    db,
    cleanup: () => {
      db.close()
      cleanup()
    }
  }
}
