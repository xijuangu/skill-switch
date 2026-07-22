// Phase 5 regression test: scan 登记候选来源后,工具页应显示"已登记候选"而非"未管理"
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'vitest'
import { getSourceByPath } from '../src/main/db/dao/skill-sources'
import { setCanonicalRepositoryPath } from '../src/main/db/database'
import { readToolsView } from '../src/main/ipc/index'
import { scanAllTools } from '../src/main/services/scan-all'
import { createDeploymentFacade } from '../src/main/services/deployment-facade'
import type { ActiveScanDir } from '../src/main/services/tools-config'
import type { ToolConfig } from '../src/main/types'
import { createTempDb, createTempDir } from './helpers/temp'

describe('scan-drift feedback loop', () => {
  test('scan registers candidate source and tool page reflects registered-candidate', () => {
    const fs = createTempDir('scan-drift-loop-')
    const database = createTempDb()
    const canonicalRepositoryPath = join(fs.dir, 'canonical')
    const toolDir = join(fs.dir, 'tools', 'codex')
    mkdirSync(canonicalRepositoryPath, { recursive: true })
    mkdirSync(toolDir, { recursive: true })
    // 外部 skill = 真实子目录(非链接),有 SKILL.md
    const externalSkillDir = join(toolDir, 'external-skill')
    mkdirSync(externalSkillDir)
    writeFileSync(join(externalSkillDir, 'SKILL.md'), '# external')
    setCanonicalRepositoryPath(database.db, canonicalRepositoryPath)

    const scanDir: ActiveScanDir = {
      key: 'codex', displayName: 'Codex',
      paths: [toolDir],
      targets: [{ id: 'codex-a', path: toolDir }]
    }

    // scan = "纳入管理"按钮的实际行为
    scanAllTools(database.db, [scanDir])

    // 断言1: source 被登记为 candidate(技能页能看到"候选来源"标签的原因)
    const source = getSourceByPath(database.db, externalSkillDir)
    expect(source).toBeDefined()
    expect(source!.source_role).toBe('candidate')

    // 断言2: readToolDrifts 应返回 kind='registered-candidate'(工具页显示"已登记候选")
    const tool: ToolConfig = {
      key: 'codex', displayName: 'Codex', enabled: true,
      paths: [toolDir], existingPaths: [toolDir],
      targets: [{ id: 'codex-a', path: toolDir }],
      existingTargets: [{ id: 'codex-a', path: toolDir }],
      isCustom: false, exists: true
    }
    const facade = createDeploymentFacade({
      db: database.db,
      backupsDir: join(fs.dir, 'backups'),
      getRuntime: () => ({
        tools: [tool],
        platform: { platform: 'test', canSymlink: true, canJunction: false }
      })
    })
    const drifts = readToolsView(database.db, [tool], facade.inspect)
    const drift = drifts[0].drifts.find((d) => d.skillName === 'external-skill')
    expect(drift).toBeDefined()
    // 修复后期望:已登记候选来源,不再显示 'external'("未管理")
    expect(drift!.kind).toBe('registered-candidate')

    database.cleanup()
    fs.cleanup()
  })
})
