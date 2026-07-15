import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'vitest'
import { upsertSkill } from '../src/main/db/dao/skills'
import { getSourceByPath, upsertSource } from '../src/main/db/dao/skill-sources'
import { createDeploymentFacade } from '../src/main/services/deployment-facade'
import { hashDir } from '../src/main/services/hash'
import { createTempDb, createTempDir } from './helpers/temp'
import type { DB } from '../src/main/db/database'
import type { ToolConfig } from '../src/main/types'

const cleanups: Array<() => void> = []

function setup() {
  const fs = createTempDir('deployment-facade-')
  const database = createTempDb()
  cleanups.push(fs.cleanup, database.cleanup)
  const sourcePath = join(fs.dir, 'source', 'demo')
  const targetRoot = join(fs.dir, 'target')
  const backupsDir = join(fs.dir, 'backups')
  mkdirSync(sourcePath, { recursive: true })
  mkdirSync(targetRoot, { recursive: true })
  writeFileSync(join(sourcePath, 'SKILL.md'), '# demo')
  const skillId = upsertSkill(database.db, 'demo', sourcePath)
  upsertSource(database.db, skillId, sourcePath, hashDir(sourcePath), 0, 'indexed', { origin: 'scan' })
  const sourceId = getSourceByPath(database.db, sourcePath)!.id
  const targetId = 'target-codex'
  const tool: ToolConfig = {
    key: 'codex', displayName: 'Codex', enabled: true, paths: [targetRoot], existingPaths: [targetRoot],
    targets: [{ id: targetId, path: targetRoot }], existingTargets: [{ id: targetId, path: targetRoot }],
    isCustom: false, exists: true
  }
  let now = 1_000
  const create = (db: DB = database.db) => createDeploymentFacade({
    db,
    getRuntime: () => ({ tools: [tool], platform: { platform: 'test', canSymlink: true, canJunction: false } }),
    backupsDir,
    now: () => now,
    createId: () => 'confirmation-1',
    confirmationTtlMs: 100
  })
  return { ...database, sourceId, targetId, targetRoot, sourcePath, create, advance: (ms: number) => { now += ms } }
}

afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

describe('Deployment Facade', () => {
  test('deploys and updates using only source ID, target ID and requested mode', () => {
    const env = setup()
    const facade = env.create()
    const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
    expect(facade.deploy(request)).toMatchObject({ status: 'completed', result: { action: 'created' } })
    expect(facade.deploy(request)).toMatchObject({ status: 'completed', result: { action: 'skipped' } })
    writeFileSync(join(env.sourcePath, 'SKILL.md'), '# changed')
    expect(facade.deploy(request)).toMatchObject({ status: 'completed', result: { action: 'updated' } })
    expect(facade.deploy({ ...request, requestedMode: 'symlink' })).toMatchObject({
      status: 'completed', result: { action: 'mode-switched' }
    })
  })

  test('external overwrite requires a single-use opaque confirmation ID', () => {
    const env = setup()
    const external = join(env.targetRoot, 'demo')
    mkdirSync(external)
    writeFileSync(join(external, 'SKILL.md'), '# external')
    const facade = env.create()
    const outcome = facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    expect(outcome).toMatchObject({
      status: 'confirmation-required', confirmationId: 'confirmation-1',
      facts: { targetPath: external, reason: 'external-overwrite' }
    })
    expect(facade.confirm('confirmation-1')).toMatchObject({
      status: 'completed', result: { action: 'external-overwritten' }
    })
    expect(facade.confirm('confirmation-1')).toMatchObject({ status: 'rejected', reason: 'confirmation-used' })
  })

  test('expired, restarted and changed confirmations are structured rejections', () => {
    const env = setup()
    const external = join(env.targetRoot, 'demo')
    mkdirSync(external)
    writeFileSync(join(external, 'SKILL.md'), '# external')
    const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
    const expired = env.create()
    expired.deploy(request)
    env.advance(101)
    expect(expired.confirm('confirmation-1')).toMatchObject({ status: 'rejected', reason: 'confirmation-expired' })
    expect(env.create().confirm('confirmation-1')).toMatchObject({ status: 'rejected', reason: 'confirmation-invalid' })
    const changed = env.create()
    changed.deploy(request)
    writeFileSync(join(external, 'SKILL.md'), '# changed externally')
    expect(changed.confirm('confirmation-1')).toMatchObject({ status: 'rejected', reason: 'plan-changed' })
  })
})
