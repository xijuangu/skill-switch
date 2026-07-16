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
  rmdirSync,
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
  recoveryDirection: 'rollback-consolidation' | 'finish-cleanup' | 'rollback-undo' | 'inspect' | null
  evidenceSummary: { itemCount: number; phases: string[] }
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

export type ConsolidationBatchPreview = {
  status: 'confirmation-required'
  confirmationId: string
  batchId: string
  items: Array<{ skillId: number; skillName: string; canonicalPath: string }>
  operations: ConsolidationPreview['operations']
}

export type ConsolidationOutcome =
  | { status: 'completed'; batchId: string; skillId: number; canonicalPath: string; items?: Array<{ skillId: number; canonicalPath: string }> }
  | { status: 'rejected'; batchId?: string; reason: 'confirmation-not-found' | 'plan-stale' | 'restore-path-occupied' | 'batch-not-undoable' | 'batch-busy'; message: string }
  | { status: 'recovery-required'; batchId: string; message: string }

export interface SkillLibraryFacade {
  read(): SkillLibraryReadModel
  previewConsolidation(request: { candidateSourceId: number; canonicalRelativeParent: string }): ConsolidationPreview
  previewConsolidationBatch(request: { items: Array<{ candidateSourceId: number; canonicalRelativeParent: string }> }): ConsolidationBatchPreview
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
  id: number
  batch_id: string
  skill_id: number
  skill_name: string
  candidate_source_snapshot: string
  observed_deployments_snapshot: string
  canonical_path: string
  archive_path: string
  canonical_hash: string | null
  phase: string | null
  evidence_json: string | null
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
  consolidationHooks?: {
    onPhase?: (event: { batchId: string; itemIndex: number; phase: string }) => void
    afterRegistryCommit?: (event: { batchId: string }) => void
    onFaultPoint?: (event: { batchId: string; itemIndex: number; point: 'before-registry-commit' | 'before-cleanup' | 'before-compensation' }) => void
  }
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
  // A non-terminal persisted phase at process startup is interrupted work, not a normal preview.
  options.db.prepare(`UPDATE consolidation_batches
    SET status = 'recovery-required',
        failure_message = COALESCE(failure_message, 'Consolidation was interrupted; inspect persisted recovery evidence.')
    WHERE status IN ('previewed', 'completed') AND (
      phase IS NOT NULL OR id IN (SELECT batch_id FROM consolidation_items WHERE phase IS NOT NULL)
      OR id IN (SELECT batch_id FROM consolidation_operation_locks)
    )`).run()
  options.db.prepare(`DELETE FROM consolidation_operation_locks
    WHERE batch_id IN (SELECT id FROM consolidation_batches WHERE phase IS NULL AND status IN ('failed', 'completed', 'undone'))`).run()

  function getPersistedBatch(id: string): { batch: BatchRow; items: ItemRow[] } | null {
    const batch = options.db.prepare('SELECT * FROM consolidation_batches WHERE id = ?').get(id) as BatchRow | undefined
    if (!batch) return null
    const items = options.db.prepare('SELECT * FROM consolidation_items WHERE batch_id = ? ORDER BY id ASC').all(id) as ItemRow[]
    return items.length > 0 ? { batch, items } : null
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

  function buildPreviewItem(request: { candidateSourceId: number; canonicalRelativeParent: string }, batchId: string) {
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
    return { source, skill, canonicalPath, archivePath, observed, observedSnapshots }
  }

  function previewConsolidationBatch(request: { items: Array<{ candidateSourceId: number; canonicalRelativeParent: string }> }): ConsolidationBatchPreview {
    if (!Array.isArray(request.items) || request.items.length === 0) throw new Error('Consolidation Batch requires at least one item')
    const batchId = randomUUID()
    const prepared = request.items.map((item) => buildPreviewItem(item, batchId))
    if (new Set(prepared.map((item) => item.source.id)).size !== prepared.length) throw new Error('Consolidation Batch contains a duplicate Candidate Source')
    if (new Set(prepared.map((item) => item.skill.id)).size !== prepared.length) throw new Error('Consolidation Batch contains multiple items for one Skill')
    if (new Set(prepared.map((item) => resolve(item.canonicalPath))).size !== prepared.length) throw new Error('Consolidation Batch contains duplicate Canonical Placements')
    const claimedPaths = prepared.flatMap((item) => [item.source.path, item.canonicalPath, ...item.observed.map((entry) => entry.target_path!)].map((path) => resolve(path)))
    const overlaps = claimedPaths.some((path, index) => claimedPaths.some((other, otherIndex) => {
      if (index >= otherIndex) return false
      const rel = relative(path, other)
      const reverse = relative(other, path)
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) ||
        (reverse !== '..' && !reverse.startsWith(`..${sep}`) && !isAbsolute(reverse))
    }))
    if (overlaps) throw new Error('Consolidation Batch contains overlapping filesystem resources')
    const createdAt = new Date().toISOString()
    runInTransaction(options.db, () => {
      options.db.prepare("INSERT INTO consolidation_batches (id, status, created_at) VALUES (?, 'previewed', ?)").run(batchId, createdAt)
      const insert = options.db.prepare(`INSERT INTO consolidation_items
        (batch_id, skill_id, skill_name, candidate_source_snapshot, observed_deployments_snapshot, canonical_path, archive_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      for (const item of prepared) insert.run(batchId, item.skill.id, item.skill.name, JSON.stringify(item.source), JSON.stringify(item.observedSnapshots), item.canonicalPath, item.archivePath)
    })
    return {
      status: 'confirmation-required', confirmationId: batchId, batchId,
      items: prepared.map((item) => ({ skillId: item.skill.id, skillName: item.skill.name, canonicalPath: item.canonicalPath })),
      operations: prepared.flatMap((item) => [
        { kind: 'write-canonical' as const, path: item.canonicalPath },
        { kind: 'archive-candidate' as const, path: item.archivePath },
        ...item.observed.map((deployment) => ({ kind: 'remove-observed-entry' as const, path: deployment.target_path! }))
      ])
    }
  }

  function previewConsolidation(request: { candidateSourceId: number; canonicalRelativeParent: string }): ConsolidationPreview {
    const preview = previewConsolidationBatch({ items: [request] })
    const item = preview.items[0]
    return { ...preview, skillId: item.skillId, skillName: item.skillName }
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

  function markItem(item: ItemRow, batchId: string, itemIndex: number, phase: string, evidence: unknown, intent: 'prepared' | 'applied', batchStatus: ConsolidationBatchStatus = 'previewed'): void {
    if (typeof evidence === 'object' && evidence !== null) {
      const journal = ((evidence as { journal?: Array<{ phase: string; intent: string }> }).journal ??= [])
      journal.push({ phase, intent })
    }
    runInTransaction(options.db, () => {
      options.db.prepare('UPDATE consolidation_items SET phase = ?, evidence_json = ? WHERE id = ?')
        .run(`${phase}:${intent}`, JSON.stringify(evidence), item.id)
      markBatch(batchId, batchStatus, undefined, `consolidating:${itemIndex}:${phase}:${intent}`, { itemIndex, phase, intent })
    })
    if (intent === 'applied') options.consolidationHooks?.onPhase?.({ batchId, itemIndex, phase })
  }

  function resourcesForItems(items: ItemRow[]): string[] {
    return items.flatMap((item) => {
      const source = JSON.parse(item.candidate_source_snapshot) as SkillSource
      const observed = JSON.parse(item.observed_deployments_snapshot) as ObservedEntrySnapshot[]
      return [
        `source:${source.id}`,
        `skill:${item.skill_name}`,
        `path:${resolve(source.path)}`,
        `path:${resolve(item.canonical_path)}`,
        ...observed.map((entry) => `path:${resolve(entry.deployment.target_path!)}`)
      ]
    })
  }

  function acquireDurableLocks(
    batchId: string,
    resources: string[],
    phase: 'consolidation-lock-acquired' | 'undo-lock-acquired'
  ): boolean {
    const ordered = [...new Set(resources)].sort()
    return runInTransaction(options.db, () => {
      const existing = options.db.prepare('SELECT resource FROM consolidation_operation_locks ORDER BY resource').all() as Array<{ resource: string }>
      const conflicts = (left: string, right: string) => {
        if (left === right) return true
        if (!left.startsWith('path:') || !right.startsWith('path:')) return false
        const leftPath = left.slice(5)
        const rightPath = right.slice(5)
        const rel = relative(leftPath, rightPath)
        const reverse = relative(rightPath, leftPath)
        return (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) ||
          (reverse !== '..' && !reverse.startsWith(`..${sep}`) && !isAbsolute(reverse))
      }
      if (ordered.some((resource) => existing.some((locked) => conflicts(resource, locked.resource)))) return false
      const insert = options.db.prepare('INSERT INTO consolidation_operation_locks (resource, batch_id) VALUES (?, ?)')
      for (const resource of ordered) insert.run(resource, batchId)
      options.db.prepare('UPDATE consolidation_batches SET phase = ?, evidence_json = ? WHERE id = ?')
        .run(phase, JSON.stringify({ resources: ordered }), batchId)
      return true
    })
  }

  function releaseDurableLocks(batchId: string): void {
    options.db.prepare('DELETE FROM consolidation_operation_locks WHERE batch_id = ?').run(batchId)
  }

  function assertPathsUnlocked(paths: string[]): void {
    const locked = (options.db.prepare("SELECT resource FROM consolidation_operation_locks WHERE resource LIKE 'path:%'").all() as Array<{ resource: string }>).map((row) => row.resource.slice(5))
    for (const path of paths) {
      const candidate = resolve(path)
      const busy = locked.some((lockedPath) => {
        const rel = relative(candidate, lockedPath)
        const reverse = relative(lockedPath, candidate)
        return (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) ||
          (reverse !== '..' && !reverse.startsWith(`..${sep}`) && !isAbsolute(reverse))
      })
      if (busy) throw new Error(`Skill Library resource is busy: ${path}`)
    }
  }

  function assertSkillUnlocked(skillName: string): void {
    const locked = options.db.prepare('SELECT 1 FROM consolidation_operation_locks WHERE resource = ?').get(`skill:${skillName}`)
    if (locked) throw new Error(`Skill Library identity is busy: ${skillName}`)
  }

  function missingParents(path: string): string[] {
    const missing: string[] = []
    let current = dirname(path)
    while (!pathEntryExists(current)) {
      missing.push(current)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return missing
  }

  function removeCreatedParents(paths: string[]): void {
    const ordered = [...new Set(paths)].sort((left, right) => right.length - left.length)
    for (const path of ordered) {
      if (!pathEntryExists(path)) continue
      try {
        rmdirSync(path)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
      }
    }
  }

  function confirmConsolidation(confirmationId: string): ConsolidationOutcome {
    const persisted = getPersistedBatch(confirmationId)
    if (!persisted) return { status: 'rejected', reason: 'confirmation-not-found', message: 'Consolidation confirmation does not exist.' }
    if (persisted.batch.status === 'recovery-required') {
      return { status: 'recovery-required', batchId: persisted.batch.id, message: persisted.batch.failure_message ?? 'Consolidation requires recovery.' }
    }
    if (!acquireDurableLocks(persisted.batch.id, resourcesForItems(persisted.items), 'consolidation-lock-acquired')) {
      return { status: 'rejected', batchId: persisted.batch.id, reason: 'batch-busy', message: 'Consolidation resources are busy.' }
    }
    try {
      let plans: Array<{ item: ItemRow; source: SkillSource; observed: ObservedEntrySnapshot[] }>
      try {
        plans = persisted.items.map((item) => ({ item, ...validatePlan(persisted.batch, item) }))
      } catch (error) {
        runInTransaction(options.db, () => {
          if (persisted.batch.status === 'previewed') markBatch(persisted.batch.id, 'failed', errorMessage(error))
          releaseDurableLocks(persisted.batch.id)
        })
        return { status: 'rejected', batchId: persisted.batch.id, reason: 'plan-stale', message: errorMessage(error) }
      }
      const applied: Array<{
        plan: typeof plans[number]
        stage: string
        sourceRollback: string
        evidence: unknown
        displacedLinks: Array<ObservedEntrySnapshot & { rollbackPath: string; archivePath: string }>
        sourceDisplaced: boolean
        canonicalInstalled: boolean
        canonicalHash: string | null
        createdCanonicalParents: string[]
      }> = []
      let registryCommitted = false
      try {
        for (const [itemIndex, plan] of plans.entries()) {
          const stage = resolveWithin(canonicalRepositoryPath, `.consolidation-stage-${persisted.batch.id}-${itemIndex}`)
          const sourceRollback = resolveWithin(dirname(plan.source.path), `.${basename(plan.source.path)}.skill-switch-${persisted.batch.id}`)
          const state = {
            plan, stage, sourceRollback,
            evidence: {
              sourcePath: plan.source.path, sourceRollback, canonicalPath: plan.item.canonical_path,
              canonicalStage: stage, archivePath: plan.item.archive_path,
              toolEntries: plan.observed.map((snapshot) => ({
                targetPath: snapshot.deployment.target_path!,
                rollbackPath: resolveWithin(dirname(snapshot.deployment.target_path!), `.${basename(snapshot.deployment.target_path!)}.skill-switch-${persisted.batch.id}`),
                archivePath: resolveWithin(sourceArchivePath, persisted.batch.id, 'links', String(snapshot.deployment.id))
              }))
            },
            displacedLinks: [] as Array<ObservedEntrySnapshot & { rollbackPath: string; archivePath: string }>,
            sourceDisplaced: false, canonicalInstalled: false, canonicalHash: null as string | null,
            createdCanonicalParents: missingParents(plan.item.canonical_path)
          }
          applied.push(state)
          markItem(plan.item, persisted.batch.id, itemIndex, 'staging', state.evidence, 'prepared')
          mkdirSync(dirname(plan.item.canonical_path), { recursive: true })
          mkdirSync(dirname(plan.item.archive_path), { recursive: true })
          cpSync(plan.source.path, stage, { recursive: true, force: false })
          state.canonicalHash = hashDir(stage)
          if (state.canonicalHash !== plan.source.hash) throw new Error('Staged canonical content failed hash verification')
          cpSync(plan.source.path, plan.item.archive_path, { recursive: true, force: false })
          if (hashDir(plan.item.archive_path) !== plan.source.hash) throw new Error('Source Archive failed hash verification')
          markItem(plan.item, persisted.batch.id, itemIndex, 'staging', state.evidence, 'applied')
          markItem(plan.item, persisted.batch.id, itemIndex, 'source-displaced', state.evidence, 'prepared')
          renameSync(plan.source.path, sourceRollback)
          state.sourceDisplaced = true
          markItem(plan.item, persisted.batch.id, itemIndex, 'source-displaced', state.evidence, 'applied')
          markItem(plan.item, persisted.batch.id, itemIndex, 'entries-displaced', state.evidence, 'prepared')
          for (const snapshot of plan.observed) {
            const archivePath = resolveWithin(sourceArchivePath, persisted.batch.id, 'links', String(snapshot.deployment.id))
            const rollbackPath = resolveWithin(dirname(snapshot.deployment.target_path!), `.${basename(snapshot.deployment.target_path!)}.skill-switch-${persisted.batch.id}`)
            mkdirSync(dirname(archivePath), { recursive: true })
            symlinkSync(snapshot.linkTarget, archivePath, snapshot.deployment.mode === 'junction' ? 'junction' : 'dir')
            if (readlinkSync(archivePath) !== snapshot.linkTarget) throw new Error('Observed Subscription archive verification failed')
            renameSync(snapshot.deployment.target_path!, rollbackPath)
            state.displacedLinks.push({ ...snapshot, rollbackPath, archivePath })
          }
          markItem(plan.item, persisted.batch.id, itemIndex, 'entries-displaced', state.evidence, 'applied')
          markItem(plan.item, persisted.batch.id, itemIndex, 'canonical-installed', state.evidence, 'prepared')
          renameSync(stage, plan.item.canonical_path)
          state.canonicalInstalled = true
          markItem(plan.item, persisted.batch.id, itemIndex, 'canonical-installed', state.evidence, 'applied')
        }
        options.consolidationHooks?.onFaultPoint?.({ batchId: persisted.batch.id, itemIndex: -1, point: 'before-registry-commit' })
        runInTransaction(options.db, () => {
          for (const state of applied) {
            const { plan } = state
            for (const snapshot of plan.observed) options.db.prepare('DELETE FROM deployments WHERE id = ?').run(snapshot.deployment.id)
            options.db.prepare('DELETE FROM skill_sources WHERE id = ?').run(plan.source.id)
            updatePrimarySourcePath(options.db, plan.source.skill_id, plan.item.canonical_path)
            upsertSource(options.db, plan.source.skill_id, plan.item.canonical_path, state.canonicalHash!,
              Math.floor(statSync(plan.item.canonical_path).mtimeMs), 'central-repo', { role: 'canonical', origin: 'local' })
            options.db.prepare("UPDATE consolidation_items SET canonical_hash = ?, phase = 'db-committed' WHERE id = ?").run(state.canonicalHash, plan.item.id)
          }
          options.db.prepare("UPDATE consolidation_batches SET phase = 'registry-committed' WHERE id = ?").run(persisted.batch.id)
        })
        registryCommitted = true
        try {
          options.consolidationHooks?.afterRegistryCommit?.({ batchId: persisted.batch.id })
          for (const [itemIndex, state] of applied.entries()) {
            options.consolidationHooks?.onFaultPoint?.({ batchId: persisted.batch.id, itemIndex, point: 'before-cleanup' })
            rmSync(state.sourceRollback, { recursive: true, force: false })
            for (const snapshot of state.displacedLinks) rmSync(snapshot.rollbackPath, { force: false })
          }
        runInTransaction(options.db, () => {
          options.db.prepare('UPDATE consolidation_items SET phase = NULL WHERE batch_id = ?').run(persisted.batch.id)
          markBatch(persisted.batch.id, 'completed', undefined, null, { itemCount: applied.length })
          releaseDurableLocks(persisted.batch.id)
        })
          const results = plans.map((plan) => ({ skillId: plan.item.skill_id, canonicalPath: plan.item.canonical_path }))
          return {
            status: 'completed' as const, batchId: persisted.batch.id,
            skillId: results[0].skillId, canonicalPath: results[0].canonicalPath,
            ...(results.length > 1 ? { items: results } : {})
          }
        } catch (postCommitError) {
          const message = `Registry committed; finish cleanup from durable evidence: ${errorMessage(postCommitError)}`
          markBatch(persisted.batch.id, 'recovery-required', message, 'registry-committed', { itemCount: applied.length })
          return { status: 'recovery-required', batchId: persisted.batch.id, message }
        }
      } catch (error) {
        if (registryCommitted) {
          const message = `Registry committed; finish cleanup from durable evidence: ${errorMessage(error)}`
          markBatch(persisted.batch.id, 'recovery-required', message, 'registry-committed', { itemCount: applied.length })
          return { status: 'recovery-required', batchId: persisted.batch.id, message }
        }
        let compensationError: unknown
        try {
          for (const [reverseIndex, state] of [...applied].reverse().entries()) {
            options.consolidationHooks?.onFaultPoint?.({ batchId: persisted.batch.id, itemIndex: applied.length - 1 - reverseIndex, point: 'before-compensation' })
            if (state.canonicalInstalled && pathEntryExists(state.plan.item.canonical_path)) renameSync(state.plan.item.canonical_path, state.stage)
            for (const snapshot of [...state.displacedLinks].reverse()) {
              if (pathEntryExists(snapshot.rollbackPath) && !pathEntryExists(snapshot.deployment.target_path!)) renameSync(snapshot.rollbackPath, snapshot.deployment.target_path!)
              rmSync(snapshot.archivePath, { force: true })
            }
            if (state.sourceDisplaced && pathEntryExists(state.sourceRollback) && !pathEntryExists(state.plan.source.path)) renameSync(state.sourceRollback, state.plan.source.path)
            rmSync(state.plan.item.archive_path, { recursive: true, force: true })
            rmSync(state.stage, { recursive: true, force: true })
          }
          removeCreatedParents(applied.flatMap((state) => state.createdCanonicalParents))
          rmSync(resolveWithin(sourceArchivePath, persisted.batch.id), { recursive: true, force: true })
        } catch (failure) { compensationError = failure }
        if (compensationError) {
          const message = `${errorMessage(error)}; compensation failed: ${errorMessage(compensationError)}`
          markBatch(persisted.batch.id, 'recovery-required', message, 'compensation-failed', { itemCount: applied.length })
          return { status: 'recovery-required', batchId: persisted.batch.id, message }
        }
        runInTransaction(options.db, () => {
          options.db.prepare('UPDATE consolidation_items SET phase = NULL WHERE batch_id = ?').run(persisted.batch.id)
          markBatch(persisted.batch.id, 'failed', errorMessage(error), null, { itemCount: applied.length })
          releaseDurableLocks(persisted.batch.id)
        })
        return { status: 'rejected', batchId: persisted.batch.id, reason: 'plan-stale', message: errorMessage(error) }
      }
    } finally { /* durable locks are released only by terminal success or compensated failure */ }
  }

  function undoConsolidation(batchId: string): ConsolidationOutcome | { status: 'undone'; batchId: string } {
    const persisted = getPersistedBatch(batchId)
    if (!persisted || persisted.batch.status !== 'completed') {
      return { status: 'rejected', batchId, reason: 'batch-not-undoable', message: 'Consolidation Batch is not completed.' }
    }
    if (!acquireDurableLocks(batchId, resourcesForItems(persisted.items), 'undo-lock-acquired')) {
      return { status: 'rejected', batchId, reason: 'batch-busy', message: 'Consolidation resources are busy.' }
    }
    type UndoPlan = { item: ItemRow; source: SkillSource; observed: ObservedEntrySnapshot[]; canonical: SkillSource; rollback: string }
    let plans: UndoPlan[]
    try {
      plans = persisted.items.map((item, index) => {
        const source = JSON.parse(item.candidate_source_snapshot) as SkillSource
        const observed = JSON.parse(item.observed_deployments_snapshot) as ObservedEntrySnapshot[]
        if (pathEntryExists(source.path) || observed.some((entry) => pathEntryExists(entry.deployment.target_path!))) throw new Error('An original Source or tool entry path is occupied.')
        const canonical = getSourceByPath(options.db, item.canonical_path)
        if (!canonical || canonical.source_role !== 'canonical' || !existsSync(canonical.path) || hashDir(canonical.path) !== item.canonical_hash) throw new Error('Canonical Source changed after consolidation.')
        if (getDeploymentsBySkillId(options.db, canonical.skill_id).some((deployment) => deployment.source_id === canonical.id)) throw new Error('Canonical Source has subsequent Deployments.')
        if (!existsSync(item.archive_path) || hashDir(item.archive_path) !== source.hash) throw new Error('Source Archive changed after consolidation.')
        for (const snapshot of observed) {
          const archivedLink = resolveWithin(sourceArchivePath, batchId, 'links', String(snapshot.deployment.id))
          if (!pathEntryExists(archivedLink) || !lstatSync(archivedLink).isSymbolicLink() || readlinkSync(archivedLink) !== snapshot.linkTarget) throw new Error('Archived tool entry changed after consolidation.')
        }
        const rollback = resolveWithin(canonicalRepositoryPath, `.consolidation-undo-${batchId}-${index}`)
        if (pathEntryExists(rollback)) throw new Error('Canonical rollback path is occupied.')
        return { item, source, observed, canonical, rollback }
      })
    } catch (error) {
      releaseDurableLocks(batchId)
      const reason = errorMessage(error).includes('occupied') ? 'restore-path-occupied' as const : 'plan-stale' as const
      return { status: 'rejected', batchId, reason, message: errorMessage(error) }
    }
    const applied: Array<{ plan: UndoPlan; canonicalMoved: boolean; sourceRestored: boolean; restoredTargets: string[]; createdRestoreParents: string[] }> = []
    let registryCommitted = false
    try {
      for (const [index, plan] of plans.entries()) {
        const evidence = { canonicalPath: plan.canonical.path, canonicalRollback: plan.rollback, sourcePath: plan.source.path,
          archivePath: plan.item.archive_path, toolEntries: plan.observed.map((entry) => ({ targetPath: entry.deployment.target_path })), journal: [] as Array<{ phase: string; intent: string }> }
        const state = {
          plan, canonicalMoved: false, sourceRestored: false, restoredTargets: [] as string[],
          createdRestoreParents: [...new Set([
            ...missingParents(plan.source.path),
            ...plan.observed.flatMap((entry) => missingParents(entry.deployment.target_path!))
          ])]
        }
        applied.push(state)
        markItem(plan.item, batchId, index, 'undo-restoring', evidence, 'prepared', 'completed')
        mkdirSync(dirname(plan.source.path), { recursive: true })
        renameSync(plan.canonical.path, plan.rollback)
        state.canonicalMoved = true
        cpSync(plan.item.archive_path, plan.source.path, { recursive: true, force: false })
        if (hashDir(plan.source.path) !== plan.source.hash) throw new Error('Restored Candidate Source failed hash verification')
        state.sourceRestored = true
        for (const snapshot of plan.observed) {
          restoreObservedEntry(snapshot)
          state.restoredTargets.push(snapshot.deployment.target_path!)
        }
        markItem(plan.item, batchId, index, 'undo-restoring', evidence, 'applied', 'completed')
      }
      runInTransaction(options.db, () => {
        for (const state of applied) {
          options.db.prepare('DELETE FROM skill_sources WHERE id = ?').run(state.plan.canonical.id)
          restoreSourceSnapshot(options.db, state.plan.source)
          for (const snapshot of state.plan.observed) restoreDeploymentSnapshot(options.db, snapshot.deployment)
          updatePrimarySourcePath(options.db, state.plan.source.skill_id, state.plan.source.path)
          options.db.prepare("UPDATE consolidation_items SET phase = 'undo-registry-committed' WHERE id = ?").run(state.plan.item.id)
        }
        options.db.prepare("UPDATE consolidation_batches SET phase = 'undo-registry-committed' WHERE id = ?").run(batchId)
      })
      registryCommitted = true
      try {
        options.consolidationHooks?.afterRegistryCommit?.({ batchId })
        for (const [itemIndex, state] of applied.entries()) {
          options.consolidationHooks?.onFaultPoint?.({ batchId, itemIndex, point: 'before-cleanup' })
          rmSync(state.plan.rollback, { recursive: true, force: false })
        }
        runInTransaction(options.db, () => {
          options.db.prepare('UPDATE consolidation_items SET phase = NULL WHERE batch_id = ?').run(batchId)
          markBatch(batchId, 'undone', undefined, null, { itemCount: applied.length })
          releaseDurableLocks(batchId)
        })
        return { status: 'undone', batchId }
      } catch (postCommitError) {
        const message = `Undo registry committed; finish cleanup from durable evidence: ${errorMessage(postCommitError)}`
        markBatch(batchId, 'recovery-required', message, 'undo-registry-committed', { itemCount: applied.length })
        return { status: 'recovery-required', batchId, message }
      }
    } catch (error) {
      if (registryCommitted) {
        const message = `Undo registry committed; finish cleanup from durable evidence: ${errorMessage(error)}`
        markBatch(batchId, 'recovery-required', message, 'undo-registry-committed', { itemCount: applied.length })
        return { status: 'recovery-required', batchId, message }
      }
      let compensationError: unknown
      try {
        for (const [reverseIndex, state] of [...applied].reverse().entries()) {
          options.consolidationHooks?.onFaultPoint?.({ batchId, itemIndex: applied.length - 1 - reverseIndex, point: 'before-compensation' })
          for (const target of [...state.restoredTargets].reverse()) if (pathEntryExists(target)) rmSync(target, { force: false })
          if (state.sourceRestored && pathEntryExists(state.plan.source.path)) rmSync(state.plan.source.path, { recursive: true, force: false })
          if (state.canonicalMoved && pathEntryExists(state.plan.rollback)) renameSync(state.plan.rollback, state.plan.canonical.path)
        }
        removeCreatedParents(applied.flatMap((state) => state.createdRestoreParents))
      } catch (failure) { compensationError = failure }
      const message = compensationError ? `${errorMessage(error)}; compensation failed: ${errorMessage(compensationError)}` : errorMessage(error)
      if (compensationError) {
        markBatch(batchId, 'recovery-required', message, 'undo-compensation-failed', { itemCount: applied.length })
      } else {
        runInTransaction(options.db, () => {
          markBatch(batchId, 'completed', message, null, { itemCount: applied.length })
          releaseDurableLocks(batchId)
        })
      }
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
    assertSkillUnlocked(skillName)
    assertPathsUnlocked([sourceDirectory, destination])
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
    previewConsolidationBatch,
    confirmConsolidation,
    undoConsolidation,
    replaceCanonicalSource,
    read() {
      const skills = getAllSkills(options.db).map((skill) => {
        const canonicalSources = skill.sources.filter((source) => source.source_role === 'canonical')
        if (canonicalSources.length > 1) throw new Error(`Skill ${skill.name} has multiple canonical Sources`)
        return { id: skill.id, name: skill.name, canonicalSource: canonicalSources[0] ?? null,
          candidates: skill.sources.filter((source) => source.source_role === 'candidate') }
      })
      const batches = options.db.prepare('SELECT * FROM consolidation_batches ORDER BY created_at DESC').all() as BatchRow[]
      return {
        canonicalRepository: { path: canonicalRepositoryPath }, skills,
        consolidationBatches: batches.map((batch) => {
          const itemRows = options.db.prepare('SELECT skill_id, skill_name, canonical_path, archive_path, phase FROM consolidation_items WHERE batch_id = ? ORDER BY id ASC').all(batch.id) as Array<{ skill_id: number; skill_name: string; canonical_path: string; archive_path: string; phase: string | null }>
          const phases = [...new Set([batch.phase, ...itemRows.map((item) => item.phase)].filter((phase): phase is string => phase !== null))]
          let recoveryDirection: ConsolidationBatchSummary['recoveryDirection'] = null
          if (batch.status === 'recovery-required') {
            recoveryDirection = phases.some((phase) => phase.includes('registry-committed') || phase.includes('cleanup'))
              ? 'finish-cleanup'
              : phases.some((phase) => phase.includes('undo')) ? 'rollback-undo' : phases.length > 0 ? 'rollback-consolidation' : 'inspect'
          }
          return {
            id: batch.id, status: batch.status,
            items: itemRows.map((item) => ({ skillId: item.skill_id, skillName: item.skill_name, canonicalPath: item.canonical_path, archivePath: item.archive_path })),
            phase: batch.phase, createdAt: batch.created_at, completedAt: batch.completed_at,
            undoneAt: batch.undone_at, failureMessage: batch.failure_message,
            recoveryDirection, evidenceSummary: { itemCount: itemRows.length, phases }
          }
        })
      }
    }
  }
}
