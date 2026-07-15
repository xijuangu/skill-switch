import { dirname } from 'path'
import type { DB } from '../db/database'
import type { ToolConfig } from '../types'

/** Reconcile legacy path snapshots only when both semantic identities match exactly once. */
export function reconcileDeploymentIdentities(db: DB, tools: ToolConfig[]): void {
  const deployments = db
    .prepare('SELECT id, skill_id, target_tool, target_path, source_path, source_id, target_id FROM deployments')
    .all() as Array<{
      id: number
      skill_id: number
      target_tool: string
      target_path: string | null
      source_path: string
      source_id: number | null
      target_id: string | null
    }>
  const update = db.prepare('UPDATE deployments SET source_id = ?, target_id = ? WHERE id = ?')
  db.transaction(() => {
    for (const deployment of deployments) {
      if (deployment.source_id != null && deployment.target_id != null) continue
      const sources = db
        .prepare('SELECT id FROM skill_sources WHERE skill_id = ? AND path = ?')
        .all(deployment.skill_id, deployment.source_path) as Array<{ id: number }>
      const targetRoot = deployment.target_path == null ? null : dirname(deployment.target_path)
      const targets = tools
        .filter((tool) => tool.key === deployment.target_tool)
        .flatMap((tool) => tool.targets)
        .filter((target) => target.path === targetRoot)
      const fullyResolved = sources.length === 1 && targets.length === 1
      update.run(
        fullyResolved ? sources[0].id : null,
        fullyResolved ? targets[0].id : null,
        deployment.id
      )
    }
  })()
}
