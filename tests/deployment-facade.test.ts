import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
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
  let confirmationSequence = 0
  const create = (options: {
    db?: DB
    tools?: ToolConfig[]
    platform?: { platform: string; canSymlink: boolean; canJunction: boolean }
    runMutation?: <T>(mutation: () => T) => Promise<T>
    mutationHooks?: DeploymentMutationHooks
  } = {}) => createDeploymentFacade({
    db: options.db ?? database.db,
    getRuntime: () => ({
      tools: options.tools ?? [tool],
      platform: options.platform ?? { platform: 'test', canSymlink: true, canJunction: false }
    }),
    backupsDir,
    now: () => now,
    createId: () => `confirmation-${++confirmationSequence}`,
    confirmationTtlMs: 100,
    runMutation: options.runMutation,
    mutationHooks: options.mutationHooks
  })
  return { ...database, skillId, sourceId, targetId, targetRoot, sourcePath, create, advance: (ms: number) => { now += ms } }
}

afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

describe('Deployment Facade', () => {
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

  test('undeploy remains available when the Source content is missing', async () => {
    const env = setup()
    const facade = env.create()
    const deployed = await facade.deploy({ sourceId: env.sourceId, targetId: env.targetId, requestedMode: 'copy' })
    if (deployed.status !== 'completed') throw new Error('expected deployment')
    rmSync(env.sourcePath, { recursive: true })
    expect(facade.inspect(deployed.deploymentId)).toMatchObject({ kind: 'source-missing' })
    expect(await facade.undeploy(deployed.deploymentId)).toMatchObject({ status: 'completed' })
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
      undeployDeployment: (deploymentId) => facade.undeploy(deploymentId)
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
})
