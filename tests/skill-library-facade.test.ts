import { describe, expect, test } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { upsertSkill } from '../src/main/db/dao/skills'
import { getSourceByPath, upsertSource } from '../src/main/db/dao/skill-sources'
import { getAllDeployments, upsertDeployment } from '../src/main/db/dao/deployments'
import { createDatabase } from '../src/main/db/database'
import { createSkillLibraryFacade } from '../src/main/services/skill-library-facade'
import { hashDir } from '../src/main/services/hash'
import { createTempDb, createTempDir } from './helpers/temp'

describe('SkillLibraryFacade', () => {
  function relocationFixture(prefix: string) {
    const root = createTempDir(prefix)
    const canonicalRepository = join(root.dir, 'canonical')
    const oldPath = join(canonicalRepository, 'old', 'demo')
    const linkedTarget = join(root.dir, 'codex', 'demo')
    const copiedTarget = join(root.dir, 'agents', 'demo')
    mkdirSync(oldPath, { recursive: true })
    mkdirSync(dirname(linkedTarget), { recursive: true })
    mkdirSync(copiedTarget, { recursive: true })
    writeFileSync(join(oldPath, 'SKILL.md'), '# canonical demo')
    writeFileSync(join(copiedTarget, 'SKILL.md'), '# deployed snapshot')
    symlinkSync(oldPath, linkedTarget, 'dir')
    const db = createDatabase(join(root.dir, 'registry.db'), canonicalRepository)
    const skillId = upsertSkill(db, 'demo', oldPath)
    const sourceHash = hashDir(oldPath)
    upsertSource(db, skillId, oldPath, sourceHash, 1, 'central-repo', { role: 'canonical', origin: 'local' })
    const source = getSourceByPath(db, oldPath)!
    upsertDeployment(db, skillId, 'codex', linkedTarget, 'symlink', oldPath, sourceHash, {
      sourceId: source.id, targetId: 'codex:demo'
    })
    upsertDeployment(db, skillId, 'agents', copiedTarget, 'copy', oldPath, sourceHash, {
      sourceId: source.id, targetId: 'agents:demo'
    })
    const facade = createSkillLibraryFacade({ db, canonicalRepositoryPath: canonicalRepository })
    return { root, db, facade, source, skillId, sourceHash, canonicalRepository, oldPath, linkedTarget, copiedTarget }
  }

  test('previews a Source Relocation from only its identity and new relative parent', () => {
    const fixture = relocationFixture('skill-library-relocation-preview-')

    const preview = fixture.facade.previewSourceRelocation({
      sourceId: fixture.source.id,
      canonicalRelativeParent: 'team/backend'
    })

    expect(preview).toMatchObject({
      status: 'confirmation-required',
      skillId: fixture.skillId,
      skillName: 'demo',
      oldCanonicalPath: fixture.oldPath,
      newCanonicalPath: join(fixture.canonicalRepository, 'team', 'backend', 'demo'),
      deployments: [
        { targetTool: 'codex', targetPath: fixture.linkedTarget, mode: 'symlink' },
        { targetTool: 'agents', targetPath: fixture.copiedTarget, mode: 'copy' }
      ]
    })
    fixture.db.close()
    fixture.root.cleanup()
  })

  test('blocks Source Relocation while any observed Subscription references the Source', () => {
    const fixture = relocationFixture('skill-library-relocation-observed-')
    fixture.db.prepare("UPDATE deployments SET management = 'observed' WHERE target_id = 'codex:demo'").run()

    expect(() => fixture.facade.previewSourceRelocation({
      sourceId: fixture.source.id,
      canonicalRelativeParent: 'team'
    })).toThrow(/Observed Subscription/)
    fixture.db.close()
    fixture.root.cleanup()
  })

  test('atomically relocates the Source and managed links while a copy only updates its identity association', () => {
    const fixture = relocationFixture('skill-library-relocation-confirm-')
    const copiedBefore = readFileSync(join(fixture.copiedTarget, 'SKILL.md'), 'utf8')
    const preview = fixture.facade.previewSourceRelocation({ sourceId: fixture.source.id, canonicalRelativeParent: 'team' })
    const newPath = join(fixture.canonicalRepository, 'team', 'demo')

    expect(fixture.facade.confirmSourceRelocation(preview.confirmationId)).toEqual({
      status: 'completed', relocationId: preview.relocationId,
      sourceId: fixture.source.id, canonicalPath: newPath
    })
    expect(existsSync(fixture.oldPath)).toBe(false)
    expect(readFileSync(join(newPath, 'SKILL.md'), 'utf8')).toBe('# canonical demo')
    expect(resolve(dirname(fixture.linkedTarget), readlinkSync(fixture.linkedTarget))).toBe(newPath)
    expect(readFileSync(join(fixture.copiedTarget, 'SKILL.md'), 'utf8')).toBe(copiedBefore)
    expect(getSourceByPath(fixture.db, newPath)).toMatchObject({ id: fixture.source.id, hash: fixture.sourceHash })
    expect(getAllDeployments(fixture.db).map((deployment) => deployment.source_path)).toEqual([newPath, newPath])
    const completedJournal = fixture.db.prepare('SELECT status, phase, journal_json FROM source_relocations WHERE id = ?')
      .get(preview.relocationId) as { status: string; phase: string | null; journal_json: string }
    expect(completedJournal).toMatchObject({ status: 'completed', phase: null })
    expect(JSON.parse(completedJournal.journal_json)).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'source-moved', intent: 'prepared' }),
      expect.objectContaining({ phase: 'links-updated', intent: 'applied' })
    ]))
    expect(fixture.db.prepare('SELECT resource FROM source_relocation_locks').all()).toEqual([])

    expect(fixture.facade.undoSourceRelocation(preview.relocationId)).toEqual({
      status: 'undone', relocationId: preview.relocationId,
      sourceId: fixture.source.id, canonicalPath: fixture.oldPath
    })
    expect(existsSync(newPath)).toBe(false)
    expect(readFileSync(join(fixture.oldPath, 'SKILL.md'), 'utf8')).toBe('# canonical demo')
    expect(resolve(dirname(fixture.linkedTarget), readlinkSync(fixture.linkedTarget))).toBe(fixture.oldPath)
    expect(readFileSync(join(fixture.copiedTarget, 'SKILL.md'), 'utf8')).toBe(copiedBefore)
    expect(getSourceByPath(fixture.db, fixture.oldPath)).toMatchObject({ id: fixture.source.id })
    expect(fixture.facade.read().sourceRelocations[0]).toMatchObject({
      id: preview.relocationId, status: 'undone', oldCanonicalPath: fixture.oldPath, newCanonicalPath: newPath
    })
    fixture.db.close()
    fixture.root.cleanup()
  })

  test('compensates the Source and links when relocation fails before registry commit', () => {
    const fixture = relocationFixture('skill-library-relocation-compensate-')
    const facade = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      relocationHooks: {
        onPhase: ({ phase }) => { if (phase === 'links-updated') throw new Error('injected relocation failure') }
      }
    })
    const preview = facade.previewSourceRelocation({ sourceId: fixture.source.id, canonicalRelativeParent: 'team' })

    expect(facade.confirmSourceRelocation(preview.confirmationId)).toMatchObject({ status: 'rejected' })
    expect(existsSync(fixture.oldPath)).toBe(true)
    expect(existsSync(join(fixture.canonicalRepository, 'team', 'demo'))).toBe(false)
    expect(resolve(dirname(fixture.linkedTarget), readlinkSync(fixture.linkedTarget))).toBe(fixture.oldPath)
    expect(getSourceByPath(fixture.db, fixture.oldPath)).toMatchObject({ id: fixture.source.id })
    fixture.db.close()
    fixture.root.cleanup()
  })

  test('keeps the journal and locks when a displaced link cannot be compensated', () => {
    const fixture = relocationFixture('skill-library-relocation-link-recovery-')
    const facade = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      relocationHooks: {
        onPhase: ({ phase }) => {
          if (phase === 'link-target-displaced') {
            mkdirSync(fixture.linkedTarget)
            throw new Error('injected link installation failure')
          }
        }
      }
    })
    const preview = facade.previewSourceRelocation({ sourceId: fixture.source.id, canonicalRelativeParent: 'team' })

    expect(facade.confirmSourceRelocation(preview.confirmationId)).toMatchObject({ status: 'recovery-required' })
    expect(fixture.db.prepare('SELECT status FROM source_relocations WHERE id = ?').get(preview.relocationId))
      .toEqual({ status: 'recovery-required' })
    expect(fixture.db.prepare('SELECT resource FROM source_relocation_locks WHERE relocation_id = ?').all(preview.relocationId))
      .not.toEqual([])
    fixture.db.close()
    fixture.root.cleanup()
  })

  test('freezes interrupted persisted relocation work after restart', () => {
    const fixture = relocationFixture('skill-library-relocation-restart-')
    const preview = fixture.facade.previewSourceRelocation({ sourceId: fixture.source.id, canonicalRelativeParent: 'team' })
    fixture.db.prepare("UPDATE source_relocations SET phase = 'source-moved:prepared' WHERE id = ?").run(preview.relocationId)
    fixture.db.prepare('INSERT INTO source_relocation_locks (resource, relocation_id) VALUES (?, ?)')
      .run(`source:${fixture.source.id}`, preview.relocationId)

    const restarted = createSkillLibraryFacade({ db: fixture.db, canonicalRepositoryPath: fixture.canonicalRepository })
    expect(restarted.confirmSourceRelocation(preview.confirmationId)).toMatchObject({ status: 'recovery-required' })
    expect(restarted.read().sourceRelocations[0]).toMatchObject({ status: 'recovery-required' })
    expect(fixture.db.prepare('SELECT resource FROM source_relocation_locks WHERE relocation_id = ?').all(preview.relocationId))
      .not.toEqual([])
    fixture.db.close()
    fixture.root.cleanup()
  })

  test('undo safely rejects occupied old placement, changed content, and a new observed relation', () => {
    for (const unsafe of ['occupied', 'content', 'observed'] as const) {
      const fixture = relocationFixture(`skill-library-relocation-undo-${unsafe}-`)
      const preview = fixture.facade.previewSourceRelocation({ sourceId: fixture.source.id, canonicalRelativeParent: 'team' })
      const result = fixture.facade.confirmSourceRelocation(preview.confirmationId)
      expect(result.status).toBe('completed')
      const newPath = join(fixture.canonicalRepository, 'team', 'demo')
      if (unsafe === 'occupied') mkdirSync(fixture.oldPath, { recursive: true })
      if (unsafe === 'content') writeFileSync(join(newPath, 'SKILL.md'), '# changed')
      if (unsafe === 'observed') {
        const target = join(fixture.root.dir, 'new-tool', 'demo')
        mkdirSync(dirname(target), { recursive: true })
        symlinkSync(newPath, target, 'dir')
        upsertDeployment(fixture.db, fixture.skillId, 'new-tool', target, 'symlink', newPath, fixture.sourceHash, {
          sourceId: fixture.source.id, targetId: 'new-tool:demo'
        }, 'observed')
      }
      expect(fixture.facade.undoSourceRelocation(preview.relocationId)).toMatchObject({
        status: 'rejected', reason: 'plan-stale'
      })
      expect(existsSync(newPath)).toBe(true)
      fixture.db.close()
      fixture.root.cleanup()
    }
  })
  function consolidationFixture(prefix: string) {
    const root = createTempDir(prefix)
    const canonicalRepository = join(root.dir, 'canonical')
    const sourceArchive = join(root.dir, 'source-archive')
    const backups = join(root.dir, 'backups')
    const candidatePath = join(root.dir, 'candidates', 'demo')
    const targetPath = join(root.dir, 'tool', 'demo')
    mkdirSync(candidatePath, { recursive: true })
    mkdirSync(join(root.dir, 'tool'), { recursive: true })
    writeFileSync(join(candidatePath, 'SKILL.md'), '# candidate demo')
    symlinkSync(candidatePath, targetPath, 'dir')
    const db = createDatabase(join(root.dir, 'registry.db'), canonicalRepository)
    const skillId = upsertSkill(db, 'demo', candidatePath)
    upsertSource(db, skillId, candidatePath, hashDir(candidatePath), 1, 'indexed', {
      role: 'candidate', origin: 'scan'
    })
    const source = getSourceByPath(db, candidatePath)!
    upsertDeployment(db, skillId, 'codex', targetPath, 'symlink', candidatePath, source.hash, {
      sourceId: source.id,
      targetId: 'codex:demo'
    }, 'observed')
    const facade = createSkillLibraryFacade({
      db,
      canonicalRepositoryPath: canonicalRepository,
      sourceArchivePath: sourceArchive,
      backupsDir: backups
    })
    return { root, db, facade, source, candidatePath, targetPath, canonicalRepository, sourceArchive }
  }

  function addCandidate(
    fixture: ReturnType<typeof consolidationFixture>,
    name: string,
    tool: string
  ) {
    const candidatePath = join(fixture.root.dir, 'candidates', name)
    const targetPath = join(fixture.root.dir, tool, name)
    mkdirSync(candidatePath, { recursive: true })
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(join(candidatePath, 'SKILL.md'), `# candidate ${name}`)
    symlinkSync(candidatePath, targetPath, 'dir')
    const skillId = upsertSkill(fixture.db, name, candidatePath)
    upsertSource(fixture.db, skillId, candidatePath, hashDir(candidatePath), 1, 'indexed', { role: 'candidate', origin: 'scan' })
    const source = getSourceByPath(fixture.db, candidatePath)!
    upsertDeployment(fixture.db, skillId, tool, targetPath, 'symlink', candidatePath, source.hash, {
      sourceId: source.id, targetId: `${tool}:${name}`
    }, 'observed')
    return { source, candidatePath, targetPath }
  }

  test('confirms and undoes multiple Candidate Sources as one atomic batch', () => {
    const fixture = consolidationFixture('skill-library-batch-')
    const second = addCandidate(fixture, 'review', 'claude')

    const preview = fixture.facade.previewConsolidationBatch({ items: [
      { candidateSourceId: fixture.source.id, canonicalRelativeParent: 'engineering' },
      { candidateSourceId: second.source.id, canonicalRelativeParent: 'product' }
    ] })
    expect(preview.items).toEqual([
      { skillId: fixture.source.skill_id, skillName: 'demo', canonicalPath: join(fixture.canonicalRepository, 'engineering', 'demo') },
      { skillId: second.source.skill_id, skillName: 'review', canonicalPath: join(fixture.canonicalRepository, 'product', 'review') }
    ])

    expect(fixture.facade.confirmConsolidation(preview.confirmationId)).toMatchObject({
      status: 'completed', batchId: preview.batchId,
      items: [
        { skillId: fixture.source.skill_id, canonicalPath: join(fixture.canonicalRepository, 'engineering', 'demo') },
        { skillId: second.source.skill_id, canonicalPath: join(fixture.canonicalRepository, 'product', 'review') }
      ]
    })
    expect(getAllDeployments(fixture.db)).toEqual([])
    expect(fixture.facade.undoConsolidation(preview.batchId)).toEqual({ status: 'undone', batchId: preview.batchId })
    expect(readFileSync(join(fixture.candidatePath, 'SKILL.md'), 'utf8')).toBe('# candidate demo')
    expect(readFileSync(join(second.candidatePath, 'SKILL.md'), 'utf8')).toBe('# candidate review')
    expect(getAllDeployments(fixture.db)).toHaveLength(2)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('a later item phase failure compensates every earlier item in reverse order', () => {
    const fixture = consolidationFixture('skill-library-batch-compensate-')
    const second = addCandidate(fixture, 'review', 'claude')
    const facade = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive,
      backupsDir: join(fixture.root.dir, 'backups'),
      consolidationHooks: {
        onPhase: ({ itemIndex, phase }) => {
          if (itemIndex === 1 && phase === 'canonical-installed') throw new Error('injected second item failure')
        }
      }
    })
    const preview = facade.previewConsolidationBatch({ items: [
      { candidateSourceId: fixture.source.id, canonicalRelativeParent: 'team/backend' },
      { candidateSourceId: second.source.id, canonicalRelativeParent: 'team/product' }
    ] })

    expect(facade.confirmConsolidation(preview.confirmationId)).toMatchObject({ status: 'rejected' })
    expect(readFileSync(join(fixture.candidatePath, 'SKILL.md'), 'utf8')).toBe('# candidate demo')
    expect(readFileSync(join(second.candidatePath, 'SKILL.md'), 'utf8')).toBe('# candidate review')
    expect(lstatSync(fixture.targetPath).isSymbolicLink()).toBe(true)
    expect(lstatSync(second.targetPath).isSymbolicLink()).toBe(true)
    expect(existsSync(join(fixture.canonicalRepository, 'team'))).toBe(false)
    expect(getAllDeployments(fixture.db)).toHaveLength(2)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('deterministic resource locks reject a reentrant overlapping batch as busy', () => {
    const fixture = consolidationFixture('skill-library-batch-busy-')
    let reentrant: unknown
    let facade!: ReturnType<typeof createSkillLibraryFacade>
    facade = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive,
      backupsDir: join(fixture.root.dir, 'backups'),
      consolidationHooks: {
        onPhase: ({ batchId, phase }) => {
          if (phase === 'staging' && reentrant === undefined) reentrant = facade.confirmConsolidation(batchId)
        }
      }
    })
    const preview = facade.previewConsolidationBatch({ items: [
      { candidateSourceId: fixture.source.id, canonicalRelativeParent: '' }
    ] })

    expect(facade.confirmConsolidation(preview.confirmationId)).toMatchObject({ status: 'completed' })
    expect(reentrant).toMatchObject({ status: 'rejected', reason: 'batch-busy' })

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('a failure after registry commit keeps physical results and durable locks for finish-cleanup recovery', () => {
    const fixture = consolidationFixture('skill-library-batch-post-commit-')
    const facade = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive,
      backupsDir: join(fixture.root.dir, 'backups'),
      consolidationHooks: { afterRegistryCommit: () => { throw new Error('injected post-commit failure') } }
    })
    const preview = facade.previewConsolidationBatch({ items: [
      { candidateSourceId: fixture.source.id, canonicalRelativeParent: '' }
    ] })

    expect(facade.confirmConsolidation(preview.confirmationId)).toMatchObject({ status: 'recovery-required' })
    const canonicalPath = join(fixture.canonicalRepository, 'demo')
    expect(existsSync(fixture.candidatePath)).toBe(false)
    expect(readFileSync(join(canonicalPath, 'SKILL.md'), 'utf8')).toBe('# candidate demo')
    expect(getSourceByPath(fixture.db, canonicalPath)).toMatchObject({ source_role: 'canonical' })
    expect(facade.read().consolidationBatches[0]).toMatchObject({
      status: 'recovery-required', recoveryDirection: 'finish-cleanup'
    })
    expect(() => facade.replaceCanonicalSource({
      sourceDirectory: canonicalPath,
      skillName: 'demo',
      origin: 'zip'
    })).toThrow(/busy/)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('a cleanup failure after one item keeps the whole committed batch in finish-cleanup recovery', () => {
    const fixture = consolidationFixture('skill-library-batch-cleanup-failure-')
    const second = addCandidate(fixture, 'review', 'claude')
    const facade = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive,
      backupsDir: join(fixture.root.dir, 'backups'),
      consolidationHooks: {
        onFaultPoint: ({ itemIndex, point }) => {
          if (point === 'before-cleanup' && itemIndex === 1) throw new Error('injected cleanup failure')
        }
      }
    })
    const preview = facade.previewConsolidationBatch({ items: [
      { candidateSourceId: fixture.source.id, canonicalRelativeParent: '' },
      { candidateSourceId: second.source.id, canonicalRelativeParent: '' }
    ] })

    expect(facade.confirmConsolidation(preview.confirmationId)).toMatchObject({ status: 'recovery-required' })
    expect(existsSync(join(fixture.canonicalRepository, 'demo'))).toBe(true)
    expect(existsSync(join(fixture.canonicalRepository, 'review'))).toBe(true)
    expect(getAllDeployments(fixture.db)).toEqual([])
    expect(facade.read().consolidationBatches[0]).toMatchObject({ recoveryDirection: 'finish-cleanup' })

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('a compensation failure preserves rollback evidence, locks, and rollback direction', () => {
    const fixture = consolidationFixture('skill-library-batch-compensation-failure-')
    const facade = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive,
      backupsDir: join(fixture.root.dir, 'backups'),
      consolidationHooks: {
        onPhase: ({ phase }) => { if (phase === 'canonical-installed') throw new Error('injected operation failure') },
        onFaultPoint: ({ point }) => { if (point === 'before-compensation') throw new Error('injected compensation failure') }
      }
    })
    const preview = facade.previewConsolidationBatch({ items: [
      { candidateSourceId: fixture.source.id, canonicalRelativeParent: '' }
    ] })

    expect(facade.confirmConsolidation(preview.confirmationId)).toMatchObject({ status: 'recovery-required' })
    expect(facade.read().consolidationBatches[0]).toMatchObject({
      recoveryDirection: 'rollback-consolidation',
      evidenceSummary: { itemCount: 1, phases: expect.any(Array) }
    })
    expect(() => facade.replaceCanonicalSource({
      sourceDirectory: fixture.root.dir,
      skillName: 'demo',
      origin: 'zip'
    })).toThrow(/busy/)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('consolidates one Candidate Source without creating a Deployment and persists an undo entry', () => {
    const fixture = consolidationFixture('skill-library-consolidate-')

    const preview = fixture.facade.previewConsolidation({
      candidateSourceId: fixture.source.id,
      canonicalRelativeParent: 'engineering'
    })

    expect(preview).toMatchObject({
      status: 'confirmation-required',
      operations: [
        { kind: 'write-canonical', path: join(fixture.canonicalRepository, 'engineering', 'demo') },
        { kind: 'archive-candidate', path: expect.stringContaining(preview.batchId) },
        { kind: 'remove-observed-entry', path: fixture.targetPath }
      ]
    })

    expect(fixture.facade.confirmConsolidation(preview.confirmationId)).toEqual({
      status: 'completed',
      batchId: preview.batchId,
      skillId: fixture.source.skill_id,
      canonicalPath: join(fixture.canonicalRepository, 'engineering', 'demo')
    })
    expect(existsSync(fixture.candidatePath)).toBe(false)
    expect(existsSync(fixture.targetPath)).toBe(false)
    expect(readFileSync(join(fixture.canonicalRepository, 'engineering', 'demo', 'SKILL.md'), 'utf8')).toBe('# candidate demo')
    expect(getAllDeployments(fixture.db)).toEqual([])
    expect(fixture.facade.read().consolidationBatches).toMatchObject([{
      id: preview.batchId,
      status: 'completed',
      items: [{ skillId: fixture.source.skill_id, skillName: 'demo' }]
    }])

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('undo restores the exact Candidate Source and observed tool entry', () => {
    const fixture = consolidationFixture('skill-library-consolidate-undo-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(preview.confirmationId)

    expect(fixture.facade.undoConsolidation(preview.batchId)).toEqual({ status: 'undone', batchId: preview.batchId })
    expect(readFileSync(join(fixture.candidatePath, 'SKILL.md'), 'utf8')).toBe('# candidate demo')
    expect(lstatSync(fixture.targetPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(fixture.targetPath)).toBe(fixture.candidatePath)
    expect(existsSync(join(fixture.canonicalRepository, 'demo'))).toBe(false)
    expect(getSourceByPath(fixture.db, fixture.candidatePath)).toMatchObject({
      id: fixture.source.id,
      source_role: 'candidate'
    })
    expect(getAllDeployments(fixture.db)).toMatchObject([{
      management: 'observed',
      target_path: fixture.targetPath,
      source_id: fixture.source.id
    }])

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('confirmation rejects a changed Candidate Source without mutating any planned path', () => {
    const fixture = consolidationFixture('skill-library-consolidate-stale-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    writeFileSync(join(fixture.candidatePath, 'SKILL.md'), '# changed after preview')

    expect(fixture.facade.confirmConsolidation(preview.confirmationId)).toMatchObject({
      status: 'rejected', reason: 'plan-stale'
    })
    expect(existsSync(fixture.candidatePath)).toBe(true)
    expect(lstatSync(fixture.targetPath).isSymbolicLink()).toBe(true)
    expect(existsSync(join(fixture.canonicalRepository, 'demo'))).toBe(false)
    expect(getAllDeployments(fixture.db)).toHaveLength(1)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('confirmation rejects when another Candidate appears after preview', () => {
    const fixture = consolidationFixture('skill-library-consolidate-new-candidate-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    const sibling = join(fixture.root.dir, 'other', 'demo')
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'SKILL.md'), '# candidate demo')
    upsertSource(fixture.db, fixture.source.skill_id, sibling, hashDir(sibling), 2, 'indexed', { origin: 'scan' })

    expect(fixture.facade.confirmConsolidation(preview.confirmationId)).toMatchObject({
      status: 'rejected', reason: 'plan-stale'
    })
    expect(existsSync(fixture.candidatePath)).toBe(true)
    expect(existsSync(join(fixture.canonicalRepository, 'demo'))).toBe(false)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('blocks an unresolved legacy Deployment that still points at the Candidate path', () => {
    const fixture = consolidationFixture('skill-library-consolidate-unresolved-')
    fixture.db.prepare("UPDATE deployments SET source_id = NULL, target_id = NULL, management = 'managed'").run()

    expect(() => fixture.facade.previewConsolidation({
      candidateSourceId: fixture.source.id,
      canonicalRelativeParent: ''
    })).toThrow(/unresolved legacy Deployment/)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('confirmation rejects a newly registered unresolved relation', () => {
    const fixture = consolidationFixture('skill-library-consolidate-new-unresolved-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.db.prepare(`INSERT INTO deployments
      (skill_id, target_tool, target_path, mode, management, source_path, deployed_at, source_hash_at_deploy, source_id, target_id)
      VALUES (?, 'legacy', ?, 'symlink', 'observed', ?, 'now', ?, NULL, NULL)`)
      .run(fixture.source.skill_id, join(fixture.root.dir, 'legacy-tool', 'demo'), fixture.candidatePath, fixture.source.hash)

    expect(fixture.facade.confirmConsolidation(preview.confirmationId)).toMatchObject({
      status: 'rejected', reason: 'plan-stale'
    })
    expect(existsSync(fixture.candidatePath)).toBe(true)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('rejects a Canonical Placement whose existing parent symlink escapes the repository', () => {
    const fixture = consolidationFixture('skill-library-consolidate-escape-')
    const outside = join(fixture.root.dir, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(fixture.canonicalRepository, 'team'), 'dir')

    expect(() => fixture.facade.previewConsolidation({
      candidateSourceId: fixture.source.id,
      canonicalRelativeParent: 'team'
    })).toThrow(/escapes the Canonical Repository/)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('rejects parent traversal, absolute parents, and occupied Canonical Placements during preview', () => {
    const traversal = consolidationFixture('skill-library-consolidate-traversal-')
    expect(() => traversal.facade.previewConsolidationBatch({ items: [{
      candidateSourceId: traversal.source.id, canonicalRelativeParent: 'team/../outside'
    }] })).toThrow('cannot contain . or ..')
    traversal.db.close()
    traversal.root.cleanup()

    const absolute = consolidationFixture('skill-library-consolidate-absolute-')
    expect(() => absolute.facade.previewConsolidationBatch({ items: [{
      candidateSourceId: absolute.source.id, canonicalRelativeParent: join(absolute.root.dir, 'outside')
    }] })).toThrow('must be relative')
    absolute.db.close()
    absolute.root.cleanup()

    const occupied = consolidationFixture('skill-library-consolidate-occupied-')
    mkdirSync(join(occupied.canonicalRepository, 'demo'))
    expect(() => occupied.facade.previewConsolidationBatch({ items: [{
      candidateSourceId: occupied.source.id, canonicalRelativeParent: ''
    }] })).toThrow('occupied')
    occupied.db.close()
    occupied.root.cleanup()
  })

  test('surfaces an interrupted applying batch as recovery-required with durable evidence', () => {
    const fixture = consolidationFixture('skill-library-consolidate-interrupted-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.db.prepare("UPDATE consolidation_batches SET status = 'previewed', phase = 'source-displaced', evidence_json = ? WHERE id = ?")
      .run(JSON.stringify({ sourcePath: fixture.candidatePath }), preview.batchId)
    const recoveredFacade = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive,
      backupsDir: join(fixture.root.dir, 'backups')
    })

    expect(recoveredFacade.read().consolidationBatches[0]).toMatchObject({
      id: preview.batchId,
      status: 'recovery-required',
      phase: 'source-displaced'
    })
    expect(recoveredFacade.confirmConsolidation(preview.confirmationId)).toMatchObject({
      status: 'recovery-required', batchId: preview.batchId
    })

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('consolidation rejects a Skill that still has an unresolved Candidate version', () => {
    const fixture = consolidationFixture('skill-library-consolidate-conflict-')
    const sibling = join(fixture.root.dir, 'other', 'demo')
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'SKILL.md'), '# another candidate')
    upsertSource(fixture.db, fixture.source.skill_id, sibling, hashDir(sibling), 2, 'indexed', {
      role: 'candidate', origin: 'scan'
    })

    expect(() => fixture.facade.previewConsolidation({
      candidateSourceId: fixture.source.id,
      canonicalRelativeParent: ''
    })).toThrow('explicit decision for conflicting Candidate versions')
    expect(existsSync(fixture.candidatePath)).toBe(true)
    expect(existsSync(sibling)).toBe(true)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('groups hash-identical Candidates into one default-selected consolidation decision', () => {
    const fixture = consolidationFixture('skill-library-identical-plan-')
    const duplicatePath = join(fixture.root.dir, 'duplicates', 'demo')
    mkdirSync(duplicatePath, { recursive: true })
    writeFileSync(join(duplicatePath, 'SKILL.md'), '# candidate demo')
    upsertSource(fixture.db, fixture.source.skill_id, duplicatePath, hashDir(duplicatePath), 2, 'indexed', {
      role: 'candidate', origin: 'scan'
    })

    expect(fixture.facade.read().consolidationPlan).toEqual([{
      skillId: fixture.source.skill_id,
      skillName: 'demo',
      selectedByDefault: true,
      hasConflict: false,
      canonicalRelativeParent: '',
      versions: [{
        hash: fixture.source.hash,
        candidateSourceIds: [fixture.source.id, getSourceByPath(fixture.db, duplicatePath)!.id],
        paths: [fixture.candidatePath, duplicatePath]
      }]
    }])

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('consolidates every Candidate in a selected hash-identical version and undo restores them', () => {
    const fixture = consolidationFixture('skill-library-identical-consolidate-')
    const duplicatePath = join(fixture.root.dir, 'duplicates', 'demo')
    mkdirSync(duplicatePath, { recursive: true })
    writeFileSync(join(duplicatePath, 'SKILL.md'), '# candidate demo')
    upsertSource(fixture.db, fixture.source.skill_id, duplicatePath, hashDir(duplicatePath), 2, 'indexed', {
      role: 'candidate', origin: 'scan'
    })

    const preview = fixture.facade.previewConsolidationBatch({ items: [{
      candidateSourceId: fixture.source.id,
      canonicalRelativeParent: ''
    }] })
    expect(preview.items).toHaveLength(1)
    expect(fixture.facade.confirmConsolidation(preview.confirmationId)).toMatchObject({ status: 'completed' })
    expect(existsSync(fixture.candidatePath)).toBe(false)
    expect(existsSync(duplicatePath)).toBe(false)
    expect(fixture.facade.read().skills[0].candidates).toEqual([])

    expect(fixture.facade.undoConsolidation(preview.batchId)).toEqual({ status: 'undone', batchId: preview.batchId })
    expect(readFileSync(join(fixture.candidatePath, 'SKILL.md'), 'utf8')).toBe('# candidate demo')
    expect(readFileSync(join(duplicatePath, 'SKILL.md'), 'utf8')).toBe('# candidate demo')

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('leaves an unselected Candidate available for a later batch', () => {
    const fixture = consolidationFixture('skill-library-unselected-')
    const later = addCandidate(fixture, 'later', 'claude')

    const preview = fixture.facade.previewConsolidationBatch({ items: [{
      candidateSourceId: fixture.source.id,
      canonicalRelativeParent: ''
    }] })
    expect(fixture.facade.confirmConsolidation(preview.confirmationId)).toMatchObject({ status: 'completed' })

    expect(existsSync(later.candidatePath)).toBe(true)
    expect(fixture.facade.read().consolidationPlan).toMatchObject([{
      skillName: 'later', selectedByDefault: true
    }])

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('undo rejects occupied original paths and leaves the completed batch untouched', () => {
    const fixture = consolidationFixture('skill-library-consolidate-undo-busy-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(preview.confirmationId)
    mkdirSync(fixture.candidatePath, { recursive: true })

    expect(fixture.facade.undoConsolidation(preview.batchId)).toMatchObject({
      status: 'rejected', reason: 'restore-path-occupied'
    })
    expect(existsSync(join(fixture.canonicalRepository, 'demo'))).toBe(true)
    expect(fixture.facade.read().consolidationBatches[0]).toMatchObject({ status: 'completed', phase: null })
    const reopened = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive,
      backupsDir: join(fixture.root.dir, 'backups')
    })
    expect(reopened.read().consolidationBatches[0].status).toBe('completed')

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('exposes permanent Source Archive history and restores a completed batch as a whole', () => {
    const fixture = consolidationFixture('skill-library-archive-history-')
    const second = addCandidate(fixture, 'review', 'claude')
    const preview = fixture.facade.previewConsolidationBatch({ items: [
      { candidateSourceId: fixture.source.id, canonicalRelativeParent: 'engineering' },
      { candidateSourceId: second.source.id, canonicalRelativeParent: 'product' }
    ] })
    fixture.facade.confirmConsolidation(preview.confirmationId)

    const history = fixture.facade.read().consolidationBatches[0]
    expect(history.archive).toMatchObject({ recoverable: true, purgedAt: null })
    expect(history.archive.sizeBytes).toBeGreaterThan(0)
    expect(history.items).toEqual([
      expect.objectContaining({
        skillName: 'demo', originalPath: fixture.candidatePath,
        originalHash: fixture.source.hash, archivedToolPaths: [fixture.targetPath]
      }),
      expect.objectContaining({
        skillName: 'review', originalPath: second.candidatePath,
        originalHash: second.source.hash, archivedToolPaths: [second.targetPath]
      })
    ])

    expect(fixture.facade.restoreConsolidation(preview.batchId)).toEqual({
      status: 'undone', batchId: preview.batchId
    })
    expect(readFileSync(join(fixture.candidatePath, 'SKILL.md'), 'utf8')).toBe('# candidate demo')
    expect(readFileSync(join(second.candidatePath, 'SKILL.md'), 'utf8')).toBe('# candidate review')
    expect(readlinkSync(fixture.targetPath)).toBe(fixture.candidatePath)
    expect(readlinkSync(second.targetPath)).toBe(second.candidatePath)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('permanently purges archive payload only after a separate preview and keeps audit history', () => {
    const fixture = consolidationFixture('skill-library-archive-purge-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(preview.confirmationId)

    const purge = fixture.facade.previewSourceArchivePurge(preview.batchId)
    expect(purge).toMatchObject({
      status: 'confirmation-required', batchId: preview.batchId,
      itemCount: 1
    })
    if (purge.status !== 'confirmation-required') throw new Error(purge.message)
    expect(purge.sizeBytes).toBeGreaterThan(0)
    expect(existsSync(join(fixture.sourceArchive, preview.batchId))).toBe(true)

    const reopened = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive,
      backupsDir: join(fixture.root.dir, 'backups')
    })
    expect(reopened.confirmSourceArchivePurge(purge.confirmationId)).toMatchObject({
      status: 'purged', batchId: preview.batchId
    })
    expect(existsSync(join(fixture.sourceArchive, preview.batchId))).toBe(false)
    const history = reopened.read().consolidationBatches[0]
    expect(history).toMatchObject({ status: 'completed', archive: { recoverable: false } })
    expect(history.archive.purgedAt).not.toBeNull()
    expect(history.archive.sizeBytes).toBe(purge.sizeBytes)
    expect(history.items[0].originalPath).toBe(fixture.candidatePath)
    expect(reopened.restoreConsolidation(preview.batchId)).toMatchObject({
      status: 'rejected', reason: 'archive-purged'
    })

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('keeps an undone batch archived until the user explicitly purges it', () => {
    const fixture = consolidationFixture('skill-library-undone-archive-purge-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(preview.confirmationId)
    fixture.facade.restoreConsolidation(preview.batchId)

    expect(fixture.facade.read().consolidationBatches[0].archive).toMatchObject({
      recoverable: false, purgeable: true, purgedAt: null
    })
    const purge = fixture.facade.previewSourceArchivePurge(preview.batchId)
    expect(purge.status).toBe('confirmation-required')
    if (purge.status !== 'confirmation-required') throw new Error(purge.message)
    expect(fixture.facade.confirmSourceArchivePurge(purge.confirmationId)).toMatchObject({ status: 'purged' })

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('marks an interrupted purge of an undone batch as recovery-required on restart', () => {
    const fixture = consolidationFixture('skill-library-undone-purge-restart-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(preview.confirmationId)
    fixture.facade.restoreConsolidation(preview.batchId)
    fixture.db.prepare("UPDATE consolidation_batches SET phase = 'archive-purge' WHERE id = ?").run(preview.batchId)

    const reopened = createSkillLibraryFacade({
      db: fixture.db,
      canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive,
      backupsDir: join(fixture.root.dir, 'backups')
    })
    expect(reopened.read().consolidationBatches[0]).toMatchObject({
      status: 'recovery-required', recoveryDirection: 'inspect'
    })

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('finishes a confirmed purge on restart when payload deletion completed before the terminal database commit', () => {
    const fixture = consolidationFixture('skill-library-purge-durable-restart-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(preview.confirmationId)
    const purge = fixture.facade.previewSourceArchivePurge(preview.batchId)
    if (purge.status !== 'confirmation-required') throw new Error(purge.message)
    const archivePath = join(fixture.sourceArchive, preview.batchId)
    const stagePath = join(fixture.sourceArchive, `.purge-${preview.batchId}-${purge.confirmationId}`)
    rmSync(archivePath, { recursive: true })
    fixture.db.prepare('INSERT INTO consolidation_operation_locks (resource, batch_id) VALUES (?, ?)')
      .run(`path:${archivePath}`, preview.batchId)
    fixture.db.prepare('UPDATE consolidation_batches SET phase = ?, evidence_json = ? WHERE id = ?').run(
      'archive-purge-prepared',
      JSON.stringify({
        action: 'archive-purge-prepared', confirmationId: purge.confirmationId,
        archivePath, stagePath, archiveHash: 'already-validated', sizeBytes: purge.sizeBytes,
        originalStatus: 'completed'
      }),
      preview.batchId
    )

    const reopened = createSkillLibraryFacade({
      db: fixture.db, canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive, backupsDir: join(fixture.root.dir, 'backups')
    })
    expect(reopened.read().consolidationBatches[0]).toMatchObject({
      status: 'completed', phase: null, archive: { recoverable: false, purgeable: false }
    })
    expect(reopened.read().consolidationBatches[0].archive.purgedAt).not.toBeNull()
    expect(fixture.db.prepare('SELECT * FROM consolidation_operation_locks WHERE batch_id = ?').all(preview.batchId)).toEqual([])
    fixture.db.close()
    fixture.root.cleanup()
  })

  test('finishes a confirmed purge on restart from its durable staged payload', () => {
    const fixture = consolidationFixture('skill-library-purge-staged-restart-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(preview.confirmationId)
    const purge = fixture.facade.previewSourceArchivePurge(preview.batchId)
    if (purge.status !== 'confirmation-required') throw new Error(purge.message)
    const archivePath = join(fixture.sourceArchive, preview.batchId)
    const stagePath = join(fixture.sourceArchive, `.purge-${preview.batchId}-${purge.confirmationId}`)
    const archiveHash = hashDir(archivePath)
    renameSync(archivePath, stagePath)
    fixture.db.prepare('UPDATE consolidation_batches SET phase = ?, evidence_json = ? WHERE id = ?').run(
      'archive-purge-prepared',
      JSON.stringify({
        action: 'archive-purge-prepared', confirmationId: purge.confirmationId,
        archivePath, stagePath, archiveHash, sizeBytes: purge.sizeBytes, originalStatus: 'completed'
      }),
      preview.batchId
    )
    const reopened = createSkillLibraryFacade({
      db: fixture.db, canonicalRepositoryPath: fixture.canonicalRepository,
      sourceArchivePath: fixture.sourceArchive, backupsDir: join(fixture.root.dir, 'backups')
    })
    expect(existsSync(stagePath)).toBe(false)
    expect(reopened.read().consolidationBatches[0]).toMatchObject({ status: 'completed', phase: null })
    expect(reopened.read().consolidationBatches[0].archive.purgedAt).not.toBeNull()
    fixture.db.close()
    fixture.root.cleanup()
  })

  test('archive purge respects Source Relocation locks and leaves them untouched', () => {
    const fixture = consolidationFixture('skill-library-purge-relocation-lock-')
    const consolidation = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(consolidation.confirmationId)
    const purge = fixture.facade.previewSourceArchivePurge(consolidation.batchId)
    if (purge.status !== 'confirmation-required') throw new Error(purge.message)
    const canonical = getSourceByPath(fixture.db, join(fixture.canonicalRepository, 'demo'))!
    const relocation = fixture.facade.previewSourceRelocation({ sourceId: canonical.id, canonicalRelativeParent: 'team' })
    fixture.db.prepare('INSERT INTO source_relocation_locks (resource, relocation_id) VALUES (?, ?)')
      .run('skill:demo', relocation.relocationId)

    expect(fixture.facade.confirmSourceArchivePurge(purge.confirmationId)).toMatchObject({
      status: 'rejected', reason: 'batch-busy'
    })
    expect(fixture.db.prepare('SELECT resource FROM source_relocation_locks WHERE relocation_id = ?').all(relocation.relocationId))
      .toEqual([{ resource: 'skill:demo' }])
    expect(existsSync(join(fixture.sourceArchive, consolidation.batchId))).toBe(true)

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('read uses the complete restore preflight and explains an occupied original path without mutating the batch', () => {
    const fixture = consolidationFixture('skill-library-archive-preflight-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(preview.confirmationId)
    mkdirSync(fixture.candidatePath, { recursive: true })
    const batch = fixture.facade.read().consolidationBatches[0]
    expect(batch).toMatchObject({ status: 'completed', phase: null })
    expect(batch.archive).toMatchObject({
      recoverable: false, recoveryBlockedReason: '原候选来源或旧工具入口位置已被占用。'
    })
    expect(fixture.db.prepare('SELECT * FROM consolidation_operation_locks WHERE batch_id = ?').all(preview.batchId)).toEqual([])
    fixture.db.close()
    fixture.root.cleanup()
  })

  test('read and restore share the same canonical-integrity preflight result', () => {
    const fixture = consolidationFixture('skill-library-archive-canonical-preflight-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(preview.confirmationId)
    writeFileSync(join(fixture.canonicalRepository, 'demo', 'SKILL.md'), '# changed canonical')
    const reason = fixture.facade.read().consolidationBatches[0].archive.recoveryBlockedReason
    expect(reason).toBe('权威 Source 已变化或不可用。')
    expect(fixture.facade.restoreConsolidation(preview.batchId)).toMatchObject({
      status: 'rejected', reason: 'plan-stale', message: reason
    })
    expect(fixture.db.prepare('SELECT * FROM consolidation_operation_locks WHERE batch_id = ?').all(preview.batchId)).toEqual([])
    fixture.db.close()
    fixture.root.cleanup()
  })

  test('read accepts multi-source Candidate snapshots and exposes every original path', () => {
    const fixture = consolidationFixture('skill-library-archive-multi-snapshot-')
    const preview = fixture.facade.previewConsolidation({ candidateSourceId: fixture.source.id, canonicalRelativeParent: '' })
    fixture.facade.confirmConsolidation(preview.confirmationId)
    const second = { ...fixture.source, id: fixture.source.id + 100, path: join(fixture.root.dir, 'candidates', 'demo-copy') }
    fixture.db.prepare('UPDATE consolidation_items SET candidate_source_snapshot = ? WHERE batch_id = ?').run(
      JSON.stringify({ sources: [fixture.source, second] }), preview.batchId
    )

    expect(fixture.facade.read().consolidationBatches[0].items[0]).toMatchObject({
      originalPaths: [fixture.source.path, second.path],
      originalHashes: [fixture.source.hash, second.hash]
    })

    fixture.db.close()
    fixture.root.cleanup()
  })

  test('establishes the fixed Canonical Repository before exposing it', () => {
    const root = createTempDir('skill-library-establish-')
    const canonicalRepository = join(root.dir, 'nested', 'canonical')
    const database = createTempDb()

    const model = createSkillLibraryFacade({
      db: database.db,
      canonicalRepositoryPath: canonicalRepository
    }).read()

    expect(existsSync(canonicalRepository)).toBe(true)
    expect(model.canonicalRepository.path).toBe(canonicalRepository)

    database.cleanup()
    root.cleanup()
  })

  test('exposes the fixed Canonical Repository and separates a discovered Candidate Source', () => {
    const repository = createTempDir('skill-library-canonical-')
    const candidateRoot = createTempDir('skill-library-candidate-')
    const database = createTempDb()
    const candidatePath = join(candidateRoot.dir, 'demo')
    mkdirSync(candidatePath)
    writeFileSync(join(candidatePath, 'SKILL.md'), '# demo')
    const skillId = upsertSkill(database.db, 'demo', candidatePath)
    upsertSource(database.db, skillId, candidatePath, 'candidate-hash', 1, 'indexed', {
      origin: 'scan'
    })

    const model = createSkillLibraryFacade({
      db: database.db,
      canonicalRepositoryPath: repository.dir
    }).read()

    expect(model.canonicalRepository).toEqual({ path: repository.dir })
    expect(model.skills).toMatchObject([{
      id: skillId,
      name: 'demo',
      canonicalSource: null,
      candidates: [{ path: candidatePath, source_role: 'candidate' }]
    }])

    database.cleanup()
    candidateRoot.cleanup()
    repository.cleanup()
  })

  test('returns a persisted canonical Source separately from Candidate Sources', () => {
    const root = createTempDir('skill-library-role-')
    const canonicalRepository = join(root.dir, 'canonical')
    const canonicalPath = join(canonicalRepository, 'team', 'demo')
    const candidatePath = join(root.dir, 'discovered', 'demo')
    mkdirSync(canonicalPath, { recursive: true })
    mkdirSync(candidatePath, { recursive: true })
    writeFileSync(join(canonicalPath, 'SKILL.md'), '# canonical')
    writeFileSync(join(candidatePath, 'SKILL.md'), '# candidate')
    const db = createDatabase(join(root.dir, 'registry.db'), canonicalRepository)
    const skillId = upsertSkill(db, 'demo', canonicalPath)
    upsertSource(db, skillId, canonicalPath, 'canonical-hash', 2, 'central-repo', {
      origin: 'github',
      role: 'canonical'
    })
    upsertSource(db, skillId, candidatePath, 'candidate-hash', 1, 'indexed', {
      origin: 'scan',
      role: 'candidate'
    })

    const model = createSkillLibraryFacade({
      db,
      canonicalRepositoryPath: canonicalRepository
    }).read()

    expect(model.skills).toMatchObject([{
      canonicalSource: {
        path: canonicalPath,
        source_role: 'canonical'
      },
      candidates: [{
        path: candidatePath,
        source_role: 'candidate'
      }]
    }])

    db.close()
    root.cleanup()
  })

  test('does not let a legacy Candidate rescan downgrade an established canonical Source', () => {
    const root = createTempDir('skill-library-rescan-')
    const canonicalRepository = join(root.dir, 'canonical')
    const canonicalPath = join(canonicalRepository, 'demo')
    mkdirSync(canonicalPath, { recursive: true })
    writeFileSync(join(canonicalPath, 'SKILL.md'), '# demo')
    const db = createDatabase(join(root.dir, 'registry.db'), canonicalRepository)
    const skillId = upsertSkill(db, 'demo', canonicalPath)
    upsertSource(db, skillId, canonicalPath, 'first-hash', 1, 'central-repo', {
      role: 'canonical',
      origin: 'github',
      repoUrl: 'https://github.com/example/demo',
      commitSha: 'abc123'
    })

    upsertSource(db, skillId, canonicalPath, 'rescanned-hash', 2, 'indexed', {
      role: 'candidate',
      origin: 'local'
    })

    expect(createSkillLibraryFacade({
      db,
      canonicalRepositoryPath: canonicalRepository
    }).read().skills[0]).toMatchObject({
      canonicalSource: {
        id: expect.any(Number),
        source_role: 'canonical',
        source_type: 'central-repo',
        source_origin: 'github',
        repo_url: 'https://github.com/example/demo',
        commit_sha: 'abc123'
      },
      candidates: []
    })

    db.close()
    root.cleanup()
  })

  test('classifies every newly discovered Source inside the fixed repository as canonical', () => {
    const root = createTempDir('skill-library-boundary-')
    const canonicalRepository = join(root.dir, 'canonical')
    const canonicalPath = join(canonicalRepository, 'team', 'demo')
    mkdirSync(canonicalPath, { recursive: true })
    const db = createDatabase(join(root.dir, 'registry.db'), canonicalRepository)
    const skillId = upsertSkill(db, 'demo', canonicalPath)

    upsertSource(db, skillId, canonicalPath, 'hash', 1, 'indexed', { origin: 'scan' })

    expect(getSourceByPath(db, canonicalPath)?.source_role).toBe('canonical')
    db.close()
    root.cleanup()
  })

  test('rejects a second canonical Source for the same Skill', () => {
    const root = createTempDir('skill-library-unique-')
    const canonicalRepository = join(root.dir, 'canonical')
    const first = join(canonicalRepository, 'demo')
    const second = join(canonicalRepository, 'nested', 'demo')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    const db = createDatabase(join(root.dir, 'registry.db'), canonicalRepository)
    const skillId = upsertSkill(db, 'demo', first)
    upsertSource(db, skillId, first, 'first', 1, 'central-repo')

    expect(() => upsertSource(db, skillId, second, 'second', 2, 'central-repo')).toThrow()
    db.close()
    root.cleanup()
  })

  test('restores the previous filesystem entry when canonical persistence fails', () => {
    const root = createTempDir('skill-library-compensation-')
    const canonicalRepository = join(root.dir, 'canonical')
    const existingCanonical = join(canonicalRepository, 'legacy', 'demo')
    const destination = join(canonicalRepository, 'demo')
    const incoming = join(root.dir, 'incoming')
    const backups = join(root.dir, 'backups')
    mkdirSync(existingCanonical, { recursive: true })
    mkdirSync(destination, { recursive: true })
    mkdirSync(incoming, { recursive: true })
    writeFileSync(join(destination, 'SKILL.md'), 'OLD')
    writeFileSync(join(incoming, 'SKILL.md'), 'NEW')
    const db = createDatabase(join(root.dir, 'registry.db'), canonicalRepository)
    const skillId = upsertSkill(db, 'demo', existingCanonical)
    upsertSource(db, skillId, existingCanonical, 'existing', 1, 'central-repo')

    const facade = createSkillLibraryFacade({
      db,
      canonicalRepositoryPath: canonicalRepository,
      backupsDir: backups
    })
    expect(() => facade.replaceCanonicalSource({
      sourceDirectory: incoming,
      skillName: 'demo',
      origin: 'zip'
    })).toThrow()
    expect(readFileSync(join(destination, 'SKILL.md'), 'utf-8')).toBe('OLD')

    db.close()
    root.cleanup()
  })
})
