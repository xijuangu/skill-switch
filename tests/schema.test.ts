import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { runMigrations } from '../src/main/db/schema'

describe('database migrations', () => {
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
