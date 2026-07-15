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

afterEach(() => databases.splice(0).forEach((db) => db.close()))

describe('deployment semantic identity expansion', () => {
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
    upsertDeployment(db, skillId, 'codex', '/targets/a/demo', 'copy', '/src/demo', 'hash')
    reconcileDeploymentIdentities(db, [tool([{ id: 'target-a', path: '/targets/a' }])])
    expect(getDeploymentsBySkillId(db, skillId)[0]).toMatchObject({ source_id: sourceId, target_id: 'target-a' })
  })

  test('ambiguous or missing legacy matches remain unresolved', () => {
    const db = createDb()
    const { skillId } = seed(db)
    upsertDeployment(db, skillId, 'codex', '/targets/a/demo', 'copy', '/missing', 'hash')
    reconcileDeploymentIdentities(db, [tool([
      { id: 'target-a', path: '/targets/a' },
      { id: 'target-duplicate', path: '/targets/a' }
    ])])
    expect(getDeploymentsBySkillId(db, skillId)[0]).toMatchObject({ source_id: null, target_id: null })
  })
})
