import type { DB } from '../database'
import type { SourceRoot } from '../../types'

export function insertSourceRoot(db: DB, path: string): SourceRoot {
  db.prepare(
    `INSERT INTO source_roots (path, created_at, last_scanned_at, last_scan_error)
     VALUES (?, ?, NULL, NULL)
     ON CONFLICT(path) DO NOTHING`
  ).run(path, new Date().toISOString())
  return db.prepare('SELECT * FROM source_roots WHERE path = ?').get(path) as SourceRoot
}

export function getAllSourceRoots(db: DB): SourceRoot[] {
  return db.prepare('SELECT * FROM source_roots ORDER BY path ASC').all() as SourceRoot[]
}

export function getSourceRootById(db: DB, id: number): SourceRoot | undefined {
  return db.prepare('SELECT * FROM source_roots WHERE id = ?').get(id) as SourceRoot | undefined
}

export function markSourceRootScanned(db: DB, id: number, scannedAt: string): void {
  db.prepare('UPDATE source_roots SET last_scanned_at = ?, last_scan_error = NULL WHERE id = ?').run(scannedAt, id)
}

export function markSourceRootScanFailed(db: DB, id: number, message: string): void {
  db.prepare('UPDATE source_roots SET last_scan_error = ? WHERE id = ?').run(message, id)
}

export function deleteSourceRoot(db: DB, id: number): void {
  db.prepare('DELETE FROM source_roots WHERE id = ?').run(id)
}
