import { describe, expect, test, vi } from 'vitest'
import { createBulkMutationFacade } from '../src/main/services/bulk-mutation-facade'
import { RegistryMutationRejectedError, RegistryRecoveryRequiredError } from '../src/main/services/registry'

describe('BulkMutationFacade', () => {
  test('preserves item order and reports mixed deploy outcomes without aborting later items', async () => {
    const deploy = vi.fn()
      .mockResolvedValueOnce({ status: 'completed', deploymentId: 11, result: {} })
      .mockResolvedValueOnce({ status: 'confirmation-required', confirmationId: 'confirm-2', facts: {} })
      .mockResolvedValueOnce({ status: 'recovery-required', message: 'manual recovery', evidence: {} })
    const facade = createBulkMutationFacade({
      deploy,
      confirmDeploy: vi.fn(),
      undeploy: vi.fn(),
      removeFromRegistry: vi.fn()
    })

    const result = await facade.deploy([
      { key: 'one', sourceId: 1, targetId: 'codex', requestedMode: 'symlink' },
      { key: 'two', sourceId: 2, targetId: 'trae', requestedMode: 'symlink' },
      { key: 'three', sourceId: 3, targetId: 'agents', requestedMode: 'copy' }
    ])

    expect(result.items.map((item) => [item.key, item.status])).toEqual([
      ['one', 'completed'],
      ['two', 'confirmation-required'],
      ['three', 'recovery-required']
    ])
    expect(result.completed).toBe(1)
    expect(result.failed).toBe(2)
  })

  test('contains thrown remove failures per item so retry can submit only failed keys', async () => {
    const removeFromRegistry = vi.fn()
      .mockRejectedValueOnce(new RegistryMutationRejectedError('observed relationship'))
      .mockResolvedValueOnce({ skillName: 'two', backedUp: false, undeployedTools: [] })
    const facade = createBulkMutationFacade({
      deploy: vi.fn(),
      confirmDeploy: vi.fn(),
      undeploy: vi.fn(),
      removeFromRegistry
    })

    const result = await facade.remove([
      { key: 'skill-1', skillId: 1 },
      { key: 'skill-2', skillId: 2 }
    ])

    expect(result.items).toMatchObject([
      { key: 'skill-1', status: 'rejected', message: 'observed relationship' },
      { key: 'skill-2', status: 'completed' }
    ])
  })

  test('reports undeploy rejection and continues with remaining deployments', async () => {
    const undeploy = vi.fn()
      .mockResolvedValueOnce({ status: 'rejected', reason: 'target-busy', message: 'busy' })
      .mockResolvedValueOnce({ status: 'completed', deploymentId: 8 })
    const facade = createBulkMutationFacade({
      deploy: vi.fn(),
      confirmDeploy: vi.fn(),
      undeploy,
      removeFromRegistry: vi.fn()
    })

    const result = await facade.undeploy([
      { key: 'dep-7', deploymentId: 7 },
      { key: 'dep-8', deploymentId: 8 }
    ])

    expect(result.items.map((item) => item.status)).toEqual(['rejected', 'completed'])
    expect(undeploy).toHaveBeenCalledTimes(2)
  })

  test('confirms pending deploy items and lets unexpected faults abort the batch', async () => {
    const confirmDeploy = vi.fn().mockResolvedValue({ status: 'completed', deploymentId: 9, result: {} })
    const facade = createBulkMutationFacade({
      deploy: vi.fn(),
      confirmDeploy,
      undeploy: vi.fn(),
      removeFromRegistry: vi.fn().mockRejectedValue(new Error('database corrupted'))
    })

    await expect(facade.confirmDeploy([{ key: 'one', confirmationId: 'confirm-1' }]))
      .resolves.toMatchObject({ completed: 1 })
    expect(confirmDeploy).toHaveBeenCalledWith('confirm-1')
    await expect(facade.remove([{ key: 'one', skillId: 1 }])).rejects.toThrow('database corrupted')
  })

  test('records an ordinary filesystem failure per item and continues the batch', async () => {
    const missing = Object.assign(new Error('target disappeared'), { code: 'ENOENT' })
    const deploy = vi.fn()
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({ status: 'completed', deploymentId: 2, result: {} })
    const facade = createBulkMutationFacade({
      deploy,
      confirmDeploy: vi.fn(),
      undeploy: vi.fn(),
      removeFromRegistry: vi.fn()
    })

    await expect(facade.deploy([
      { key: 'one', sourceId: 1, targetId: 'one', requestedMode: 'symlink' },
      { key: 'two', sourceId: 2, targetId: 'two', requestedMode: 'symlink' }
    ])).resolves.toMatchObject({
      items: [
        { key: 'one', status: 'rejected', message: 'target disappeared' },
        { key: 'two', status: 'completed' }
      ]
    })
    expect(deploy).toHaveBeenCalledTimes(2)
  })

  test('preserves registry recovery evidence and stops later destructive removals', async () => {
    const evidence = {
      operationId: 'op-1',
      targetPath: '/target',
      markerPath: '/marker',
      stagingPath: '/stage',
      rollbackPath: '/rollback',
      phase: 'compensation-failed'
    }
    const removeFromRegistry = vi.fn()
      .mockRejectedValueOnce(new RegistryRecoveryRequiredError('manual recovery', evidence))
      .mockResolvedValueOnce({ skillName: 'two', backedUp: false, undeployedTools: [] })
    const facade = createBulkMutationFacade({
      deploy: vi.fn(),
      confirmDeploy: vi.fn(),
      undeploy: vi.fn(),
      removeFromRegistry
    })

    await expect(facade.remove([
      { key: 'one', skillId: 1 },
      { key: 'two', skillId: 2 }
    ])).resolves.toMatchObject({
      items: [
        { key: 'one', status: 'recovery-required', outcome: { evidence } },
        { key: 'two', status: 'rejected', message: '前一项需要人工恢复，本项未执行。' }
      ]
    })
    expect(removeFromRegistry).toHaveBeenCalledTimes(1)
  })
})
