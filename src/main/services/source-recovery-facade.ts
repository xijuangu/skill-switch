// #91: Source Recovery Facade
// 当 canonical Source 缺失或不可读时,收集归档、历史权威版本、copy deployment 和用户选择目录
// 作为候选,用户显式选定后通过 staging 恢复到原 Canonical Placement。

import { randomUUID } from 'crypto'
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'fs'
import { dirname, resolve } from 'path'
import type { DB } from '../db/database'
import { runInTransaction } from '../db/database'
import { getCanonicalSourceBySkillId } from '../db/dao/skill-sources'
import { getSkillById } from '../db/dao/skills'
import { getDeploymentsBySkillId } from '../db/dao/deployments'
import { hashDir } from './hash'
import { assertAbsolutePath, resolveWithin } from './path-safety'
import type { SkillLibraryFacade } from './skill-library-facade'

export type RecoveryCandidateKind = 'archive' | 'historical-canonical' | 'copy-deployment' | 'user-directory'

export interface RecoveryCandidate {
  path: string
  hash: string
  kind: RecoveryCandidateKind
  /** 候选来源的描述性元数据,用于 UI 展示 */
  label: string
}

export interface RecoveryCandidateGroup {
  hash: string
  candidates: RecoveryCandidate[]
  /** 此组的 hash 是否与最后已知权威 hash 一致 */
  matchesLastKnownHash: boolean
}

export interface SourceRecoveryPreview {
  status: 'confirmation-required'
  confirmationId: string
  skillId: number
  skillName: string
  canonicalPath: string
  lastKnownHash: string
  candidateGroups: RecoveryCandidateGroup[]
  /** 始终为 true:即使只有一个匹配候选,也要求用户显式选择 */
  requiresExplicitChoice: boolean
}

export type SourceRecoveryOutcome =
  | { status: 'completed'; recoveryId: string; canonicalPath: string; canonicalHash: string }
  | {
      status: 'rejected'
      recoveryId?: string
      reason: 'confirmation-not-found' | 'confirmation-used' | 'candidate-not-found' | 'placement-occupied' | 'candidate-unavailable' | 'plan-stale'
      message: string
    }
  | { status: 'recovery-required'; recoveryId: string; message: string }

interface RecoveryRow {
  id: string
  status: string
  skill_id: number
  skill_name: string
  canonical_source_id: number
  canonical_path: string
  last_known_hash: string
  selected_candidate_path: string
  selected_candidate_hash: string
  selected_candidate_kind: string
  candidates_snapshot: string
  phase: string | null
  journal_json: string | null
  created_at: string
  completed_at: string | null
  failure_message: string | null
}

interface PersistedCandidate {
  path: string
  hash: string
  kind: RecoveryCandidateKind
  label: string
}

interface PersistedPreview {
  candidates: PersistedCandidate[]
  lastKnownHash: string
  canonicalPath: string
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function directoryHashIfAvailable(path: string): string | null {
  try {
    if (!pathEntryExists(path) || !statSync(path).isDirectory()) return null
    return hashDir(path)
  } catch {
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface SourceRecoveryFacade {
  previewSourceRecovery(request: {
    skillId: number
    userDirectories?: string[]
  }): SourceRecoveryPreview
  confirmSourceRecovery(request: {
    confirmationId: string
    selectedCandidatePath: string
  }): SourceRecoveryOutcome
}

export function createSourceRecoveryFacade(options: {
  db: DB
  canonicalRepositoryPath: string
  sourceArchivePath: string
  skillLibraryFacade: SkillLibraryFacade
  createId?: () => string
}): SourceRecoveryFacade {
  const canonicalRepositoryPath = resolve(assertAbsolutePath(options.canonicalRepositoryPath, 'Canonical Repository path'))
  const sourceArchivePath = resolve(assertAbsolutePath(options.sourceArchivePath, 'Source Archive path'))
  const createId = options.createId ?? randomUUID
  const consumedConfirmations = new Set<string>()

  // 启动时把未完成的恢复标记为 recovery-required(journal 可诊断)
  options.db.prepare(`UPDATE source_recoveries
    SET status = 'recovery-required',
        failure_message = COALESCE(failure_message, 'Source Recovery was interrupted; inspect the persisted journal.')
    WHERE status = 'previewed' AND (phase IS NOT NULL OR id IN (SELECT recovery_id FROM source_recovery_locks))`).run()
  options.db.prepare(`DELETE FROM source_recovery_locks
    WHERE recovery_id IN (SELECT id FROM source_recoveries WHERE phase IS NULL AND status IN ('failed', 'completed'))`).run()

  function collectArchiveCandidates(skillId: number): PersistedCandidate[] {
    const candidates: PersistedCandidate[] = []
    // 从已完成的 consolidation batch 的 archive 中提取候选
    const batches = options.db.prepare(
      `SELECT id FROM consolidation_batches
       WHERE status IN ('completed', 'undone') AND archive_purged_at IS NULL
       ORDER BY created_at DESC`
    ).all() as Array<{ id: string }>
    for (const batch of batches) {
      const items = options.db.prepare(
        'SELECT skill_id, skill_name, archive_path, canonical_path, candidate_source_snapshot FROM consolidation_items WHERE batch_id = ?'
      ).all(batch.id) as Array<{ skill_id: number; skill_name: string; archive_path: string; canonical_path: string; candidate_source_snapshot: string }>
      for (const item of items) {
        if (item.skill_id !== skillId) continue
        // archive 目录结构: {sourceArchivePath}/{batchId}/source/{skillName}/
        const archiveRoot = resolveWithin(sourceArchivePath, batch.id, 'source', item.skill_name)
        if (pathEntryExists(archiveRoot) && statSync(archiveRoot).isDirectory()) {
          const hash = directoryHashIfAvailable(archiveRoot)
          if (hash) {
            candidates.push({
              path: archiveRoot,
              hash,
              kind: 'archive',
              label: `archive:${batch.id}/${item.skill_name}`
            })
          }
        }
        // 多个 source 的归档会在 archive_path 下按 sourceId 分目录
        if (pathEntryExists(item.archive_path) && statSync(item.archive_path).isDirectory()) {
          for (const entry of readdirSync(item.archive_path, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const sub = resolve(item.archive_path, entry.name)
            const hash = directoryHashIfAvailable(sub)
            if (hash && !candidates.some((c) => c.path === sub)) {
              candidates.push({
                path: sub,
                hash,
                kind: 'archive',
                label: `archive:${batch.id}/${item.skill_name}/${entry.name}`
              })
            }
          }
        }
      }
    }
    return candidates
  }

  function collectHistoricalCanonicalCandidates(skillId: number, currentCanonicalPath: string): PersistedCandidate[] {
    // 从 skill_sources 表中查找同 skill_id 的其他 canonical 记录(历史)
    // 注:当前 schema 下一个 skill 最多一个 canonical,但通过 archive 恢复后可能有历史记录
    // 此处主要检查 source_relocations 表中的 old_path,那是历史权威路径
    const candidates: PersistedCandidate[] = []
    const relocations = options.db.prepare(
      "SELECT old_path, source_hash FROM source_relocations WHERE skill_id = ? AND status IN ('completed', 'undone') ORDER BY created_at DESC"
    ).all(skillId) as Array<{ old_path: string; source_hash: string }>
    for (const relocation of relocations) {
      if (resolve(relocation.old_path) === resolve(currentCanonicalPath)) continue
      const hash = directoryHashIfAvailable(relocation.old_path)
      if (hash) {
        candidates.push({
          path: relocation.old_path,
          hash,
          kind: 'historical-canonical',
          label: `historical:${relocation.old_path}`
        })
      }
    }
    return candidates
  }

  function collectCopyDeploymentCandidates(skillId: number): PersistedCandidate[] {
    const candidates: PersistedCandidate[] = []
    const deployments = getDeploymentsBySkillId(options.db, skillId)
    for (const deployment of deployments) {
      if (deployment.mode !== 'copy') continue
      if (!deployment.target_path) continue
      const hash = directoryHashIfAvailable(deployment.target_path)
      if (hash) {
        candidates.push({
          path: deployment.target_path,
          hash,
          kind: 'copy-deployment',
          label: `copy:${deployment.target_tool}:${deployment.target_id ?? deployment.target_path}`
        })
      }
    }
    return candidates
  }

  function collectUserDirectoryCandidates(userDirectories: string[]): PersistedCandidate[] {
    const candidates: PersistedCandidate[] = []
    for (const dir of userDirectories) {
      const resolved = resolve(assertAbsolutePath(dir, 'user directory'))
      const hash = directoryHashIfAvailable(resolved)
      if (hash) {
        candidates.push({
          path: resolved,
          hash,
          kind: 'user-directory',
          label: `user:${resolved}`
        })
      }
    }
    return candidates
  }

  function groupCandidates(candidates: PersistedCandidate[], lastKnownHash: string): RecoveryCandidateGroup[] {
    const groups = new Map<string, PersistedCandidate[]>()
    for (const candidate of candidates) {
      const group = groups.get(candidate.hash) ?? []
      group.push(candidate)
      groups.set(candidate.hash, group)
    }
    return [...groups.entries()].map(([hash, groupCandidates]) => ({
      hash,
      candidates: groupCandidates.map((c) => ({ ...c })),
      matchesLastKnownHash: hash === lastKnownHash
    }))
  }

  function previewSourceRecovery(request: {
    skillId: number
    userDirectories?: string[]
  }): SourceRecoveryPreview {
    if (!Number.isInteger(request.skillId)) throw new Error('skillId must be an integer')
    const skill = getSkillById(options.db, request.skillId)
    if (!skill) throw new Error('Skill does not exist')
    const canonical = getCanonicalSourceBySkillId(options.db, request.skillId)
    if (!canonical) throw new Error('Skill has no canonical Source; nothing to recover')

    const candidates: PersistedCandidate[] = [
      ...collectArchiveCandidates(request.skillId),
      ...collectHistoricalCanonicalCandidates(request.skillId, canonical.path),
      ...collectCopyDeploymentCandidates(request.skillId),
      ...collectUserDirectoryCandidates(request.userDirectories ?? [])
    ]
    // 去重(同 path 只保留一次,优先级 archive > historical > copy > user)
    const seen = new Set<string>()
    const deduped: PersistedCandidate[] = []
    for (const candidate of candidates) {
      const key = resolve(candidate.path)
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(candidate)
    }

    const candidateGroups = groupCandidates(deduped, canonical.hash)
    const confirmationId = createId()
    const preview: PersistedPreview = {
      candidates: deduped,
      lastKnownHash: canonical.hash,
      canonicalPath: canonical.path
    }
    options.db.prepare(
      `INSERT INTO source_recoveries
       (id, status, skill_id, skill_name, canonical_source_id, canonical_path,
        last_known_hash, selected_candidate_path, selected_candidate_hash, selected_candidate_kind,
        candidates_snapshot, created_at)
       VALUES (?, 'previewed', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    ).run(
      confirmationId,
      request.skillId,
      skill.name,
      canonical.id,
      canonical.path,
      canonical.hash,
      JSON.stringify(preview),
      new Date().toISOString()
    )
    return {
      status: 'confirmation-required',
      confirmationId,
      skillId: request.skillId,
      skillName: skill.name,
      canonicalPath: canonical.path,
      lastKnownHash: canonical.hash,
      candidateGroups,
      requiresExplicitChoice: true
    }
  }

  function getPersistedRecovery(id: string): RecoveryRow | null {
    return (options.db.prepare('SELECT * FROM source_recoveries WHERE id = ?').get(id) as RecoveryRow | undefined) ?? null
  }

  function markRecovery(id: string, status: 'completed' | 'failed' | 'recovery-required', phase: string | null, failureMessage: string | null, journal: unknown): void {
    const completedAt = status === 'completed' ? new Date().toISOString() : null
    options.db.prepare(
      `UPDATE source_recoveries
       SET status = ?, phase = ?, failure_message = ?, journal_json = ?, completed_at = COALESCE(?, completed_at)
       WHERE id = ?`
    ).run(status, phase, failureMessage, JSON.stringify(journal), completedAt, id)
  }

  function appendJournal(row: RecoveryRow, phase: string, intent: 'prepared' | 'applied'): unknown {
    const journal = row.journal_json ? JSON.parse(row.journal_json) as Array<Record<string, unknown>> : []
    journal.push({ phase, intent, at: new Date().toISOString() })
    return journal
  }

  function confirmSourceRecovery(request: {
    confirmationId: string
    selectedCandidatePath: string
  }): SourceRecoveryOutcome {
    if (consumedConfirmations.has(request.confirmationId)) {
      return { status: 'rejected', reason: 'confirmation-used', message: '恢复确认已使用,请重新预览。' }
    }
    const row = getPersistedRecovery(request.confirmationId)
    if (!row || row.status !== 'previewed') {
      return { status: 'rejected', reason: 'confirmation-not-found', message: '恢复确认不存在或已失效。' }
    }
    const preview = JSON.parse(row.candidates_snapshot) as PersistedPreview
    const selected = preview.candidates.find((c) => resolve(c.path) === resolve(request.selectedCandidatePath))
    if (!selected) {
      return { status: 'rejected', recoveryId: row.id, reason: 'candidate-not-found', message: '所选候选不在预览中,请重新预览并选择。' }
    }
    if (!directoryHashIfAvailable(selected.path)) {
      return { status: 'rejected', recoveryId: row.id, reason: 'candidate-unavailable', message: '所选候选内容不可读,请选择其他候选。' }
    }
    // #91 AC6: 原位置被占用时不覆盖
    if (pathEntryExists(row.canonical_path)) {
      return {
        status: 'rejected',
        recoveryId: row.id,
        reason: 'placement-occupied',
        message: '原 Canonical Placement 已被占用,恢复不会覆盖;请人工处理占用内容后重试。'
      }
    }

    const stage = resolveWithin(canonicalRepositoryPath, `.recovery-stage-${row.id}`)
    if (pathEntryExists(stage)) {
      return { status: 'rejected', recoveryId: row.id, reason: 'plan-stale', message: '恢复 staging 路径被占用,请检查并重试。' }
    }

    // 获取持久化锁(防止并发恢复)
    const resources = [`source:${row.canonical_source_id}`, `skill:${row.skill_name}`, `path:${resolve(row.canonical_path)}`, `path:${resolve(selected.path)}`]
    const acquired = runInTransaction(options.db, () => {
      const existing = options.db.prepare('SELECT resource FROM source_recovery_locks').all() as Array<{ resource: string }>
      const consolidationLocks = options.db.prepare('SELECT resource FROM consolidation_operation_locks').all() as Array<{ resource: string }>
      const relocationLocks = options.db.prepare('SELECT resource FROM source_relocation_locks').all() as Array<{ resource: string }>
      const all = [...existing, ...consolidationLocks, ...relocationLocks].map((r) => r.resource)
      if (resources.some((r) => all.includes(r))) return false
      const insert = options.db.prepare('INSERT INTO source_recovery_locks (resource, recovery_id) VALUES (?, ?)')
      for (const r of resources) insert.run(r, row.id)
      return true
    })
    if (!acquired) {
      return { status: 'rejected', recoveryId: row.id, reason: 'plan-stale', message: '相关资源被其他操作锁定,请稍后重试。' }
    }

    consumedConfirmations.add(request.confirmationId)
    let stageCreated = false
    let canonicalInstalled = false
    let registryCommitted = false
    try {
      // #91 AC5: 通过 staging 恢复到原 Canonical Placement
      let currentRow = getPersistedRecovery(row.id)!
      let journal = appendJournal(currentRow, 'staging', 'prepared')
      markRecovery(row.id, 'previewed', 'staging:prepared', null, journal)
      mkdirSync(dirname(row.canonical_path), { recursive: true })
      cpSync(selected.path, stage, { recursive: true, force: false })
      stageCreated = true
      const stagedHash = hashDir(stage)
      if (stagedHash !== selected.hash) throw new Error('Staged content failed hash verification')
      journal = appendJournal(currentRow, 'staging', 'applied')
      markRecovery(row.id, 'previewed', 'staging:applied', null, journal)

      currentRow = getPersistedRecovery(row.id)!
      journal = appendJournal(currentRow, 'canonical-installed', 'prepared')
      markRecovery(row.id, 'previewed', 'canonical-installed:prepared', null, journal)
      renameSync(stage, row.canonical_path)
      canonicalInstalled = true
      journal = appendJournal(currentRow, 'canonical-installed', 'applied')
      markRecovery(row.id, 'previewed', 'canonical-installed:applied', null, journal)

      currentRow = getPersistedRecovery(row.id)!
      journal = appendJournal(currentRow, 'registry-committed', 'prepared')
      markRecovery(row.id, 'previewed', 'registry-committed:prepared', null, journal)
      runInTransaction(options.db, () => {
        const mtime = Math.floor(statSync(row.canonical_path).mtimeMs)
        options.db.prepare('UPDATE skill_sources SET hash = ?, mtime = ? WHERE id = ?')
          .run(selected.hash, mtime, row.canonical_source_id)
        options.db.prepare(
          `UPDATE source_recoveries
           SET selected_candidate_path = ?, selected_candidate_hash = ?, selected_candidate_kind = ?,
               status = 'completed', phase = 'registry-committed:applied', completed_at = ?
           WHERE id = ?`
        ).run(selected.path, selected.hash, selected.kind, new Date().toISOString(), row.id)
      })
      registryCommitted = true
      journal = appendJournal(currentRow, 'registry-committed', 'applied')
      // 最后一次 markRecovery 用 completed 状态
      markRecovery(row.id, 'completed', null, null, journal)
      options.db.prepare('DELETE FROM source_recovery_locks WHERE recovery_id = ?').run(row.id)
      return {
        status: 'completed',
        recoveryId: row.id,
        canonicalPath: row.canonical_path,
        canonicalHash: selected.hash
      }
    } catch (error) {
      const message = errorMessage(error)
      if (registryCommitted) {
        markRecovery(row.id, 'recovery-required', 'registry-committed:applied', message, appendJournal(getPersistedRecovery(row.id)!, 'registry-committed', 'applied'))
        return { status: 'recovery-required', recoveryId: row.id, message }
      }
      // 补偿:撤回 staging 和已安装的 canonical
      try {
        if (canonicalInstalled && pathEntryExists(row.canonical_path)) {
          renameSync(row.canonical_path, stage)
        }
        if (stageCreated && pathEntryExists(stage)) {
          rmSync(stage, { recursive: true, force: false })
        }
      } catch (compensationError) {
        const combined = `${message}; compensation failed: ${errorMessage(compensationError)}`
        markRecovery(row.id, 'recovery-required', 'compensation-failed', combined, appendJournal(getPersistedRecovery(row.id)!, 'compensation', 'applied'))
        return { status: 'recovery-required', recoveryId: row.id, message: combined }
      }
      markRecovery(row.id, 'failed', null, message, appendJournal(getPersistedRecovery(row.id)!, 'failure', 'applied'))
      options.db.prepare('DELETE FROM source_recovery_locks WHERE recovery_id = ?').run(row.id)
      return { status: 'rejected', recoveryId: row.id, reason: 'plan-stale', message }
    }
  }

  // 引用 skillLibraryFacade 以便未来集成(当前仅用于类型契约)
  void options.skillLibraryFacade

  return {
    previewSourceRecovery,
    confirmSourceRecovery
  }
}
