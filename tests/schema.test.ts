import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, test } from 'vitest'
import { runMigrations } from '../src/main/db/schema'
import { createDatabase } from '../src/main/db/database'

describe('database migrations', () => {
  test('createDatabase upgrades the pre-identity schema before installing identity constraints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-switch-schema-'))
    const path = join(dir, 'registry.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        primary_source_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE skill_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_origin TEXT NOT NULL DEFAULT 'legacy',
        source_tool TEXT,
        discovered_at TEXT NOT NULL,
        repo_url TEXT,
        commit_sha TEXT,
        UNIQUE (skill_id, path)
      );
      CREATE TABLE deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id INTEGER NOT NULL,
        target_tool TEXT NOT NULL,
        mode TEXT NOT NULL,
        source_path TEXT NOT NULL,
        deployed_at TEXT NOT NULL,
        source_hash_at_deploy TEXT NOT NULL,
        UNIQUE (skill_id, target_tool)
      );
      INSERT INTO deployments
        (skill_id, target_tool, mode, source_path, deployed_at, source_hash_at_deploy)
      VALUES (1, 'codex', 'symlink', '/src/demo', 'now', 'hash');
    `)
    legacy.close()

    const upgraded = createDatabase(path)
    expect(
      (upgraded.prepare('PRAGMA table_info(deployments)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    ).toEqual(expect.arrayContaining(['source_id', 'target_id', 'management']))
    expect(upgraded.prepare('SELECT management FROM deployments WHERE id = 1').get()).toEqual({
      management: 'managed'
    })
    upgraded.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('legacy sources receive conservative persisted origins', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE skill_sources (
        id INTEGER PRIMARY KEY,
        source_type TEXT NOT NULL,
        repo_url TEXT,
        commit_sha TEXT
      );
      CREATE TABLE deployments (
        id INTEGER PRIMARY KEY
      );
      INSERT INTO skill_sources VALUES
        (1, 'central-repo', 'https://github.com/example/repo', 'abc'),
        (2, 'central-repo', NULL, NULL),
        (3, 'indexed', NULL, NULL);
    `)

    runMigrations(db)

    const rows = db
      .prepare(
        'SELECT id, source_origin, source_tool FROM skill_sources ORDER BY id'
      )
      .all() as Array<{
      id: number
      source_origin: string
      source_tool: string | null
    }>
    expect(rows).toEqual([
      { id: 1, source_origin: 'github', source_tool: null },
      { id: 2, source_origin: 'zip', source_tool: null },
      { id: 3, source_origin: 'legacy', source_tool: null }
    ])
    db.close()
  })
})
