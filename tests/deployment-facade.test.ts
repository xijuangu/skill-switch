import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
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
import { getDeploymentBySkillAndTargetId } from '../src/main/db/dao/deployments'

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
    runMutation?: <T>(mutation: () => T) => Promise<T>
    mutationHooks?: DeploymentMutationHooks
  } = {}) => createDeploymentFacade({
    db: options.db ?? database.db,
    getRuntime: () => ({ tools: options.tools ?? [tool], platform: { platform: 'test', canSymlink: true, canJunction: false } }),
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
      facts: { targetPath: external, reason: 'external-overwrite' }
    })
    expect(await facade.confirm('confirmation-1')).toMatchObject({
      status: 'completed', result: { action: 'external-overwritten' }
    })
    expect(await facade.confirm('confirmation-1')).toMatchObject({ status: 'rejected', reason: 'confirmation-used' })
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
