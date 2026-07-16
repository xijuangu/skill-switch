import { existsSync, lstatSync, readlinkSync, realpathSync } from 'fs'
import { randomUUID } from 'crypto'
import type { DB } from '../db/database'
import { adoptObservedDeployment, getAllDeployments, getDeploymentById, getDeploymentBySkillAndTargetId } from '../db/dao/deployments'
import { getSourceById } from '../db/dao/skill-sources'
import { getSkillById } from '../db/dao/skills'
import type { DeployMode, DeployResult, Deployment, DeploymentMutationHooks, DriftStatus, PlatformInfo, RecoveryEvidence, ToolConfig } from '../types'
import {
  executePreparedDeployment,
  inspectRecoveryEvidence,
  ModeDegradationRequiredError,
  RecoveryRequiredError,
  resolveActualMode,
  targetMatchesDeployment,
  executePreparedUndeployment
} from './deployer'
import { hashDir } from './hash'
import { assessSafeDeployTarget, resolveWithin, validateSkillName } from './path-safety'

/**
 * Read-only target eligibility owned by the same module that authorizes deploy.
 * Renderer-facing IPC must not recreate the managed/observed mutation policy.
 */
export function assessDeploymentTargetOption(
  sourcePath: string,
  targetPath: string,
  existing?: Pick<Deployment, 'management' | 'mode'>
) {
  if (existing?.management === 'observed') {
    return { eligible: false, reason: '已有外部订阅，请先在工具页显式接管' }
  }
  return assessSafeDeployTarget(sourcePath, targetPath, {
    allowExistingSymlinkToSource:
      existing?.management === 'managed' &&
      (existing.mode === 'symlink' || existing.mode === 'junction')
  })
}

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
  targetDisplayName: string
  reasons: DeploymentConfirmationReason[]
  requestedMode: DeployMode
  actualMode: DeployMode
  backup: { required: boolean; directory: string | null }
}

export type DeploymentCompletedResult = Omit<DeployResult, 'targetPath' | 'sourceHashAtDeploy'> & {
  targetDisplayName: string
}

export type DeploymentOutcome =
  | { status: 'completed'; deploymentId: number; result: DeploymentCompletedResult }
  | {
      status: 'confirmation-required'
      confirmationId: string
      expiresAt: number
      facts: DeploymentConfirmationFacts
    }
  | {
      status: 'rejected'
      reason: 'confirmation-expired' | 'confirmation-used' | 'confirmation-invalid' | 'plan-changed' | 'target-busy' | 'observed-read-only'
      message: string
    }
  | { status: 'recovery-required'; message: string; evidence: RecoveryEvidence }

export type DeploymentMutationOutcome =
  | { status: 'completed'; deploymentId: number }
  | {
      status: 'rejected'
      reason: 'deployment-not-found' | 'unresolved' | 'target-busy' | 'observed-read-only' | 'observation-stale'
      message: string
    }
  | { status: 'recovery-required'; message: string; evidence: RecoveryEvidence }

export interface BulkAdoptionPreviewItem {
  deploymentId: number
  skillName: string
}

export interface BulkAdoptionPreviewFacts {
  total: number
  tools: Array<{
    targetTool: string
    targetDisplayName: string
    items: BulkAdoptionPreviewItem[]
  }>
}

export type BulkAdoptionPreviewOutcome =
  | { status: 'empty'; facts: BulkAdoptionPreviewFacts }
  | {
      status: 'confirmation-required'
      confirmationId: string
      expiresAt: number
      facts: BulkAdoptionPreviewFacts
    }

export interface BulkAdoptionResultItem extends BulkAdoptionPreviewItem {
  targetTool: string
}

export interface BulkAdoptionFailure extends BulkAdoptionResultItem {
  reason: 'deployment-not-found' | 'unresolved' | 'target-busy' | 'observation-stale' | 'recovery-required'
  message: string
}

export type BulkAdoptionConfirmationOutcome =
  | {
      status: 'completed'
      total: number
      adopted: BulkAdoptionResultItem[]
      failed: BulkAdoptionFailure[]
    }
  | {
      status: 'rejected'
      reason: 'confirmation-expired' | 'confirmation-used' | 'confirmation-invalid'
      message: string
    }

type TargetBusyOutcome = { status: 'rejected'; reason: 'target-busy'; message: string }
export type DeploymentRedeployOutcome =
  | DeploymentOutcome
  | Extract<DeploymentMutationOutcome, { status: 'rejected' }>

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

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function fingerprintTarget(path: string): string {
  try {
    return hashDir(path)
  } catch {
    const stat = lstatSync(path)
    return stat.isSymbolicLink() ? `symlink:${readlinkSync(path)}` : `unreadable:${stat.mode}`
  }
}

export interface DeploymentFacade {
  deploy(request: DeploymentRequest): Promise<DeploymentOutcome>
  confirm(confirmationId: string): Promise<DeploymentOutcome>
  redeploy(deploymentId: number): Promise<DeploymentRedeployOutcome>
  undeploy(deploymentId: number): Promise<DeploymentMutationOutcome>
  adopt(deploymentId: number): Promise<DeploymentMutationOutcome>
  previewBulkAdoption(): BulkAdoptionPreviewOutcome
  confirmBulkAdoption(confirmationId: string): Promise<BulkAdoptionConfirmationOutcome>
  inspect(deploymentId: number): DriftStatus | null
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
  const bulkAdoptionConfirmations = new Map<string, {
    expiresAt: number
    items: BulkAdoptionResultItem[]
  }>()
  const consumedBulkAdoptionConfirmations = new Set<string>()
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

  async function withTargetLock<T extends DeploymentOutcome | DeploymentMutationOutcome>(
    targetId: string,
    mutation: () => T
  ): Promise<T | TargetBusyOutcome> {
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

  function inspect(deploymentId: number): DriftStatus | null {
    const deployment = getDeploymentById(options.db, deploymentId)
    if (!deployment) return null
    const skill = getSkillById(options.db, deployment.skill_id)
    if (!skill) return null
    const targetPath = deployment.target_path ?? ''
    const recovery = deployment.target_path == null ? null : inspectRecoveryEvidence(deployment.target_path)
    if (recovery) {
      return {
        skillId: skill.id, skillName: skill.name, targetTool: deployment.target_tool,
        targetPath, deployment, targetExists: existsSync(targetPath), currentSourceHash: null,
        currentTargetHash: null, kind: 'recovery-required', recovery
      }
    }
    if (deployment.source_id == null || deployment.target_id == null || deployment.target_path == null) {
      return {
        skillId: skill.id, skillName: skill.name, targetTool: deployment.target_tool,
        targetPath, deployment, targetExists: false, currentSourceHash: null,
        currentTargetHash: null, kind: 'unresolved'
      }
    }
    const targetKnown = options.getRuntime().tools.some((tool) =>
      tool.targets.some((target) => target.id === deployment.target_id)
    )
    if (!targetKnown) {
      return {
        skillId: skill.id, skillName: skill.name, targetTool: deployment.target_tool,
        targetPath, deployment, targetExists: false, currentSourceHash: null,
        currentTargetHash: null, kind: 'unresolved'
      }
    }
    const source = getSourceById(options.db, deployment.source_id)
    const sourcePath = source?.path ?? deployment.source_path
    const targetExists = (() => { try { lstatSync(targetPath); return true } catch { return false } })()
    if (!source || source.skill_id !== deployment.skill_id || !existsSync(sourcePath)) {
      return {
        skillId: skill.id, skillName: skill.name, targetTool: deployment.target_tool,
        targetPath, deployment, targetExists, currentSourceHash: null,
        currentTargetHash: null, kind: 'source-missing'
      }
    }
    if (!targetExists) {
      return {
        skillId: skill.id, skillName: skill.name, targetTool: deployment.target_tool,
        targetPath, deployment, targetExists: false, currentSourceHash: null,
        currentTargetHash: null, kind: 'drift'
      }
    }
    const currentSourceHash = hashDir(sourcePath)
    if (deployment.mode === 'symlink' || deployment.mode === 'junction') {
      let matches = false
      try {
        matches = lstatSync(targetPath).isSymbolicLink() && realpathSync(targetPath) === realpathSync(sourcePath)
      } catch { /* mismatch */ }
      return {
        skillId: skill.id, skillName: skill.name, targetTool: deployment.target_tool,
        targetPath, deployment, targetExists: true, currentSourceHash,
        currentTargetHash: null, kind: matches ? 'normal' : 'link-mismatch'
      }
    }
    const currentTargetHash = hashDir(targetPath)
    const kind = currentTargetHash !== deployment.source_hash_at_deploy
      ? 'target-modified'
      : currentSourceHash !== deployment.source_hash_at_deploy
        ? 'source-updated'
        : 'normal'
    return {
      skillId: skill.id, skillName: skill.name, targetTool: deployment.target_tool,
      targetPath, deployment, targetExists: true, currentSourceHash, currentTargetHash, kind
    }
  }

  function resolveExisting(deploymentId: number):
    | { rejection: Extract<DeploymentMutationOutcome, { status: 'rejected' }> }
    | {
        deployment: NonNullable<ReturnType<typeof getDeploymentById>>
        source: NonNullable<ReturnType<typeof getSourceById>>
        skill: NonNullable<ReturnType<typeof getSkillById>>
        target: { tool: ToolConfig; target: ToolConfig['targets'][number] }
      } {
    const deployment = getDeploymentById(options.db, deploymentId)
    if (!deployment) return { rejection: { status: 'rejected', reason: 'deployment-not-found', message: '部署记录不存在。' } as const }
    if (deployment.source_id == null || deployment.target_id == null || deployment.target_path == null) {
      return { rejection: { status: 'rejected', reason: 'unresolved', message: '部署身份尚未解析，拒绝执行文件系统操作。' } as const }
    }
    const source = getSourceById(options.db, deployment.source_id)
    const skill = getSkillById(options.db, deployment.skill_id)
    const target = options.getRuntime().tools
      .flatMap((tool) => tool.targets.map((candidate) => ({ tool, target: candidate })))
      .find(({ target: candidate }) => candidate.id === deployment.target_id)
    if (!source || source.skill_id !== deployment.skill_id || !skill || !target) {
      return { rejection: { status: 'rejected', reason: 'unresolved', message: '部署关联的 Source 或 Discovery Target 不可解析。' } as const }
    }
    return { deployment, source, skill, target }
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
    const targetExists = pathEntryExists(resolved.targetPath)
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
      existing && targetExists &&
      !targetMatchesDeployment(
        resolved.targetPath,
        existing.mode,
        resolved.source.path,
        existing.source_hash_at_deploy
      )
    ) reasons.push('target-modified')
    if (actualMode === 'copy' && request.requestedMode !== 'copy') reasons.push('mode-degraded')
    const targetHash = targetExists ? fingerprintTarget(resolved.targetPath) : null
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
        targetDisplayName: plan.resolved.tool.displayName,
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
      result = executePreparedDeployment(options.db, {
        skillId: resolved.skill.id,
        skillName: resolved.skill.name,
        targetTool: resolved.tool.key,
        mode: plan.actualMode,
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
    const { targetPath: _targetPath, sourceHashAtDeploy: _sourceHash, ...safeResult } = result
    return {
      status: 'completed',
      deploymentId: deployment.id,
      result: { ...safeResult, targetDisplayName: resolved.tool.displayName }
    }
  }

  function previewBulkAdoption(): BulkAdoptionPreviewOutcome {
    const runtime = options.getRuntime()
    const groups = new Map<string, BulkAdoptionPreviewFacts['tools'][number]>()
    for (const deployment of getAllDeployments(options.db)) {
      if (deployment.management !== 'observed') continue
      const skill = getSkillById(options.db, deployment.skill_id)
      if (!skill) continue
      const tool = runtime.tools.find((candidate) => candidate.key === deployment.target_tool)
      const group = groups.get(deployment.target_tool) ?? {
        targetTool: deployment.target_tool,
        targetDisplayName: tool?.displayName ?? deployment.target_tool,
        items: []
      }
      group.items.push({ deploymentId: deployment.id, skillName: skill.name })
      groups.set(deployment.target_tool, group)
    }
    const facts = {
      total: [...groups.values()].reduce((total, group) => total + group.items.length, 0),
      tools: [...groups.values()]
    }
    if (facts.total === 0) return { status: 'empty', facts }
    const confirmationId = createId()
    const expiresAt = now() + ttl
    bulkAdoptionConfirmations.set(confirmationId, {
      expiresAt,
      items: facts.tools.flatMap((group) => group.items.map((item) => ({
        ...item,
        targetTool: group.targetTool
      })))
    })
    return { status: 'confirmation-required', confirmationId, expiresAt, facts }
  }

  function adoptOne(deploymentId: number, requireObserved = false): Promise<DeploymentMutationOutcome> {
    const resolved = resolveExisting(deploymentId)
    if ('rejection' in resolved) return Promise.resolve(resolved.rejection)
    const { deployment, source, skill, target } = resolved
    if (deployment.management === 'managed') {
      return Promise.resolve(requireObserved
        ? { status: 'rejected', reason: 'observation-stale', message: '外部订阅状态已变化，请刷新后重试。' } as const
        : { status: 'completed', deploymentId: deployment.id } as const)
    }
    return withTargetLock(deployment.target_id!, () => {
      const expectedTargetPath = resolveWithin(target.target.path, validateSkillName(skill.name))
      try {
        if (
          deployment.mode !== 'symlink' ||
          deployment.target_path !== expectedTargetPath ||
          !lstatSync(expectedTargetPath).isSymbolicLink() ||
          realpathSync(expectedTargetPath) !== realpathSync(source.path)
        ) {
          return { status: 'rejected', reason: 'observation-stale', message: '外部订阅已变化，拒绝接管。' } as const
        }
      } catch {
        return { status: 'rejected', reason: 'observation-stale', message: '外部订阅已变化或不可访问，拒绝接管。' } as const
      }
      if (!adoptObservedDeployment(options.db, deployment.id)) {
        return { status: 'rejected', reason: 'observation-stale', message: '外部订阅状态已变化，请刷新后重试。' } as const
      }
      return { status: 'completed', deploymentId: deployment.id } as const
    }) as Promise<DeploymentMutationOutcome>
  }

  async function confirmBulkAdoption(confirmationId: string): Promise<BulkAdoptionConfirmationOutcome> {
    if (consumedBulkAdoptionConfirmations.has(confirmationId)) {
      return { status: 'rejected', reason: 'confirmation-used', message: '批量接管确认已使用，请重新预览。' }
    }
    const confirmation = bulkAdoptionConfirmations.get(confirmationId)
    if (!confirmation) {
      return { status: 'rejected', reason: 'confirmation-invalid', message: '批量接管确认无效或应用已重启，请重新预览。' }
    }
    bulkAdoptionConfirmations.delete(confirmationId)
    consumedBulkAdoptionConfirmations.add(confirmationId)
    if (confirmation.expiresAt <= now()) {
      return { status: 'rejected', reason: 'confirmation-expired', message: '批量接管确认已过期，请重新预览。' }
    }
    const adopted: BulkAdoptionResultItem[] = []
    const failed: BulkAdoptionFailure[] = []
    for (const item of confirmation.items) {
      const outcome = await adoptOne(item.deploymentId, true)
      if (outcome.status === 'completed') {
        adopted.push(item)
      } else {
        failed.push({
          ...item,
          reason: outcome.status === 'rejected' && outcome.reason !== 'observed-read-only'
            ? outcome.reason
            : outcome.status === 'recovery-required' ? 'recovery-required' : 'observation-stale',
          message: outcome.message
        })
      }
    }
    return { status: 'completed', total: confirmation.items.length, adopted, failed }
  }

  return {
    deploy(request) {
      const requestedSource = getSourceById(options.db, request.sourceId)
      const existing = requestedSource == null
        ? undefined
        : getDeploymentBySkillAndTargetId(options.db, requestedSource.skill_id, request.targetId)
      if (existing?.management === 'observed') {
        return Promise.resolve({
          status: 'rejected',
          reason: 'observed-read-only',
          message: '该目标是外部订阅，请先显式接管。'
        } as const)
      }
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
    },
    inspect,
    previewBulkAdoption,
    confirmBulkAdoption,
    redeploy(deploymentId) {
      const resolved = resolveExisting(deploymentId)
      if ('rejection' in resolved) return Promise.resolve(resolved.rejection)
      const { deployment, source, target } = resolved
      if (deployment.management === 'observed') {
        return Promise.resolve({ status: 'rejected', reason: 'observed-read-only', message: '外部订阅尚未接管，拒绝重新部署。' } as const)
      }
      return withTargetLock(deployment.target_id!, () => {
        const prepared = prepare({
          sourceId: source.id,
          targetId: target.target.id,
          requestedMode: deployment.mode
        })
        if (inspectRecoveryEvidence(prepared.resolved.targetPath)) return execute(prepared)
        if (prepared.reasons.length > 0) return requireConfirmation(prepared)
        return execute(prepared)
      })
    },
    undeploy(deploymentId) {
      const deployment = getDeploymentById(options.db, deploymentId)
      if (!deployment) {
        return Promise.resolve({ status: 'rejected', reason: 'deployment-not-found', message: '部署记录不存在。' } as const)
      }
      if (deployment.management === 'observed') {
        return Promise.resolve({ status: 'rejected', reason: 'observed-read-only', message: '外部订阅尚未接管，拒绝取消部署。' } as const)
      }
      if (deployment.target_id == null || deployment.target_path == null) {
        return Promise.resolve({ status: 'rejected', reason: 'unresolved', message: '部署目标身份尚未解析，拒绝执行文件系统操作。' } as const)
      }
      return withTargetLock(deployment.target_id!, () => {
        const recovery = inspectRecoveryEvidence(deployment.target_path!)
        if (recovery) return { status: 'recovery-required', message: '检测到未完成的部署操作，请保留现场并人工选择恢复方向。', evidence: recovery }
        try {
          executePreparedUndeployment(options.db, deployment, options.mutationHooks)
          return { status: 'completed', deploymentId: deployment.id }
        } catch (error) {
          if (error instanceof RecoveryRequiredError) {
            return { status: 'recovery-required', message: '取消部署失败且自动补偿未完成，请保留现场并人工恢复。', evidence: error.evidence }
          }
          throw error
        }
      }) as Promise<DeploymentMutationOutcome>
    },
    adopt: adoptOne
  }
}
