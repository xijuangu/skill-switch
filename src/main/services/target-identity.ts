import { createHash, randomUUID } from 'crypto'
import type { DiscoveryTarget } from '../types'

export function legacyTargetId(scope: string, index: number, path: string): string {
  const digest = createHash('sha256').update(`${scope}\0${index}\0${path}`).digest('hex').slice(0, 24)
  return `target_${digest}`
}

export function targetsForLegacyPaths(scope: string, paths: string[]): DiscoveryTarget[] {
  return paths.map((path, index) => ({ id: legacyTargetId(scope, index, path), path }))
}

export function reconcileTargetPaths(
  previous: DiscoveryTarget[],
  paths: string[]
): DiscoveryTarget[] {
  const unused = new Set(previous.map((target) => target.id))
  return paths.map((path, index) => {
    const exact = previous.find((target) => unused.has(target.id) && target.path === path)
    const edited = exact ?? previous[index]
    if (edited && unused.has(edited.id)) {
      unused.delete(edited.id)
      return { id: edited.id, path }
    }
    return { id: `target_${randomUUID()}`, path }
  })
}
