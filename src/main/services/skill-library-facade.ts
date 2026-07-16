import { resolve } from 'path'
import { mkdirSync } from 'fs'
import type { DB } from '../db/database'
import { getAllSkills } from '../db/dao/skills'
import type { SkillSource } from '../types'
import { assertAbsolutePath } from './path-safety'

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
}

export function createSkillLibraryFacade(options: {
  db: DB
  canonicalRepositoryPath: string
}): SkillLibraryFacade {
  const canonicalRepositoryPath = resolve(
    assertAbsolutePath(options.canonicalRepositoryPath, 'Canonical Repository path')
  )
  mkdirSync(canonicalRepositoryPath, { recursive: true })

  return {
    read() {
      const skills = getAllSkills(options.db).map((skill) => {
        const sources = skill.sources
        return {
          id: skill.id,
          name: skill.name,
          canonicalSource: sources.find((source) => source.source_role === 'canonical') ?? null,
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
