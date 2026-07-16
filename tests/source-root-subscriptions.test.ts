import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'vitest'
import { getDeploymentsBySkillId } from '../src/main/db/dao/deployments'
import { getSourcesBySkillId } from '../src/main/db/dao/skill-sources'
import { getSkillByName } from '../src/main/db/dao/skills'
import { createDeploymentFacade } from '../src/main/services/deployment-facade'
import { scanAllTools } from '../src/main/services/scan-all'
import {
  registerSourceRoot,
  rescanSourceRoot
} from '../src/main/services/source-roots'
import type { ToolConfig } from '../src/main/types'
import { createTempDb, createTempDir } from './helpers/temp'

describe('Source Root selective subscriptions', () => {
  test.runIf(process.platform !== 'win32')(
    'discovers authoritative Skills, subscribes only one to two targets, and never scans managed links back as Sources',
    async () => {
      const content = createTempDir('source-root-subscriptions-content-')
      const targets = createTempDir('source-root-subscriptions-targets-')
      const backups = createTempDir('source-root-subscriptions-backups-')
      const database = createTempDb()

      try {
        const subscribedSource = join(content.dir, 'stable', 'shared-skill')
        const unsubscribedSource = join(content.dir, 'personal', 'private-skill')
        mkdirSync(subscribedSource, { recursive: true })
        mkdirSync(unsubscribedSource, { recursive: true })
        writeFileSync(
          join(subscribedSource, 'SKILL.md'),
          '---\nname: shared-skill\n---\n# Shared\n'
        )
        writeFileSync(
          join(unsubscribedSource, 'SKILL.md'),
          '---\nname: private-skill\n---\n# Private\n'
        )

        const sourceRoot = registerSourceRoot(database.db, content.dir)
        const discovery = rescanSourceRoot(database.db, sourceRoot.id)
        expect(discovery).toMatchObject({ discovered: 2, upserted: 2, removed: 0 })

        const subscribedSkill = getSkillByName(database.db, 'shared-skill')!
        const unsubscribedSkill = getSkillByName(database.db, 'private-skill')!
        const subscribedSources = getSourcesBySkillId(database.db, subscribedSkill.id)
        const unsubscribedSources = getSourcesBySkillId(database.db, unsubscribedSkill.id)
        expect(subscribedSources).toMatchObject([
          { path: realpathSync(subscribedSource), source_root_id: sourceRoot.id }
        ])
        expect(unsubscribedSources).toMatchObject([
          { path: realpathSync(unsubscribedSource), source_root_id: sourceRoot.id }
        ])

        const codexRoot = join(targets.dir, 'codex')
        const agentsRoot = join(targets.dir, 'agents')
        mkdirSync(codexRoot)
        mkdirSync(agentsRoot)
        const tools: ToolConfig[] = [
          {
            key: 'codex',
            displayName: 'Codex',
            enabled: true,
            paths: [codexRoot],
            existingPaths: [codexRoot],
            targets: [{ id: 'codex-target', path: codexRoot }],
            existingTargets: [{ id: 'codex-target', path: codexRoot }],
            isCustom: false,
            exists: true
          },
          {
            key: 'agents',
            displayName: 'Agents',
            enabled: true,
            paths: [agentsRoot],
            existingPaths: [agentsRoot],
            targets: [{ id: 'agents-target', path: agentsRoot }],
            existingTargets: [{ id: 'agents-target', path: agentsRoot }],
            isCustom: false,
            exists: true
          }
        ]
        const facade = createDeploymentFacade({
          db: database.db,
          backupsDir: backups.dir,
          getRuntime: () => ({
            tools,
            platform: {
              platform: process.platform,
              canSymlink: true,
              canJunction: false
            }
          })
        })

        // #92: 只有 Canonical Source 可以创建部署,将发现的 candidate source 提升为 canonical
        database.db.prepare("UPDATE skill_sources SET source_role = 'canonical' WHERE id = ?").run(subscribedSources[0].id)

        const codexDeployment = await facade.deploy({
          sourceId: subscribedSources[0].id,
          targetId: 'codex-target',
          requestedMode: 'symlink'
        })
        const agentsDeployment = await facade.deploy({
          sourceId: subscribedSources[0].id,
          targetId: 'agents-target',
          requestedMode: 'symlink'
        })
        expect(codexDeployment).toMatchObject({ status: 'completed' })
        expect(agentsDeployment).toMatchObject({ status: 'completed' })
        if (codexDeployment.status !== 'completed') {
          throw new Error('expected Codex subscription to complete')
        }

        const codexSubscribedPath = join(codexRoot, 'shared-skill')
        const agentsSubscribedPath = join(agentsRoot, 'shared-skill')
        expect(lstatSync(codexSubscribedPath).isSymbolicLink()).toBe(true)
        expect(lstatSync(agentsSubscribedPath).isSymbolicLink()).toBe(true)
        expect(existsSync(join(codexRoot, 'private-skill'))).toBe(false)
        expect(existsSync(join(agentsRoot, 'private-skill'))).toBe(false)

        const rescan = scanAllTools(database.db, [
          { key: 'codex', displayName: 'Codex', paths: [codexRoot] },
          { key: 'agents', displayName: 'Agents', paths: [agentsRoot] }
        ])
        expect(rescan).toMatchObject({ totalScanned: 0, totalUpserted: 0 })
        expect(getSourcesBySkillId(database.db, subscribedSkill.id)).toMatchObject([
          { path: realpathSync(subscribedSource), source_root_id: sourceRoot.id }
        ])
        expect(getSourcesBySkillId(database.db, unsubscribedSkill.id)).toMatchObject([
          { path: realpathSync(unsubscribedSource), source_root_id: sourceRoot.id }
        ])

        expect(await facade.undeploy(codexDeployment.deploymentId)).toMatchObject({
          status: 'completed',
          deploymentId: codexDeployment.deploymentId
        })
        expect(existsSync(codexSubscribedPath)).toBe(false)
        expect(lstatSync(agentsSubscribedPath).isSymbolicLink()).toBe(true)
        expect(getSourcesBySkillId(database.db, subscribedSkill.id)).toMatchObject([
          { path: realpathSync(subscribedSource), source_root_id: sourceRoot.id }
        ])
        expect(getSourcesBySkillId(database.db, unsubscribedSkill.id)).toMatchObject([
          { path: realpathSync(unsubscribedSource), source_root_id: sourceRoot.id }
        ])
        expect(getDeploymentsBySkillId(database.db, subscribedSkill.id)).toMatchObject([
          { target_id: 'agents-target', mode: 'symlink' }
        ])
      } finally {
        database.cleanup()
        backups.cleanup()
        targets.cleanup()
        content.cleanup()
      }
    }
  )
})
