import { describe, expect, test, vi } from 'vitest'
import { createBulkMutationFacade } from '../src/main/services/bulk-mutation-facade'

describe('BulkMutationFacade', () => {
  test('preserves item order and reports mixed deploy outcomes without aborting later items', async () => {
    const deploy = vi.fn()
      .mockResolvedValueOnce({ status: 'completed', deploymentId: 11, result: {} })
      .mockResolvedValueOnce({ status: 'confirmation-required', confirmationId: 'confirm-2', facts: {} })
      .mockResolvedValueOnce({ status: 'recovery-required', message: 'manual recovery', evidence: {} })
    const facade = createBulkMutationFacade({
      deploy,
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
      .mockRejectedValueOnce(new Error('observed relationship'))
      .mockResolvedValueOnce({ skillName: 'two', backedUp: false, undeployedTools: [] })
    const facade = createBulkMutationFacade({
      deploy: vi.fn(),
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
})
