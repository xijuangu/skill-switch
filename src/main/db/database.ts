// DB 连接管理:better-sqlite3 同步封装 + mutex 保护 + schema 初始化
//
// better-sqlite3 是同步 API,Electron 主进程单线程内天然串行。这里加一个
// 互斥标志位防止意外的重入调用(虽然同步操作不会真正并发,但 PRD 要求
// mutex 保护,作为防御性约束)。DB 本身的原子性靠 transaction 保证。

import Database from 'better-sqlite3'
import { SCHEMA, runMigrations } from './schema'

export type DB = Database.Database

let mutexLocked = false

/** 在 mutex 保护下执行同步操作(防止重入) */
function withMutex<T>(fn: () => T): T {
  if (mutexLocked) {
    throw new Error('DB mutex: concurrent access detected (reentrant call)')
  }
  mutexLocked = true
  try {
    return fn()
  } finally {
    mutexLocked = false
  }
}

/**
 * 创建/打开 SQLite 数据库并初始化 schema。
 * @param dbPath 数据库文件路径
 */
export function createDatabase(dbPath: string): DB {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  runMigrations(db)
  return db
}

/** 在 mutex 保护下执行事务 */
export function runInTransaction<T>(db: DB, fn: () => T): T {
  return withMutex(() => {
    const tx = db.transaction(fn)
    return tx()
  })
}

/** 在 mutex 保护下执行单条语句(无返回值场景) */
export function runWithMutex<T>(db: DB, fn: () => T): T {
  return withMutex(fn)
}
