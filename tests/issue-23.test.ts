// issue #23:验证 getSkills 返回的 deployment 列表区分 source 与部署目标。
//
// Skills 页展开视图需要分别展示 source(权威内容来源)和 deployment(派生目标)。
// deployment 数据来自 deployments 表,由 getSkills IPC handler 通过
// getDeploymentsBySkillId 附加到每个 skill。本测试验证该数据契约:
// - 一个 skill 部署到多个工具 → getSkills 返回全部 deployment
// - 每个 deployment 含 target_tool / target_path / mode / deployed_at
// - copy / symlink / junction 三种 mode 信息结构一致

import { test, expect, describe } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import { upsertSkill, getAllSkills } from '../src/main/db/dao/skills'
import { upsertSource } from '../src/main/db/dao/skill-sources'
import { getDeploymentsBySkillId } from '../src/main/db/dao/deployments'
import { deploySkill } from '../src/main/services/deployer'
import type { Deployment } from '../src/main/types'

describe('issue #23: getSkills 返回的 deployment 区分 source 与部署目标', () => {
  test('一个 skill 部署到多个工具 → 返回全部 deployment,含 tool/path/mode', () => {
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
    deploySkill(db, {
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
    deploySkill(db, {
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

    // getSkills 返回的 deployment 列表(模拟 IPC handler 的 getDeploymentsBySkillId)
    const skills = getAllSkills(db)
    const skill = skills.find((s) => s.id === skillId)!
    const deployments: Deployment[] = getDeploymentsBySkillId(db, skillId)

    expect(deployments).toHaveLength(2)
    expect(skills.find((s) => s.name === skillName)).toBeDefined()

    // codex 部署:copy mode + 精确 target_path
    const codexDep = deployments.find((d) => d.target_tool === 'codex')!
    expect(codexDep.mode).toBe('copy')
    expect(codexDep.target_path).toBe(codexTargetDir)
    expect(codexDep.source_path).toBe(skillDir)
    expect(typeof codexDep.deployed_at).toBe('string')
    expect(codexDep.source_hash_at_deploy).toHaveLength(64)

    // agents 部署:symlink mode + 精确 target_path
    const agentsDep = deployments.find((d) => d.target_tool === 'agents')!
    expect(agentsDep.mode).toBe('symlink')
    expect(agentsDep.target_path).toBe(agentsTargetDir)
    expect(agentsDep.source_path).toBe(skillDir)

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
    deploySkill(db, {
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

    const skills = getAllSkills(db)
    const skill = skills.find((s) => s.id === skillId)!
    const deployments = getDeploymentsBySkillId(db, skillId)

    // source 是 central-repo 类型,路径在中央仓库
    expect(skill.sources).toHaveLength(1)
    expect(skill.sources[0].source_type).toBe('central-repo')
    expect(skill.sources[0].path).toBe(skillDir)

    // deployment 目标路径在工具目录下,与 source 不同
    expect(deployments).toHaveLength(1)
    expect(deployments[0].target_path).toBe(targetDir)
    expect(deployments[0].target_path).not.toBe(skillDir)

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

    const deployments = getDeploymentsBySkillId(db, skillId)
    expect(deployments).toHaveLength(0)

    source.cleanup()
    cleanup()
  })
})
