import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import type { DB } from '../db/database'
import { getDeploymentBySkillAndTargetId } from '../db/dao/deployments'
import { getSourceById } from '../db/dao/skill-sources'
import { getSkillById } from '../db/dao/skills'
import type { DeployMode, DeployResult, PlatformInfo, ToolConfig } from '../types'
import { deploySkill } from './deployer'
import { hashDir } from './hash'
import { resolveWithin, validateSkillName } from './path-safety'

export interface DeploymentRequest {
  sourceId: number
  targetId: string
  requestedMode: DeployMode
}

export type DeploymentOutcome =
  | { status: 'completed'; deploymentId: number; result: DeployResult }
  | {
      status: 'confirmation-required'
      confirmationId: string
      expiresAt: number
      facts: { skillName: string; targetPath: string; reason: 'external-overwrite' }
    }
  | {
      status: 'rejected'
      reason: 'confirmation-expired' | 'confirmation-used' | 'confirmation-invalid' | 'plan-changed' | 'target-busy'
      message: string
    }

interface Runtime {
  tools: ToolConfig[]
  platform: PlatformInfo
}

interface ConfirmationPlan extends DeploymentRequest {
  expiresAt: number
  sourcePath: string
  sourceHash: string
  targetPath: string
  targetHash: string
}

export interface DeploymentFacade {
  deploy(request: DeploymentRequest): Promise<DeploymentOutcome>
  confirm(confirmationId: string): Promise<DeploymentOutcome>
}

export function createDeploymentFacade(options: {
  db: DB
  getRuntime: () => Runtime
  backupsDir: string
  now?: () => number
  createId?: () => string
  confirmationTtlMs?: number
  runMutation?: <T>(mutation: () => T) => Promise<T>
}): DeploymentFacade {
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const ttl = options.confirmationTtlMs ?? 5 * 60_000
  const confirmations = new Map<string, ConfirmationPlan>()
  const consumed = new Set<string>()
  const lockedTargets = new Set<string>()
  const runMutation = options.runMutation ?? (async (mutation) => {
    await Promise.resolve()
    return mutation()
  })

  async function withTargetLock(
    targetId: string,
    mutation: () => DeploymentOutcome
  ): Promise<DeploymentOutcome> {
    if (lockedTargets.has(targetId)) {
      return { status: 'rejected', reason: 'target-busy', message: '目标正在执行其他部署操作，请稍后重试。' }
    }
    lockedTargets.add(targetId)
    try {
      return await runMutation(mutation)
    } finally {
      lockedTargets.delete(targetId)
    }
  }

  function resolve(request: DeploymentRequest) {
    const source = getSourceById(options.db, request.sourceId)
    if (!source) throw new Error(`source not found: ${request.sourceId}`)
    const skill = getSkillById(options.db, source.skill_id)
    if (!skill) throw new Error(`skill not found for source: ${request.sourceId}`)
    const runtime = options.getRuntime()
    const matches = runtime.tools
      .filter((tool) => tool.enabled)
      .flatMap((tool) => tool.targets.map((target) => ({ tool, target })))
      .filter(({ target }) => target.id === request.targetId)
    if (matches.length !== 1) throw new Error(`discovery target not found: ${request.targetId}`)
    const { tool, target } = matches[0]
    if (!existsSync(target.path)) throw new Error(`discovery target is unavailable: ${request.targetId}`)
    return {
      source,
      skill,
      tool,
      target,
      targetPath: resolveWithin(target.path, validateSkillName(skill.name)),
      runtime
    }
  }

  function execute(request: DeploymentRequest, allowExternalOverwrite: boolean): DeploymentOutcome {
    const plan = resolve(request)
    const result = deploySkill(options.db, {
      skillId: plan.skill.id,
      skillName: plan.skill.name,
      targetTool: plan.tool.key,
      mode: request.requestedMode,
      sourcePath: plan.source.path,
      targetDir: plan.targetPath,
      backupsDir: options.backupsDir,
      canSymlink: plan.runtime.platform.canSymlink,
      canJunction: plan.runtime.platform.canJunction,
      allowExternalOverwrite,
      identity: { sourceId: plan.source.id, targetId: plan.target.id }
    })
    const deployment = getDeploymentBySkillAndTargetId(options.db, plan.skill.id, plan.target.id)
    if (!deployment) throw new Error('deployment manifest was not persisted')
    return { status: 'completed', deploymentId: deployment.id, result }
  }

  return {
    deploy(request) {
      return withTargetLock(request.targetId, () => {
        const plan = resolve(request)
        const existing = getDeploymentBySkillAndTargetId(options.db, plan.skill.id, plan.target.id)
        if (!existing && existsSync(plan.targetPath)) {
          const confirmationId = createId()
          const expiresAt = now() + ttl
          confirmations.set(confirmationId, {
            ...request,
            expiresAt,
            sourcePath: plan.source.path,
            sourceHash: hashDir(plan.source.path),
            targetPath: plan.targetPath,
            targetHash: hashDir(plan.targetPath)
          })
          return {
            status: 'confirmation-required',
            confirmationId,
            expiresAt,
            facts: { skillName: plan.skill.name, targetPath: plan.targetPath, reason: 'external-overwrite' }
          }
        }
        return execute(request, false)
      })
    },
    confirm(confirmationId) {
      if (consumed.has(confirmationId)) {
        return Promise.resolve({ status: 'rejected', reason: 'confirmation-used', message: '确认已使用，请重新发起部署。' })
      }
      const stored = confirmations.get(confirmationId)
      if (!stored) {
        return Promise.resolve({ status: 'rejected', reason: 'confirmation-invalid', message: '确认无效或应用已重启，请重新发起部署。' })
      }
      return withTargetLock(stored.targetId, () => {
        // Consume only after this confirmation owns the target lock.
        confirmations.delete(confirmationId)
        consumed.add(confirmationId)
        if (stored.expiresAt <= now()) {
          return { status: 'rejected', reason: 'confirmation-expired', message: '确认已过期，请重新发起部署。' }
        }
        try {
          const current = resolve(stored)
          const changed =
            current.source.path !== stored.sourcePath ||
            current.targetPath !== stored.targetPath ||
            !existsSync(current.targetPath) ||
            hashDir(current.source.path) !== stored.sourceHash ||
            hashDir(current.targetPath) !== stored.targetHash ||
            getDeploymentBySkillAndTargetId(options.db, current.skill.id, current.target.id) != null
          if (changed) {
            return { status: 'rejected', reason: 'plan-changed', message: '部署计划已变化，请重新检查并确认。' }
          }
        } catch {
          return { status: 'rejected', reason: 'plan-changed', message: '部署计划已变化，请重新检查并确认。' }
        }
        return execute(stored, true)
      })
    }
  }
}
