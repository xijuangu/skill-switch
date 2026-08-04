import type {
  DeploymentMutationOutcome,
  DeploymentOutcome,
  DeploymentRequest,
  ExternalManagementOutcome
} from './deployment-facade'
import {
  RegistryMutationRejectedError,
  RegistryRecoveryRequiredError,
  type RemoveFromRegistryResult
} from './registry'

export type BulkItemStatus =
  | 'completed'
  | 'confirmation-required'
  | 'rejected'
  | 'recovery-required'

export interface BulkMutationItem {
  key: string
  status: BulkItemStatus
  message?: string
  outcome?: DeploymentOutcome | DeploymentMutationOutcome | ExternalManagementOutcome | RemoveFromRegistryResult
}

export interface BulkMutationResult {
  total: number
  completed: number
  failed: number
  items: BulkMutationItem[]
}

export interface BulkDeployRequest extends DeploymentRequest {
  key: string
}

export interface BulkUndeployRequest {
  key: string
  deploymentId: number
}

export interface BulkRemoveRequest {
  key: string
  skillId: number
}

export interface BulkExternalManagementRequest {
  key: string
  targetId: string
  entryName: string
}

interface BulkMutationDependencies {
  deploy: (request: DeploymentRequest) => Promise<DeploymentOutcome>
  confirmDeploy: (confirmationId: string) => Promise<DeploymentOutcome>
  undeploy: (deploymentId: number) => Promise<DeploymentMutationOutcome>
  removeFromRegistry: (skillId: number, ignoreSourcePaths?: boolean) => Promise<RemoveFromRegistryResult>
  detachRegistration?: (deploymentId: number) => Promise<DeploymentMutationOutcome>
  manageExternal?: (request: { targetId: string; entryName: string }) => Promise<ExternalManagementOutcome>
}

function summarize(items: BulkMutationItem[]): BulkMutationResult {
  const completed = items.filter((item) => item.status === 'completed').length
  return {
    total: items.length,
    completed,
    failed: items.length - completed,
    items
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPerItemOperationalError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' &&
    ['ENOENT', 'EEXIST', 'EACCES', 'EPERM', 'ENOTEMPTY', 'EXDEV'].includes(code)
}

export function createBulkMutationFacade(deps: BulkMutationDependencies) {
  async function deploy(requests: BulkDeployRequest[]): Promise<BulkMutationResult> {
    const items: BulkMutationItem[] = []
    for (const { key, ...request } of requests) {
      try {
        const outcome = await deps.deploy(request)
        items.push({
          key,
          status: outcome.status,
          ...('message' in outcome ? { message: outcome.message } : {}),
          outcome
        })
      } catch (error) {
        if (!isPerItemOperationalError(error)) throw error
        items.push({ key, status: 'rejected', message: messageOf(error) })
      }
    }
    return summarize(items)
  }

  async function confirmDeploy(requests: Array<{ key: string; confirmationId: string }>): Promise<BulkMutationResult> {
    const items: BulkMutationItem[] = []
    for (const request of requests) {
      try {
        const outcome = await deps.confirmDeploy(request.confirmationId)
        items.push({
          key: request.key,
          status: outcome.status,
          ...('message' in outcome ? { message: outcome.message } : {}),
          outcome
        })
      } catch (error) {
        if (!isPerItemOperationalError(error)) throw error
        items.push({ key: request.key, status: 'rejected', message: messageOf(error) })
      }
    }
    return summarize(items)
  }

  async function undeploy(requests: BulkUndeployRequest[]): Promise<BulkMutationResult> {
    const items: BulkMutationItem[] = []
    for (const request of requests) {
      try {
        const outcome = await deps.undeploy(request.deploymentId)
        items.push({
          key: request.key,
          status: outcome.status,
          ...('message' in outcome ? { message: outcome.message } : {}),
          outcome
        })
      } catch (error) {
        if (!isPerItemOperationalError(error)) throw error
        items.push({ key: request.key, status: 'rejected', message: messageOf(error) })
      }
    }
    return summarize(items)
  }

  async function remove(requests: BulkRemoveRequest[], ignoreSourcePaths?: boolean): Promise<BulkMutationResult> {
    const items: BulkMutationItem[] = []
    for (const [index, request] of requests.entries()) {
      try {
        const outcome = await deps.removeFromRegistry(request.skillId, ignoreSourcePaths)
        items.push({ key: request.key, status: 'completed', outcome })
      } catch (error) {
        if (error instanceof RegistryRecoveryRequiredError) {
          items.push({
            key: request.key,
            status: 'recovery-required',
            message: error.message,
            outcome: {
              status: 'recovery-required',
              message: error.message,
              evidence: error.evidence
            }
          })
          items.push(...requests.slice(index + 1).map((pending) => ({
            key: pending.key,
            status: 'rejected' as const,
            message: '前一项需要人工恢复，本项未执行。'
          })))
          break
        }
        if (!(error instanceof RegistryMutationRejectedError)) throw error
        items.push({ key: request.key, status: 'rejected', message: messageOf(error) })
      }
    }
    return summarize(items)
  }

  async function detach(requests: BulkUndeployRequest[]): Promise<BulkMutationResult> {
    if (!deps.detachRegistration) throw new Error('bulk detach is unavailable')
    const items: BulkMutationItem[] = []
    for (const request of requests) {
      const outcome = await deps.detachRegistration(request.deploymentId)
      items.push({
        key: request.key,
        status: outcome.status,
        ...('message' in outcome ? { message: outcome.message } : {}),
        outcome
      })
    }
    return summarize(items)
  }

  async function manageExternal(
    requests: BulkExternalManagementRequest[]
  ): Promise<BulkMutationResult> {
    if (!deps.manageExternal) throw new Error('bulk external management is unavailable')
    const items: BulkMutationItem[] = []
    for (const { key, ...request } of requests) {
      try {
        const outcome = await deps.manageExternal(request)
        items.push({
          key,
          status: outcome.status,
          ...('message' in outcome ? { message: outcome.message } : {}),
          outcome
        })
      } catch (error) {
        if (!isPerItemOperationalError(error)) throw error
        items.push({ key, status: 'rejected', message: messageOf(error) })
      }
    }
    return summarize(items)
  }

  return { deploy, confirmDeploy, undeploy, remove, detach, manageExternal }
}
