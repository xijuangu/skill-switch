import { mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'vitest'
import { upsertSkill } from '../src/main/db/dao/skills'
import { getSourceByPath, upsertSource } from '../src/main/db/dao/skill-sources'
import { createDeploymentFacade } from '../src/main/services/deployment-facade'
import { hashDir } from '../src/main/services/hash'
import { createTempDb, createTempDir } from './helpers/temp'
import type { DB } from '../src/main/db/database'
import type { ToolConfig } from '../src/main/types'
import type { DeploymentMutationHooks } from '../src/main/types'
import { getDeploymentBySkillAndTargetId, upsertDeployment } from '../src/main/db/dao/deployments'
import { removeFromRegistry } from '../src/main/services/registry'
import { dirname } from 'path'

const cleanups: Array<() => void> = []

function setup() {
  const fs = createTempDir('deployment-facade-')
  const database = createTempDb()
  cleanups.push(fs.cleanup, database.cleanup)
  const canonicalRepositoryPath = join(fs.dir, 'canonical')
  const sourcePath = join(canonicalRepositoryPath, 'demo')
  const targetRoot = join(fs.dir, 'target')
  const backupsDir = join(fs.dir, 'backups')
  mkdirSync(sourcePath, { recursive: true })
  mkdirSync(targetRoot, { recursive: true })
  mkdirSync(canonicalRepositoryPath, { recursive: true })
  writeFileSync(join(sourcePath, 'SKILL.md'), '# demo')
  const skillId = upsertSkill(database.db, 'demo', sourcePath)
  upsertSource(database.db, skillId, sourcePath, hashDir(sourcePath), 0, 'central-repo', { role: 'canonical', origin: 'local' })
  const sourceId = getSourceByPath(database.db, sourcePath)!.id
  const targetId = 'target-codex'
  const tool: ToolConfig = {
    key: 'codex', displayName: 'Codex', enabled: true, paths: [targetRoot], existingPaths: [targetRoot],
    targets: [{ id: targetId, path: targetRoot }], existingTargets: [{ id: targetId, path: targetRoot }],
    isCustom: false, exists: true
  }
  let now = 1_000
  let confirmationSequence = 0
  const create = (options: {
    db?: DB
    tools?: ToolConfig[]
    platform?: { platform: string; canSymlink: boolean; canJunction: boolean }
    runMutation?: <T>(mutation: () => T) => Promise<T>
    mutationHooks?: DeploymentMutationHooks
    canonicalRepositoryPath?: string
  } = {}) => createDeploymentFacade({
    db: options.db ?? database.db,
    getRuntime: () => ({
      tools: options.tools ?? [tool],
      platform: options.platform ?? { platform: 'test', canSymlink: true, canJunction: false }
    }),
    backupsDir,
    canonicalRepositoryPath: options.canonicalRepositoryPath ?? canonicalRepositoryPath,
    now: () => now,
    createId: () => `confirmation-${++confirmationSequence}`,
    confirmationTtlMs: 100,
    runMutation: options.runMutation,
    mutationHooks: options.mutationHooks
  })
  return { ...database, skillId, sourceId, targetId, targetRoot, sourcePath, canonicalRepositoryPath, tool, create, advance: (ms: number) => { now += ms } }
}

afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

describe('Deployment Facade', () => {
  test('reports a configured-target relation as target-unconfigured after that target is removed', () => {
    const env = setup()
    const oldTargetPath = join(env.targetRoot, 'demo')
    upsertDeployment(
      env.db,
      env.skillId,
      'codex',
      oldTargetPath,
      'symlink',
      env.sourcePath,
      hashDir(env.sourcePath),
      { sourceId: env.sourceId, targetId: 'removed-codex-target' },
      'observed'
    )
    const deployment = getDeploymentBySkillAndTargetId(
      env.db,
      env.skillId,
      'removed-codex-target'
    )!

    expect(env.create().inspect(deployment.id)).toMatchObject({
      kind: 'target-unconfigured',
      targetPath: oldTargetPath,
      targetExists: false,
      deployment: {
        management: 'observed',
        target_id: 'removed-codex-target'
      }
    })
    expect(env.create().detachStaleTarget(deployment.id)).toEqual({
      status: 'completed',
      deploymentId: deployment.id
    })
    expect(getDeploymentBySkillAndTargetId(env.db, env.skillId, 'removed-codex-target')).toBeUndefined()
  })

  test('rechecks stale target configuration before metadata-only detach for managed relations', () => {
    const env = setup()
    const staleTargetId = 'removed-codex-target'
    upsertDeployment(
      env.db,
      env.skillId,
      'codex',
      join(env.targetRoot, 'demo'),
      'copy',
      env.sourcePath,
      hashDir(env.sourcePath),
      { sourceId: env.sourceId, targetId: staleTargetId },
      'managed'
    )
    const deployment = getDeploymentBySkillAndTargetId(env.db, env.skillId, staleTargetId)!
    const reconfigured = {
      ...env.tool,
      targets: [{ id: staleTargetId, path: env.targetRoot }],
      existingTargets: [{ id: staleTargetId, path: env.targetRoot }]
    }

    expect(env.create({ tools: [reconfigured] }).detachStaleTarget(deployment.id)).toMatchObject({
      status: 'rejected',
      reason: 'observation-stale'
    })
    expect(getDeploymentBySkillAndTargetId(env.db, env.skillId, staleTargetId)).toBeDefined()
    expect(env.create({ tools: [] }).detachStaleTarget(deployment.id)).toMatchObject({ status: 'completed' })
  })

  test.runIf(process.platform !== 'win32')('previews every observed subscription grouped by tool without changing links', () => {
    const env = setup()
    const targetPath = join(env.targetRoot, 'demo')
    symlinkSync(env.sourcePath, targetPath)
    upsertDeployment(
      env.db,
      env.skillId,
      'codex',
      targetPath,
      'symlink',
      env.sourcePath,
      hashDir(env.sourcePath),
      { sourceId: env.sourceId, targetId: env.targetId },
      'observed'
    )
    const observed = getDeploymentBySkillAndTargetId(env.db, env.skillId, env.targetId)!
    const agentsRoot = join(dirname(env.targetRoot), 'agents-target')
    const agentsTargetId = 'target-agents'
    mkdirSync(agentsRoot)
    symlinkSync(env.sourcePath, join(agentsRoot, 'demo'))
    upsertDeployment(
      env.db,
      env.skillId,
      'agents',
      join(agentsRoot, 'demo'),
      'symlink',
      env.sourcePath,
      hashDir(env.sourcePath),
      { sourceId: env.sourceId, targetId: agentsTargetId },
      'observed'
    )
    const agentsObserved = getDeploymentBySkillAndTargetId(env.db, env.skillId, agentsTargetId)!
    const agentsTool: ToolConfig = {
      key: 'agents', displayName: 'Agents', enabled: true,
      paths: [agentsRoot], existingPaths: [agentsRoot],
      targets: [{ id: agentsTargetId, path: agentsRoot }],
      existingTargets: [{ id: agentsTargetId, path: agentsRoot }],
      isCustom: false, exists: true
    }

    const facade = env.create({ tools: [env.tool, agentsTool] })
    expect(facade.getBulkAdoptionFacts()).toEqual({
      total: 2,
      tools: expect.arrayContaining([
        {
          targetTool: 'codex',
          targetDisplayName: 'Codex',
          items: [{ deploymentId: observed.id, skillName: 'demo', targetId: env.targetId, targetPath }]
        },
        {
          targetTool: 'agents',
          targetDisplayName: 'Agents',
          items: [{ deploymentId: agentsObserved.id, skillName: 'demo', targetId: agentsTargetId, targetPath: join(agentsRoot, 'demo') }]
        }
      ])
    })
    expect(facade.previewBulkAdoption()).toMatchObject({
      status: 'confirmation-required',
      confirmationId: 'confirmation-1',
      facts: {
        total: 2,
        tools: expect.arrayContaining([
          {
            targetTool: 'codex',
            targetDisplayName: 'Codex',
            items: [{ deploymentId: observed.id, skillName: 'demo', targetId: env.targetId, targetPath }]
          },
          {
            targetTool: 'agents',
            targetDisplayName: 'Agents',
            items: [{ deploymentId: agentsObserved.id, skillName: 'demo', targetId: agentsTargetId, targetPath: join(agentsRoot, 'demo') }]
          }
        ])
      }
    })
    expect(realpathSync(targetPath)).toBe(realpathSync(env.sourcePath))
    expect(getDeploymentBySkillAndTargetId(env.db, env.skillId, env.targetId)).toMatchObject({
      management: 'observed'
    })
    expect(getDeploymentBySkillAndTargetId(env.db, env.skillId, agentsTargetId)).toMatchObject({
      management: 'observed'
    })
  })

  test('bulk adoption facts only include observed rows whose tool key and configured target id match the runtime', () => {
    const env = setup()
    const addObserved = (name: string, targetTool: string, targetId: string) => {
      const sourcePath = join(dirname(env.canonicalRepositoryPath), 'sources', name)
      mkdirSync(sourcePath, { recursive: true })
      writeFileSync(join(sourcePath, 'SKILL.md'), `# ${name}`)
      const skillId = upsertSkill(env.db, name, sourcePath)
      upsertSource(env.db, skillId, sourcePath, hashDir(sourcePath), 0, 'indexed', { origin: 'scan' })
      const sourceId = getSourceByPath(env.db, sourcePath)!.id
      upsertDeployment(
        env.db, skillId, targetTool, join(env.targetRoot, name), 'symlink', sourcePath,
        hashDir(sourcePath), { sourceId, targetId }, 'observed'
      )
    }

    addObserved('valid', 'codex', env.targetId)
    addObserved('wrong-tool', 'agents', env.targetId)
    addObserved('unknown-target', 'codex', 'missing-target')

    const facade = env.create()
    expect(facade.getBulkAdoptionFacts()).toMatchObject({
      total: 1,
      tools: [{
        targetTool: 'codex',
        items: [{ skillName: 'valid', targetId: env.targetId, targetPath: join(env.targetRoot, 'valid') }]
      }]
    })
    expect(facade.previewBulkAdoption()).toMatchObject({
      status: 'confirmation-required',
      confirmationId: 'confirmation-1',
      facts: { total: 1 }
    })
  })

  test.runIf(process.platform !== 'win32')('bulk adoption revalidates each previewed link and reports partial success without changing files', async () => {
    const env = setup()
    const firstTarget = join(env.targetRoot, 'demo')
    symlinkSync(env.sourcePath, firstTarget)
    upsertDeployment(
      env.db, env.skillId, 'codex', firstTarget, 'symlink', env.sourcePath,
      hashDir(env.sourcePath), { sourceId: env.sourceId, targetId: env.targetId }, 'observed'
    )

    const secondSource = join(dirname(env.canonicalRepositoryPath), 'sources', 'second')
    const secondTarget = join(env.targetRoot, 'second')
    const replacement = join(dirname(env.canonicalRepositoryPath), 'sources', 'replacement')
    mkdirSync(secondSource, { recursive: true })
    mkdirSync(replacement, { recursive: true })
    writeFileSync(join(secondSource, 'SKILL.md'), '# second')
    const secondSkillId = upsertSkill(env.db, 'second', secondSource)
    upsertSource(env.db, secondSkillId, secondSource, hashDir(secondSource), 0, 'indexed', { origin: 'scan' })
    const secondSourceId = getSourceByPath(env.db, secondSource)!.id
    symlinkSync(secondSource, secondTarget)
    upsertDeployment(
      env.db, secondSkillId, 'codex', secondTarget, 'symlink', secondSource,
      hashDir(secondSource), { sourceId: secondSourceId, targetId: env.targetId }, 'observed'
    )

    const first = getDeploymentBySkillAndTargetId(env.db, env.skillId, env.targetId)!
    const second = getDeploymentBySkillAndTargetId(env.db, secondSkillId, env.targetId)!
    const facade = env.create()
    const preview = facade.previewBulkAdoption()
    if (preview.status !== 'confirmation-required') throw new Error('expected bulk adoption confirmation')
    unlinkSync(secondTarget)
    symlinkSync(replacement, secondTarget)

    expect(await facade.confirmBulkAdoption(preview.confirmationId)).toEqual({
      status: 'completed',
      total: 2,
      adopted: [{ deploymentId: first.id, skillName: 'demo', targetTool: 'codex', targetId: env.targetId, targetPath: firstTarget }],
      failed: [{
        deploymentId: second.id,
        skillName: 'second',
        targetTool: 'codex',
        targetId: env.targetId,
        targetPath: secondTarget,
        reason: 'observation-stale',
        message: '外部订阅已变化，拒绝接管。'
      }]
    })
    expect(getDeploymentBySkillAndTargetId(env.db, env.skillId, env.targetId)?.management).toBe('managed')
    expect(getDeploymentBySkillAndTargetId(env.db, secondSkillId, env.targetId)?.management).toBe('observed')
    expect(readlinkSync(firstTarget)).toBe(env.sourcePath)
    expect(readlinkSync(secondTarget)).toBe(replacement)
    expect(facade.previewBulkAdoption()).toMatchObject({
      status: 'confirmation-required',
      facts: {
        total: 1,
        tools: [{
          targetTool: 'codex',
          items: [{ deploymentId: second.id, skillName: 'second', targetId: env.targetId, targetPath: secondTarget }]
        }]
      }
    })
  })

  test.runIf(process.platform !== 'win32')('keeps observed subscriptions read-only until an exact link is explicitly adopted', async () => {
    const env = setup()
    const targetPath = join(env.targetRoot, 'demo')
    symlinkSync(env.sourcePath, targetPath)
    upsertDeployment(
      env.db,
      env.skillId,
      'codex',
      targetPath,
      'symlink',
      env.sourcePath,
      hashDir(env.sourcePath),
      { sourceId: env.sourceId, targetId: env.targetId },
      'observed'
    )
    const observed = getDeploymentBySkillAndTargetId(env.db, env.skillId, env.targetId)!
    const facade = env.create()

    expect(await facade.redeploy(observed.id)).toMatchObject({
      status: 'rejected', reason: 'observed-read-only'
    })
    expect(await facade.undeploy(observed.id)).toMatchObject({
      status: 'rejected', reason: 'observed-read-only'
    })
    expect(await facade.deploy({
      sourceId: env.sourceId,
      targetId: env.targetId,
      requestedMode: 'symlink'
    })).toMatchObject({ status: 'rejected', reason: 'observed-read-only' })
    expect(await facade.adopt(observed.id)).toMatchObject({
      status: 'completed', deploymentId: observed.id
    })
    expect(getDeploymentBySkillAndTargetId(env.db, env.skillId, env.targetId)).toMatchObject({
      management: 'managed'
    })
    expect(realpathSync(targetPath)).toBe(realpathSync(env.sourcePath))
  })

  test.runIf(process.platform !== 'win32')('rejects adoption when the observed link no longer targets its Source', async () => {
    const env = setup()
    const targetPath = join(env.targetRoot, 'demo')
    const replacement = join(env.targetRoot, 'replacement')
    mkdirSync(replacement)
    symlinkSync(env.sourcePath, targetPath)
    upsertDeployment(
      env.db,
      env.skillId,
      'codex',
      targetPath,
      'symlink',
      env.sourcePath,
      hashDir(env.sourcePath),
      { sourceId: env.sourceId, targetId: env.targetId },
      'observed'
    )
    const observed = getDeploymentBySkillAndTargetId(env.db, env.skillId, env.targetId)!
    unlinkSync(targetPath)
    symlinkSync(replacement, targetPath)

    expect(await env.create().adopt(observed.id)).toMatchObject({
      status: 'rejected', reason: 'observation-stale'
    })
    expect(getDeploymentBySkillAndTargetId(env.db, env.skillId, env.targetId)).toMatchObject({
      management: 'observed'
    })
  })
  test('redeploy of a modified managed target uses the aggregated confirmation plan', async () => {
    const env = setup()
    const facade = env.create()
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')
    writeFileSync(join(env.targetRoot, 'demo', 'SKILL.md'), '# modified target')

    const planned = await facade.redeploy(deployed.deploymentId)
    expect(planned).toMatchObject({
      status: 'confirmation-required',
      facts: { reasons: ['target-modified'], requestedMode: 'copy', actualMode: 'copy' }
    })
    if (planned.status !== 'confirmation-required') throw new Error('expected confirmation')
    expect(await facade.confirm(planned.confirmationId)).toMatchObject({ status: 'completed' })
  })

  test('redeploy restores a missing managed target without overwrite confirmation', async () => {
    const env = setup()
    const facade = env.create()
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')
    rmSync(join(env.targetRoot, 'demo'), { recursive: true, force: true })

    expect(await facade.redeploy(deployed.deploymentId)).toMatchObject({
      status: 'completed',
      deploymentId: deployed.deploymentId
    })
    expect(readFileSync(join(env.targetRoot, 'demo', 'SKILL.md'), 'utf-8')).toBe('# demo')
  })

  test('inspect, redeploy and undeploy use only the stable deployment ID', async () => {
    const env = setup()
    const facade = env.create()
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')

    expect(facade.inspect(deployed.deploymentId)).toMatchObject({ kind: 'normal', deployment: { id: deployed.deploymentId } })
    writeFileSync(join(env.sourcePath, 'SKILL.md'), '# changed')
    expect(facade.inspect(deployed.deploymentId)).toMatchObject({ kind: 'source-updated' })
    expect(await facade.redeploy(deployed.deploymentId)).toMatchObject({ status: 'completed', deploymentId: deployed.deploymentId })
    expect(facade.inspect(deployed.deploymentId)).toMatchObject({ kind: 'normal' })

    expect(await facade.undeploy(deployed.deploymentId)).toMatchObject({ status: 'completed', deploymentId: deployed.deploymentId })
    expect(facade.inspect(deployed.deploymentId)).toBeNull()
  })

  test('undeploy is frozen when the canonical Source content is missing (#91)', async () => {
    const env = setup()
    const facade = env.create()
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')
    rmSync(env.sourcePath, { recursive: true })
    expect(facade.inspect(deployed.deploymentId)).toMatchObject({ kind: 'source-missing' })
    // #91: canonical source 缺失时,undeploy 被冻结
    expect(await facade.undeploy(deployed.deploymentId))
      .toMatchObject({ status: 'rejected', reason: 'canonical-source-unavailable' })
  })

  test('inspect and mutations report recovery evidence for the deployment target', async () => {
    const env = setup()
    const facade = env.create()
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')
    const targetPath = join(env.targetRoot, 'demo')
    const markerPath = join(env.targetRoot, '.skill-switch-operation-demo-crash.json')
    writeFileSync(markerPath, JSON.stringify({
      operationId: 'crash', targetPath, markerPath,
      stagingPath: join(env.targetRoot, '.skill-switch-staging-demo-crash'),
      rollbackPath: join(env.targetRoot, '.skill-switch-rollback-demo-crash'), phase: 'switched'
    }))

    expect(facade.inspect(deployed.deploymentId)).toMatchObject({ kind: 'recovery-required', recovery: { operationId: 'crash' } })
    expect(await facade.redeploy(deployed.deploymentId)).toMatchObject({ status: 'recovery-required' })
    expect(await facade.undeploy(deployed.deploymentId)).toMatchObject({ status: 'recovery-required' })
  })

  test('redeploy and undeploy share the discovery-target lock', async () => {
    const env = setup()
    const initial = await env.create().deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (initial.status !== 'completed') throw new Error('expected deployment')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const facade = env.create({ runMutation: async (mutation) => { await gate; return mutation() } })
    const redeploy = facade.redeploy(initial.deploymentId)
    expect(await facade.undeploy(initial.deploymentId)).toMatchObject({ status: 'rejected', reason: 'target-busy' })
    release()
    expect(await redeploy).toMatchObject({ status: 'completed' })
  })

  test('registry removal cascades every filesystem mutation through the Facade', async () => {
    const env = setup()
    const facade = env.create()
    await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    const result = await removeFromRegistry(env.db, env.skillId, {
      centralSkillsDir: dirname(env.sourcePath),
      backupsDir: join(env.targetRoot, '..', 'registry-backups'),
      undeployDeployment: (deploymentId) => facade.undeploy(deploymentId),
      preflightUndeploy: (deploymentId) => facade.preflightUndeploy(deploymentId)
    })
    expect(result.undeployedTools).toEqual(['codex'])
    expect(facade.inspect(1)).toBeNull()
  })

  test('undeploy compensates before commit and reports failed compensation', async () => {
    const compensated = setup()
    const first = await compensated.create().deploy({ sourceId: compensated.sourceId, targetId: compensated.targetId, requestedMode: 'copy' })
    if (first.status !== 'completed') throw new Error('expected deployment')
    const failing = compensated.create({ mutationHooks: { afterRollback: () => { throw new Error('stop') } } })
    await expect(failing.undeploy(first.deploymentId)).rejects.toThrow('stop')
    expect(failing.inspect(first.deploymentId)).toMatchObject({ kind: 'normal' })

    const recovery = compensated.create({ mutationHooks: {
      operationId: () => 'undeploy-recovery',
      afterRollback: () => { throw new Error('stop') },
      beforeCompensate: () => { throw new Error('compensation failed') }
    } })
    expect(await recovery.undeploy(first.deploymentId)).toMatchObject({
      status: 'recovery-required', evidence: { operationId: 'undeploy-recovery' }
    })
  })

  test('deploys and updates using only source ID, target ID and requested mode', async () => {
    const env = setup()
    const facade = env.create()
    const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
    expect(await facade.deploy(request)).toMatchObject({ status: 'completed', result: { action: 'created' } })
    expect(await facade.deploy(request)).toMatchObject({ status: 'completed', result: { action: 'skipped' } })
    writeFileSync(join(env.sourcePath, 'SKILL.md'), '# changed')
    expect(await facade.deploy(request)).toMatchObject({ status: 'completed', result: { action: 'updated' } })
    expect(await facade.deploy({ ...request, requestedMode: 'symlink' })).toMatchObject({
      status: 'completed', result: { action: 'mode-switched' }
    })
  })

  test('external overwrite requires a single-use opaque confirmation ID', async () => {
    const env = setup()
    const external = join(env.targetRoot, 'demo')
    mkdirSync(external)
    writeFileSync(join(external, 'SKILL.md'), '# external')
    const facade = env.create()
    const outcome = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    expect(outcome).toMatchObject({
      status: 'confirmation-required', confirmationId: 'confirmation-1',
      facts: { targetDisplayName: 'Codex', reasons: ['external-overwrite'] }
    })
    expect(await facade.confirm('confirmation-1')).toMatchObject({
      status: 'completed', result: { action: 'external-overwritten' }
    })
    expect(await facade.confirm('confirmation-1')).toMatchObject({ status: 'rejected', reason: 'confirmation-used' })
  })

  test.runIf(process.platform !== 'win32')('a broken external symlink still requires structured overwrite confirmation', async () => {
    const env = setup()
    symlinkSync(join(env.targetRoot, 'missing-source'), join(env.targetRoot, 'demo'))
    const facade = env.create()

    const outcome = await facade.deploy({
      sourceId: env.sourceId,
      targetId: env.targetId,
      requestedMode: 'copy'
    })

    expect(outcome).toMatchObject({
      status: 'confirmation-required',
      facts: { reasons: ['external-overwrite'] }
    })
    if (outcome.status !== 'confirmation-required') throw new Error('expected confirmation')
    expect(await facade.confirm(outcome.confirmationId)).toMatchObject({
      status: 'completed',
      result: { action: 'external-overwritten', mode: 'copy' }
    })
    expect(readFileSync(join(env.targetRoot, 'demo', 'SKILL.md'), 'utf-8')).toBe('# demo')
  })

  test('aggregates external overwrite and known linked-to-copy degradation in one confirmation', async () => {
    const env = setup()
    const external = join(env.targetRoot, 'demo')
    mkdirSync(external)
    writeFileSync(join(external, 'SKILL.md'), '# external')
    const facade = env.create({ platform: { platform: 'test', canSymlink: false, canJunction: false } })

    const outcome = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'symlink' })

    expect(outcome).toMatchObject({
      status: 'confirmation-required',
      facts: {
        targetDisplayName: 'Codex',
        requestedMode: 'symlink',
        actualMode: 'copy',
        reasons: ['external-overwrite', 'mode-degraded'],
        backup: { required: true }
      }
    })
    expect(readFileSync(join(external, 'SKILL.md'), 'utf-8')).toBe('# external')
    if (outcome.status !== 'confirmation-required') throw new Error('expected confirmation')
    expect(await facade.confirm(outcome.confirmationId)).toMatchObject({
      status: 'completed', result: { mode: 'copy', degradedFrom: 'symlink' }
    })
  })

  test('managed target modification is a stable confirmation risk', async () => {
    const env = setup()
    const facade = env.create()
    const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
    await facade.deploy(request)
    writeFileSync(join(env.targetRoot, 'demo', 'SKILL.md'), '# changed outside')

    const outcome = await facade.deploy(request)

    expect(outcome).toMatchObject({
      status: 'confirmation-required',
      facts: { reasons: ['target-modified'], requestedMode: 'copy', actualMode: 'copy' }
    })
  })

  test('new risk invalidates a confirmation that was issued for a smaller plan', async () => {
    const env = setup()
    const facade = env.create({ platform: { platform: 'test', canSymlink: false, canJunction: false } })
    const confirmation = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'symlink' })
    if (confirmation.status !== 'confirmation-required') throw new Error('expected confirmation')
    mkdirSync(join(env.targetRoot, 'demo'))
    writeFileSync(join(env.targetRoot, 'demo', 'SKILL.md'), '# appeared later')

    expect(await facade.confirm(confirmation.confirmationId)).toMatchObject({
      status: 'rejected', reason: 'plan-changed'
    })
  })

  test.each(['symlink', 'junction'] as const)(
    '%s junction runtime failure compensates staging and returns a fresh copy-degradation confirmation', async (requestedMode) => {
      const env = setup()
      const facade = env.create({
        platform: { platform: 'test', canSymlink: false, canJunction: true },
        mutationHooks: {
          operationId: () => 'junction-failure',
          beforeJunctionStage: () => { throw new Error('junction unavailable at runtime') }
        }
      })

      const outcome = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode })

      expect(outcome).toMatchObject({
        status: 'confirmation-required',
        facts: { reasons: ['mode-degraded'], requestedMode, actualMode: 'copy' }
      })
      expect(readdirSync(env.targetRoot).filter((name) => name.startsWith('.skill-switch-'))).toEqual([])
      if (outcome.status !== 'confirmation-required') throw new Error('expected confirmation')
      expect(await facade.confirm(outcome.confirmationId)).toMatchObject({
        status: 'completed', result: { mode: 'copy', degradedFrom: requestedMode }
      })
    }
  )

  test('a confirmed runtime junction fallback executes copy without retrying junction', async () => {
    const env = setup()
    let attempts = 0
    const facade = env.create({
      platform: { platform: 'test', canSymlink: false, canJunction: true },
      mutationHooks: {
        beforeJunctionStage: () => {
          attempts++
          if (attempts === 1) throw new Error('junction failed once')
        }
      }
    })

    const planned = await facade.deploy({
      sourceId: env.sourceId,
      targetId: env.targetId,
      requestedMode: 'symlink'
    })
    expect(planned).toMatchObject({
      status: 'confirmation-required',
      facts: { requestedMode: 'symlink', actualMode: 'copy', reasons: ['mode-degraded'] }
    })
    if (planned.status !== 'confirmation-required') throw new Error('expected confirmation')

    expect(await facade.confirm(planned.confirmationId)).toMatchObject({
      status: 'completed',
      result: { mode: 'copy', degradedFrom: 'symlink' }
    })
    expect(attempts).toBe(1)
  })

  test('expired, restarted and changed confirmations are structured rejections', async () => {
    const env = setup()
    const external = join(env.targetRoot, 'demo')
    mkdirSync(external)
    writeFileSync(join(external, 'SKILL.md'), '# external')
    const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
    const expired = env.create()
    await expired.deploy(request)
    env.advance(101)
    expect(await expired.confirm('confirmation-1')).toMatchObject({ status: 'rejected', reason: 'confirmation-expired' })
    expect(await env.create().confirm('confirmation-1')).toMatchObject({ status: 'rejected', reason: 'confirmation-invalid' })
    const changed = env.create()
    const changedConfirmation = await changed.deploy(request)
    if (changedConfirmation.status !== 'confirmation-required') throw new Error('expected confirmation')
    writeFileSync(join(external, 'SKILL.md'), '# changed externally')
    expect(await changed.confirm(changedConfirmation.confirmationId)).toMatchObject({ status: 'rejected', reason: 'plan-changed' })
  })

  test('same-target deploy/deploy returns target-busy without queueing', async () => {
    const env = setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const facade = env.create({ runMutation: async (mutation) => { await gate; return mutation() } })
    const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
    const first = facade.deploy(request)
    expect(await facade.deploy(request)).toMatchObject({ status: 'rejected', reason: 'target-busy' })
    release()
    expect(await first).toMatchObject({ status: 'completed' })
  })

  test('deploy/confirm share a lock and a busy confirm does not consume its ID', async () => {
    const env = setup()
    const external = join(env.targetRoot, 'demo')
    mkdirSync(external)
    writeFileSync(join(external, 'SKILL.md'), '# external')
    let blocked = false
    let release!: () => void
    let gate = Promise.resolve()
    const facade = env.create({
      runMutation: async (mutation) => { if (blocked) await gate; return mutation() }
    })
    const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
    const confirmation = await facade.deploy(request)
    expect(confirmation.status).toBe('confirmation-required')
    blocked = true
    gate = new Promise<void>((resolve) => { release = resolve })
    const deploy = facade.deploy(request)
    expect(await facade.confirm('confirmation-1')).toMatchObject({ status: 'rejected', reason: 'target-busy' })
    release()
    await deploy
    blocked = false
    expect(await facade.confirm('confirmation-1')).toMatchObject({ status: 'completed' })
  })

  test('confirm/confirm returns target-busy to the second caller', async () => {
    const env = setup()
    const external = join(env.targetRoot, 'demo')
    mkdirSync(external)
    writeFileSync(join(external, 'SKILL.md'), '# external')
    let blocked = false
    let release!: () => void
    let gate = Promise.resolve()
    const facade = env.create({ runMutation: async (mutation) => { if (blocked) await gate; return mutation() } })
    await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    blocked = true
    gate = new Promise<void>((resolve) => { release = resolve })
    const first = facade.confirm('confirmation-1')
    expect(await facade.confirm('confirmation-1')).toMatchObject({ status: 'rejected', reason: 'target-busy' })
    release()
    expect(await first).toMatchObject({ status: 'completed' })
  })

  test('different discovery targets can hold mutations concurrently', async () => {
    const env = setup()
    const secondRoot = join(env.targetRoot, '..', 'target-2')
    mkdirSync(secondRoot)
    const tools: ToolConfig[] = [{
      key: 'codex', displayName: 'Codex', enabled: true,
      paths: [env.targetRoot, secondRoot], existingPaths: [env.targetRoot, secondRoot],
      targets: [{ id: env.targetId, path: env.targetRoot }, { id: 'target-2', path: secondRoot }],
      existingTargets: [{ id: env.targetId, path: env.targetRoot }, { id: 'target-2', path: secondRoot }],
      isCustom: false, exists: true
    }]
    let entered = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const facade = env.create({ tools, runMutation: async (mutation) => { entered += 1; await gate; return mutation() } })
    const first = facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    const second = facade.deploy({ sourceId: env.sourceId, targetId: 'target-2', requestedMode: 'copy' })
    await Promise.resolve()
    expect(entered).toBe(2)
    release()
    expect((await first).status).toBe('completed')
    expect((await second).status).toBe('completed')
  })

  test('target lock is released after unexpected exceptions', async () => {
    const env = setup()
    let fail = true
    const facade = env.create({ runMutation: async (mutation) => {
      if (fail) { fail = false; throw new Error('boom') }
      return mutation()
    } })
    const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
    await expect(facade.deploy(request)).rejects.toThrow('boom')
    expect(await facade.deploy(request)).toMatchObject({ status: 'completed' })
  })

  test.each(['afterStaging', 'afterMarker', 'afterRollback', 'afterSwitch', 'beforeManifest'] as const)(
    'failure at %s restores the old target and manifest without transaction artifacts',
    async (failurePoint) => {
      const env = setup()
      const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
      await env.create().deploy(request)
      const targetPath = join(env.targetRoot, 'demo')
      const before = getDeploymentBySkillAndTargetId(env.db, env.skillId, env.targetId)!
      writeFileSync(join(env.sourcePath, 'SKILL.md'), '# new source')
      const hooks: DeploymentMutationHooks = {
        operationId: () => `fail-${failurePoint}`,
        [failurePoint]: () => { throw new Error(`fail ${failurePoint}`) }
      }
      await expect(env.create({ mutationHooks: hooks }).deploy(request)).rejects.toThrow(`fail ${failurePoint}`)
      expect(readFileSync(join(targetPath, 'SKILL.md'), 'utf-8')).toBe('# demo')
      expect(getDeploymentBySkillAndTargetId(env.db, before.skill_id, env.targetId)).toEqual(before)
      expect(readdirSync(env.targetRoot).filter((name) => name.startsWith('.skill-switch-'))).toEqual([])
    }
  )

  test('compensation failure returns recovery-required and later deploy diagnoses the evidence', async () => {
    const env = setup()
    const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
    await env.create().deploy(request)
    writeFileSync(join(env.sourcePath, 'SKILL.md'), '# new source')
    const failed = await env.create({ mutationHooks: {
      operationId: () => 'recovery-case',
      afterSwitch: () => { throw new Error('switch failed') },
      beforeCompensate: () => { throw new Error('compensation failed') }
    } }).deploy(request)
    expect(failed).toMatchObject({
      status: 'recovery-required',
      evidence: { operationId: 'recovery-case', phase: 'switched' }
    })
    expect(await env.create().deploy(request)).toMatchObject({
      status: 'recovery-required',
      evidence: { operationId: 'recovery-case' }
    })
  })

  test('backup-stage failure leaves external target intact and removes transaction artifacts', async () => {
    const env = setup()
    const targetPath = join(env.targetRoot, 'demo')
    mkdirSync(targetPath)
    writeFileSync(join(targetPath, 'SKILL.md'), '# external')
    const request = { sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' as const }
    const hooks: DeploymentMutationHooks = { operationId: () => 'backup-failure' }
    const planner = env.create({ mutationHooks: hooks })
    const confirmation = await planner.deploy(request)
    if (confirmation.status !== 'confirmation-required') throw new Error('expected confirmation')

    hooks.afterBackup = () => { throw new Error('backup stage failed') }
    await expect(planner.confirm(confirmation.confirmationId)).rejects.toThrow('backup stage failed')
    expect(readFileSync(join(targetPath, 'SKILL.md'), 'utf-8')).toBe('# external')
    expect(readdirSync(env.targetRoot).filter((name) => name.startsWith('.skill-switch-'))).toEqual([])
  })

  test('#89 inspect reports bidirectional drift when both source and copy target have changed', async () => {
    const env = setup()
    const facade = env.create()
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')

    // 双向变化:source 和 target 都改了,且内容不同
    writeFileSync(join(env.sourcePath, 'SKILL.md'), '# source changed')
    writeFileSync(join(env.targetRoot, 'demo', 'SKILL.md'), '# target changed')

    expect(facade.inspect(deployed.deploymentId)).toMatchObject({ kind: 'bidirectional' })
  })

  test('#89 bidirectional drift requires confirmation without choosing a direction', async () => {
    const env = setup()
    const facade = env.create()
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')

    writeFileSync(join(env.sourcePath, 'SKILL.md'), '# source changed')
    writeFileSync(join(env.targetRoot, 'demo', 'SKILL.md'), '# target changed')

    const planned = await facade.redeploy(deployed.deploymentId)
    expect(planned).toMatchObject({
      status: 'confirmation-required',
      facts: { reasons: ['bidirectional'] }
    })
  })

  test('#89 adopts a modified copy target as a Candidate Source without overwriting it', async () => {
    const env = setup()
    const facade = env.create()
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')
    writeFileSync(join(env.targetRoot, 'demo', 'SKILL.md'), '# target modified')

    const result = await facade.adoptTargetAsCandidate(deployed.deploymentId)

    expect(result).toMatchObject({ status: 'adopted', deploymentId: deployed.deploymentId })
    if (result.status !== 'adopted') throw new Error('expected adopted')
    // 新 Candidate Source 已注册
    const candidate = getSourceByPath(env.db, result.candidateSourcePath)!
    expect(candidate).toBeDefined()
    expect(candidate.source_role).toBe('candidate')
    expect(candidate.skill_id).toBe(env.skillId)
    expect(readFileSync(join(result.candidateSourcePath, 'SKILL.md'), 'utf8')).toBe('# target modified')
    // 原目标未被覆盖,仍保留修改后内容
    expect(readFileSync(join(env.targetRoot, 'demo', 'SKILL.md'), 'utf8')).toBe('# target modified')
  })

  test('#91 freezes deployment mutations when canonical Source is missing', async () => {
    const env = setup()
    const facade = env.create()
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')
    // 在 canonical repository 内创建 canonical source,随后删除触发冻结
    const canonicalPath = join(env.canonicalRepositoryPath, 'demo')
    mkdirSync(canonicalPath, { recursive: true })
    writeFileSync(join(canonicalPath, 'SKILL.md'), '# canonical')
    upsertSource(env.db, env.skillId, canonicalPath, hashDir(canonicalPath), 0, 'central-repo', { role: 'canonical', origin: 'local' })
    rmSync(canonicalPath, { recursive: true, force: true })

    // deploy / redeploy / undeploy / adoptTargetAsCandidate 均被冻结
    expect(await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' }))
      .toMatchObject({ status: 'rejected', reason: 'canonical-source-unavailable' })
    expect(await facade.redeploy(deployed.deploymentId))
      .toMatchObject({ status: 'rejected', reason: 'canonical-source-unavailable' })
    expect(await facade.undeploy(deployed.deploymentId))
      .toMatchObject({ status: 'rejected', reason: 'canonical-source-unavailable' })
    expect(await facade.adoptTargetAsCandidate(deployed.deploymentId))
      .toMatchObject({ status: 'rejected', reason: 'canonical-source-unavailable' })
    // 只读 inspect 不受 freeze 影响,仍可正常返回 drift 状态
    expect(facade.inspect(deployed.deploymentId)).not.toBeNull()
  })

  test('#91 freezes confirm when canonical Source becomes unavailable after preview', async () => {
    const env = setup()
    const facade = env.create()
    const targetPath = join(env.targetRoot, 'demo')
    mkdirSync(targetPath)
    writeFileSync(join(targetPath, 'SKILL.md'), '# external')
    const confirmation = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (confirmation.status !== 'confirmation-required') throw new Error('expected confirmation')

    // 创建 canonical source 后删除,触发冻结
    const canonicalPath = join(env.canonicalRepositoryPath, 'demo')
    mkdirSync(canonicalPath, { recursive: true })
    writeFileSync(join(canonicalPath, 'SKILL.md'), '# canonical')
    upsertSource(env.db, env.skillId, canonicalPath, hashDir(canonicalPath), 0, 'central-repo', { role: 'canonical', origin: 'local' })
    rmSync(canonicalPath, { recursive: true, force: true })

    expect(await facade.confirm(confirmation.confirmationId))
      .toMatchObject({ status: 'rejected', reason: 'canonical-source-unavailable' })
  })

  test('#91 does not freeze mutations when skill has no canonical Source', async () => {
    const env = setup()
    const facade = env.create()
    // 创建一个没有 canonical source 的 candidate-only skill
    const candidatePath = join(dirname(env.canonicalRepositoryPath), 'candidate-only', 'demo')
    mkdirSync(candidatePath, { recursive: true })
    writeFileSync(join(candidatePath, 'SKILL.md'), '# candidate only')
    const candidateSkillId = upsertSkill(env.db, 'candidate-only', candidatePath)
    upsertSource(env.db, candidateSkillId, candidatePath, hashDir(candidatePath), 0, 'indexed', { origin: 'scan' })
    const candidateSourceId = getSourceByPath(env.db, candidatePath)!.id
    // #92: candidate source 无法部署,但拒绝原因是 source-not-canonical 而非 canonical-source-unavailable
    // 这证明 #91 freeze 未触发(没有 canonical source 时不冻结)
    expect(await facade.deploy({ sourceId: candidateSourceId, targetId: env.targetId, requestedMode: 'copy' }))
      .toMatchObject({ status: 'rejected', reason: 'source-not-canonical' })
  })

  test('#92 rejects deploy from a Candidate Source', async () => {
    const env = setup()
    const facade = env.create()
    // 创建一个 candidate source(在 canonical repository 之外)
    const candidatePath = join(dirname(env.canonicalRepositoryPath), 'candidates', 'demo')
    mkdirSync(candidatePath, { recursive: true })
    writeFileSync(join(candidatePath, 'SKILL.md'), '# candidate')
    upsertSource(env.db, env.skillId, candidatePath, hashDir(candidatePath), 0, 'indexed', { origin: 'scan' })
    const candidateSourceId = getSourceByPath(env.db, candidatePath)!.id

    expect(await facade.deploy({ sourceId: candidateSourceId, targetId: env.targetId, requestedMode: 'copy' }))
      .toMatchObject({ status: 'rejected', reason: 'source-not-canonical' })
  })

  test('#92 rejects redeploy of a deployment whose Source is Candidate', async () => {
    const env = setup()
    const facade = env.create()
    // 先用 canonical source 创建部署
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')
    // 将 source 的 role 降级为 candidate(模拟 legacy 部署)
    env.db.prepare("UPDATE skill_sources SET source_role = 'candidate' WHERE id = ?").run(env.sourceId)

    expect(await facade.redeploy(deployed.deploymentId))
      .toMatchObject({ status: 'rejected', reason: 'source-not-canonical' })
  })

  test('#92 allows deploy from a Canonical Source', async () => {
    const env = setup()
    const facade = env.create()
    // setup() 已将 source 创建在 canonical repository 内,role 自动为 canonical
    const result = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    expect(result.status).toBe('completed')
  })
})
