import { randomUUID } from 'crypto'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync
} from 'fs'
import type { DB } from '../db/database'
import { runInTransaction, setCanonicalRepositoryPath } from '../db/database'
import { getSourceById, getSourceByPath, upsertSource } from '../db/dao/skill-sources'
import { getAllSkills, getSkillById, updatePrimarySourcePath, upsertSkill } from '../db/dao/skills'
import { getDeploymentsBySkillId } from '../db/dao/deployments'
import type { Deployment, SkillSource, SourceOrigin } from '../types'
import { createBackup } from './backup'
import { hashDir } from './hash'
import { assertAbsolutePath, resolveWithin, validateSkillName } from './path-safety'

export type SkillLibrarySource = SkillSource
export type ConsolidationBatchStatus = 'previewed' | 'completed' | 'failed' | 'recovery-required' | 'undone'

export interface SkillLibrarySkill {
  id: number
  name: string
  canonicalSource: SkillLibrarySource | null
  candidates: SkillLibrarySource[]
}

export interface ConsolidationBatchSummary {
  id: string
  status: ConsolidationBatchStatus
  items: Array<{ skillId: number; skillName: string; canonicalPath: string; archivePath: string }>
  phase: string | null
  createdAt: string
  completedAt: string | null
  undoneAt: string | null
  failureMessage: string | null
}

export interface SkillLibraryReadModel {
  canonicalRepository: { path: string }
  skills: SkillLibrarySkill[]
  consolidationBatches: ConsolidationBatchSummary[]
}

export type ConsolidationPreview = {
  status: 'confirmation-required'
  confirmationId: string
  batchId: string
  skillId: number
  skillName: string
  operations: Array<{
    kind: 'write-canonical' | 'archive-candidate' | 'remove-observed-entry'
    path: string
  }>
}

export type ConsolidationOutcome =
  | { status: 'completed'; batchId: string; skillId: number; canonicalPath: string }
  | { status: 'rejected'; batchId?: string; reason: 'confirmation-not-found' | 'plan-stale' | 'restore-path-occupied' | 'batch-not-undoable'; message: string }
  | { status: 'recovery-required'; batchId: string; message: string }

export interface SkillLibraryFacade {
  read(): SkillLibraryReadModel
  previewConsolidation(request: { candidateSourceId: number; canonicalRelativeParent: string }): ConsolidationPreview
  confirmConsolidation(confirmationId: string): ConsolidationOutcome
  undoConsolidation(batchId: string): ConsolidationOutcome | { status: 'undone'; batchId: string }
  replaceCanonicalSource(request: {
    sourceDirectory: string
    skillName: string
    origin: Extract<SourceOrigin, 'github' | 'zip'>
    repoUrl?: string
    commitSha?: string
  }): { skillId: number; sourcePath: string; overwritten: boolean }
}

interface BatchRow {
  id: string
  status: ConsolidationBatchStatus
  phase: string | null
  evidence_json: string | null
  created_at: string
  completed_at: string | null
  undone_at: string | null
  failure_message: string | null
}

interface ItemRow {
  batch_id: string
  skill_id: number
  skill_name: string
  candidate_source_snapshot: string
  observed_deployments_snapshot: string
  canonical_path: string
  archive_path: string
  canonical_hash: string | null
}

interface ObservedEntrySnapshot {
  deployment: Deployment
  /** Preserve the exact link payload so undo restores relative links as relative links. */
  linkTarget: string
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function restoreSourceSnapshot(db: DB, source: SkillSource): void {
  db.prepare(`INSERT INTO skill_sources
    (id, skill_id, path, hash, mtime, source_type, source_role, source_origin, source_tool,
     source_root_id, discovered_at, repo_url, commit_sha)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(source.id, source.skill_id, source.path, source.hash, source.mtime, source.source_type,
    source.source_role, source.source_origin, source.source_tool, source.source_root_id,
    source.discovered_at, source.repo_url, source.commit_sha)
}

function restoreDeploymentSnapshot(db: DB, deployment: Deployment): void {
  db.prepare(`INSERT INTO deployments
    (id, skill_id, target_tool, target_path, mode, management, source_path, deployed_at,
     source_hash_at_deploy, source_id, target_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(deployment.id, deployment.skill_id, deployment.target_tool, deployment.target_path,
    deployment.mode, deployment.management, deployment.source_path, deployment.deployed_at,
    deployment.source_hash_at_deploy, deployment.source_id, deployment.target_id)
}

export function createSkillLibraryFacade(options: {
  db: DB
  canonicalRepositoryPath: string
  sourceArchivePath?: string
  backupsDir?: string
}): SkillLibraryFacade {
  const canonicalRepositoryPath = resolve(assertAbsolutePath(options.canonicalRepositoryPath, 'Canonical Repository path'))
  const sourceArchivePath = resolve(assertAbsolutePath(
    options.sourceArchivePath ?? resolve(canonicalRepositoryPath, '..', 'source-archive'),
    'Source Archive path'
  ))
  const backupsDir = resolve(assertAbsolutePath(
    options.backupsDir ?? resolve(canonicalRepositoryPath, '..', 'skill-backups'),
    'backups directory'
  ))
  setCanonicalRepositoryPath(options.db, canonicalRepositoryPath)
  mkdirSync(canonicalRepositoryPath, { recursive: true })

  function getPersistedBatch(id: string): { batch: BatchRow; items: ItemRow[] } | null {
    const batch = options.db.prepare('SELECT * FROM consolidation_batches WHERE id = ?').get(id) as BatchRow | undefined
    if (!batch) return null
    const items = options.db.prepare('SELECT * FROM consolidation_items WHERE batch_id = ? ORDER BY id ASC').all(id) as ItemRow[]
    return items.length > 0 ? { batch, items } : null
  }

  function requireSingleItem(items: ItemRow[]): ItemRow {
    if (items.length !== 1) throw new Error('Single-source consolidation requires exactly one batch item')
    return items[0]
  }

  function observedForSource(source: SkillSource): Deployment[] {
    return getDeploymentsBySkillId(options.db, source.skill_id)
      .filter((deployment) => deployment.source_id === source.id && deployment.management === 'observed')
      .sort((a, b) => a.id - b.id)
  }

  function allKnownRelationsForSource(source: SkillSource): Deployment[] {
    return getDeploymentsBySkillId(options.db, source.skill_id)
      .filter((deployment) => deployment.source_id === source.id ||
        (deployment.source_id == null && resolve(deployment.source_path) === resolve(source.path)))
      .sort((a, b) => a.id - b.id)
  }

  function assertObservedLink(deployment: Deployment, sourcePath: string): void {
    if (!deployment.target_path || !pathEntryExists(deployment.target_path) || !lstatSync(deployment.target_path).isSymbolicLink()) {
      throw new Error(`Observed Subscription is no longer a directory link: ${deployment.target_path ?? deployment.id}`)
    }
    const linked = resolve(dirname(deployment.target_path), readlinkSync(deployment.target_path))
    if (linked !== resolve(sourcePath)) throw new Error(`Observed Subscription changed target: ${deployment.target_path}`)
  }


  function snapshotObservedEntry(deployment: Deployment): ObservedEntrySnapshot {
    assertObservedLink(deployment, deployment.source_path)
    return { deployment, linkTarget: readlinkSync(deployment.target_path!) }
  }

  function restoreObservedEntry(snapshot: ObservedEntrySnapshot): void {
    mkdirSync(dirname(snapshot.deployment.target_path!), { recursive: true })
    symlinkSync(snapshot.linkTarget, snapshot.deployment.target_path!,
      snapshot.deployment.mode === 'junction' ? 'junction' : 'dir')
  }

  function canonicalPlacement(skillName: string, relativeParent: string): string {
    if (typeof relativeParent !== 'string' || isAbsolute(relativeParent)) throw new Error('Canonical Placement must be relative')
    const trimmed = relativeParent.trim()
    const placement = resolveWithin(canonicalRepositoryPath, ...(trimmed ? trimmed.split(/[\\/]+/) : []), skillName)
    assertCanonicalParentConfined(placement)
    return placement
  }

  function assertCanonicalParentConfined(placement: string): void {
    const canonicalReal = realpathSync(canonicalRepositoryPath)
    let ancestor = dirname(placement)
    while (!pathEntryExists(ancestor)) {
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new Error('Canonical Placement has no existing parent')
      ancestor = parent
    }
    const ancestorReal = realpathSync(ancestor)
    const rel = relative(canonicalReal, ancestorReal)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('Canonical Placement escapes the Canonical Repository through a symbolic link')
    }
  }

  function previewConsolidation(request: { candidateSourceId: number; canonicalRelativeParent: string }): ConsolidationPreview {
    if (!Number.isInteger(request.candidateSourceId)) throw new Error('candidateSourceId must be an integer')
    const source = getSourceById(options.db, request.candidateSourceId)
    if (!source || source.source_role !== 'candidate') throw new Error('Consolidation requires a Candidate Source ID')
    const skill = getSkillById(options.db, source.skill_id)
    if (!skill) throw new Error('Candidate Source Skill does not exist')
    if (!existsSync(source.path) || !statSync(source.path).isDirectory()) throw new Error('Candidate Source is unavailable')
    const currentHash = hashDir(source.path)
    if (currentHash !== source.hash) throw new Error('Candidate Source changed; rescan before consolidation')
    if (getAllSkills(options.db).find((item) => item.id === skill.id)?.sources.some((candidate) => candidate.source_role === 'canonical')) {
      throw new Error('Skill already has a canonical Source')
    }
    const siblingCandidates = getAllSkills(options.db).find((item) => item.id === skill.id)?.sources
      .filter((candidate) => candidate.source_role === 'candidate' && candidate.id !== source.id) ?? []
    if (siblingCandidates.length > 0) throw new Error('Single-source consolidation requires exactly one Candidate Source')
    const canonicalPath = canonicalPlacement(validateSkillName(skill.name), request.canonicalRelativeParent)
    if (pathEntryExists(canonicalPath)) throw new Error('Canonical Placement is occupied')
    const batchId = randomUUID()
    const archivePath = resolveWithin(sourceArchivePath, batchId, 'source', skill.name)
    const allRelations = allKnownRelationsForSource(source)
    if (allRelations.some((deployment) => deployment.source_id == null)) {
      throw new Error('Candidate Source has an unresolved legacy Deployment; reconcile it before consolidation')
    }
    if (allRelations.some((deployment) => deployment.management !== 'observed')) {
      throw new Error('Candidate Source has a Managed Deployment and cannot be consolidated')
    }
    const observed = observedForSource(source)
    for (const deployment of observed) assertObservedLink(deployment, source.path)
    const observedSnapshots = observed.map(snapshotObservedEntry)
    const createdAt = new Date().toISOString()
    runInTransaction(options.db, () => {
      options.db.prepare("INSERT INTO consolidation_batches (id, status, created_at) VALUES (?, 'previewed', ?)").run(batchId, createdAt)
      options.db.prepare(`INSERT INTO consolidation_items
        (batch_id, skill_id, skill_name, candidate_source_snapshot, observed_deployments_snapshot, canonical_path, archive_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(batchId, skill.id, skill.name, JSON.stringify(source), JSON.stringify(observedSnapshots), canonicalPath, archivePath)
    })
    return {
      status: 'confirmation-required', confirmationId: batchId, batchId, skillId: skill.id, skillName: skill.name,
      operations: [
        { kind: 'write-canonical', path: canonicalPath },
        { kind: 'archive-candidate', path: archivePath },
        ...observed.map((deployment) => ({ kind: 'remove-observed-entry' as const, path: deployment.target_path! }))
      ]
    }
  }

  function validatePlan(batch: BatchRow, item: ItemRow): { source: SkillSource; observed: ObservedEntrySnapshot[] } {
    if (batch.status !== 'previewed') throw new Error('Confirmation is no longer pending')
    const sourceSnapshot = JSON.parse(item.candidate_source_snapshot) as SkillSource
    const observedSnapshot = JSON.parse(item.observed_deployments_snapshot) as ObservedEntrySnapshot[]
    const source = getSourceById(options.db, sourceSnapshot.id)
    if (!source || source.source_role !== 'candidate' || JSON.stringify(source) !== JSON.stringify(sourceSnapshot)) throw new Error('Candidate Source registration changed')
    const currentSkillSources = getAllSkills(options.db).find((skill) => skill.id === source.skill_id)?.sources ?? []
    if (currentSkillSources.length !== 1 || currentSkillSources[0].id !== source.id) {
      throw new Error('Skill Source set changed')
    }
    if (!existsSync(source.path) || hashDir(source.path) !== sourceSnapshot.hash) throw new Error('Candidate Source content changed')
    assertCanonicalParentConfined(item.canonical_path)
    if (pathEntryExists(item.canonical_path) || pathEntryExists(item.archive_path)) throw new Error('Destination or Source Archive is occupied')
    const sourceRollback = resolveWithin(dirname(source.path), `.${basename(source.path)}.skill-switch-${batch.id}`)
    if (pathEntryExists(sourceRollback)) throw new Error('Candidate Source rollback path is occupied')
    const currentRelations = allKnownRelationsForSource(source)
    if (currentRelations.some((deployment) => deployment.source_id == null || deployment.management !== 'observed')) {
      throw new Error('Candidate Source Deployment set became unresolved or managed')
    }
    const observed = currentRelations.map(snapshotObservedEntry)
    if (JSON.stringify(observed) !== JSON.stringify(observedSnapshot)) throw new Error('Observed Subscription set changed')
    for (const snapshot of observed) {
      const archivePath = resolveWithin(sourceArchivePath, batch.id, 'links', String(snapshot.deployment.id))
      const rollbackPath = resolveWithin(dirname(snapshot.deployment.target_path!), `.${basename(snapshot.deployment.target_path!)}.skill-switch-${batch.id}`)
      if (pathEntryExists(archivePath) || pathEntryExists(rollbackPath)) throw new Error('Observed Subscription archive or rollback path is occupied')
    }
    return { source, observed }
  }

  function markBatch(id: string, status: ConsolidationBatchStatus, failure?: string, phase?: string | null, evidence?: unknown): void {
    const completed = status === 'completed' ? new Date().toISOString() : null
    const undone = status === 'undone' ? new Date().toISOString() : null
    options.db.prepare('UPDATE consolidation_batches SET status = ?, phase = ?, evidence_json = COALESCE(?, evidence_json), completed_at = COALESCE(?, completed_at), undone_at = COALESCE(?, undone_at), failure_message = ? WHERE id = ?')
      .run(status, phase ?? null, evidence === undefined ? null : JSON.stringify(evidence), completed, undone, failure ?? null, id)
  }

  function confirmConsolidation(confirmationId: string): ConsolidationOutcome {
    const persisted = getPersistedBatch(confirmationId)
    if (!persisted) return { status: 'rejected', reason: 'confirmation-not-found', message: 'Consolidation confirmation does not exist.' }
    if (persisted.batch.phase !== null || persisted.batch.status === 'recovery-required') {
      return { status: 'recovery-required', batchId: persisted.batch.id, message: persisted.batch.failure_message ?? 'Consolidation was interrupted and requires recovery.' }
    }
    let item: ItemRow
    try {
      item = requireSingleItem(persisted.items)
    } catch (error) {
      return { status: 'rejected', batchId: persisted.batch.id, reason: 'plan-stale', message: errorMessage(error) }
    }
    let plan: { source: SkillSource; observed: ObservedEntrySnapshot[] }
    try {
      plan = validatePlan(persisted.batch, item)
    } catch (error) {
      if (persisted.batch.status === 'previewed') markBatch(persisted.batch.id, 'failed', errorMessage(error))
      return { status: 'rejected', batchId: persisted.batch.id, reason: 'plan-stale', message: errorMessage(error) }
    }
    const { batch } = persisted
    const stage = resolveWithin(canonicalRepositoryPath, `.consolidation-stage-${batch.id}`)
    const sourceRollback = resolveWithin(dirname(plan.source.path), `.${basename(plan.source.path)}.skill-switch-${batch.id}`)
    const displacedLinks: Array<ObservedEntrySnapshot & { rollbackPath: string; archivePath: string }> = []
    const evidence = {
      sourcePath: plan.source.path,
      sourceRollback,
      canonicalPath: item.canonical_path,
      canonicalStage: stage,
      archivePath: item.archive_path,
      toolEntries: plan.observed.map((snapshot) => ({
        targetPath: snapshot.deployment.target_path!,
        rollbackPath: resolveWithin(dirname(snapshot.deployment.target_path!), `.${basename(snapshot.deployment.target_path!)}.skill-switch-${batch.id}`),
        archivePath: resolveWithin(sourceArchivePath, batch.id, 'links', String(snapshot.deployment.id))
      }))
    }
    let sourceArchived = false
    let canonicalInstalled = false
    try {
      markBatch(batch.id, 'previewed', undefined, 'staging', evidence)
      mkdirSync(dirname(item.canonical_path), { recursive: true })
      mkdirSync(dirname(item.archive_path), { recursive: true })
      cpSync(plan.source.path, stage, { recursive: true, force: false })
      const canonicalHash = hashDir(stage)
      if (canonicalHash !== plan.source.hash) throw new Error('Staged canonical content failed hash verification')
      cpSync(plan.source.path, item.archive_path, { recursive: true, force: false })
      if (hashDir(item.archive_path) !== plan.source.hash) throw new Error('Source Archive failed hash verification')
      renameSync(plan.source.path, sourceRollback)
      sourceArchived = true
      markBatch(batch.id, 'previewed', undefined, 'source-displaced', evidence)
      for (const snapshot of plan.observed) {
        const archivePath = resolveWithin(sourceArchivePath, batch.id, 'links', String(snapshot.deployment.id))
        const rollbackPath = resolveWithin(dirname(snapshot.deployment.target_path!), `.${basename(snapshot.deployment.target_path!)}.skill-switch-${batch.id}`)
        if (pathEntryExists(archivePath) || pathEntryExists(rollbackPath)) throw new Error('Observed Subscription archive or rollback path is occupied')
        mkdirSync(dirname(archivePath), { recursive: true })
        symlinkSync(snapshot.linkTarget, archivePath, snapshot.deployment.mode === 'junction' ? 'junction' : 'dir')
        if (readlinkSync(archivePath) !== snapshot.linkTarget) throw new Error('Observed Subscription archive verification failed')
        renameSync(snapshot.deployment.target_path!, rollbackPath)
        displacedLinks.push({ ...snapshot, rollbackPath, archivePath })
      }
      markBatch(batch.id, 'previewed', undefined, 'entries-displaced', evidence)
      renameSync(stage, item.canonical_path)
      canonicalInstalled = true
      markBatch(batch.id, 'previewed', undefined, 'canonical-installed', evidence)
      runInTransaction(options.db, () => {
        for (const snapshot of plan.observed) options.db.prepare('DELETE FROM deployments WHERE id = ?').run(snapshot.deployment.id)
        options.db.prepare('DELETE FROM skill_sources WHERE id = ?').run(plan.source.id)
        updatePrimarySourcePath(options.db, plan.source.skill_id, item.canonical_path)
        upsertSource(options.db, plan.source.skill_id, item.canonical_path, canonicalHash,
          Math.floor(statSync(item.canonical_path).mtimeMs), 'central-repo', { role: 'canonical', origin: 'local' })
        options.db.prepare("UPDATE consolidation_items SET canonical_hash = ? WHERE batch_id = ?").run(canonicalHash, batch.id)
      })
      try {
        rmSync(sourceRollback, { recursive: true, force: false })
        for (const snapshot of displacedLinks) rmSync(snapshot.rollbackPath, { force: false })
      } catch (cleanupError) {
        const message = `Consolidation committed but rollback cleanup failed: ${errorMessage(cleanupError)}`
        markBatch(batch.id, 'recovery-required', message, 'cleanup-failed', evidence)
        return { status: 'recovery-required', batchId: batch.id, message }
      }
      try {
        markBatch(batch.id, 'completed', undefined, null, evidence)
      } catch (statusError) {
        return { status: 'recovery-required', batchId: batch.id, message: `Consolidation committed but status persistence failed: ${errorMessage(statusError)}` }
      }
      return { status: 'completed', batchId: batch.id, skillId: item.skill_id, canonicalPath: item.canonical_path }
    } catch (error) {
      let compensationError: unknown
      try {
        if (canonicalInstalled && pathEntryExists(item.canonical_path)) renameSync(item.canonical_path, stage)
        for (const snapshot of [...displacedLinks].reverse()) {
          if (pathEntryExists(snapshot.rollbackPath) && !pathEntryExists(snapshot.deployment.target_path!)) {
            renameSync(snapshot.rollbackPath, snapshot.deployment.target_path!)
          }
          rmSync(snapshot.archivePath, { force: true })
        }
        if (sourceArchived && pathEntryExists(sourceRollback) && !pathEntryExists(plan.source.path)) renameSync(sourceRollback, plan.source.path)
        rmSync(item.archive_path, { recursive: true, force: true })
        rmSync(stage, { recursive: true, force: true })
        rmSync(resolveWithin(sourceArchivePath, batch.id), { recursive: true, force: true })
      } catch (compensationFailure) {
        compensationError = compensationFailure
      }
      if (compensationError) {
        const message = `${errorMessage(error)}; compensation failed: ${errorMessage(compensationError)}`
        markBatch(batch.id, 'recovery-required', message, 'compensation-failed', evidence)
        return { status: 'recovery-required', batchId: batch.id, message }
      }
      markBatch(batch.id, 'failed', errorMessage(error), null, evidence)
      return { status: 'rejected', batchId: batch.id, reason: 'plan-stale', message: errorMessage(error) }
    }
  }

  function undoConsolidation(batchId: string): ConsolidationOutcome | { status: 'undone'; batchId: string } {
    const persisted = getPersistedBatch(batchId)
    if (!persisted || persisted.batch.status !== 'completed') {
      return { status: 'rejected', batchId, reason: 'batch-not-undoable', message: 'Consolidation Batch is not completed.' }
    }
    let item: ItemRow
    try { item = requireSingleItem(persisted.items) } catch (error) {
      return { status: 'rejected', batchId, reason: 'batch-not-undoable', message: errorMessage(error) }
    }
    const sourceSnapshot = JSON.parse(item.candidate_source_snapshot) as SkillSource
    const observedSnapshots = JSON.parse(item.observed_deployments_snapshot) as ObservedEntrySnapshot[]
    const deployments = observedSnapshots.map((snapshot) => snapshot.deployment)
    if (pathEntryExists(sourceSnapshot.path) || deployments.some((deployment) => deployment.target_path && pathEntryExists(deployment.target_path))) {
      return { status: 'rejected', batchId, reason: 'restore-path-occupied', message: 'An original Source or tool entry path is occupied.' }
    }
    const canonical = getSourceByPath(options.db, item.canonical_path)
    if (!canonical || canonical.source_role !== 'canonical' || !existsSync(canonical.path) || hashDir(canonical.path) !== item.canonical_hash) {
      return { status: 'rejected', batchId, reason: 'plan-stale', message: 'Canonical Source changed after consolidation.' }
    }
    if (getDeploymentsBySkillId(options.db, canonical.skill_id).some((deployment) => deployment.source_id === canonical.id)) {
      return { status: 'rejected', batchId, reason: 'plan-stale', message: 'Canonical Source has subsequent Deployments.' }
    }
    if (!existsSync(item.archive_path) || hashDir(item.archive_path) !== sourceSnapshot.hash) {
      return { status: 'rejected', batchId, reason: 'plan-stale', message: 'Source Archive changed after consolidation.' }
    }
    for (const snapshot of observedSnapshots) {
      const archivedLink = resolveWithin(sourceArchivePath, batchId, 'links', String(snapshot.deployment.id))
      if (!pathEntryExists(archivedLink) || !lstatSync(archivedLink).isSymbolicLink() || readlinkSync(archivedLink) !== snapshot.linkTarget) {
        return { status: 'rejected', batchId, reason: 'plan-stale', message: 'Archived tool entry changed after consolidation.' }
      }
    }
    const canonicalRollback = resolveWithin(canonicalRepositoryPath, `.consolidation-undo-${batchId}`)
    if (pathEntryExists(canonicalRollback)) {
      return { status: 'rejected', batchId, reason: 'restore-path-occupied', message: 'Canonical rollback path is occupied.' }
    }
    let canonicalMoved = false
    let sourceRestored = false
    const restoredLinks: Array<{ target: string; archive: string }> = []
    const undoEvidence = {
      canonicalPath: canonical.path,
      canonicalRollback,
      sourcePath: sourceSnapshot.path,
      archivePath: item.archive_path,
      toolEntries: observedSnapshots.map((snapshot) => ({ targetPath: snapshot.deployment.target_path }))
    }
    try {
      markBatch(batchId, 'completed', undefined, 'restoring', undoEvidence)
      mkdirSync(dirname(sourceSnapshot.path), { recursive: true })
      renameSync(canonical.path, canonicalRollback)
      canonicalMoved = true
      cpSync(item.archive_path, sourceSnapshot.path, { recursive: true, force: false })
      if (hashDir(sourceSnapshot.path) !== sourceSnapshot.hash) throw new Error('Restored Candidate Source failed hash verification')
      sourceRestored = true
      observedSnapshots.forEach((snapshot) => {
        restoreObservedEntry(snapshot)
        restoredLinks.push({ target: snapshot.deployment.target_path!, archive: '' })
      })
      runInTransaction(options.db, () => {
        options.db.prepare('DELETE FROM skill_sources WHERE id = ?').run(canonical.id)
        restoreSourceSnapshot(options.db, sourceSnapshot)
        for (const deployment of deployments) restoreDeploymentSnapshot(options.db, deployment)
        updatePrimarySourcePath(options.db, sourceSnapshot.skill_id, sourceSnapshot.path)
      })
      // The authority has already been removed from its canonical placement. Cleanup
      // failures must not compensate a committed DB transaction back into inconsistency;
      // leftover copies remain inside controlled storage as recovery evidence.
      try {
        rmSync(canonicalRollback, { recursive: true, force: false })
      } catch (cleanupError) {
        const message = `Undo committed but canonical rollback cleanup failed: ${errorMessage(cleanupError)}`
        markBatch(batchId, 'recovery-required', message, 'undo-cleanup-failed', undoEvidence)
        return { status: 'recovery-required', batchId, message }
      }
      try {
        markBatch(batchId, 'undone', undefined, null, undoEvidence)
      } catch (statusError) {
        return { status: 'recovery-required', batchId, message: `Undo committed but status persistence failed: ${errorMessage(statusError)}` }
      }
      return { status: 'undone', batchId }
    } catch (error) {
      let compensationError: unknown
      try {
        for (const link of [...restoredLinks].reverse()) if (pathEntryExists(link.target)) rmSync(link.target, { force: false })
        if (sourceRestored && pathEntryExists(sourceSnapshot.path)) rmSync(sourceSnapshot.path, { recursive: true, force: false })
        if (canonicalMoved && pathEntryExists(canonicalRollback)) renameSync(canonicalRollback, canonical.path)
      } catch (compensationFailure) {
        compensationError = compensationFailure
      }
      const message = compensationError ? `${errorMessage(error)}; compensation failed: ${errorMessage(compensationError)}` : errorMessage(error)
      markBatch(batchId, compensationError ? 'recovery-required' : 'completed', message,
        compensationError ? 'undo-compensation-failed' : null, undoEvidence)
      return compensationError
        ? { status: 'recovery-required', batchId, message }
        : { status: 'rejected', batchId, reason: 'plan-stale', message }
    }
  }

  function replaceCanonicalSource(request: {
    sourceDirectory: string
    skillName: string
    origin: Extract<SourceOrigin, 'github' | 'zip'>
    repoUrl?: string
    commitSha?: string
  }) {
    const sourceDirectory = resolve(assertAbsolutePath(request.sourceDirectory, 'Canonical Source input'))
    const skillName = validateSkillName(request.skillName)
    const destination = resolveWithin(canonicalRepositoryPath, skillName)
    const stage = resolveWithin(canonicalRepositoryPath, `.stage-${skillName}-${randomUUID()}`)
    const rollback = resolveWithin(canonicalRepositoryPath, `.rollback-${skillName}-${randomUUID()}`)
    const overwritten = existsSync(destination)
    cpSync(sourceDirectory, stage, { recursive: true, force: true })
    const hash = hashDir(stage)
    const mtime = Math.floor(statSync(stage).mtimeMs)
    let displaced = false
    try {
      if (overwritten) {
        createBackup({ skillName, targetTool: 'central-repo', sourcePath: destination, backupsDir })
        renameSync(destination, rollback)
        displaced = true
      }
      renameSync(stage, destination)
      const skillId = runInTransaction(options.db, () => {
        const id = upsertSkill(options.db, skillName, destination)
        upsertSource(options.db, id, destination, hash, mtime, 'central-repo', {
          origin: request.origin, role: 'canonical', repoUrl: request.repoUrl, commitSha: request.commitSha
        })
        return id
      })
      if (displaced) rmSync(rollback, { recursive: true, force: true })
      return { skillId, sourcePath: destination, overwritten }
    } catch (error) {
      rmSync(stage, { recursive: true, force: true })
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true })
      if (displaced && existsSync(rollback)) renameSync(rollback, destination)
      throw error
    }
  }

  return {
    previewConsolidation,
    confirmConsolidation,
    undoConsolidation,
    replaceCanonicalSource,
    read() {
      options.db.prepare(`UPDATE consolidation_batches
        SET status = 'recovery-required',
            failure_message = COALESCE(failure_message, 'Consolidation was interrupted; inspect persisted recovery evidence.')
        WHERE phase IS NOT NULL AND status IN ('previewed', 'completed')`).run()
      const skills = getAllSkills(options.db).map((skill) => {
        const canonicalSources = skill.sources.filter((source) => source.source_role === 'canonical')
        if (canonicalSources.length > 1) throw new Error(`Skill ${skill.name} has multiple canonical Sources`)
        return { id: skill.id, name: skill.name, canonicalSource: canonicalSources[0] ?? null,
          candidates: skill.sources.filter((source) => source.source_role === 'candidate') }
      })
      const batches = options.db.prepare('SELECT * FROM consolidation_batches ORDER BY created_at DESC').all() as BatchRow[]
      return {
        canonicalRepository: { path: canonicalRepositoryPath }, skills,
        consolidationBatches: batches.map((batch) => ({
          id: batch.id, status: batch.status,
          items: (options.db.prepare('SELECT skill_id, skill_name, canonical_path, archive_path FROM consolidation_items WHERE batch_id = ? ORDER BY id ASC').all(batch.id) as Array<{ skill_id: number; skill_name: string; canonical_path: string; archive_path: string }>).map((item) => ({
            skillId: item.skill_id, skillName: item.skill_name, canonicalPath: item.canonical_path, archivePath: item.archive_path
          })),
          phase: batch.phase, createdAt: batch.created_at,
          completedAt: batch.completed_at, undoneAt: batch.undone_at, failureMessage: batch.failure_message
        }))
      }
    }
  }
}
