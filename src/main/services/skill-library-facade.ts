import { randomUUID } from 'crypto'
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from 'path'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync
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
export type SourceRelocationStatus = ConsolidationBatchStatus

export interface SkillLibrarySkill {
  id: number
  name: string
  canonicalSource: SkillLibrarySource | null
  candidates: SkillLibrarySource[]
}

export interface ConsolidationBatchSummary {
  id: string
  status: ConsolidationBatchStatus
  items: Array<{
    skillId: number
    skillName: string
    canonicalPath: string
    archivePath: string
    originalPath: string
    originalHash: string
    archivedToolPaths: string[]
  }>
  archive: { sizeBytes: number; recoverable: boolean; purgeable: boolean; purgedAt: string | null }
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
  consolidationPlan: ConsolidationPlanItem[]
  consolidationBatches: ConsolidationBatchSummary[]
  sourceRelocations: SourceRelocationSummary[]
}

export interface ConsolidationPlanItem {
  skillId: number
  skillName: string
  selectedByDefault: boolean
  hasConflict: boolean
  canonicalRelativeParent: string
  versions: Array<{ hash: string; candidateSourceIds: number[]; paths: string[] }>
}

export interface SourceRelocationSummary {
  id: string
  status: SourceRelocationStatus
  skillId: number
  skillName: string
  sourceId: number
  oldCanonicalPath: string
  newCanonicalPath: string
  createdAt: string
  completedAt: string | null
  undoneAt: string | null
  failureMessage: string | null
}

export type SourceRelocationPreview = {
  status: 'confirmation-required'
  confirmationId: string
  relocationId: string
  skillId: number
  skillName: string
  oldCanonicalPath: string
  newCanonicalPath: string
  deployments: Array<{ deploymentId: number; targetTool: string; targetPath: string; mode: Deployment['mode'] }>
}

export type SourceRelocationOutcome =
  | { status: 'completed'; relocationId: string; sourceId: number; canonicalPath: string }
  | { status: 'undone'; relocationId: string; sourceId: number; canonicalPath: string }
  | { status: 'rejected'; relocationId?: string; reason: 'confirmation-not-found' | 'plan-stale' | 'relocation-not-undoable' | 'relocation-busy'; message: string }
  | { status: 'recovery-required'; relocationId: string; message: string }

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
  | { status: 'rejected'; batchId?: string; reason: 'confirmation-not-found' | 'plan-stale' | 'restore-path-occupied' | 'batch-not-undoable' | 'batch-not-purgeable' | 'archive-purged' | 'batch-busy'; message: string }
  | { status: 'recovery-required'; batchId: string; message: string }

export interface SkillLibraryFacade {
  read(): SkillLibraryReadModel
  previewConsolidation(request: { candidateSourceId: number; canonicalRelativeParent: string }): ConsolidationPreview
  previewConsolidationBatch(request: { items: Array<{ candidateSourceId: number; canonicalRelativeParent: string }> }): ConsolidationBatchPreview
  confirmConsolidation(confirmationId: string): ConsolidationOutcome
  undoConsolidation(batchId: string): ConsolidationOutcome | { status: 'undone'; batchId: string }
  restoreConsolidation(batchId: string): ConsolidationOutcome | { status: 'undone'; batchId: string }
  previewSourceArchivePurge(batchId: string): {
    status: 'confirmation-required'; confirmationId: string; batchId: string; itemCount: number; sizeBytes: number
  } | Extract<ConsolidationOutcome, { status: 'rejected' }>
  confirmSourceArchivePurge(confirmationId: string):
    | { status: 'purged'; batchId: string; purgedAt: string; sizeBytes: number }
    | Extract<ConsolidationOutcome, { status: 'rejected' | 'recovery-required' }>
  previewSourceRelocation(request: { sourceId: number; canonicalRelativeParent: string }): SourceRelocationPreview
  confirmSourceRelocation(confirmationId: string): SourceRelocationOutcome
  undoSourceRelocation(relocationId: string): SourceRelocationOutcome
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
  archive_size_bytes: number | null
  archive_purged_at: string | null
  purge_confirmation_id: string | null
  purge_previewed_at: string | null
  purge_archive_hash: string | null
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

type CandidateSourceSnapshot = SkillSource | { sources: SkillSource[] }

function snapshotSources(snapshot: string): SkillSource[] {
  const parsed = JSON.parse(snapshot) as CandidateSourceSnapshot
  return 'sources' in parsed ? parsed.sources : [parsed]
}

interface RelocationRow {
  id: string
  status: SourceRelocationStatus
  skill_id: number
  skill_name: string
  source_id: number
  old_path: string
  new_path: string
  source_hash: string
  deployments_snapshot: string
  phase: string | null
  journal_json: string | null
  created_at: string
  completed_at: string | null
  undone_at: string | null
  failure_message: string | null
}

interface RelocationDeploymentSnapshot {
  deployment: Deployment
  linkTarget: string | null
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function removePathEntry(path: string): void {
  if (!pathEntryExists(path)) return
  const entry = lstatSync(path)
  if (entry.isDirectory() && !entry.isSymbolicLink()) rmSync(path, { recursive: true, force: true })
  else unlinkSync(path)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function directorySize(path: string): number {
  if (!pathEntryExists(path)) return 0
  const entry = lstatSync(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) return entry.size
  return readdirSync(path).reduce((total, name) => total + directorySize(resolve(path, name)), 0)
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
  relocationHooks?: {
    onPhase?: (event: { relocationId: string; phase: string }) => void
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
    WHERE status IN ('previewed', 'completed', 'undone') AND (
      phase IS NOT NULL OR id IN (SELECT batch_id FROM consolidation_items WHERE phase IS NOT NULL)
      OR id IN (SELECT batch_id FROM consolidation_operation_locks)
    )`).run()
  options.db.prepare(`DELETE FROM consolidation_operation_locks
    WHERE batch_id IN (SELECT id FROM consolidation_batches WHERE phase IS NULL AND status IN ('failed', 'completed', 'undone'))`).run()
  options.db.prepare(`UPDATE source_relocations
    SET status = 'recovery-required',
        failure_message = COALESCE(failure_message, 'Source Relocation was interrupted; inspect the persisted journal.')
    WHERE status IN ('previewed', 'completed') AND (phase IS NOT NULL OR id IN (SELECT relocation_id FROM source_relocation_locks))`).run()
  options.db.prepare(`DELETE FROM source_relocation_locks
    WHERE relocation_id IN (SELECT id FROM source_relocations WHERE phase IS NULL AND status IN ('failed', 'completed', 'undone'))`).run()

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
    if (typeof relativeParent !== 'string' || isAbsolute(relativeParent) || win32.isAbsolute(relativeParent)) throw new Error('Canonical Placement must be relative')
    const trimmed = relativeParent.trim()
    const segments = trimmed ? trimmed.split(/[\\/]+/) : []
    if (segments.some((segment) => segment === '.' || segment === '..')) throw new Error('Canonical Placement cannot contain . or .. segments')
    const placement = resolveWithin(canonicalRepositoryPath, ...segments, skillName)
    assertCanonicalParentConfined(placement)
    return placement
  }

  function getRelocation(id: string): RelocationRow | null {
    return (options.db.prepare('SELECT * FROM source_relocations WHERE id = ?').get(id) as RelocationRow | undefined) ?? null
  }

  function relationsForCanonicalSource(source: SkillSource): Deployment[] {
    const relations = getDeploymentsBySkillId(options.db, source.skill_id)
      .filter((deployment) => deployment.source_id === source.id ||
        (deployment.source_id == null && resolve(deployment.source_path) === resolve(source.path)))
      .sort((left, right) => left.id - right.id)
    if (relations.some((deployment) => deployment.source_id == null || deployment.target_id == null || deployment.target_path == null)) {
      throw new Error('Canonical Source has an unresolved Deployment; reconcile it before relocation')
    }
    return relations
  }

  function previewSourceRelocation(request: { sourceId: number; canonicalRelativeParent: string }): SourceRelocationPreview {
    if (!Number.isInteger(request.sourceId)) throw new Error('sourceId must be an integer')
    const source = getSourceById(options.db, request.sourceId)
    if (!source || source.source_role !== 'canonical') throw new Error('Source Relocation requires a canonical Source ID')
    const skill = getSkillById(options.db, source.skill_id)
    if (!skill) throw new Error('Canonical Source Skill does not exist')
    if (!pathEntryExists(source.path) || !statSync(source.path).isDirectory() || hashDir(source.path) !== source.hash) {
      throw new Error('Canonical Source content changed or is unavailable')
    }
    const newPath = canonicalPlacement(validateSkillName(skill.name), request.canonicalRelativeParent)
    if (resolve(newPath) === resolve(source.path)) throw new Error('New Canonical Placement must differ from the current placement')
    const oldToNew = relative(resolve(source.path), resolve(newPath))
    const newToOld = relative(resolve(newPath), resolve(source.path))
    if ((oldToNew !== '..' && !oldToNew.startsWith(`..${sep}`) && !isAbsolute(oldToNew)) ||
      (newToOld !== '..' && !newToOld.startsWith(`..${sep}`) && !isAbsolute(newToOld))) {
      throw new Error('New Canonical Placement overlaps the current Source')
    }
    if (pathEntryExists(newPath)) throw new Error('New Canonical Placement is occupied')
    const deployments = relationsForCanonicalSource(source)
    if (deployments.some((deployment) => deployment.management === 'observed')) {
      throw new Error('Observed Subscription must be adopted or removed before Source Relocation')
    }
    for (const deployment of deployments) {
      if (deployment.mode !== 'copy') assertObservedLink(deployment, source.path)
    }
    const snapshots: RelocationDeploymentSnapshot[] = deployments.map((deployment) => ({
      deployment,
      linkTarget: deployment.mode === 'copy' ? null : readlinkSync(deployment.target_path!)
    }))
    const id = randomUUID()
    options.db.prepare(`INSERT INTO source_relocations
      (id, status, skill_id, skill_name, source_id, old_path, new_path, source_hash,
       deployments_snapshot, created_at)
      VALUES (?, 'previewed', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, skill.id, skill.name, source.id, source.path, newPath, source.hash,
      JSON.stringify(snapshots), new Date().toISOString())
    return {
      status: 'confirmation-required', confirmationId: id, relocationId: id,
      skillId: skill.id, skillName: skill.name,
      oldCanonicalPath: source.path, newCanonicalPath: newPath,
      deployments: deployments.map((deployment) => ({
        deploymentId: deployment.id,
        targetTool: deployment.target_tool,
        targetPath: deployment.target_path!,
        mode: deployment.mode
      }))
    }
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
    const candidates = getAllSkills(options.db).find((item) => item.id === skill.id)?.sources
      .filter((candidate) => candidate.source_role === 'candidate') ?? []
    if (candidates.some((candidate) => candidate.hash !== source.hash)) {
      throw new Error('Consolidation requires an explicit decision for conflicting Candidate versions')
    }
    for (const candidate of candidates) {
      if (!existsSync(candidate.path) || !statSync(candidate.path).isDirectory() || hashDir(candidate.path) !== candidate.hash) {
        throw new Error('Candidate Source changed; rescan before consolidation')
      }
    }
    const canonicalPath = canonicalPlacement(validateSkillName(skill.name), request.canonicalRelativeParent)
    if (pathEntryExists(canonicalPath)) throw new Error('Canonical Placement is occupied')
    const archivePath = resolveWithin(sourceArchivePath, batchId, 'source', skill.name)
    const allRelations = candidates.flatMap(allKnownRelationsForSource)
    if (allRelations.some((deployment) => deployment.source_id == null)) {
      throw new Error('Candidate Source has an unresolved legacy Deployment; reconcile it before consolidation')
    }
    if (allRelations.some((deployment) => deployment.management !== 'observed')) {
      throw new Error('Candidate Source has a Managed Deployment and cannot be consolidated')
    }
    const observed = candidates.flatMap(observedForSource).sort((a, b) => a.id - b.id)
    for (const deployment of observed) {
      const candidate = candidates.find((item) => item.id === deployment.source_id)!
      assertObservedLink(deployment, candidate.path)
    }
    const observedSnapshots = observed.map(snapshotObservedEntry)
    return { source, sources: candidates, skill, canonicalPath, archivePath, observed, observedSnapshots }
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
      for (const item of prepared) insert.run(batchId, item.skill.id, item.skill.name, JSON.stringify({ sources: item.sources }), JSON.stringify(item.observedSnapshots), item.canonicalPath, item.archivePath)
    })
    return {
      status: 'confirmation-required', confirmationId: batchId, batchId,
      items: prepared.map((item) => ({ skillId: item.skill.id, skillName: item.skill.name, canonicalPath: item.canonicalPath })),
      operations: prepared.flatMap((item) => [
        { kind: 'write-canonical' as const, path: item.canonicalPath },
        ...item.sources.map((source) => ({ kind: 'archive-candidate' as const, path: archivePathForSource(item.archivePath, source, item.sources) })),
        ...item.observed.map((deployment) => ({ kind: 'remove-observed-entry' as const, path: deployment.target_path! }))
      ])
    }
  }

  function previewConsolidation(request: { candidateSourceId: number; canonicalRelativeParent: string }): ConsolidationPreview {
    const preview = previewConsolidationBatch({ items: [request] })
    const item = preview.items[0]
    return { ...preview, skillId: item.skillId, skillName: item.skillName }
  }

  function archivePathForSource(archivePath: string, source: SkillSource, sources: SkillSource[]): string {
    return sources.length === 1 ? archivePath : resolveWithin(archivePath, String(source.id))
  }

  function validatePlan(batch: BatchRow, item: ItemRow): { source: SkillSource; sources: SkillSource[]; observed: ObservedEntrySnapshot[] } {
    if (batch.status !== 'previewed') throw new Error('Confirmation is no longer pending')
    const sources = snapshotSources(item.candidate_source_snapshot)
    const sourceSnapshot = sources[0]
    const observedSnapshot = JSON.parse(item.observed_deployments_snapshot) as ObservedEntrySnapshot[]
    const currentSources = sources.map((snapshot) => getSourceById(options.db, snapshot.id))
    if (currentSources.some((source, index) => !source || source.source_role !== 'candidate' || JSON.stringify(source) !== JSON.stringify(sources[index]))) {
      throw new Error('Candidate Source registration changed')
    }
    const source = currentSources[0]!
    const currentSkillSources = getAllSkills(options.db).find((skill) => skill.id === source.skill_id)?.sources ?? []
    if (currentSkillSources.length !== sources.length || currentSkillSources.some((candidate, index) => candidate.id !== sources[index].id)) {
      throw new Error('Skill Source set changed')
    }
    if (sources.some((candidate) => !existsSync(candidate.path) || hashDir(candidate.path) !== candidate.hash)) throw new Error('Candidate Source content changed')
    assertCanonicalParentConfined(item.canonical_path)
    if (pathEntryExists(item.canonical_path) || pathEntryExists(item.archive_path)) throw new Error('Destination or Source Archive is occupied')
    for (const candidate of sources) {
      const sourceRollback = resolveWithin(dirname(candidate.path), `.${basename(candidate.path)}.skill-switch-${batch.id}`)
      if (pathEntryExists(sourceRollback)) throw new Error('Candidate Source rollback path is occupied')
    }
    const currentRelations = sources.flatMap(allKnownRelationsForSource).sort((a, b) => a.id - b.id)
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
    return { source, sources, observed }
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
      const sources = snapshotSources(item.candidate_source_snapshot)
      const observed = JSON.parse(item.observed_deployments_snapshot) as ObservedEntrySnapshot[]
      return [
        `skill:${item.skill_name}`,
        ...sources.flatMap((source) => [`source:${source.id}`, `path:${resolve(source.path)}`]),
        `path:${resolve(item.canonical_path)}`,
        ...observed.map((entry) => `path:${resolve(entry.deployment.target_path!)}`)
      ]
    })
  }

  function acquireDurableLocks(
    batchId: string,
    resources: string[],
    phase: 'consolidation-lock-acquired' | 'undo-lock-acquired' | 'archive-purge'
  ): boolean {
    const ordered = [...new Set(resources)].sort()
    return runInTransaction(options.db, () => {
      const existing = options.db.prepare('SELECT resource FROM consolidation_operation_locks ORDER BY resource').all() as Array<{ resource: string }>
      const relocationLocks = options.db.prepare('SELECT resource FROM source_relocation_locks ORDER BY resource').all() as Array<{ resource: string }>
      if (ordered.some((resource) => [...existing, ...relocationLocks].some((locked) => resourcesConflict(resource, locked.resource)))) return false
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
    const locked = [
      ...(options.db.prepare("SELECT resource FROM consolidation_operation_locks WHERE resource LIKE 'path:%'").all() as Array<{ resource: string }>),
      ...(options.db.prepare("SELECT resource FROM source_relocation_locks WHERE resource LIKE 'path:%'").all() as Array<{ resource: string }>)
    ].map((row) => row.resource.slice(5))
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
    const locked = options.db.prepare(`SELECT 1 FROM (
      SELECT resource FROM consolidation_operation_locks
      UNION ALL SELECT resource FROM source_relocation_locks
    ) WHERE resource = ?`).get(`skill:${skillName}`)
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
      let plans: Array<{ item: ItemRow; source: SkillSource; sources: SkillSource[]; observed: ObservedEntrySnapshot[] }>
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
        sourceRollbacks: Array<{ source: SkillSource; path: string; displaced: boolean }>
        evidence: unknown
        displacedLinks: Array<ObservedEntrySnapshot & { rollbackPath: string; archivePath: string }>
        canonicalInstalled: boolean
        canonicalHash: string | null
        createdCanonicalParents: string[]
      }> = []
      let registryCommitted = false
      try {
        for (const [itemIndex, plan] of plans.entries()) {
          const stage = resolveWithin(canonicalRepositoryPath, `.consolidation-stage-${persisted.batch.id}-${itemIndex}`)
          const sourceRollbacks = plan.sources.map((source) => ({
            source,
            path: resolveWithin(dirname(source.path), `.${basename(source.path)}.skill-switch-${persisted.batch.id}`),
            displaced: false
          }))
          const state = {
            plan, stage, sourceRollbacks,
            evidence: {
              sourcePaths: sourceRollbacks.map((entry) => ({ sourcePath: entry.source.path, sourceRollback: entry.path })), canonicalPath: plan.item.canonical_path,
              canonicalStage: stage, archivePath: plan.item.archive_path,
              toolEntries: plan.observed.map((snapshot) => ({
                targetPath: snapshot.deployment.target_path!,
                rollbackPath: resolveWithin(dirname(snapshot.deployment.target_path!), `.${basename(snapshot.deployment.target_path!)}.skill-switch-${persisted.batch.id}`),
                archivePath: resolveWithin(sourceArchivePath, persisted.batch.id, 'links', String(snapshot.deployment.id))
              }))
            },
            displacedLinks: [] as Array<ObservedEntrySnapshot & { rollbackPath: string; archivePath: string }>,
            canonicalInstalled: false, canonicalHash: null as string | null,
            createdCanonicalParents: missingParents(plan.item.canonical_path)
          }
          applied.push(state)
          markItem(plan.item, persisted.batch.id, itemIndex, 'staging', state.evidence, 'prepared')
          mkdirSync(dirname(plan.item.canonical_path), { recursive: true })
          mkdirSync(dirname(plan.item.archive_path), { recursive: true })
          cpSync(plan.source.path, stage, { recursive: true, force: false })
          state.canonicalHash = hashDir(stage)
          if (state.canonicalHash !== plan.source.hash) throw new Error('Staged canonical content failed hash verification')
          for (const source of plan.sources) {
            const archivePath = archivePathForSource(plan.item.archive_path, source, plan.sources)
            mkdirSync(dirname(archivePath), { recursive: true })
            cpSync(source.path, archivePath, { recursive: true, force: false })
            if (hashDir(archivePath) !== source.hash) throw new Error('Source Archive failed hash verification')
          }
          markItem(plan.item, persisted.batch.id, itemIndex, 'staging', state.evidence, 'applied')
          markItem(plan.item, persisted.batch.id, itemIndex, 'source-displaced', state.evidence, 'prepared')
          for (const rollback of state.sourceRollbacks) {
            renameSync(rollback.source.path, rollback.path)
            rollback.displaced = true
          }
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
            for (const source of plan.sources) options.db.prepare('DELETE FROM skill_sources WHERE id = ?').run(source.id)
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
            for (const rollback of state.sourceRollbacks) rmSync(rollback.path, { recursive: true, force: false })
            for (const snapshot of state.displacedLinks) rmSync(snapshot.rollbackPath, { force: false })
          }
        runInTransaction(options.db, () => {
          options.db.prepare('UPDATE consolidation_items SET phase = NULL WHERE batch_id = ?').run(persisted.batch.id)
          const archiveSize = directorySize(resolveWithin(sourceArchivePath, persisted.batch.id))
          options.db.prepare('UPDATE consolidation_batches SET archive_size_bytes = ? WHERE id = ?').run(archiveSize, persisted.batch.id)
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
            for (const rollback of [...state.sourceRollbacks].reverse()) {
              if (rollback.displaced && pathEntryExists(rollback.path) && !pathEntryExists(rollback.source.path)) renameSync(rollback.path, rollback.source.path)
            }
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
    if (persisted?.batch.archive_purged_at) {
      return { status: 'rejected', batchId, reason: 'archive-purged', message: 'Source Archive payload was permanently purged.' }
    }
    if (!persisted || persisted.batch.status !== 'completed') {
      return { status: 'rejected', batchId, reason: 'batch-not-undoable', message: 'Consolidation Batch is not completed.' }
    }
    if (!acquireDurableLocks(batchId, resourcesForItems(persisted.items), 'undo-lock-acquired')) {
      return { status: 'rejected', batchId, reason: 'batch-busy', message: 'Consolidation resources are busy.' }
    }
    type UndoPlan = { item: ItemRow; source: SkillSource; sources: SkillSource[]; observed: ObservedEntrySnapshot[]; canonical: SkillSource; rollback: string }
    let plans: UndoPlan[]
    try {
      plans = persisted.items.map((item, index) => {
        const sources = snapshotSources(item.candidate_source_snapshot)
        const source = sources[0]
        const observed = JSON.parse(item.observed_deployments_snapshot) as ObservedEntrySnapshot[]
        if (sources.some((candidate) => pathEntryExists(candidate.path)) || observed.some((entry) => pathEntryExists(entry.deployment.target_path!))) throw new Error('An original Source or tool entry path is occupied.')
        const canonical = getSourceByPath(options.db, item.canonical_path)
        if (!canonical || canonical.source_role !== 'canonical' || !existsSync(canonical.path) || hashDir(canonical.path) !== item.canonical_hash) throw new Error('Canonical Source changed after consolidation.')
        if (getDeploymentsBySkillId(options.db, canonical.skill_id).some((deployment) => deployment.source_id === canonical.id)) throw new Error('Canonical Source has subsequent Deployments.')
        for (const candidate of sources) {
          const archivePath = archivePathForSource(item.archive_path, candidate, sources)
          if (!existsSync(archivePath) || hashDir(archivePath) !== candidate.hash) throw new Error('Source Archive changed after consolidation.')
        }
        for (const snapshot of observed) {
          const archivedLink = resolveWithin(sourceArchivePath, batchId, 'links', String(snapshot.deployment.id))
          if (!pathEntryExists(archivedLink) || !lstatSync(archivedLink).isSymbolicLink() || readlinkSync(archivedLink) !== snapshot.linkTarget) throw new Error('Archived tool entry changed after consolidation.')
        }
        const rollback = resolveWithin(canonicalRepositoryPath, `.consolidation-undo-${batchId}-${index}`)
        if (pathEntryExists(rollback)) throw new Error('Canonical rollback path is occupied.')
        return { item, source, sources, observed, canonical, rollback }
      })
    } catch (error) {
      runInTransaction(options.db, () => {
        options.db.prepare('UPDATE consolidation_batches SET phase = NULL, evidence_json = ? WHERE id = ?')
          .run(persisted.batch.evidence_json, batchId)
        releaseDurableLocks(batchId)
      })
      const reason = errorMessage(error).includes('occupied') ? 'restore-path-occupied' as const : 'plan-stale' as const
      return { status: 'rejected', batchId, reason, message: errorMessage(error) }
    }
    const applied: Array<{ plan: UndoPlan; canonicalMoved: boolean; restoredSources: SkillSource[]; restoredTargets: string[]; createdRestoreParents: string[] }> = []
    let registryCommitted = false
    try {
      for (const [index, plan] of plans.entries()) {
        const evidence = { canonicalPath: plan.canonical.path, canonicalRollback: plan.rollback, sourcePaths: plan.sources.map((source) => source.path),
          archivePath: plan.item.archive_path, toolEntries: plan.observed.map((entry) => ({ targetPath: entry.deployment.target_path })), journal: [] as Array<{ phase: string; intent: string }> }
        const state = {
          plan, canonicalMoved: false, restoredSources: [] as SkillSource[], restoredTargets: [] as string[],
          createdRestoreParents: [...new Set([
            ...plan.sources.flatMap((source) => missingParents(source.path)),
            ...plan.observed.flatMap((entry) => missingParents(entry.deployment.target_path!))
          ])]
        }
        applied.push(state)
        markItem(plan.item, batchId, index, 'undo-restoring', evidence, 'prepared', 'completed')
        renameSync(plan.canonical.path, plan.rollback)
        state.canonicalMoved = true
        for (const source of plan.sources) {
          mkdirSync(dirname(source.path), { recursive: true })
          cpSync(archivePathForSource(plan.item.archive_path, source, plan.sources), source.path, { recursive: true, force: false })
          if (hashDir(source.path) !== source.hash) throw new Error('Restored Candidate Source failed hash verification')
          state.restoredSources.push(source)
        }
        for (const snapshot of plan.observed) {
          restoreObservedEntry(snapshot)
          state.restoredTargets.push(snapshot.deployment.target_path!)
        }
        markItem(plan.item, batchId, index, 'undo-restoring', evidence, 'applied', 'completed')
      }
      runInTransaction(options.db, () => {
        for (const state of applied) {
          options.db.prepare('DELETE FROM skill_sources WHERE id = ?').run(state.plan.canonical.id)
          for (const source of state.plan.sources) restoreSourceSnapshot(options.db, source)
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
          for (const source of [...state.restoredSources].reverse()) if (pathEntryExists(source.path)) rmSync(source.path, { recursive: true, force: false })
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

  function previewSourceArchivePurge(batchId: string) {
    const persisted = getPersistedBatch(batchId)
    if (!persisted || !['completed', 'undone'].includes(persisted.batch.status)) {
      return { status: 'rejected' as const, batchId, reason: 'batch-not-purgeable' as const, message: 'Only a completed or restored Consolidation Batch can be purged.' }
    }
    if (persisted.batch.archive_purged_at) {
      return { status: 'rejected' as const, batchId, reason: 'archive-purged' as const, message: 'Source Archive payload was already permanently purged.' }
    }
    const batchArchivePath = resolveWithin(sourceArchivePath, batchId)
    if (!pathEntryExists(batchArchivePath)) {
      return { status: 'rejected' as const, batchId, reason: 'plan-stale' as const, message: 'Source Archive payload is unavailable.' }
    }
    const confirmationId = randomUUID()
    const sizeBytes = directorySize(batchArchivePath)
    options.db.prepare(`UPDATE consolidation_batches
      SET purge_confirmation_id = ?, purge_previewed_at = ?, purge_archive_hash = ?,
          archive_size_bytes = ? WHERE id = ?`
    ).run(confirmationId, new Date().toISOString(), hashDir(batchArchivePath), sizeBytes, batchId)
    return { status: 'confirmation-required' as const, confirmationId, batchId, itemCount: persisted.items.length, sizeBytes }
  }

  function rejectStaleArchivePurge(batch: BatchRow, message: string) {
    runInTransaction(options.db, () => {
      options.db.prepare(`UPDATE consolidation_batches
        SET phase = NULL, evidence_json = ?, purge_confirmation_id = NULL,
            purge_previewed_at = NULL, purge_archive_hash = NULL WHERE id = ?`
      ).run(batch.evidence_json, batch.id)
      releaseDurableLocks(batch.id)
    })
    return { status: 'rejected' as const, batchId: batch.id, reason: 'plan-stale' as const, message }
  }

  function confirmSourceArchivePurge(confirmationId: string) {
    const batch = options.db.prepare('SELECT * FROM consolidation_batches WHERE purge_confirmation_id = ?').get(confirmationId) as BatchRow | undefined
    if (!batch) {
      return { status: 'rejected' as const, reason: 'confirmation-not-found' as const, message: 'Source Archive purge confirmation does not exist.' }
    }
    const persisted = getPersistedBatch(batch.id)
    if (!persisted || !['completed', 'undone'].includes(batch.status) || batch.archive_purged_at) {
      return { status: 'rejected' as const, batchId: batch.id, reason: batch.archive_purged_at ? 'archive-purged' as const : 'batch-not-purgeable' as const, message: 'Source Archive purge plan is no longer valid.' }
    }
    if (!acquireDurableLocks(batch.id, resourcesForItems(persisted.items), 'archive-purge')) {
      return { status: 'rejected' as const, batchId: batch.id, reason: 'batch-busy' as const, message: 'Consolidation resources are busy.' }
    }
    try {
      const batchArchivePath = resolveWithin(sourceArchivePath, batch.id)
      if (!pathEntryExists(batchArchivePath)) {
        return rejectStaleArchivePurge(batch, 'Source Archive payload is unavailable.')
      }
      if (!batch.purge_archive_hash || hashDir(batchArchivePath) !== batch.purge_archive_hash) {
        return rejectStaleArchivePurge(batch, 'Source Archive payload changed after preview.')
      }
      const sizeBytes = directorySize(batchArchivePath)
      const purgeStage = resolveWithin(sourceArchivePath, `.purge-${batch.id}-${confirmationId}`)
      if (pathEntryExists(purgeStage)) throw new Error('Source Archive purge staging path is occupied.')
      renameSync(batchArchivePath, purgeStage)
      rmSync(purgeStage, { recursive: true, force: false })
      const purgedAt = new Date().toISOString()
      runInTransaction(options.db, () => {
        options.db.prepare(`UPDATE consolidation_batches
          SET archive_size_bytes = ?, archive_purged_at = ?, purge_confirmation_id = NULL,
              purge_previewed_at = NULL, purge_archive_hash = NULL, phase = NULL,
              evidence_json = ? WHERE id = ?`
        ).run(sizeBytes, purgedAt, JSON.stringify({ action: 'archive-purged', purgedAt, sizeBytes }), batch.id)
        releaseDurableLocks(batch.id)
      })
      return { status: 'purged' as const, batchId: batch.id, purgedAt, sizeBytes }
    } catch (error) {
      const message = `Source Archive purge requires recovery: ${errorMessage(error)}`
      markBatch(batch.id, 'recovery-required', message, 'archive-purge', { confirmationId })
      return { status: 'recovery-required' as const, batchId: batch.id, message }
    }
  }

  function relocationSnapshots(row: RelocationRow): RelocationDeploymentSnapshot[] {
    return JSON.parse(row.deployments_snapshot) as RelocationDeploymentSnapshot[]
  }

  function relocationResources(row: RelocationRow): string[] {
    return [
      `source:${row.source_id}`,
      `skill:${row.skill_name}`,
      `path:${resolve(row.old_path)}`,
      `path:${resolve(row.new_path)}`,
      ...relocationSnapshots(row).map((snapshot) => `path:${resolve(snapshot.deployment.target_path!)}`)
    ]
  }

  function resourcesConflict(left: string, right: string): boolean {
    if (left === right) return true
    if (!left.startsWith('path:') || !right.startsWith('path:')) return false
    const leftPath = left.slice(5)
    const rightPath = right.slice(5)
    const rel = relative(leftPath, rightPath)
    const reverse = relative(rightPath, leftPath)
    return (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) ||
      (reverse !== '..' && !reverse.startsWith(`..${sep}`) && !isAbsolute(reverse))
  }

  function acquireRelocationLocks(row: RelocationRow, phase: 'relocation-lock-acquired' | 'relocation-undo-lock-acquired'): boolean {
    const resources = [...new Set(relocationResources(row))].sort()
    return runInTransaction(options.db, () => {
      const relocationLocks = options.db.prepare('SELECT resource FROM source_relocation_locks').all() as Array<{ resource: string }>
      const consolidationLocks = options.db.prepare('SELECT resource FROM consolidation_operation_locks').all() as Array<{ resource: string }>
      const existing = [...relocationLocks, ...consolidationLocks]
      if (resources.some((resource) => existing.some((locked) => resourcesConflict(resource, locked.resource)))) return false
      const insert = options.db.prepare('INSERT INTO source_relocation_locks (resource, relocation_id) VALUES (?, ?)')
      for (const resource of resources) insert.run(resource, row.id)
      options.db.prepare('UPDATE source_relocations SET phase = ?, journal_json = ? WHERE id = ?')
        .run(phase, JSON.stringify([{ phase, intent: 'applied', at: new Date().toISOString() }]), row.id)
      return true
    })
  }

  function releaseRelocationLocks(id: string): void {
    options.db.prepare('DELETE FROM source_relocation_locks WHERE relocation_id = ?').run(id)
  }

  function markRelocation(row: RelocationRow, phase: string, intent: 'prepared' | 'applied'): void {
    const current = getRelocation(row.id)
    const journal = current?.journal_json ? JSON.parse(current.journal_json) as Array<Record<string, unknown>> : []
    journal.push({ phase, intent, at: new Date().toISOString() })
    options.db.prepare('UPDATE source_relocations SET phase = ?, journal_json = ? WHERE id = ?')
      .run(`${phase}:${intent}`, JSON.stringify(journal), row.id)
    if (intent === 'applied') options.relocationHooks?.onPhase?.({ relocationId: row.id, phase })
  }

  function currentRelocationPlan(row: RelocationRow, expectedPath: string): {
    source: SkillSource
    snapshots: RelocationDeploymentSnapshot[]
  } {
    const source = getSourceById(options.db, row.source_id)
    if (!source || source.source_role !== 'canonical' || resolve(source.path) !== resolve(expectedPath) || source.hash !== row.source_hash) {
      throw new Error('Canonical Source registration changed')
    }
    if (!pathEntryExists(expectedPath) || !statSync(expectedPath).isDirectory() || hashDir(expectedPath) !== row.source_hash) {
      throw new Error('Canonical Source content changed or is unavailable')
    }
    const snapshots = relocationSnapshots(row)
    const current = relationsForCanonicalSource(source)
    if (current.some((deployment) => deployment.management === 'observed')) {
      throw new Error('Observed Subscription must be adopted or removed before Source Relocation')
    }
    const expectedDeployments = snapshots.map((snapshot) => ({ ...snapshot.deployment, source_path: expectedPath }))
    if (JSON.stringify(current) !== JSON.stringify(expectedDeployments)) {
      throw new Error('Managed Deployment set changed')
    }
    for (const deployment of current) {
      if (deployment.mode !== 'copy') assertObservedLink(deployment, expectedPath)
    }
    return { source, snapshots }
  }

  function linkWorkPaths(relocationId: string, targetPath: string) {
    return {
      stage: resolveWithin(dirname(targetPath), `.${basename(targetPath)}.skill-switch-relocation-stage-${relocationId}`),
      rollback: resolveWithin(dirname(targetPath), `.${basename(targetPath)}.skill-switch-relocation-rollback-${relocationId}`)
    }
  }

  interface LinkReplacementState {
    targetPath: string
    rollback: string
    stage: string
    targetDisplaced: boolean
    replacementInstalled: boolean
  }

  function installReplacementLink(
    relocationId: string,
    snapshot: RelocationDeploymentSnapshot,
    linkTarget: string,
    track: (state: LinkReplacementState) => void
  ): void {
    const targetPath = snapshot.deployment.target_path!
    const paths = linkWorkPaths(relocationId, targetPath)
    if (pathEntryExists(paths.stage) || pathEntryExists(paths.rollback)) throw new Error(`Deployment rollback path is occupied: ${targetPath}`)
    const state: LinkReplacementState = {
      targetPath, ...paths, targetDisplaced: false, replacementInstalled: false
    }
    track(state)
    symlinkSync(linkTarget, paths.stage, snapshot.deployment.mode === 'junction' ? 'junction' : 'dir')
    renameSync(targetPath, paths.rollback)
    state.targetDisplaced = true
    options.relocationHooks?.onPhase?.({ relocationId, phase: 'link-target-displaced' })
    renameSync(paths.stage, targetPath)
    state.replacementInstalled = true
  }

  function restoreReplacedLink(item: LinkReplacementState): void {
    if (item.replacementInstalled) removePathEntry(item.targetPath)
    if (item.targetDisplaced && pathEntryExists(item.rollback)) renameSync(item.rollback, item.targetPath)
    removePathEntry(item.stage)
  }

  function confirmSourceRelocation(confirmationId: string): SourceRelocationOutcome {
    const row = getRelocation(confirmationId)
    if (!row) return { status: 'rejected', reason: 'confirmation-not-found', message: 'Source Relocation confirmation does not exist.' }
    if (row.status === 'recovery-required') return { status: 'recovery-required', relocationId: row.id, message: row.failure_message ?? 'Source Relocation requires recovery.' }
    if (row.status !== 'previewed') return { status: 'rejected', relocationId: row.id, reason: 'plan-stale', message: 'Source Relocation confirmation is no longer pending.' }
    if (!acquireRelocationLocks(row, 'relocation-lock-acquired')) {
      return { status: 'rejected', relocationId: row.id, reason: 'relocation-busy', message: 'Source Relocation resources are busy.' }
    }
    const replacedLinks: LinkReplacementState[] = []
    const createdParents = missingParents(row.new_path)
    let sourceMoved = false
    let registryCommitted = false
    try {
      assertCanonicalParentConfined(row.new_path)
      if (pathEntryExists(row.new_path)) throw new Error('New Canonical Placement is occupied')
      const { source, snapshots } = currentRelocationPlan(row, row.old_path)
      markRelocation(row, 'source-moved', 'prepared')
      mkdirSync(dirname(row.new_path), { recursive: true })
      renameSync(row.old_path, row.new_path)
      sourceMoved = true
      markRelocation(row, 'source-moved', 'applied')
      markRelocation(row, 'links-updated', 'prepared')
      for (const snapshot of snapshots) {
        if (snapshot.deployment.mode === 'copy') continue
        installReplacementLink(row.id, snapshot, row.new_path, (state) => replacedLinks.push(state))
      }
      markRelocation(row, 'links-updated', 'applied')
      markRelocation(row, 'registry-committed', 'prepared')
      runInTransaction(options.db, () => {
        options.db.prepare('UPDATE skill_sources SET path = ?, mtime = ? WHERE id = ?')
          .run(row.new_path, Math.floor(statSync(row.new_path).mtimeMs), source.id)
        updatePrimarySourcePath(options.db, row.skill_id, row.new_path)
        options.db.prepare('UPDATE deployments SET source_path = ? WHERE source_id = ?').run(row.new_path, source.id)
        options.db.prepare("UPDATE source_relocations SET status = 'completed', completed_at = ?, phase = 'registry-committed:applied' WHERE id = ?")
          .run(new Date().toISOString(), row.id)
      })
      registryCommitted = true
      options.relocationHooks?.onPhase?.({ relocationId: row.id, phase: 'registry-committed' })
      for (const item of replacedLinks) removePathEntry(item.rollback)
      removeCreatedParents([])
      runInTransaction(options.db, () => {
        options.db.prepare('UPDATE source_relocations SET phase = NULL, failure_message = NULL WHERE id = ?').run(row.id)
        releaseRelocationLocks(row.id)
      })
      return { status: 'completed', relocationId: row.id, sourceId: source.id, canonicalPath: row.new_path }
    } catch (error) {
      const message = errorMessage(error)
      if (registryCommitted) {
        options.db.prepare("UPDATE source_relocations SET status = 'recovery-required', failure_message = ? WHERE id = ?").run(message, row.id)
        return { status: 'recovery-required', relocationId: row.id, message }
      }
      let compensationError: unknown = null
      try {
        for (const item of [...replacedLinks].reverse()) restoreReplacedLink(item)
        if (sourceMoved && pathEntryExists(row.new_path) && !pathEntryExists(row.old_path)) renameSync(row.new_path, row.old_path)
        removeCreatedParents(createdParents)
      } catch (rollbackError) {
        compensationError = rollbackError
      }
      if (compensationError) {
        const recoveryMessage = `${message}; compensation failed: ${errorMessage(compensationError)}`
        options.db.prepare("UPDATE source_relocations SET status = 'recovery-required', failure_message = ? WHERE id = ?").run(recoveryMessage, row.id)
        return { status: 'recovery-required', relocationId: row.id, message: recoveryMessage }
      }
      runInTransaction(options.db, () => {
        options.db.prepare("UPDATE source_relocations SET status = 'failed', phase = NULL, failure_message = ? WHERE id = ?").run(message, row.id)
        releaseRelocationLocks(row.id)
      })
      return { status: 'rejected', relocationId: row.id, reason: 'plan-stale', message }
    }
  }

  function undoSourceRelocation(relocationId: string): SourceRelocationOutcome {
    const row = getRelocation(relocationId)
    if (!row) return { status: 'rejected', reason: 'confirmation-not-found', message: 'Source Relocation does not exist.' }
    if (row.status === 'recovery-required') return { status: 'recovery-required', relocationId: row.id, message: row.failure_message ?? 'Source Relocation requires recovery.' }
    if (row.status !== 'completed' || row.phase !== null) {
      return { status: 'rejected', relocationId: row.id, reason: 'relocation-not-undoable', message: 'Source Relocation is not safely undoable.' }
    }
    if (!acquireRelocationLocks(row, 'relocation-undo-lock-acquired')) {
      return { status: 'rejected', relocationId: row.id, reason: 'relocation-busy', message: 'Source Relocation resources are busy.' }
    }
    const replacedLinks: LinkReplacementState[] = []
    let sourceMoved = false
    let registryCommitted = false
    try {
      if (pathEntryExists(row.old_path)) throw new Error('Previous Canonical Placement is occupied')
      assertCanonicalParentConfined(row.old_path)
      const { source, snapshots } = currentRelocationPlan(row, row.new_path)
      markRelocation(row, 'undo-links-updated', 'prepared')
      for (const snapshot of snapshots) {
        if (snapshot.deployment.mode === 'copy') continue
        installReplacementLink(row.id, snapshot, snapshot.linkTarget!, (state) => replacedLinks.push(state))
      }
      markRelocation(row, 'undo-links-updated', 'applied')
      markRelocation(row, 'undo-source-moved', 'prepared')
      mkdirSync(dirname(row.old_path), { recursive: true })
      renameSync(row.new_path, row.old_path)
      sourceMoved = true
      markRelocation(row, 'undo-source-moved', 'applied')
      runInTransaction(options.db, () => {
        options.db.prepare('UPDATE skill_sources SET path = ?, mtime = ? WHERE id = ?')
          .run(row.old_path, Math.floor(statSync(row.old_path).mtimeMs), source.id)
        updatePrimarySourcePath(options.db, row.skill_id, row.old_path)
        options.db.prepare('UPDATE deployments SET source_path = ? WHERE source_id = ?').run(row.old_path, source.id)
        options.db.prepare("UPDATE source_relocations SET phase = 'undo-registry-committed:applied' WHERE id = ?").run(row.id)
      })
      registryCommitted = true
      for (const item of replacedLinks) removePathEntry(item.rollback)
      removeCreatedParents(missingParents(row.new_path))
      runInTransaction(options.db, () => {
        options.db.prepare("UPDATE source_relocations SET status = 'undone', undone_at = ?, phase = NULL, failure_message = NULL WHERE id = ?")
          .run(new Date().toISOString(), row.id)
        releaseRelocationLocks(row.id)
      })
      return { status: 'undone', relocationId: row.id, sourceId: source.id, canonicalPath: row.old_path }
    } catch (error) {
      const message = errorMessage(error)
      if (registryCommitted) {
        options.db.prepare("UPDATE source_relocations SET status = 'recovery-required', failure_message = ? WHERE id = ?").run(message, row.id)
        return { status: 'recovery-required', relocationId: row.id, message }
      }
      let compensationError: unknown = null
      try {
        if (sourceMoved && pathEntryExists(row.old_path) && !pathEntryExists(row.new_path)) {
          mkdirSync(dirname(row.new_path), { recursive: true })
          renameSync(row.old_path, row.new_path)
        }
        for (const item of [...replacedLinks].reverse()) restoreReplacedLink(item)
      } catch (rollbackError) {
        compensationError = rollbackError
      }
      if (compensationError) {
        const recoveryMessage = `${message}; undo compensation failed: ${errorMessage(compensationError)}`
        options.db.prepare("UPDATE source_relocations SET status = 'recovery-required', failure_message = ? WHERE id = ?").run(recoveryMessage, row.id)
        return { status: 'recovery-required', relocationId: row.id, message: recoveryMessage }
      }
      runInTransaction(options.db, () => {
        options.db.prepare("UPDATE source_relocations SET phase = NULL, failure_message = ? WHERE id = ?").run(message, row.id)
        releaseRelocationLocks(row.id)
      })
      return { status: 'rejected', relocationId: row.id, reason: 'plan-stale', message }
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
    restoreConsolidation: undoConsolidation,
    previewSourceArchivePurge,
    confirmSourceArchivePurge,
    previewSourceRelocation,
    confirmSourceRelocation,
    undoSourceRelocation,
    replaceCanonicalSource,
    read() {
      const skills = getAllSkills(options.db).map((skill) => {
        const canonicalSources = skill.sources.filter((source) => source.source_role === 'canonical')
        if (canonicalSources.length > 1) throw new Error(`Skill ${skill.name} has multiple canonical Sources`)
        return { id: skill.id, name: skill.name, canonicalSource: canonicalSources[0] ?? null,
          candidates: skill.sources.filter((source) => source.source_role === 'candidate') }
      })
      const batches = options.db.prepare('SELECT * FROM consolidation_batches ORDER BY created_at DESC').all() as BatchRow[]
      const consolidationPlan = skills
        .filter((skill) => skill.canonicalSource === null && skill.candidates.length > 0)
        .map((skill) => {
          const groups = new Map<string, SkillSource[]>()
          for (const candidate of skill.candidates) {
            const group = groups.get(candidate.hash) ?? []
            group.push(candidate)
            groups.set(candidate.hash, group)
          }
          const versions = [...groups.entries()].map(([hash, candidates]) => ({
            hash,
            candidateSourceIds: candidates.map((candidate) => candidate.id),
            paths: candidates.map((candidate) => candidate.path)
          }))
          return {
            skillId: skill.id,
            skillName: skill.name,
            selectedByDefault: versions.length === 1,
            hasConflict: versions.length > 1,
            canonicalRelativeParent: '',
            versions
          }
        })
      const relocations = options.db.prepare('SELECT * FROM source_relocations ORDER BY created_at DESC').all() as RelocationRow[]
      return {
        canonicalRepository: { path: canonicalRepositoryPath }, skills, consolidationPlan,
        sourceRelocations: relocations.map((relocation) => ({
          id: relocation.id, status: relocation.status, skillId: relocation.skill_id,
          skillName: relocation.skill_name, sourceId: relocation.source_id,
          oldCanonicalPath: relocation.old_path, newCanonicalPath: relocation.new_path,
          createdAt: relocation.created_at, completedAt: relocation.completed_at,
          undoneAt: relocation.undone_at, failureMessage: relocation.failure_message
        })),
        consolidationBatches: batches.map((batch) => {
          const itemRows = options.db.prepare('SELECT skill_id, skill_name, canonical_path, archive_path, candidate_source_snapshot, observed_deployments_snapshot, phase FROM consolidation_items WHERE batch_id = ? ORDER BY id ASC').all(batch.id) as Array<{ skill_id: number; skill_name: string; canonical_path: string; archive_path: string; candidate_source_snapshot: string; observed_deployments_snapshot: string; phase: string | null }>
          const phases = [...new Set([batch.phase, ...itemRows.map((item) => item.phase)].filter((phase): phase is string => phase !== null))]
          let recoveryDirection: ConsolidationBatchSummary['recoveryDirection'] = null
          if (batch.status === 'recovery-required') {
            recoveryDirection = phases.some((phase) => phase.includes('registry-committed') || phase.includes('cleanup'))
              ? 'finish-cleanup'
              : phases.some((phase) => phase.includes('undo')) ? 'rollback-undo'
                : phases.some((phase) => phase.includes('archive-purge')) ? 'inspect'
                  : phases.length > 0 ? 'rollback-consolidation' : 'inspect'
          }
          return {
            id: batch.id, status: batch.status,
            items: itemRows.map((item) => {
              const original = snapshotSources(item.candidate_source_snapshot)[0]
              const observed = JSON.parse(item.observed_deployments_snapshot) as ObservedEntrySnapshot[]
              return {
                skillId: item.skill_id, skillName: item.skill_name, canonicalPath: item.canonical_path,
                archivePath: item.archive_path, originalPath: original.path, originalHash: original.hash,
                archivedToolPaths: observed.map((entry) => entry.deployment.target_path!).filter(Boolean)
              }
            }),
            archive: {
              sizeBytes: batch.archive_size_bytes ?? directorySize(resolveWithin(sourceArchivePath, batch.id)),
              recoverable: batch.status === 'completed' && batch.archive_purged_at === null && pathEntryExists(resolveWithin(sourceArchivePath, batch.id)),
              purgeable: ['completed', 'undone'].includes(batch.status) && batch.archive_purged_at === null && pathEntryExists(resolveWithin(sourceArchivePath, batch.id)),
              purgedAt: batch.archive_purged_at
            },
            phase: batch.phase, createdAt: batch.created_at, completedAt: batch.completed_at,
            undoneAt: batch.undone_at, failureMessage: batch.failure_message,
            recoveryDirection, evidenceSummary: { itemCount: itemRows.length, phases }
          }
        })
      }
    }
  }
}
