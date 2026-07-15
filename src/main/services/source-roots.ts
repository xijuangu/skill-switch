import { basename, join } from 'path'
import { readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import matter from 'gray-matter'
import type { DB } from '../db/database'
import type { SkillSource, SourceRoot } from '../types'
import {
  getAllSourceRoots,
  getSourceRootById,
  insertSourceRoot,
  markSourceRootScanned,
  deleteSourceRoot
} from '../db/dao/source-roots'
import {
  deleteSourceById,
  getSourceByPath,
  getSourcesByRootId,
  getSourcesBySkillId,
  moveSourceToSkill,
  upsertSource
} from '../db/dao/skill-sources'
import { deleteSkill, getSkillById, updatePrimarySourcePath, upsertSkill } from '../db/dao/skills'
import { getDeploymentsBySkillId } from '../db/dao/deployments'
import { runInTransaction } from '../db/database'
import { assertAbsolutePath, isPathWithin, validateSkillName } from './path-safety'
import { hashDir } from './hash'

export function listSourceRoots(db: DB): SourceRoot[] {
  return getAllSourceRoots(db)
}

export function registerSourceRoot(db: DB, path: string): SourceRoot {
  const absolute = assertAbsolutePath(path, 'Source Root path')
  const canonical = realpathSync(absolute)
  if (!statSync(canonical).isDirectory()) {
    throw new Error('Source Root path must be a directory')
  }
  const overlap = getAllSourceRoots(db).find(
    (root) =>
      root.path !== canonical &&
      (isPathWithin(root.path, canonical) || isPathWithin(canonical, root.path))
  )
  if (overlap) {
    throw new Error(`Source Root overlap is not allowed: ${overlap.path}`)
  }
  return insertSourceRoot(db, canonical)
}

export interface SourceRootScanResult {
  root: SourceRoot
  discovered: number
  upserted: number
  removed: number
  sources: SkillSource[]
}

function resolveSkillName(skillDir: string): string {
  const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  const name = matter(content).data.name
  return validateSkillName(
    typeof name === 'string' && name.trim().length > 0 ? name : basename(skillDir)
  )
}

function discoverSkillDirs(rootPath: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
    if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) {
      const canonical = realpathSync(directory)
      if (canonical !== rootPath && !isPathWithin(rootPath, canonical)) {
        throw new Error(`Source Root traversal escaped its boundary: ${canonical}`)
      }
      found.push(canonical)
    }
    for (const entry of entries) {
      // Dirent.isDirectory() is false for directory symlinks and junctions.
      if (entry.isDirectory()) walk(join(directory, entry.name))
    }
  }
  walk(rootPath)
  return found.sort()
}

function removeRootSourceMetadata(db: DB, source: SkillSource): void {
  const skill = getSkillById(db, source.skill_id)
  if (!skill) return
  const remaining = getSourcesBySkillId(db, source.skill_id).filter(
    (candidate) => candidate.id !== source.id
  )
  deleteSourceById(db, source.id)
  if (remaining.length > 0) {
    if (skill.primary_source_path === source.path) {
      updatePrimarySourcePath(db, skill.id, remaining[0].path)
    }
  } else if (getDeploymentsBySkillId(db, skill.id).length === 0) {
    deleteSkill(db, skill.id)
  }
}

function sourceHasDeployment(db: DB, source: SkillSource): boolean {
  return getDeploymentsBySkillId(db, source.skill_id).some(
    (deployment) => deployment.source_id === source.id
  )
}

export function rescanSourceRoot(db: DB, rootId: number): SourceRootScanResult {
  const root = getSourceRootById(db, rootId)
  if (!root) throw new Error(`Source Root not found: ${rootId}`)
  const canonicalRoot = realpathSync(root.path)
  const discoveredPaths = discoverSkillDirs(canonicalRoot)
  const keep = new Set(discoveredPaths)
  let removed = 0

  runInTransaction(db, () => {
    for (const skillDir of discoveredPaths) {
      const name = resolveSkillName(skillDir)
      const previous = getSourceByPath(db, skillDir)
      const previousSkill = previous ? getSkillById(db, previous.skill_id) : undefined
      if (previous && previousSkill && previousSkill.name !== name) {
        if (sourceHasDeployment(db, previous)) {
          throw new Error('Source has an active Deployment; undeploy it before renaming the Skill')
        }
        const skillId = upsertSkill(db, name, skillDir)
        moveSourceToSkill(
          db,
          previous.id,
          skillId,
          hashDir(skillDir),
          Math.floor(statSync(skillDir).mtimeMs),
          rootId
        )
        if (
          getSourcesBySkillId(db, previous.skill_id).length === 0 &&
          getDeploymentsBySkillId(db, previous.skill_id).length === 0
        ) {
          deleteSkill(db, previous.skill_id)
        }
        continue
      }
      const skillId = previous?.skill_id ?? upsertSkill(db, name, skillDir)
      upsertSource(db, skillId, skillDir, hashDir(skillDir), Math.floor(statSync(skillDir).mtimeMs), 'indexed', {
        origin: 'local',
        rootId
      })
    }
    for (const source of getSourcesByRootId(db, rootId)) {
      if (!keep.has(source.path) && !sourceHasDeployment(db, source)) {
        removeRootSourceMetadata(db, source)
        removed++
      }
    }
    markSourceRootScanned(db, rootId, new Date().toISOString())
  })

  return {
    root: getSourceRootById(db, rootId)!,
    discovered: discoveredPaths.length,
    upserted: discoveredPaths.length,
    removed,
    sources: getSourcesByRootId(db, rootId)
  }
}

export function registerAndScanSourceRoot(db: DB, path: string): SourceRootScanResult {
  const canonical = realpathSync(assertAbsolutePath(path, 'Source Root path'))
  const existed = getAllSourceRoots(db).some((root) => root.path === canonical)
  const root = registerSourceRoot(db, canonical)
  try {
    return rescanSourceRoot(db, root.id)
  } catch (error) {
    if (!existed) {
      runInTransaction(db, () => deleteSourceRoot(db, root.id))
    }
    throw error
  }
}

export function detachSourceRoot(db: DB, rootId: number): { detachedSources: number } {
  const root = getSourceRootById(db, rootId)
  if (!root) throw new Error(`Source Root not found: ${rootId}`)
  const sources = getSourcesByRootId(db, rootId)
  if (sources.some((source) => sourceHasDeployment(db, source))) {
    throw new Error('Source Root has an active Deployment; undeploy it before detaching the Root')
  }
  runInTransaction(db, () => {
    for (const source of sources) removeRootSourceMetadata(db, source)
    deleteSourceRoot(db, rootId)
  })
  return { detachedSources: sources.length }
}
