import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import type { DB } from '../db/database'
import { runInTransaction, setCanonicalRepositoryPath } from '../db/database'
import { upsertSource } from '../db/dao/skill-sources'
import { upsertSkill } from '../db/dao/skills'
import { getAllSkills } from '../db/dao/skills'
import type { SkillSource, SourceOrigin } from '../types'
import { createBackup } from './backup'
import { hashDir } from './hash'
import { assertAbsolutePath, resolveWithin, validateSkillName } from './path-safety'

export type SkillLibrarySource = SkillSource

export interface SkillLibrarySkill {
  id: number
  name: string
  canonicalSource: SkillLibrarySource | null
  candidates: SkillLibrarySource[]
}

export interface SkillLibraryReadModel {
  canonicalRepository: { path: string }
  skills: SkillLibrarySkill[]
}

export interface SkillLibraryFacade {
  read(): SkillLibraryReadModel
  replaceCanonicalSource(request: {
    sourceDirectory: string
    skillName: string
    origin: Extract<SourceOrigin, 'github' | 'zip'>
    repoUrl?: string
    commitSha?: string
  }): {
    skillId: number
    sourcePath: string
    overwritten: boolean
  }
}

export function createSkillLibraryFacade(options: {
  db: DB
  canonicalRepositoryPath: string
  backupsDir?: string
}): SkillLibraryFacade {
  const canonicalRepositoryPath = resolve(
    assertAbsolutePath(options.canonicalRepositoryPath, 'Canonical Repository path')
  )
  setCanonicalRepositoryPath(options.db, canonicalRepositoryPath)
  mkdirSync(canonicalRepositoryPath, { recursive: true })

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
        if (!options.backupsDir) throw new Error('backups directory is required to replace a canonical Source')
        createBackup({
          skillName,
          targetTool: 'central-repo',
          sourcePath: destination,
          backupsDir: options.backupsDir
        })
        renameSync(destination, rollback)
        displaced = true
      }
      renameSync(stage, destination)
      const skillId = runInTransaction(options.db, () => {
        const id = upsertSkill(options.db, skillName, destination)
        upsertSource(options.db, id, destination, hash, mtime, 'central-repo', {
          origin: request.origin,
          role: 'canonical',
          repoUrl: request.repoUrl,
          commitSha: request.commitSha
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
    replaceCanonicalSource,
    read() {
      const skills = getAllSkills(options.db).map((skill) => {
        const sources = skill.sources
        const canonicalSources = sources.filter((source) => source.source_role === 'canonical')
        if (canonicalSources.length > 1) {
          throw new Error(`Skill ${skill.name} has multiple canonical Sources`)
        }
        return {
          id: skill.id,
          name: skill.name,
          canonicalSource: canonicalSources[0] ?? null,
          candidates: sources.filter((source) => source.source_role === 'candidate')
        }
      })
      return {
        canonicalRepository: { path: canonicalRepositoryPath },
        skills
      }
    }
  }
}
