import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'vitest'
import { deleteDeploymentById } from '../src/main/db/dao/deployments'
import { getSourceByPath, upsertSource } from '../src/main/db/dao/skill-sources'
import { upsertSkill } from '../src/main/db/dao/skills'
import { setCanonicalRepositoryPath } from '../src/main/db/database'
import { readToolsView } from '../src/main/ipc/index'
import { markerForTarget, writeMarker } from '../src/main/services/deployer'
import { createDeploymentFacade } from '../src/main/services/deployment-facade'
import { hashDir } from '../src/main/services/hash'
import type { ToolConfig } from '../src/main/types'
import { createTempDb, createTempDir } from './helpers/temp'

const cleanups: Array<() => void> = []

function setup() {
  const fs = createTempDir('deployment-read-')
  const database = createTempDb()
  cleanups.push(fs.cleanup, database.cleanup)
  const canonicalRepositoryPath = join(fs.dir, 'canonical')
  const sourcePath = join(canonicalRepositoryPath, 'demo')
  const firstRoot = join(fs.dir, 'target-a')
  const secondRoot = join(fs.dir, 'target-b')
  mkdirSync(canonicalRepositoryPath, { recursive: true })
  mkdirSync(sourcePath, { recursive: true })
  mkdirSync(firstRoot)
  mkdirSync(secondRoot)
  writeFileSync(join(sourcePath, 'SKILL.md'), '# demo')
  setCanonicalRepositoryPath(database.db, canonicalRepositoryPath)
  const skillId = upsertSkill(database.db, 'demo', sourcePath)
  upsertSource(database.db, skillId, sourcePath, hashDir(sourcePath), 0, 'central-repo', { role: 'canonical', origin: 'local' })
  const sourceId = getSourceByPath(database.db, sourcePath)!.id
  const tool: ToolConfig = {
    key: 'codex', displayName: 'Codex', enabled: true,
    paths: [firstRoot, secondRoot], existingPaths: [firstRoot, secondRoot],
    targets: [{ id: 'codex-a', path: firstRoot }, { id: 'codex-b', path: secondRoot }],
    existingTargets: [{ id: 'codex-a', path: firstRoot }, { id: 'codex-b', path: secondRoot }],
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
  return { ...database, sourceId, firstRoot, secondRoot, tool, facade }
}

afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

describe('authoritative deployment read model', () => {
  test('deploy, drift, redeploy, undeploy and manifest removal reuse Facade.inspect', async () => {
    const env = setup()
    const deployed = await env.facade.deploy({
      sourceId: env.sourceId,
      targetId: 'codex-a',
      requestedMode: 'copy'
    })
    if (deployed.status !== 'completed') throw new Error('expected deployment')
    const read = () => readToolsView(env.db, [env.tool], env.facade.inspect)[0].drifts

    expect(read().filter((item) => item.deployment != null)).toMatchObject([{ kind: 'normal' }])
    rmSync(join(env.firstRoot, 'demo'), { recursive: true, force: true })
    expect(read().filter((item) => item.deployment != null)).toMatchObject([{ kind: 'drift' }])
    expect(await env.facade.redeploy(deployed.deploymentId)).toMatchObject({ status: 'completed' })
    expect(read().filter((item) => item.deployment != null)).toMatchObject([{ kind: 'normal' }])
    expect(await env.facade.undeploy(deployed.deploymentId)).toMatchObject({ status: 'completed' })
    expect(read()).toEqual([])

    const redeployed = await env.facade.deploy({
      sourceId: env.sourceId,
      targetId: 'codex-a',
      requestedMode: 'copy'
    })
    if (redeployed.status !== 'completed') throw new Error('expected deployment')
    deleteDeploymentById(env.db, redeployed.deploymentId)
    expect(read()).toMatchObject([{ kind: 'external', targetPath: join(env.firstRoot, 'demo') }])
  })

  test('multi-target external entries remain distinct and null inspect results are not duplicated', async () => {
    const env = setup()
    mkdirSync(join(env.firstRoot, 'external-a'))
    mkdirSync(join(env.secondRoot, 'external-b'))
    writeFileSync(
      join(env.firstRoot, 'external-a', 'SKILL.md'),
      '---\nname: declared-a\n---\n'
    )
    expect(
      readToolsView(env.db, [env.tool], env.facade.inspect)[0].drifts
        .map((item) => [item.targetPath, item.targetId, item.targetEntryName, item.skillName])
        .sort()
    ).toEqual([
      [join(env.firstRoot, 'external-a'), 'codex-a', 'external-a', 'declared-a'],
      [join(env.secondRoot, 'external-b'), 'codex-b', 'external-b', 'external-b']
    ].sort())

    const deployed = await env.facade.deploy({
      sourceId: env.sourceId,
      targetId: 'codex-a',
      requestedMode: 'copy'
    })
    if (deployed.status !== 'completed') throw new Error('expected deployment')
    const withNullInspect = readToolsView(env.db, [env.tool], () => null)[0].drifts
    expect(withNullInspect.some((item) => item.skillName === 'demo')).toBe(false)
  })

  test('unfinished external management remains visible as recovery-required after restart', () => {
    const env = setup()
    const externalPath = join(env.firstRoot, 'external-recovery')
    mkdirSync(externalPath)
    writeFileSync(join(externalPath, 'SKILL.md'), '# external-recovery')
    const evidence = markerForTarget(externalPath, 'manage-external-recovery')
    writeMarker(evidence, 'registry-committed')

    expect(readToolsView(env.db, [env.tool], env.facade.inspect)[0].drifts).toMatchObject([
      {
        skillName: 'external-recovery',
        targetPath: externalPath,
        deployment: null,
        kind: 'recovery-required',
        recovery: {
          operationId: 'manage-external-recovery',
          phase: 'registry-committed'
        }
      }
    ])
  })

  test('an invalid external identity does not block other relationships', () => {
    const env = setup()
    const invalidPath = join(env.firstRoot, 'invalid-external')
    const validPath = join(env.firstRoot, 'valid-external')
    mkdirSync(invalidPath)
    mkdirSync(validPath)
    writeFileSync(join(invalidPath, 'SKILL.md'), '---\nname: ../invalid\n---\n')
    writeFileSync(join(validPath, 'SKILL.md'), '---\nname: valid-name\n---\n')

    const drifts = readToolsView(env.db, [env.tool], env.facade.inspect)[0].drifts
    expect(drifts).toHaveLength(2)
    expect(drifts.find((item) => item.targetPath === invalidPath)).toMatchObject({
      skillName: 'invalid-external',
      kind: 'external',
      targetId: 'codex-a',
      externalError: expect.stringContaining('无法解析 Skill 身份')
    })
    expect(drifts.find((item) => item.targetPath === validPath)).toMatchObject({
      skillName: 'valid-name',
      kind: 'external',
      targetId: 'codex-a'
    })
  })
})
