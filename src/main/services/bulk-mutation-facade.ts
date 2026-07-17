import type {
  DeploymentMutationOutcome,
  DeploymentOutcome,
  DeploymentRequest
} from './deployment-facade'
import type { RemoveFromRegistryResult } from './registry'

export type BulkItemStatus =
  | 'completed'
  | 'confirmation-required'
  | 'rejected'
  | 'recovery-required'

export interface BulkMutationItem {
  key: string
  status: BulkItemStatus
  message?: string
  outcome?: unknown
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

interface BulkMutationDependencies {
  deploy: (request: DeploymentRequest) => Promise<DeploymentOutcome>
  undeploy: (deploymentId: number) => Promise<DeploymentMutationOutcome>
  removeFromRegistry: (skillId: number) => Promise<RemoveFromRegistryResult>
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
        items.push({ key, status: 'rejected', message: messageOf(error) })
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
        items.push({ key: request.key, status: 'rejected', message: messageOf(error) })
      }
    }
    return summarize(items)
  }

  async function remove(requests: BulkRemoveRequest[]): Promise<BulkMutationResult> {
    const items: BulkMutationItem[] = []
    for (const request of requests) {
      try {
        const outcome = await deps.removeFromRegistry(request.skillId)
        items.push({ key: request.key, status: 'completed', outcome })
      } catch (error) {
        items.push({ key: request.key, status: 'rejected', message: messageOf(error) })
      }
    }
    return summarize(items)
  }

  return { deploy, undeploy, remove }
}
