import { describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { upsertSkill } from '../src/main/db/dao/skills'
import { getSourceByPath, upsertSource } from '../src/main/db/dao/skill-sources'
import { createDatabase } from '../src/main/db/database'
import { createSkillLibraryFacade } from '../src/main/services/skill-library-facade'
import { createTempDb, createTempDir } from './helpers/temp'

describe('SkillLibraryFacade', () => {
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
