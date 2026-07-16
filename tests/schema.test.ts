import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, test } from 'vitest'
import { runMigrations } from '../src/main/db/schema'
import { createDatabase } from '../src/main/db/database'

describe('database migrations', () => {
  test('adds persistent Consolidation Batch and item snapshots to an existing database', () => {
    const db = new Database(':memory:')
    db.exec("CREATE TABLE skill_sources (id INTEGER PRIMARY KEY, source_type TEXT NOT NULL DEFAULT 'indexed'); CREATE TABLE deployments (id INTEGER PRIMARY KEY);")

    runMigrations(db)

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'consolidation_%' ORDER BY name").all()).toEqual([
      { name: 'consolidation_batches' },
      { name: 'consolidation_items' },
      { name: 'consolidation_operation_locks' }
    ])
    expect((db.prepare('PRAGMA table_info(consolidation_items)').all() as Array<{ name: string }>).map((column) => column.name)).toEqual(expect.arrayContaining([
      'candidate_source_snapshot', 'observed_deployments_snapshot', 'canonical_path', 'archive_path', 'phase', 'evidence_json'
    ]))
    db.close()
  })

  test('adds durable execution evidence columns to an existing Consolidation table', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE skill_sources (id INTEGER PRIMARY KEY, source_type TEXT NOT NULL DEFAULT 'indexed');
      CREATE TABLE deployments (id INTEGER PRIMARY KEY);
      CREATE TABLE consolidation_batches (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('previewed', 'completed', 'failed', 'recovery-required', 'undone')),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        undone_at TEXT,
        failure_message TEXT
      );
    `)

    runMigrations(db)

    const columns = (db.prepare('PRAGMA table_info(consolidation_batches)').all() as Array<{ name: string }>).map((column) => column.name)
    expect(columns).toEqual(expect.arrayContaining([
      'phase', 'evidence_json', 'archive_size_bytes', 'archive_purged_at',
      'purge_confirmation_id', 'purge_previewed_at', 'purge_archive_hash'
    ]))
    db.close()
  })

  test('classifies legacy Source rows by the fixed Canonical Repository without changing IDs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-switch-source-role-'))
    const canonicalRepository = join(dir, 'canonical')
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE skill_sources (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        source_type TEXT NOT NULL,
        repo_url TEXT,
        commit_sha TEXT
      );
      CREATE TABLE deployments (id INTEGER PRIMARY KEY);
    `)
    db.prepare(
      'INSERT INTO skill_sources (id, path, source_type) VALUES (?, ?, ?)'
    ).run(11, join(canonicalRepository, 'engineering', 'demo'), 'central-repo')
    db.prepare(
      'INSERT INTO skill_sources (id, path, source_type) VALUES (?, ?, ?)'
    ).run(27, join(dir, 'discovered', 'demo'), 'indexed')

    runMigrations(db, canonicalRepository)

    expect(db.prepare('SELECT id, source_role FROM skill_sources ORDER BY id').all()).toEqual([
      { id: 11, source_role: 'canonical' },
      { id: 27, source_role: 'candidate' }
    ])
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('legacy classification keeps at most one canonical Source per Skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-switch-source-role-unique-'))
    const canonicalRepository = join(dir, 'canonical')
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE skills (id INTEGER PRIMARY KEY, primary_source_path TEXT NOT NULL);
      CREATE TABLE skill_sources (
        id INTEGER PRIMARY KEY,
        skill_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        source_type TEXT NOT NULL,
        repo_url TEXT,
        commit_sha TEXT
      );
      CREATE TABLE deployments (id INTEGER PRIMARY KEY);
    `)
    const preferred = join(canonicalRepository, 'demo')
    db.prepare('INSERT INTO skills VALUES (?, ?)').run(1, preferred)
    db.prepare('INSERT INTO skill_sources VALUES (?, ?, ?, ?, NULL, NULL)').run(11, 1, join(canonicalRepository, 'old', 'demo'), 'central-repo')
    db.prepare('INSERT INTO skill_sources VALUES (?, ?, ?, ?, NULL, NULL)').run(12, 1, preferred, 'central-repo')

    runMigrations(db, canonicalRepository)

    expect(db.prepare("SELECT id FROM skill_sources WHERE source_role = 'canonical'").all()).toEqual([{ id: 12 }])
    expect(() => db.prepare("UPDATE skill_sources SET source_role = 'canonical' WHERE id = 11").run()).toThrow()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

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
