import { existsSync, lstatSync } from 'fs'
import { randomUUID } from 'crypto'
import type { DB } from '../db/database'
import { getDeploymentBySkillAndTargetId } from '../db/dao/deployments'
import { getSourceById } from '../db/dao/skill-sources'
import { getSkillById } from '../db/dao/skills'
import type { DeployMode, DeployResult, DeploymentMutationHooks, PlatformInfo, RecoveryEvidence, ToolConfig } from '../types'
import {
  deploySkill,
  inspectRecoveryEvidence,
  ModeDegradationRequiredError,
  RecoveryRequiredError,
  resolveActualMode,
  targetMatchesDeployment
} from './deployer'
import { hashDir } from './hash'
import { resolveWithin, validateSkillName } from './path-safety'

export interface DeploymentRequest {
  sourceId: number
  targetId: string
  requestedMode: DeployMode
}

export type DeploymentConfirmationReason =
  | 'external-overwrite'
  | 'target-modified'
  | 'mode-degraded'

export interface DeploymentConfirmationFacts {
  skillName: string
  targetPath: string
  reasons: DeploymentConfirmationReason[]
  requestedMode: DeployMode
  actualMode: DeployMode
  backup: { required: boolean; directory: string | null }
}

export type DeploymentOutcome =
  | { status: 'completed'; deploymentId: number; result: DeployResult }
  | {
      status: 'confirmation-required'
      confirmationId: string
      expiresAt: number
      facts: DeploymentConfirmationFacts
    }
  | {
      status: 'rejected'
      reason: 'confirmation-expired' | 'confirmation-used' | 'confirmation-invalid' | 'plan-changed' | 'target-busy'
      message: string
    }
  | { status: 'recovery-required'; message: string; evidence: RecoveryEvidence }

interface Runtime {
  tools: ToolConfig[]
  platform: PlatformInfo
}

interface ConfirmationPlan extends DeploymentRequest {
  expiresAt: number
  fingerprint: string
  actualMode: DeployMode
  degradationReason?: string
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
  mutationHooks?: DeploymentMutationHooks
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

  type Resolved = ReturnType<typeof resolve>
  interface PreparedPlan {
    request: DeploymentRequest
    resolved: Resolved
    reasons: DeploymentConfirmationReason[]
    actualMode: DeployMode
    degradationReason?: string
    fingerprint: string
  }

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

  function prepare(
    request: DeploymentRequest,
    forcedActualMode?: DeployMode,
    forcedDegradationReason?: string
  ): PreparedPlan {
    const resolved = resolve(request)
    const existing = getDeploymentBySkillAndTargetId(options.db, resolved.skill.id, resolved.target.id)
    const targetExists = existsSync(resolved.targetPath)
    const sourceHash = hashDir(resolved.source.path)
    const platformMode = resolveActualMode(
      request.requestedMode,
      resolved.runtime.platform.canSymlink,
      resolved.runtime.platform.canJunction,
      lstatSync(resolved.source.path).isDirectory()
    )
    const actualMode = forcedActualMode ?? platformMode.actualMode
    const degradationReason = forcedDegradationReason ?? platformMode.degradeReason
    const reasons: DeploymentConfirmationReason[] = []
    if (!existing && targetExists) reasons.push('external-overwrite')
    if (
      existing &&
      !targetMatchesDeployment(
        resolved.targetPath,
        existing.mode,
        resolved.source.path,
        existing.source_hash_at_deploy
      )
    ) reasons.push('target-modified')
    if (actualMode === 'copy' && request.requestedMode !== 'copy') reasons.push('mode-degraded')
    const targetHash = targetExists ? hashDir(resolved.targetPath) : null
    const fingerprint = JSON.stringify({
      sourceId: request.sourceId,
      targetId: request.targetId,
      requestedMode: request.requestedMode,
      actualMode,
      degradationReason: degradationReason ?? null,
      sourcePath: resolved.source.path,
      sourceHash,
      targetPath: resolved.targetPath,
      targetHash,
      reasons,
      platform: {
        canSymlink: resolved.runtime.platform.canSymlink,
        canJunction: resolved.runtime.platform.canJunction
      },
      backupsDir: options.backupsDir,
      existing: existing == null ? null : {
        id: existing.id,
        mode: existing.mode,
        sourcePath: existing.source_path,
        sourceHash: existing.source_hash_at_deploy,
        targetPath: existing.target_path
      }
    })
    return { request, resolved, reasons, actualMode, fingerprint, ...(degradationReason ? { degradationReason } : {}) }
  }

  function requireConfirmation(plan: PreparedPlan): DeploymentOutcome {
    const confirmationId = createId()
    const expiresAt = now() + ttl
    confirmations.set(confirmationId, {
      ...plan.request,
      expiresAt,
      fingerprint: plan.fingerprint,
      actualMode: plan.actualMode,
      ...(plan.degradationReason ? { degradationReason: plan.degradationReason } : {})
    })
    const backupRequired = plan.reasons.includes('external-overwrite')
    return {
      status: 'confirmation-required',
      confirmationId,
      expiresAt,
      facts: {
        skillName: plan.resolved.skill.name,
        targetPath: plan.resolved.targetPath,
        reasons: plan.reasons,
        requestedMode: plan.request.requestedMode,
        actualMode: plan.actualMode,
        backup: { required: backupRequired, directory: backupRequired ? options.backupsDir : null }
      }
    }
  }

  function execute(plan: PreparedPlan): DeploymentOutcome {
    const resolved = plan.resolved
    const existingEvidence = inspectRecoveryEvidence(resolved.targetPath)
    if (existingEvidence) {
      return { status: 'recovery-required', message: '检测到未完成的部署操作，请保留现场并人工选择恢复方向。', evidence: existingEvidence }
    }
    let result: DeployResult
    try {
      result = deploySkill(options.db, {
        skillId: resolved.skill.id,
        skillName: resolved.skill.name,
        targetTool: resolved.tool.key,
        mode: plan.request.requestedMode,
        sourcePath: resolved.source.path,
        targetDir: resolved.targetPath,
        backupsDir: options.backupsDir,
        canSymlink: resolved.runtime.platform.canSymlink,
        canJunction: resolved.runtime.platform.canJunction,
        allowExternalOverwrite: plan.reasons.includes('external-overwrite'),
        ...(plan.actualMode === 'copy' && plan.request.requestedMode !== 'copy' ? {
          approvedModeDegradation: {
            from: plan.request.requestedMode,
            to: 'copy' as const,
            reason: plan.degradationReason ?? 'linked deployment is unavailable; copy is required'
          }
        } : {}),
        identity: { sourceId: resolved.source.id, targetId: resolved.target.id },
        mutationHooks: options.mutationHooks
      })
    } catch (error) {
      if (error instanceof ModeDegradationRequiredError) {
        return requireConfirmation(prepare(plan.request, error.to, error.reason))
      }
      if (error instanceof RecoveryRequiredError) {
        return { status: 'recovery-required', message: '部署失败且自动补偿未完成，请保留现场并人工恢复。', evidence: error.evidence }
      }
      throw error
    }
    const deployment = getDeploymentBySkillAndTargetId(options.db, resolved.skill.id, resolved.target.id)
    if (!deployment) throw new Error('deployment manifest was not persisted')
    return { status: 'completed', deploymentId: deployment.id, result }
  }

  return {
    deploy(request) {
      return withTargetLock(request.targetId, () => {
        const prepared = prepare(request)
        if (inspectRecoveryEvidence(prepared.resolved.targetPath)) return execute(prepared)
        if (prepared.reasons.length > 0) return requireConfirmation(prepared)
        return execute(prepared)
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
        let current: PreparedPlan
        try {
          current = prepare(stored, stored.actualMode, stored.degradationReason)
        } catch {
          return { status: 'rejected', reason: 'plan-changed', message: '部署计划已变化，请重新检查并确认。' }
        }
        if (current.fingerprint !== stored.fingerprint) {
          return { status: 'rejected', reason: 'plan-changed', message: '部署计划已变化，请重新检查并确认。' }
        }
        return execute(current)
      })
    }
  }
}
