// issue #23:验证 getSkills 返回的 deployment 列表区分 source 与部署目标,
// 每条 deployment 附带"当前状态",且 source 类型可辨(GitHub/ZIP/扫描发现/添加本地)。
//
// Skills 页展开视图需要分别展示 source(权威内容来源)和 deployment(派生目标)。
// issue #21 把读逻辑抽到 readSkillsView 纯函数,本测试直接调用真实函数验证数据契约:
// - 一个 skill 部署到多个工具 → readSkillsView 返回全部 deployment
// - 每个 deployment 含 target_tool / target_path / mode / deployed_at / status
// - copy / symlink / junction 三种 mode 信息结构一致
// - status 反映目标存在性(目标存在/缺失/链接断裂)

import { test, expect, describe } from 'vitest'
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import { upsertSkill } from '../src/main/db/dao/skills'
import { getSourceByPath, upsertSource } from '../src/main/db/dao/skill-sources'
import { executePreparedDeployment } from '../src/main/services/deployer'
import { readSkillsView } from '../src/main/ipc/index'
import { reconcileDeploymentIdentities } from '../src/main/services/deployment-identities'
import { createDeploymentFacade } from '../src/main/services/deployment-facade'
import type { DB } from '../src/main/db/database'
import type { PreparedDeploymentPlan, ToolConfig } from '../src/main/types'

function executeFixture(db: DB, plan: Omit<PreparedDeploymentPlan, 'identity'>) {
  const sourceId = getSourceByPath(db, plan.sourcePath)?.id
  if (sourceId == null) throw new Error('fixture source missing')
  return executePreparedDeployment(db, {
    ...plan,
    identity: { sourceId, targetId: `${plan.targetTool}-0` }
  })
}

/** 构造测试用 ToolConfig */
function mkTool(key: string, paths: string[], enabled = true): ToolConfig {
  return {
    key,
    displayName: key,
    enabled,
    paths,
    existingPaths: paths,
    targets: paths.map((path, index) => ({ id: `${key}-${index}`, path })),
    existingTargets: paths.map((path, index) => ({ id: `${key}-${index}`, path })),
    isCustom: false,
    exists: true
  }
}

function readView(db: DB, tools: ToolConfig[]) {
  reconcileDeploymentIdentities(db, tools)
  const facade = createDeploymentFacade({
    db,
    backupsDir: '/tmp',
    getRuntime: () => ({
      tools,
      platform: { platform: 'test', canSymlink: true, canJunction: false }
    })
  })
  return readSkillsView(db, tools, facade.inspect)
}

describe('issue #23: readSkillsView 区分 source 与 deployment,含当前状态', () => {
  test('一个 skill 部署到多个工具 → 返回全部 deployment,含 tool/path/mode/status', () => {
    const source = createTempDir('iss23-src-')
    const codexTarget = createTempDir('iss23-codex-')
    const agentsTarget = createTempDir('iss23-agents-')
    const backups = createTempDir('iss23-bak-')
    const { db, cleanup } = createTempDb()

    const skillName = 'grilling'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'indexed')

    // 部署到 codex(copy)和 agents(symlink)
    const codexTargetDir = join(codexTarget.dir, skillName)
    executeFixture(db, {
      skillId,
      skillName,
      targetTool: 'codex',
      mode: 'copy',
      sourcePath: skillDir,
      targetDir: codexTargetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })
    const agentsTargetDir = join(agentsTarget.dir, skillName)
    executeFixture(db, {
      skillId,
      skillName,
      targetTool: 'agents',
      mode: 'symlink',
      sourcePath: skillDir,
      targetDir: agentsTargetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })

    // readSkillsView(真实函数)返回含 status 的 deployment
    const toolConfigs = [
      mkTool('codex', [codexTarget.dir]),
      mkTool('agents', [agentsTarget.dir])
    ]
    const view = readView(db, toolConfigs)
    const skill = view.find((s) => s.id === skillId)!
    expect(skill).toBeDefined()
    expect(skill.deployments).toHaveLength(2)

    // codex 部署:copy mode + 精确 target_path + status
    const codexDep = skill.deployments.find((d) => d.target_tool === 'codex')!
    expect(codexDep.mode).toBe('copy')
    expect(codexDep.target_path).toBe(codexTargetDir)
    expect(codexDep.source_path).toBe(skillDir)
    expect(typeof codexDep.deployed_at).toBe('string')
    expect(codexDep.source_hash_at_deploy).toHaveLength(64)
    expect(codexDep.status).toBe('normal')

    // agents 部署:symlink mode + 精确 target_path + status
    const agentsDep = skill.deployments.find((d) => d.target_tool === 'agents')!
    expect(agentsDep.mode).toBe('symlink')
    expect(agentsDep.target_path).toBe(agentsTargetDir)
    expect(agentsDep.source_path).toBe(skillDir)
    expect(agentsDep.status).toBe('normal')

    // source 与 deployment 路径不重叠(部署目标不是 source)
    const sourcePaths = skill.sources.map((s) => s.path)
    expect(sourcePaths).toContain(skillDir)
    expect(sourcePaths).not.toContain(codexTargetDir)
    expect(sourcePaths).not.toContain(agentsTargetDir)

    source.cleanup()
    codexTarget.cleanup()
    agentsTarget.cleanup()
    backups.cleanup()
    cleanup()
  })

  test('central-repo source + 部署到工具 → source 与 deployment 清晰可辨', () => {
    const central = createTempDir('iss23-central-')
    const target = createTempDir('iss23-tgt-')
    const backups = createTempDir('iss23-bak-')
    const { db, cleanup } = createTempDb()

    const skillName = 'serenity'
    const skillDir = join(central.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: serenity\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'central-repo')

    const targetDir = join(target.dir, skillName)
    executeFixture(db, {
      skillId,
      skillName,
      targetTool: 'codex',
      mode: 'symlink',
      sourcePath: skillDir,
      targetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })

    const view = readView(db, [mkTool('codex', [target.dir])])
    const skill = view.find((s) => s.id === skillId)!

    // source 是 central-repo 类型,路径在中央仓库
    expect(skill.sources).toHaveLength(1)
    expect(skill.sources[0].source_type).toBe('central-repo')
    expect(skill.sources[0].path).toBe(skillDir)

    // deployment 目标路径在工具目录下,与 source 不同;status 反映链接存在
    expect(skill.deployments).toHaveLength(1)
    expect(skill.deployments[0].target_path).toBe(targetDir)
    expect(skill.deployments[0].target_path).not.toBe(skillDir)
    expect(skill.deployments[0].status).toBe('normal')

    central.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanup()
  })

  test('未部署的 skill → deployments 为空,展开只显示 source', () => {
    const source = createTempDir('iss23-src-')
    const { db, cleanup } = createTempDb()

    const skillName = 'lonely'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: lonely\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'indexed')

    const view = readView(db, [])
    const skill = view.find((s) => s.id === skillId)!
    expect(skill.deployments).toHaveLength(0)

    source.cleanup()
    cleanup()
  })

  test('删除 copy 目标后 status 变为"目标缺失"', () => {
    // issue #23 验收:每条 deployment 至少展示工具、实际 target_path、mode 和当前状态
    const source = createTempDir('iss23-src-')
    const target = createTempDir('iss23-tgt-')
    const backups = createTempDir('iss23-bak-')
    const { db, cleanup } = createTempDb()

    const skillName = 'gone'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: gone\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'indexed')

    const targetDir = join(target.dir, skillName)
    executeFixture(db, {
      skillId,
      skillName,
      targetTool: 'codex',
      mode: 'copy',
      sourcePath: skillDir,
      targetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })

    // 部署后 status = 目标存在(副本)
    let view = readView(db, [mkTool('codex', [target.dir])])
    expect(view[0].deployments[0].status).toBe('normal')

    // 删 target → status 变为 目标缺失
    rmSync(targetDir, { recursive: true, force: true })
    view = readView(db, [mkTool('codex', [target.dir])])
    expect(view[0].deployments[0].status).toBe('drift')

    source.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanup()
  })

  test('symlink 源被删后 status 变为"链接断裂"', () => {
    const source = createTempDir('iss23-src-')
    const target = createTempDir('iss23-tgt-')
    const backups = createTempDir('iss23-bak-')
    const { db, cleanup } = createTempDb()

    const skillName = 'broken'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: broken\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'indexed')

    const targetDir = join(target.dir, skillName)
    executeFixture(db, {
      skillId,
      skillName,
      targetTool: 'codex',
      mode: 'symlink',
      sourcePath: skillDir,
      targetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })

    // 部署后 status = 目标存在(链接)
    let view = readView(db, [mkTool('codex', [target.dir])])
    expect(view[0].deployments[0].status).toBe('normal')

    // 删源 → symlink 断裂 → status = 链接断裂
    rmSync(skillDir, { recursive: true, force: true })
    view = readView(db, [mkTool('codex', [target.dir])])
    expect(view[0].deployments[0].status).toBe('source-missing')

    source.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanup()
  })

  test('symlink target replaced by a real directory reports link-mismatch', () => {
    const source = createTempDir('iss27-src-')
    const target = createTempDir('iss27-tgt-')
    const backups = createTempDir('iss27-bak-')
    const { db, cleanup } = createTempDb()
    const skillName = 'replaced'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), 'body')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'hash', Date.now(), 'indexed')
    const targetDir = join(target.dir, skillName)
    executeFixture(db, {
      skillId,
      skillName,
      targetTool: 'codex',
      mode: 'symlink',
      sourcePath: skillDir,
      targetDir,
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })
    unlinkSync(targetDir)
    mkdirSync(targetDir)

    const view = readView(db, [mkTool('codex', [target.dir])])
    expect(view[0].deployments[0].status).toBe('link-mismatch')

    source.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanup()
  })
})
