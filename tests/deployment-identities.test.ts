import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { SCHEMA, runMigrations } from '../src/main/db/schema'
import { getDeploymentsBySkillId, upsertDeployment } from '../src/main/db/dao/deployments'
import { reconcileDeploymentIdentities } from '../src/main/services/deployment-identities'
import type { ToolConfig } from '../src/main/types'

const databases: Database.Database[] = []

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  runMigrations(db)
  databases.push(db)
  return db
}

function seed(db: Database.Database): { skillId: number; sourceId: number } {
  const skillId = Number(
    db.prepare("INSERT INTO skills (name, primary_source_path, created_at) VALUES ('demo', '/src/demo', 'now')").run()
      .lastInsertRowid
  )
  const sourceId = Number(
    db.prepare(`INSERT INTO skill_sources
      (skill_id, path, hash, mtime, source_type, source_origin, discovered_at)
      VALUES (?, '/src/demo', 'hash', 0, 'indexed', 'scan', 'now')`).run(skillId).lastInsertRowid
  )
  return { skillId, sourceId }
}

function tool(targets: Array<{ id: string; path: string }>): ToolConfig {
  return {
    key: 'codex', displayName: 'Codex', enabled: true, paths: targets.map((t) => t.path),
    existingPaths: targets.map((t) => t.path), targets, existingTargets: targets,
    isCustom: false, exists: true
  }
}

function insertLegacyDeployment(
  db: Database.Database,
  skillId: number,
  targetPath: string,
  sourcePath: string
): void {
  db.prepare(`INSERT INTO deployments
    (skill_id, target_tool, target_path, mode, source_path, deployed_at, source_hash_at_deploy)
    VALUES (?, 'codex', ?, 'copy', ?, 'now', 'hash')`).run(skillId, targetPath, sourcePath)
}

afterEach(() => databases.splice(0).forEach((db) => db.close()))

describe('deployment semantic identity expansion', () => {
  test('resolved identity columns are enforced as an all-or-nothing pair', () => {
    const db = createDb()
    const { skillId, sourceId } = seed(db)
    expect(() => {
      db.prepare(`INSERT INTO deployments
        (skill_id, target_tool, target_path, mode, source_path, deployed_at, source_hash_at_deploy, source_id)
        VALUES (?, 'codex', '/target/demo', 'copy', '/src/demo', 'now', 'hash', ?)`)
        .run(skillId, sourceId)
    }).toThrow(/resolve together/)
    expect(() => insertLegacyDeployment(db, skillId, '/target/demo', '/src/demo')).not.toThrow()
  })

  test('new deployments can persist source and target IDs for multiple targets of one tool', () => {
    const db = createDb()
    const { skillId, sourceId } = seed(db)
    upsertDeployment(db, skillId, 'codex', '/targets/a/demo', 'copy', '/src/demo', 'hash', { sourceId, targetId: 'target-a' })
    upsertDeployment(db, skillId, 'codex', '/targets/b/demo', 'copy', '/src/demo', 'hash', { sourceId, targetId: 'target-b' })
    expect(getDeploymentsBySkillId(db, skillId).map((d) => d.target_id)).toEqual(['target-a', 'target-b'])
  })

  test('legacy deployment is backfilled only from exact source and target snapshots', () => {
    const db = createDb()
    const { skillId, sourceId } = seed(db)
    insertLegacyDeployment(db, skillId, '/targets/a/demo', '/src/demo')
    reconcileDeploymentIdentities(db, [tool([{ id: 'target-a', path: '/targets/a' }])])
    expect(getDeploymentsBySkillId(db, skillId)[0]).toMatchObject({ source_id: sourceId, target_id: 'target-a' })
  })

  test('ambiguous or missing legacy matches remain unresolved', () => {
    const db = createDb()
    const { skillId } = seed(db)
    insertLegacyDeployment(db, skillId, '/targets/a/demo', '/missing')
    reconcileDeploymentIdentities(db, [tool([
      { id: 'target-a', path: '/targets/a' },
      { id: 'target-duplicate', path: '/targets/a' }
    ])])
    expect(getDeploymentsBySkillId(db, skillId)[0]).toMatchObject({ source_id: null, target_id: null })
  })

  test.each([
    {
      name: 'source only',
      sourcePath: '/src/demo',
      targetPath: '/missing/demo',
      targets: [{ id: 'target-a', path: '/targets/a' }]
    },
    {
      name: 'target only',
      sourcePath: '/missing',
      targetPath: '/targets/a/demo',
      targets: [{ id: 'target-a', path: '/targets/a' }]
    }
  ])('one-sided legacy match ($name) remains fully unresolved', ({ sourcePath, targetPath, targets }) => {
    const db = createDb()
    const { skillId } = seed(db)
    insertLegacyDeployment(db, skillId, targetPath, sourcePath)
    expect(() => reconcileDeploymentIdentities(db, [tool(targets)])).not.toThrow()
    expect(getDeploymentsBySkillId(db, skillId)[0]).toMatchObject({ source_id: null, target_id: null })
  })

  test('deleting a referenced source safely returns its deployment to unresolved legacy state', () => {
    const db = createDb()
    const { skillId, sourceId } = seed(db)
    upsertDeployment(db, skillId, 'codex', '/targets/a/demo', 'copy', '/src/demo', 'hash', {
      sourceId,
      targetId: 'target-a'
    })

    expect(() => db.prepare('DELETE FROM skill_sources WHERE id = ?').run(sourceId)).not.toThrow()
    expect(getDeploymentsBySkillId(db, skillId)[0]).toMatchObject({ source_id: null, target_id: null })
  })
})
