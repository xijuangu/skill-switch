import { describe, expect, test } from 'vitest'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { createTempDb, createTempDir } from './helpers/temp'
import { upsertSkill } from '../src/main/db/dao/skills'
import { getSourceByPath, upsertSource } from '../src/main/db/dao/skill-sources'
import { readDeployTargetOptions } from '../src/main/ipc/index'
import type { ToolConfig } from '../src/main/types'

function tool(key: string, path: string): ToolConfig {
  return {
    key,
    displayName: key,
    enabled: true,
    paths: [path],
    existingPaths: [path],
    targets: [{ id: `target-${key}`, path }],
    existingTargets: [{ id: `target-${key}`, path }],
    isCustom: false,
    exists: true
  }
}

describe('deploy target options', () => {
  test('main-process view excludes self deployment and keeps a safe sibling tool', () => {
    const sourceRoot = createTempDir('target-source-')
    const safeRoot = createTempDir('target-safe-')
    const { db, cleanup } = createTempDb()
    const skillName = 'demo'
    const sourcePath = join(sourceRoot.dir, skillName)
    mkdirSync(sourcePath)
    const skillId = upsertSkill(db, skillName, sourcePath)
    upsertSource(db, skillId, sourcePath, 'hash', 0, 'indexed')
    const sourceId = getSourceByPath(db, sourcePath)!.id

    const options = readDeployTargetOptions(
      db,
      sourceId,
      [tool('self', sourceRoot.dir), tool('safe', safeRoot.dir)]
    )

    expect(options.find((option) => option.targetTool === 'self')).toMatchObject({
      eligible: false
    })
    expect(options.find((option) => option.targetTool === 'safe')).toMatchObject({
      eligible: true,
      targetId: 'target-safe'
    })

    sourceRoot.cleanup()
    safeRoot.cleanup()
    cleanup()
  })
})
