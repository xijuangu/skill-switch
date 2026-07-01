// issue #21:验证 mutation 后 getSkills / getTools 等读操作返回一致的权威状态。
//
// renderer 的统一 refresh 机制在每次 deploy / undeploy / remove 后调用 getSkills +
// getTools 重读 DB。这些 IPC handler 是薄传透,实际数据来自 service + DAO。
// 本测试在 service 层模拟完整的 mutation → read 周期,确保 refresh 读到的状态
// 与 mutation 结果一致(不依赖全量磁盘扫描)。

import { test, expect, describe } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTempDir, createTempDb } from './helpers/temp'
import { upsertSkill } from '../src/main/db/dao/skills'
import { upsertSource } from '../src/main/db/dao/skill-sources'
import { getDeploymentsBySkillId, getDeploymentsByTool } from '../src/main/db/dao/deployments'
import { getAllSkills } from '../src/main/db/dao/skills'
import { computeConflict, filterSourcesByEnabledTools, removeFromRegistry } from '../src/main/services/registry'
import {
  deploySkill,
  undeploySkill,
  detectDriftsForTool,
  redeploySkill
} from '../src/main/services/deployer'
import { deleteDeployment } from '../src/main/db/dao/deployments'
import type { ToolConfig } from '../src/main/types'

/** 模拟 getSkills IPC handler 的核心读逻辑(含 issue #20 source 过滤) */
function readSkillsView(db: ReturnType<typeof createTempDb>['db'], toolConfigs: ToolConfig[]) {
  const skills = getAllSkills(db)
  return skills
    .map((s) => {
      const visible = filterSourcesByEnabledTools(s.sources, toolConfigs)
      return {
        ...s,
        sources: visible,
        conflict: computeConflict(visible, s.id),
        deployments: getDeploymentsBySkillId(db, s.id)
      }
    })
    .filter((s) => s.sources.length > 0)
}

/** 模拟 getTools IPC handler 的核心读逻辑(detectDriftsForTool) */
function readToolsView(
  db: ReturnType<typeof createTempDb>['db'],
  toolKey: string,
  toolSkillDirs: string[]
) {
  return detectDriftsForTool(db, toolKey, toolSkillDirs)
}

/** 构造测试用 ToolConfig */
function mkTool(key: string, paths: string[], enabled = true): ToolConfig {
  return {
    key,
    displayName: key,
    enabled,
    paths,
    existingPaths: paths,
    isCustom: false,
    exists: true
  }
}

describe('issue #21: mutation 后读操作返回一致的权威状态', () => {
  test('deploy → getSkills 显示已部署 + getTools 显示 normal', () => {
    const source = createTempDir('iss21-src-')
    const target = createTempDir('iss21-tgt-')
    const backups = createTempDir('iss21-bak-')
    const { db, cleanup } = createTempDb()

    const skillName = 'grilling'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'indexed')

    const targetDir = join(target.dir, skillName)
    const toolConfigs = [mkTool('codex', [target.dir])]

    // 部署前:getSkills 无部署,getTools 无 managed drift
    let skillsView = readSkillsView(db, toolConfigs)
    expect(skillsView[0].deployments).toHaveLength(0)
    let toolsView = readToolsView(db, 'codex', [target.dir])
    expect(toolsView.filter((d) => d.deployment !== null)).toHaveLength(0)

    // deploy
    deploySkill(db, {
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

    // 部署后:getSkills 显示 1 个部署,getTools 显示 1 个 normal drift
    skillsView = readSkillsView(db, toolConfigs)
    expect(skillsView[0].deployments).toHaveLength(1)
    expect(skillsView[0].deployments[0].target_tool).toBe('codex')
    toolsView = readToolsView(db, 'codex', [target.dir])
    const managed = toolsView.filter((d) => d.deployment !== null)
    expect(managed).toHaveLength(1)
    expect(managed[0].kind).toBe('normal')

    source.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanup()
  })

  test('undeploy → getSkills 无部署 + getTools 无 managed drift', () => {
    const source = createTempDir('iss21-src-')
    const target = createTempDir('iss21-tgt-')
    const backups = createTempDir('iss21-bak-')
    const { db, cleanup } = createTempDb()

    const skillName = 'grilling'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'indexed')
    const targetDir = join(target.dir, skillName)
    const toolConfigs = [mkTool('codex', [target.dir])]

    deploySkill(db, {
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

    // undeploy
    undeploySkill(db, skillId, 'codex')

    // 卸载后:getSkills 无部署,getTools 无 managed drift
    const skillsView = readSkillsView(db, toolConfigs)
    expect(skillsView[0].deployments).toHaveLength(0)
    const toolsView = readToolsView(db, 'codex', [target.dir])
    expect(toolsView.filter((d) => d.deployment !== null)).toHaveLength(0)

    source.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanup()
  })

  test('removeFromManifest → getSkills 无部署 + getTools 无该 skill 的 drift', () => {
    const source = createTempDir('iss21-src-')
    const target = createTempDir('iss21-tgt-')
    const backups = createTempDir('iss21-bak-')
    const { db, cleanup } = createTempDb()

    const skillName = 'grilling'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'indexed')
    const targetDir = join(target.dir, skillName)
    const toolConfigs = [mkTool('codex', [target.dir])]

    deploySkill(db, {
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

    // removeFromManifest(只删清单记录,不碰磁盘)
    deleteDeployment(db, skillId, 'codex')

    const skillsView = readSkillsView(db, toolConfigs)
    expect(skillsView[0].deployments).toHaveLength(0)
    const toolsView = readToolsView(db, 'codex', [target.dir])
    // 磁盘上 target 仍存在,但清单无记录 → external
    const external = toolsView.filter((d) => d.kind === 'external')
    expect(external).toHaveLength(1)
    expect(toolsView.filter((d) => d.deployment !== null)).toHaveLength(0)

    source.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanup()
  })

  test('removeFromRegistry → getSkills 不含该 skill + getTools 无该 skill', () => {
    const central = createTempDir('iss21-central-')
    const target = createTempDir('iss21-tgt-')
    const backups = createTempDir('iss21-bak-')
    const { db, cleanup } = createTempDb()

    const skillName = 'grilling'
    const skillDir = join(central.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'central-repo')
    const targetDir = join(target.dir, skillName)
    const toolConfigs = [mkTool('codex', [target.dir])]

    deploySkill(db, {
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

    // removeFromRegistry
    removeFromRegistry(db, skillId, {
      centralSkillsDir: central.dir,
      backupsDir: backups.dir
    })

    // getSkills 不含该 skill
    const skillsView = readSkillsView(db, toolConfigs)
    expect(skillsView.find((s) => s.name === skillName)).toBeUndefined()
    // getTools 无 managed drift(target 已被清理)
    const toolsView = readToolsView(db, 'codex', [target.dir])
    expect(toolsView.filter((d) => d.deployment !== null)).toHaveLength(0)

    central.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanup()
  })

  test('redeploy → getTools drift 恢复 normal', () => {
    const source = createTempDir('iss21-src-')
    const target = createTempDir('iss21-tgt-')
    const backups = createTempDir('iss21-bak-')
    const { db, cleanup } = createTempDb()

    const skillName = 'grilling'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'indexed')
    const targetDir = join(target.dir, skillName)
    const toolConfigs = [mkTool('codex', [target.dir])]

    deploySkill(db, {
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

    // 模拟 drift:删除 target 目录
    rmSync(targetDir, { recursive: true, force: true })

    let toolsView = readToolsView(db, 'codex', [target.dir])
    const driftBefore = toolsView.find((d) => d.skillId === skillId)
    expect(driftBefore?.kind).toBe('drift')

    // redeploy(issue #22:从清单读 target_path)
    redeploySkill(db, skillId, 'codex', {
      skillName,
      mode: 'copy',
      backupsDir: backups.dir,
      canSymlink: true,
      canJunction: false
    })

    toolsView = readToolsView(db, 'codex', [target.dir])
    const driftAfter = toolsView.find((d) => d.skillId === skillId)
    expect(driftAfter?.kind).toBe('normal')

    source.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanup()
  })

  test('mutation 失败(源缺失)→ DB 状态不变,读操作返回原状态', () => {
    const source = createTempDir('iss21-src-')
    const target = createTempDir('iss21-tgt-')
    const backups = createTempDir('iss21-bak-')
    const { db, cleanup } = createTempDb()

    const skillName = 'grilling'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'indexed')
    const targetDir = join(target.dir, skillName)
    const toolConfigs = [mkTool('codex', [target.dir])]

    // 记录部署前状态
    const skillsBefore = readSkillsView(db, toolConfigs)
    const deploymentsBefore = getDeploymentsByTool(db, 'codex')

    // 尝试 deploy 到不存在的源 → 抛错
    expect(() =>
      deploySkill(db, {
        skillId,
        skillName,
        targetTool: 'codex',
        mode: 'copy',
        sourcePath: '/nonexistent/source/path',
        targetDir,
        backupsDir: backups.dir,
        canSymlink: true,
        canJunction: false
      })
    ).toThrow()

    // 失败后:状态与部署前一致(DB 未被修改)
    const skillsAfter = readSkillsView(db, toolConfigs)
    expect(skillsAfter[0].deployments).toEqual(skillsBefore[0].deployments)
    expect(getDeploymentsByTool(db, 'codex')).toEqual(deploymentsBefore)

    source.cleanup()
    target.cleanup()
    backups.cleanup()
    cleanup()
  })

  test('undeploy 失败(无部署记录)→ DB 状态不变', () => {
    const source = createTempDir('iss21-src-')
    const { db, cleanup } = createTempDb()

    const skillName = 'grilling'
    const skillDir = join(source.dir, skillName)
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: grilling\n---\nbody\n')
    const skillId = upsertSkill(db, skillName, skillDir)
    upsertSource(db, skillId, skillDir, 'somehash', Date.now(), 'indexed')

    const deploymentsBefore = getDeploymentsBySkillId(db, skillId)
    expect(deploymentsBefore).toHaveLength(0)

    // undeploy 无部署记录 → 抛错
    expect(() => undeploySkill(db, skillId, 'codex')).toThrow()

    // 失败后:仍无部署记录
    expect(getDeploymentsBySkillId(db, skillId)).toHaveLength(0)

    source.cleanup()
    cleanup()
  })
})
