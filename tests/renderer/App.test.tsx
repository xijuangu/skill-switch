import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../../src/renderer/src/app/App'
import { ToastProvider } from '../../src/renderer/src/app/Toast'
import { SkillsPage } from '../../src/renderer/src/features/skills/SkillsPage'
import { BulkSkillActionsDialog, DeployDialogContent, InstallDialogContent } from '../../src/renderer/src/features/skills/dialogs'
import type { SkillWithConflictView } from '../../src/preload'

// 回归 #52:App 必须在 ToastProvider 之内消费 useToast,
// 否则首屏抛 "useToast must be used within ToastProvider" → 白屏(typecheck/build 不可见)。

function mockWindowApi(overrides: Partial<Window['api']> = {}) {
  const api: Window['api'] = {
    scan: vi.fn().mockResolvedValue({ tools: [], totalScanned: 0, totalUpserted: 0 }),
    getSkills: vi.fn().mockResolvedValue([]),
    getSkillLibrary: vi.fn().mockResolvedValue({
      canonicalRepository: { path: '/canonical' },
      skills: [],
      consolidationPlan: [],
      consolidationBatches: [],
      sourceRelocations: []
    }),
    previewConflictResolution: vi.fn(),
    previewConsolidation: vi.fn(),
    previewConsolidationBatch: vi.fn(),
    confirmConsolidation: vi.fn(),
    undoConsolidation: vi.fn(),
    restoreConsolidation: vi.fn(),
    previewSourceArchivePurge: vi.fn(),
    confirmSourceArchivePurge: vi.fn(),
    previewSourceRelocation: vi.fn(),
    confirmSourceRelocation: vi.fn(),
    undoSourceRelocation: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      tools: [],
      backupRetention: 5,
      platform: { platform: 'darwin', canSymlink: true, canJunction: false },
    }),
    getSourceRoots: vi.fn().mockResolvedValue([]),
    registerSourceRoot: vi.fn(),
    rescanSourceRoot: vi.fn(),
    detachSourceRoot: vi.fn(),
    getDeployTargets: vi.fn().mockResolvedValue([]),
    setPresetEnabled: vi.fn(),
    setPresetPaths: vi.fn(),
    addCustomTool: vi.fn(),
    removeCustomTool: vi.fn(),
    setBackupRetention: vi.fn(),
    listBackups: vi.fn().mockResolvedValue([]),
    restoreBackup: vi.fn(),
    deleteBackup: vi.fn(),
    deploymentDeploy: vi.fn(),
    deploymentConfirm: vi.fn(),
    redeploy: vi.fn(),
    undeploy: vi.fn(),
    bulkDeploy: vi.fn(),
    bulkConfirmDeploy: vi.fn(),
    bulkUndeploy: vi.fn(),
    bulkRemoveFromRegistry: vi.fn(),
    adoptDeployment: vi.fn(),
    getBulkAdoptionFacts: vi.fn().mockResolvedValue({ total: 0, tools: [] }),
    previewBulkAdoption: vi.fn().mockResolvedValue({ status: 'empty', facts: { total: 0, tools: [] } }),
    confirmBulkAdoption: vi.fn(),
    getTools: vi.fn().mockResolvedValue([]),
    removeFromManifest: vi.fn(),
    detachStaleDeployment: vi.fn(),
    getDeploymentsForSkill: vi.fn().mockResolvedValue([]),
    viewSkillMd: vi.fn(),
    removeFromRegistry: vi.fn(),
    installFromGitHub: vi.fn(),
    installFromZip: vi.fn(),
    installFromLocalDir: vi.fn(),
    selectZipFile: vi.fn(),
    selectLocalDir: vi.fn(),
    ...overrides,
  }
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true })
  return api
}

describe('App (integration)', () => {
  it('defaults a new deployment request to symlink while still allowing copy', async () => {
    const skill = buildFakeSkills(1)[0]
    skill.sources[0].source_role = 'canonical'
    skill.conflict.primarySource = skill.sources[0]
    const api = mockWindowApi({
      getDeployTargets: vi.fn().mockResolvedValue([{
        targetId: 'agents-user',
        targetTool: 'agents',
        displayName: 'Agents',
        eligible: true,
        reason: null
      }]),
      deploymentDeploy: vi.fn().mockResolvedValue({
        status: 'completed',
        deploymentId: 1,
        result: {
          action: 'created',
          mode: 'symlink',
          targetId: 'agents-user',
          targetDisplayName: 'Agents',
          degradedFrom: null,
          degradeReason: null
        }
      })
    })

    render(<DeployDialogContent skill={skill} sourceId={skill.sources[0].id} onDone={vi.fn()} />)
    expect(await screen.findByRole('radio', { name: 'symlink' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'copy' })).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: '部署' }))
    await waitFor(() => expect(api.deploymentDeploy).toHaveBeenCalledWith({
      sourceId: skill.sources[0].id,
      targetId: 'agents-user',
      requestedMode: 'symlink'
    }))
  })

  it('keeps installation open as a repeatable deployment step until the user closes it', async () => {
    const installed = buildFakeSkills(1)[0]
    installed.name = 'local-demo'
    installed.sources[0].source_role = 'canonical'
    installed.sources[0].source_type = 'central-repo'
    installed.sources[0].path = '/canonical/local-demo'
    installed.conflict.primarySource = installed.sources[0]
    const installResult = {
      skillName: 'local-demo',
      skillId: installed.id,
      sourcePath: '/canonical/local-demo',
      sourceType: 'central-repo' as const,
      repoUrl: null,
      commitSha: null,
      overwritten: false
    }
    const api = mockWindowApi({
      selectLocalDir: vi.fn().mockResolvedValue('/imports/local-demo'),
      installFromLocalDir: vi.fn().mockResolvedValue(installResult),
      getSkills: vi.fn().mockResolvedValue([installed]),
      getDeployTargets: vi.fn().mockResolvedValue([{
        targetId: 'codex-user', targetTool: 'codex', displayName: 'Codex',
        eligible: true, reason: null
      }]),
      deploymentDeploy: vi.fn().mockResolvedValue({
        status: 'completed',
        deploymentId: 1,
        result: {
          action: 'created', mode: 'symlink', targetId: 'codex-user',
          targetDisplayName: 'Codex', degradedFrom: null, degradeReason: null
        }
      })
    })
    const onDone = vi.fn().mockResolvedValue(undefined)

    render(
      <InstallDialogContent
        initialTab="local-dir"
        onInstalled={onDone}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: '选择目录…' }))
    await userEvent.click(screen.getByRole('button', { name: '安装' }))

    expect(await screen.findByText(/安装完成，可继续部署到多个工具/)).toBeInTheDocument()
    expect(onDone).toHaveBeenCalledWith(installResult)
    expect(screen.getByRole('radio', { name: 'symlink' })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: '部署' }))
    await waitFor(() => expect(api.deploymentDeploy).toHaveBeenCalled())
    expect(screen.getByText(/安装完成，可继续部署到多个工具/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('runs selected skill-target pairs as a symlink batch and keeps per-item results visible', async () => {
    const skills = buildFakeSkills(2)
    skills.forEach((skill) => {
      skill.sources[0].source_role = 'canonical'
      skill.conflict.primarySource = skill.sources[0]
    })
    const api = mockWindowApi({
      getDeployTargets: vi.fn().mockResolvedValue([{
        targetId: 'codex-user',
        targetTool: 'codex',
        displayName: 'Codex',
        eligible: true,
        reason: null
      }]),
      bulkDeploy: vi.fn().mockResolvedValue({
        total: 2,
        completed: 1,
        failed: 1,
        items: [
          { key: `${skills[0].id}:codex-user`, status: 'completed' },
          { key: `${skills[1].id}:codex-user`, status: 'rejected', message: 'target busy' }
        ]
      })
    })

    const view = render(<BulkSkillActionsDialog skills={skills} onRefresh={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByRole('radio', { name: 'symlink' })).toBeChecked()
    await waitFor(() => expect(screen.getAllByRole('checkbox', { name: /Codex/ })).toHaveLength(2))
    await userEvent.click(screen.getByRole('button', { name: '批量部署' }))

    await waitFor(() => expect(api.bulkDeploy).toHaveBeenCalledWith([
      { key: `${skills[0].id}:codex-user`, sourceId: skills[0].sources[0].id, targetId: 'codex-user', requestedMode: 'symlink' },
      { key: `${skills[1].id}:codex-user`, sourceId: skills[1].sources[0].id, targetId: 'codex-user', requestedMode: 'symlink' }
    ]))
    expect(await screen.findByText('完成 1，失败 1')).toBeInTheDocument()
    expect(screen.getByText(/target busy/)).toBeInTheDocument()
    view.rerender(<BulkSkillActionsDialog skills={skills.map((skill) => ({ ...skill }))} onRefresh={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('完成 1，失败 1')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: `${skills[0].name} → Codex` })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: `${skills[1].name} → Codex` })).toBeChecked()
  })

  it('completes confirmation-required items inside the batch deployment flow', async () => {
    const skill = buildFakeSkills(1)[0]
    skill.sources[0].source_role = 'canonical'
    skill.conflict.primarySource = skill.sources[0]
    const key = `${skill.id}:codex-user`
    const api = mockWindowApi({
      getDeployTargets: vi.fn().mockResolvedValue([{
        targetId: 'codex-user',
        targetTool: 'codex',
        displayName: 'Codex',
        eligible: true,
        reason: null
      }]),
      bulkDeploy: vi.fn().mockResolvedValue({
        total: 1,
        completed: 0,
        failed: 1,
        items: [{
          key,
          status: 'confirmation-required',
          outcome: {
            status: 'confirmation-required',
            confirmationId: 'confirm-1',
            expiresAt: Date.now() + 60_000,
            facts: {
              skillName: skill.name,
              targetDisplayName: 'Codex',
              reasons: ['external-overwrite'],
              requestedMode: 'symlink',
              actualMode: 'symlink',
              backup: { required: true, directory: '/backups' }
            }
          }
        }]
      }),
      bulkConfirmDeploy: vi.fn().mockResolvedValue({
        total: 1,
        completed: 1,
        failed: 0,
        items: [{ key, status: 'completed' }]
      })
    })

    render(<BulkSkillActionsDialog skills={[skill]} onRefresh={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('checkbox', { name: `${skill.name} → Codex` })
    await userEvent.click(screen.getByRole('button', { name: '批量部署' }))
    expect(await screen.findByText('将覆盖目标中不受管理的现有内容')).toBeInTheDocument()
    expect(screen.getByText('备份：/backups')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: '确认并继续' }))

    await waitFor(() => expect(api.bulkConfirmDeploy).toHaveBeenCalledWith([
      { key, confirmationId: 'confirm-1' }
    ]))
    expect(await screen.findByText('完成 1，失败 0')).toBeInTheDocument()
  })

  it('mounts without throwing (regression: white screen from useToast outside ToastProvider)', async () => {
    mockWindowApi()
    // 不应用 catch 兜底,抛错即测试失败
    render(<App />)
    // 导航可见
    expect(screen.getByText('skill-switch')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '技能' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '工具' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '备份' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument()
    // 首次 refresh 触发
    await waitFor(() => {
      expect(window.api.getSkills).toHaveBeenCalledTimes(1)
      expect(window.api.getTools).toHaveBeenCalledTimes(1)
    })
  })

  it('switches pages via nav', async () => {
    mockWindowApi()
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: '设置' }))
    await userEvent.click(screen.getByRole('button', { name: '工具' }))
    await userEvent.click(screen.getByRole('button', { name: '来源归档' }))
    await userEvent.click(screen.getByRole('button', { name: '技能' }))
    // 切回 skills 时不抛错即可
    expect(screen.getByRole('button', { name: '技能' })).toBeInTheDocument()
  })

  it('shows Source Archive history and requires separate confirmation before permanent purge', async () => {
    const batch = {
      id: 'batch-88', status: 'completed' as const, phase: null,
      items: [{
        skillId: 1, skillName: 'demo', canonicalPath: '/canonical/demo',
        archivePath: '/archive/batch-88/source/demo', originalPath: '/imports/demo',
        originalPaths: ['/imports/demo', '/imports/demo-copy'], originalHash: 'abc123',
        originalHashes: ['abc123', 'abc123'], archivedToolPaths: ['/tools/codex/demo']
      }],
      archive: { sizeBytes: 2048, recoverable: true, purgeable: true, purgedAt: null, recoveryBlockedReason: null },
      createdAt: '2026-07-16T00:00:00.000Z', completedAt: '2026-07-16T00:01:00.000Z',
      undoneAt: null, failureMessage: null, recoveryDirection: null,
      evidenceSummary: { itemCount: 1, phases: [] }
    }
    const api = mockWindowApi({
      getSkillLibrary: vi.fn().mockResolvedValue({
        canonicalRepository: { path: '/canonical' }, skills: [], consolidationBatches: [batch]
      }),
      previewSourceArchivePurge: vi.fn().mockResolvedValue({
        status: 'confirmation-required', confirmationId: 'purge-88', batchId: 'batch-88',
        itemCount: 1, sizeBytes: 2048
      }),
      confirmSourceArchivePurge: vi.fn().mockResolvedValue({
        status: 'purged', batchId: 'batch-88', purgedAt: '2026-07-16T01:00:00.000Z', sizeBytes: 2048
      })
    })
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: '来源归档' }))

    expect(await screen.findByText('demo')).toBeInTheDocument()
    expect(screen.getByText('/imports/demo')).toBeInTheDocument()
    expect(screen.getByText('/imports/demo-copy')).toBeInTheDocument()
    expect(screen.getByText('/tools/codex/demo')).toBeInTheDocument()
    expect(screen.getByText('归档占用：2 KB')).toBeInTheDocument()
    expect(screen.getByText('可恢复')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '永久清理' }))
    await userEvent.click(screen.getByRole('button', { name: '预览清理' }))
    expect(api.previewSourceArchivePurge).toHaveBeenCalledWith('batch-88')
    expect(screen.getByText(/将永久清理 1 个归档项/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '确认永久清理' }))
    expect(api.confirmSourceArchivePurge).toHaveBeenCalledWith('purge-88')
  })

  it('shows the fixed Canonical Repository separately from Candidate Source directories', async () => {
    mockWindowApi({
      getSkillLibrary: vi.fn().mockResolvedValue({
        canonicalRepository: { path: '/canonical/skills' },
        skills: []
      }),
      getSourceRoots: vi.fn().mockResolvedValue([{
        id: 1,
        path: '/imports/team-skills',
        created_at: '2026-07-15T00:00:00.000Z',
        last_scanned_at: '2026-07-15T01:00:00.000Z',
        last_scan_error: null
      }])
    })
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(await screen.findByText('权威源码库')).toBeInTheDocument()
    expect(screen.getByText('/canonical/skills')).toBeInTheDocument()
    expect(screen.getByText('候选来源目录')).toBeInTheDocument()
    expect(screen.getByText('/imports/team-skills')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新扫描' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '解除登记' })).toBeInTheDocument()
  })

  it('shows observed subscriptions as read-only with an explicit adopt action', async () => {
    const api = mockWindowApi({
      adoptDeployment: vi.fn().mockResolvedValue({ status: 'completed', deploymentId: 9 }),
      getBulkAdoptionFacts: vi.fn()
        .mockResolvedValueOnce({ total: 1, tools: [] })
        .mockResolvedValue({ total: 0, tools: [] }),
      getTools: vi.fn().mockResolvedValue([{
        config: {
          key: 'agents', displayName: 'Agents', enabled: true,
          paths: ['/agents'], existingPaths: ['/agents'],
          targets: [{ id: 'agents-0', path: '/agents' }],
          existingTargets: [{ id: 'agents-0', path: '/agents' }],
          isCustom: false, exists: true
        },
        drifts: [{
          skillId: 1, skillName: 'to-tickets', targetTool: 'agents',
          targetPath: '/agents/to-tickets', targetExists: true,
          currentSourceHash: 'hash', currentTargetHash: null, kind: 'normal',
          deployment: {
            id: 9, skill_id: 1, target_tool: 'agents', target_path: '/agents/to-tickets',
            mode: 'symlink', management: 'observed', source_path: '/source/to-tickets',
            source_id: 2, target_id: 'agents-0', deployed_at: '2026-07-15T00:00:00.000Z',
            source_hash_at_deploy: 'hash'
          }
        }]
      }]) as Window['api']['getTools']
    })
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: '工具' }))
    await userEvent.click(await screen.findByRole('button', { name: /Agents/ }))

    expect(screen.getByText('外部订阅')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '接管' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消部署' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新部署' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '接管' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('接管 agents 的外部订阅「to-tickets」?')
    await userEvent.click(screen.getAllByRole('button', { name: '接管' }).at(-1)!)
    await waitFor(() => expect(api.adoptDeployment).toHaveBeenCalledWith(9))
    await waitFor(() => expect(screen.queryByRole('button', { name: '一键接管 1 个外部订阅' })).not.toBeInTheDocument())
    expect(api.getBulkAdoptionFacts).toHaveBeenCalledTimes(2)
  })

  it('allows a stale observed relation for a removed Discovery Target to be detached', async () => {
    const api = mockWindowApi({
      detachStaleDeployment: vi.fn().mockResolvedValue({ status: 'completed', deploymentId: 29 }),
      getTools: vi.fn().mockResolvedValue([{
        config: {
          key: 'trae', displayName: 'TRAE', enabled: true,
          paths: ['/trae-cn'], existingPaths: ['/trae-cn'],
          targets: [{ id: 'trae-current', path: '/trae-cn' }],
          existingTargets: [{ id: 'trae-current', path: '/trae-cn' }],
          isCustom: false, exists: true
        },
        drifts: [{
          skillId: 33, skillName: 'find-skills', targetTool: 'trae',
          targetPath: '/trae/find-skills', targetExists: false,
          currentSourceHash: null, currentTargetHash: null, kind: 'target-unconfigured',
          deployment: {
            id: 29, skill_id: 33, target_tool: 'trae', target_path: '/trae/find-skills',
            mode: 'symlink', management: 'observed', source_path: '/agents/find-skills',
            source_id: 37, target_id: 'trae-removed', deployed_at: '2026-07-15T00:00:00.000Z',
            source_hash_at_deploy: 'hash'
          }
        }]
      }]) as Window['api']['getTools']
    })

    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: '工具' }))
    await userEvent.click(await screen.findByRole('button', { name: /TRAE/ }))

    expect(screen.getByText('目标已移除')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '接管' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '解除登记' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('/trae/find-skills')
    await userEvent.click(screen.getByRole('button', { name: '确认解除登记' }))
    await waitFor(() => expect(api.detachStaleDeployment).toHaveBeenCalledWith(29))
  })

  it('previews and confirms every observed subscription globally, then retries only failures', async () => {
    const observedTool = (key: string, displayName: string, skillName: string, id: number) => ({
      config: {
        key, displayName, enabled: true,
        paths: [`/${key}`], existingPaths: [`/${key}`],
        targets: [{ id: `${key}-0`, path: `/${key}` }],
        existingTargets: [{ id: `${key}-0`, path: `/${key}` }],
        isCustom: false, exists: true
      },
      drifts: [{
        skillId: id, skillName, targetTool: key,
        targetPath: `/${key}/${skillName}`, targetExists: true,
        currentSourceHash: 'hash', currentTargetHash: null, kind: 'normal' as const,
        deployment: {
          id, skill_id: id, target_tool: key, target_path: `/${key}/${skillName}`,
          mode: 'symlink' as const, management: 'observed' as const, source_path: `/source/${skillName}`,
          source_id: id, target_id: `${key}-0`, deployed_at: '2026-07-15T00:00:00.000Z',
          source_hash_at_deploy: 'hash'
        }
      }]
    })
    const previewAll = {
      status: 'confirmation-required' as const,
      confirmationId: 'bulk-1',
      expiresAt: 99_999,
      facts: {
        total: 2,
        tools: [
          { targetTool: 'agents', targetDisplayName: 'Agents', items: [{ deploymentId: 9, skillName: 'to-tickets', targetId: 'agents-team', targetPath: '/agents/team/to-tickets' }] },
          { targetTool: 'codex', targetDisplayName: 'Codex', items: [{ deploymentId: 10, skillName: 'research', targetId: 'codex-user', targetPath: '/codex/user/research' }] }
        ]
      }
    }
    const previewRemaining = {
      status: 'confirmation-required' as const,
      confirmationId: 'bulk-2',
      expiresAt: 99_999,
      facts: {
        total: 1,
        tools: [{ targetTool: 'codex', targetDisplayName: 'Codex', items: [{ deploymentId: 10, skillName: 'research', targetId: 'codex-user', targetPath: '/codex/user/research' }] }]
      }
    }
    const api = mockWindowApi({
      getTools: vi.fn().mockResolvedValue([
        observedTool('agents', 'Agents', 'to-tickets', 9),
        observedTool('codex', 'Codex', 'research', 10)
      ]) as Window['api']['getTools'],
      getBulkAdoptionFacts: vi.fn().mockResolvedValue({ total: 2, tools: previewAll.facts.tools }),
      previewBulkAdoption: vi.fn()
        .mockResolvedValueOnce(previewAll)
        .mockResolvedValueOnce(previewRemaining),
      confirmBulkAdoption: vi.fn().mockResolvedValue({
        status: 'completed',
        total: 2,
        adopted: [{ deploymentId: 9, skillName: 'to-tickets', targetTool: 'agents', targetId: 'agents-team', targetPath: '/agents/team/to-tickets' }],
        failed: [{
          deploymentId: 10, skillName: 'research', targetTool: 'codex',
          targetId: 'codex-user', targetPath: '/codex/user/research',
          reason: 'observation-stale', message: '外部订阅已变化，拒绝接管。'
        }]
      })
    })

    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: '工具' }))
    const bulkButton = await screen.findByRole('button', { name: '一键接管 2 个外部订阅' })
    await userEvent.click(bulkButton)

    expect(api.previewBulkAdoption).toHaveBeenCalledWith()
    const previewDialog = screen.getByRole('dialog')
    expect(previewDialog).toHaveTextContent('Agents')
    expect(previewDialog).toHaveTextContent('to-tickets')
    expect(previewDialog).toHaveTextContent('agents-team · /agents/team/to-tickets')
    expect(previewDialog).toHaveTextContent('Codex')
    expect(previewDialog).toHaveTextContent('research')
    expect(previewDialog).toHaveTextContent('codex-user · /codex/user/research')

    await userEvent.click(screen.getByRole('button', { name: '确认接管全部' }))
    await waitFor(() => expect(api.confirmBulkAdoption).toHaveBeenCalledWith('bulk-1'))
    const resultDialog = screen.getByRole('dialog')
    expect(resultDialog).toHaveTextContent('已接管 1 个，失败 1 个')
    expect(resultDialog).toHaveTextContent('research：外部订阅已变化，拒绝接管。')

    await userEvent.click(screen.getByRole('button', { name: '重试剩余' }))
    await waitFor(() => expect(api.previewBulkAdoption).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('dialog')).toHaveTextContent('共 1 个外部订阅')
    expect(screen.getByRole('dialog')).toHaveTextContent('research')
  })

  it('uses the global bulk-adoption facts count instead of the enabled-tools read model', async () => {
    mockWindowApi({
      getTools: vi.fn().mockResolvedValue([]),
      getBulkAdoptionFacts: vi.fn().mockResolvedValue({
        total: 3,
        tools: [{ targetTool: 'codex', targetDisplayName: 'Codex', items: [] }]
      })
    })
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: '工具' }))
    expect(await screen.findByRole('button', { name: '一键接管 3 个外部订阅' })).toBeInTheDocument()
  })

  it('renders empty state on Skills page when no skills', async () => {
    mockWindowApi()
    render(<App />)
    // 等待 loading 结束后空态出现(空态文案不在此断言具体文本,只确认不抛错且页面挂载)
    await waitFor(() => {
      expect(window.api.getSkills).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByText('skill-switch')).toBeInTheDocument()
  })

  it('renders load failure state with retry (not empty state) on first refresh error', async () => {
    mockWindowApi({
      getSkills: vi.fn().mockRejectedValue(new Error('db locked')),
      getTools: vi.fn().mockRejectedValue(new Error('db locked')),
    })
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('加载失败')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})
// #56:1000 条假数据搜索/筛选/选择功能与性能冒烟(不断言毫秒阈值,只确认可用)
function buildFakeSkills(n: number): SkillWithConflictView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `skill-${String(i + 1).padStart(4, '0')}`,
    primary_source_path: `/path/to/skill-${i + 1}`,
    created_at: new Date(2025, 0, 1).toISOString(),
    sources: [{
      id: i + 1,
      skill_id: i + 1,
      path: `/repo/skill-${i + 1}`,
      hash: `hash${i}`,
      mtime: Date.now(),
      source_type: 'indexed',
      source_role: 'candidate',
      source_origin: 'scan',
      source_tool: 'trae',
      discovered_at: new Date().toISOString(),
      repo_url: null,
      commit_sha: null,
    }],
    conflict: {
      skillId: i + 1,
      sourceCount: 1,
      distinctHashCount: 1,
      hasConflict: false,
      primarySource: null,
    },
    deployments: i % 3 === 0
      ? [{
          id: i + 1,
          skill_id: i + 1,
          target_tool: 'trae',
          target_path: `/trae/skill-${i + 1}`,
          mode: 'symlink' as const,
          management: 'managed' as const,
          source_path: `/repo/skill-${i + 1}`,
          deployed_at: new Date().toISOString(),
          source_hash_at_deploy: `hash${i}`,
          status: 'normal' as const,
        }]
      : [],
  }))
}

describe('SkillsPage 1000-row smoke (#56)', () => {
  it('renders, searches and filters 1000 skills without error', async () => {
    const skills = buildFakeSkills(1000)
    mockWindowApi()
    render(
      <ToastProvider>
        <SkillsPage
          skills={skills}
          tools={[]}
          scanning={false}
          lastScan={null}
          loading={false}
          loadError={null}
          onScan={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onRetry={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    )
    // 首条已选中(列表 + detail 都可能出现,用 getAllByText)
    expect(screen.getAllByText('skill-0001').length).toBeGreaterThan(0)
    // 搜索 narrowing
    const search = screen.getByPlaceholderText('搜索名称、路径或工具…')
    await userEvent.type(search, 'skill-0500')
    expect(screen.getAllByText('skill-0500').length).toBeGreaterThan(0)
    // 清空搜索后筛选"已部署"
    await userEvent.clear(search)
    const deployedBtn = screen.getByRole('button', { name: '已部署' })
    await userEvent.click(deployedBtn)
    // 已部署的 skill-0001(id=1,i=0,0%3===0 有 deployment)应可见
    expect(screen.getAllByText('skill-0001').length).toBeGreaterThan(0)
  })

  it('does not classify an observed-only subscription as deployed', async () => {
    const skill = buildFakeSkills(1)[0]
    skill.deployments[0].management = 'observed'
    mockWindowApi()
    render(
      <ToastProvider>
        <SkillsPage
          skills={[skill]}
          tools={[]}
          scanning={false}
          lastScan={null}
          loading={false}
          loadError={null}
          onScan={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onRetry={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    )

    expect(screen.getByText('外部订阅 · 1')).toBeInTheDocument()
    expect(screen.queryByText('已部署 · 1')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '已部署' }))
    expect(screen.queryByText('skill-0001')).not.toBeInTheDocument()
  })

  it('distinguishes the Canonical Source from Candidate Sources', () => {
    const skill = buildFakeSkills(1)[0]
    skill.sources = [
      {
        ...skill.sources[0],
        id: 10,
        path: '/canonical/demo',
        source_role: 'canonical'
      },
      {
        ...skill.sources[0],
        id: 11,
        path: '/discovered/demo',
        source_role: 'candidate'
      }
    ]
    skill.conflict = {
      skillId: skill.id,
      sourceCount: 2,
      distinctHashCount: 1,
      hasConflict: false,
      primarySource: skill.sources[0]
    }
    mockWindowApi()

    render(
      <ToastProvider>
        <SkillsPage
          skills={[skill]}
          tools={[]}
          scanning={false}
          lastScan={null}
          loading={false}
          loadError={null}
          onScan={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onRetry={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    )

    expect(screen.getByText('权威来源')).toBeInTheDocument()
    expect(screen.getByText('候选来源')).toBeInTheDocument()
  })
})

// #62: 多版本冲突时,详情列来源应按 hash 分组渲染(版本 A / 版本 B 标题)
function buildConflictSkill(): SkillWithConflictView {
  return {
    id: 1,
    name: 'conflicted-skill',
    primary_source_path: '/repo/v1',
    created_at: new Date(2025, 0, 1).toISOString(),
    sources: [
      {
        id: 1, skill_id: 1, path: '/repo/v1', hash: 'aaaa1111aaaa',
        mtime: Date.now(), source_type: 'indexed', source_origin: 'scan',
        source_role: 'candidate',
        source_tool: 'trae', discovered_at: new Date().toISOString(),
        repo_url: null, commit_sha: null,
      },
      {
        id: 2, skill_id: 1, path: '/repo/v1-dup', hash: 'aaaa1111aaaa',
        mtime: Date.now(), source_type: 'indexed', source_origin: 'scan',
        source_role: 'candidate',
        source_tool: 'trae', discovered_at: new Date().toISOString(),
        repo_url: null, commit_sha: null,
      },
      {
        id: 3, skill_id: 1, path: '/repo/v2', hash: 'bbbb2222bbbb',
        mtime: Date.now(), source_type: 'indexed', source_origin: 'local',
        source_role: 'candidate',
        source_tool: null, discovered_at: new Date().toISOString(),
        repo_url: null, commit_sha: null,
      },
    ],
    conflict: {
      skillId: 1,
      sourceCount: 3,
      distinctHashCount: 2,
      hasConflict: true,
      primarySource: null,
    },
    deployments: [],
  }
}

describe('SkillsPage source grouping (#62)', () => {
  it('renders discovered_at in the local timezone instead of raw UTC text', async () => {
    const discoveredAt = '2026-07-15T04:00:00.000Z'
    const skill = buildFakeSkills(1)[0]
    skill.sources[0].discovered_at = discoveredAt
    mockWindowApi()
    render(
      <ToastProvider>
        <SkillsPage
          skills={[skill]}
          tools={[]}
          scanning={false}
          lastScan={null}
          loading={false}
          loadError={null}
          onScan={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onRetry={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    )

    await userEvent.click(screen.getByText('/repo/skill-1'))
    expect(screen.getByText(new Date(discoveredAt).toLocaleString())).toBeInTheDocument()
    expect(screen.queryByText(discoveredAt)).not.toBeInTheDocument()
  })

  it('renders version group headers when skill has multiple versions', () => {
    const skill = buildConflictSkill()
    mockWindowApi()
    render(
      <ToastProvider>
        <SkillsPage
          skills={[skill]}
          tools={[]}
          scanning={false}
          lastScan={null}
          loading={false}
          loadError={null}
          onScan={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onRetry={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    )
    // 选中该 skill 后,详情列应出现版本 A / 版本 B 两个组标题
    expect(screen.getByText('版本 A')).toBeInTheDocument()
    expect(screen.getByText('版本 B')).toBeInTheDocument()
    // 组标题标注来源数
    expect(screen.getByText('· 2 个来源')).toBeInTheDocument()
    expect(screen.getByText('· 1 个来源')).toBeInTheDocument()
    // hash 短码显示(带 "hash: " 前缀,与部署弹窗一致)
    expect(screen.getByText('hash: aaaa1111')).toBeInTheDocument()
    expect(screen.getByText('hash: bbbb2222')).toBeInTheDocument()
  })

  it('does not render version group headers for single-version skill', () => {
    const skills = buildFakeSkills(1)
    mockWindowApi()
    render(
      <ToastProvider>
        <SkillsPage
          skills={skills}
          tools={[]}
          scanning={false}
          lastScan={null}
          loading={false}
          loadError={null}
          onScan={vi.fn()}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onRetry={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    )
    // 单版本不显示分组标题
    expect(screen.queryByText('版本 A')).not.toBeInTheDocument()
  })
})

describe('SkillsPage consolidation (#84)', () => {
  function renderSkillsPage(skills: SkillWithConflictView[], onRefresh = vi.fn().mockResolvedValue(undefined)) {
    render(
      <ToastProvider>
        <SkillsPage
          skills={skills}
          tools={[]}
          scanning={false}
          lastScan={null}
          loading={false}
          loadError={null}
          onScan={vi.fn()}
          onRefresh={onRefresh}
          onRetry={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    )
    return onRefresh
  }

  it('offers consolidation only for a conflict-free Candidate Source and confirms the previewed plan', async () => {
    const skill = buildFakeSkills(1)[0]
    const preview = {
      status: 'confirmation-required' as const,
      confirmationId: 'confirm-84',
      batchId: 'batch-84',
      skillId: skill.id,
      skillName: skill.name,
      operations: [
        { kind: 'write-canonical' as const, path: '/canonical/team/skill-0001' },
        { kind: 'archive-candidate' as const, path: '/archive/batch-84/skill-0001' },
        { kind: 'remove-observed-entry' as const, path: '/agents/skill-0001' }
      ]
    }
    const api = mockWindowApi({
      getSkillLibrary: vi.fn().mockResolvedValue({
        canonicalRepository: { path: '/canonical' },
        skills: [],
        consolidationBatches: []
      }),
      previewConsolidation: vi.fn().mockResolvedValue(preview),
      confirmConsolidation: vi.fn().mockResolvedValue({
        status: 'completed', batchId: 'batch-84', skillId: skill.id,
        canonicalPath: '/canonical/team/skill-0001'
      })
    })
    const onRefresh = renderSkillsPage([skill])

    await userEvent.click(await screen.findByRole('button', { name: '整理' }))
    const input = screen.getByLabelText('权威库内父目录')
    await userEvent.type(input, 'team')
    await userEvent.click(screen.getByRole('button', { name: '预览整理' }))

    expect(api.previewConsolidation).toHaveBeenCalledWith({
      candidateSourceId: skill.sources[0].id,
      canonicalRelativeParent: 'team'
    })
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('写入权威源码库')
    expect(dialog).toHaveTextContent('永久归档候选来源')
    expect(dialog).toHaveTextContent('移除外部订阅入口')
    expect(dialog).toHaveTextContent('归档会永久保留')
    expect(dialog).toHaveTextContent('不会自动部署')

    await userEvent.click(screen.getByRole('button', { name: '确认整理' }))
    await waitFor(() => expect(api.confirmConsolidation).toHaveBeenCalledWith('confirm-84'))
    await waitFor(() => expect(onRefresh).toHaveBeenCalled())
    expect(await screen.findByRole('alert')).toHaveTextContent('整理完成')
  })

  it('does not offer consolidation for conflicts, duplicate Candidates, or a Canonical Source', async () => {
    const conflict = buildConflictSkill()
    const canonical = buildFakeSkills(1)[0]
    canonical.id = 2
    canonical.name = 'canonical-skill'
    canonical.sources[0] = { ...canonical.sources[0], id: 20, skill_id: 2, source_role: 'canonical' }
    const duplicate = buildFakeSkills(1)[0]
    duplicate.id = 3
    duplicate.name = 'duplicate-candidates'
    duplicate.sources = [
      { ...duplicate.sources[0], id: 30, skill_id: 3 },
      { ...duplicate.sources[0], id: 31, skill_id: 3, path: '/same-version/duplicate' }
    ]
    mockWindowApi()
    renderSkillsPage([conflict, canonical, duplicate])

    expect(screen.queryByRole('button', { name: '整理' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('canonical-skill'))
    expect(screen.queryByRole('button', { name: '整理' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('duplicate-candidates'))
    expect(screen.queryByRole('button', { name: '整理' })).not.toBeInTheDocument()
  })

  it('offers undo on the canonical source from the latest completed batch and shows rejection messages', async () => {
    const skill = buildFakeSkills(1)[0]
    skill.sources[0] = { ...skill.sources[0], source_role: 'canonical' }
    const api = mockWindowApi({
      getSkillLibrary: vi.fn().mockResolvedValue({
        canonicalRepository: { path: '/canonical' },
        skills: [],
        consolidationBatches: [
          {
            id: 'batch-old', status: 'completed', phase: null,
            items: [{ skillId: skill.id, skillName: skill.name, canonicalPath: '/canonical/skill-0001', archivePath: '/archive/old' }],
            createdAt: '2026-07-15T00:00:00.000Z', completedAt: '2026-07-15T00:01:00.000Z',
            undoneAt: null, failureMessage: null
          },
          {
            id: 'batch-latest', status: 'completed', phase: null,
            items: [{ skillId: skill.id, skillName: skill.name, canonicalPath: '/canonical/skill-0001', archivePath: '/archive/latest' }],
            createdAt: '2026-07-16T00:00:00.000Z', completedAt: '2026-07-16T00:01:00.000Z',
            undoneAt: null, failureMessage: null
          }
        ]
      }),
      undoConsolidation: vi.fn().mockResolvedValue({
        status: 'rejected', batchId: 'batch-latest', reason: 'restore-path-occupied',
        message: '原候选位置已被占用，无法撤销。'
      })
    })
    renderSkillsPage([skill])

    await userEvent.click(await screen.findByRole('button', { name: '撤销整理' }))
    await userEvent.click(screen.getByRole('button', { name: '确认撤销' }))
    await waitFor(() => expect(api.undoConsolidation).toHaveBeenCalledWith('batch-latest'))
    expect(await screen.findByRole('alert')).toHaveTextContent('原候选位置已被占用，无法撤销。')
  })
})

describe('SkillsPage bulk consolidation planning (#86)', () => {
  it('refreshes the consolidation plan when a scan refreshes the Skills list', async () => {
    const skills = buildFakeSkills(1)
    const plan = [{
      skillId: skills[0].id, skillName: skills[0].name,
      selectedByDefault: true, hasConflict: false, canonicalRelativeParent: '',
      versions: [{ hash: 'newly-scanned', candidateSourceIds: [11], paths: ['/new/skill'] }]
    }]
    const api = mockWindowApi({
      getSkillLibrary: vi.fn()
        .mockResolvedValueOnce({
          canonicalRepository: { path: '/canonical' }, skills: [], consolidationPlan: [], consolidationBatches: []
        })
        .mockResolvedValueOnce({
          canonicalRepository: { path: '/canonical' }, skills: [], consolidationPlan: plan, consolidationBatches: []
        })
    })
    const props = {
      tools: [], scanning: false, lastScan: null, loading: false, loadError: null,
      onScan: vi.fn(), onRefresh: vi.fn().mockResolvedValue(undefined), onRetry: vi.fn().mockResolvedValue(undefined)
    }
    const { rerender } = render(
      <ToastProvider><SkillsPage {...props} skills={[]} /></ToastProvider>
    )
    await waitFor(() => expect(api.getSkillLibrary).toHaveBeenCalledTimes(1))

    rerender(<ToastProvider><SkillsPage {...props} skills={skills} /></ToastProvider>)

    expect(await screen.findByRole('button', { name: '批量整理 (1)' })).toBeInTheDocument()
    expect(api.getSkillLibrary).toHaveBeenCalledTimes(2)
  })

  it('defaults safe version groups to selected and applies batch or per-Skill relative parents', async () => {
    const skills = buildFakeSkills(3)
    const plan = [
      {
        skillId: skills[0].id, skillName: skills[0].name,
        selectedByDefault: true, hasConflict: false, canonicalRelativeParent: '',
        versions: [{ hash: 'same-a', candidateSourceIds: [11, 12], paths: ['/a/one', '/b/one'] }]
      },
      {
        skillId: skills[1].id, skillName: skills[1].name,
        selectedByDefault: true, hasConflict: false, canonicalRelativeParent: '',
        versions: [{ hash: 'same-b', candidateSourceIds: [21], paths: ['/a/two'] }]
      },
      {
        skillId: skills[2].id, skillName: skills[2].name,
        selectedByDefault: false, hasConflict: true, canonicalRelativeParent: '',
        versions: [
          { hash: 'conflict-a', candidateSourceIds: [31], paths: ['/a/three'] },
          { hash: 'conflict-b', candidateSourceIds: [32], paths: ['/b/three'] }
        ]
      }
    ]
    const preview = {
      status: 'confirmation-required' as const,
      confirmationId: 'confirm-86', batchId: 'batch-86',
      items: [
        { skillId: skills[0].id, skillName: skills[0].name, canonicalPath: `/canonical/team/${skills[0].name}` },
        { skillId: skills[1].id, skillName: skills[1].name, canonicalPath: `/canonical/product/${skills[1].name}` }
      ],
      operations: [
        { kind: 'write-canonical' as const, path: `/canonical/team/${skills[0].name}` },
        { kind: 'write-canonical' as const, path: `/canonical/product/${skills[1].name}` }
      ]
    }
    const api = mockWindowApi({
      getSkillLibrary: vi.fn().mockResolvedValue({
        canonicalRepository: { path: '/canonical' }, skills: [], consolidationPlan: plan, consolidationBatches: []
      }),
      previewConsolidationBatch: vi.fn().mockResolvedValue(preview),
      confirmConsolidation: vi.fn().mockResolvedValue({
        status: 'completed', batchId: 'batch-86', skillId: skills[0].id,
        canonicalPath: `/canonical/team/${skills[0].name}`, items: preview.items
      })
    })
    render(
      <ToastProvider>
        <SkillsPage
          skills={skills} tools={[]} scanning={false} lastScan={null} loading={false} loadError={null}
          onScan={vi.fn()} onRefresh={vi.fn().mockResolvedValue(undefined)} onRetry={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    )

    await userEvent.click(await screen.findByRole('button', { name: '批量整理 (3)' }))
    expect(screen.getByRole('checkbox', { name: `选择 ${skills[0].name}` })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: `选择 ${skills[1].name}` })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: `选择 ${skills[2].name}` })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: `选择 ${skills[2].name}` })).toBeDisabled()
    expect(screen.getByText('2 个同内容来源')).toBeInTheDocument()
    expect(screen.getByLabelText(`${skills[0].name} 权威库内父目录`)).toHaveValue('')

    await userEvent.type(screen.getByLabelText('批量设置权威库内父目录'), 'team')
    await userEvent.click(screen.getByRole('button', { name: '应用到已选' }))
    const secondParent = screen.getByLabelText(`${skills[1].name} 权威库内父目录`)
    await userEvent.clear(secondParent)
    await userEvent.type(secondParent, 'product')
    await userEvent.click(screen.getByRole('button', { name: '预览批量整理' }))

    expect(api.previewConsolidationBatch).toHaveBeenCalledWith({ items: [
      { candidateSourceId: 11, canonicalRelativeParent: 'team' },
      { candidateSourceId: 21, canonicalRelativeParent: 'product' }
    ] })
    expect(screen.getByRole('dialog')).toHaveTextContent(`/canonical/team/${skills[0].name}`)
    expect(screen.getByRole('dialog')).toHaveTextContent(`/canonical/product/${skills[1].name}`)

    await userEvent.click(screen.getByRole('button', { name: '确认批量整理' }))
    await waitFor(() => expect(api.confirmConsolidation).toHaveBeenCalledWith('confirm-86'))
    expect(await screen.findByRole('alert')).toHaveTextContent('已整理 2 个 Skill')
  })
})

describe('SkillsPage Candidate conflict resolution (#87)', () => {
  function renderConflictSkills(skills: SkillWithConflictView[]) {
    return render(
      <ToastProvider>
        <SkillsPage
          skills={skills} tools={[]} scanning={false} lastScan={null} loading={false} loadError={null}
          onScan={vi.fn()} onRefresh={vi.fn().mockResolvedValue(undefined)} onRetry={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    )
  }

  function conflictFixture() {
    const skill = buildFakeSkills(1)[0]
    const plan = [{
      skillId: skill.id,
      skillName: skill.name,
      selectedByDefault: false,
      hasConflict: true,
      canonicalRelativeParent: '',
      versions: [
        { hash: 'hash-a', candidateSourceIds: [31], paths: ['/codex/demo'] },
        { hash: 'hash-b', candidateSourceIds: [32], paths: ['/claude/demo'] },
        { hash: 'hash-c', candidateSourceIds: [33], paths: ['/agents/demo'] }
      ]
    }]
    const conflictPreview = {
      skillId: skill.id,
      skillName: skill.name,
      versions: [
        {
          hash: 'hash-a',
          skillMd: '---\nname: demo\n---\n# version A',
          sources: [{
            id: 31, path: '/codex/demo', sourceOrigin: 'scan' as const, sourceTool: 'codex',
            sourceRootId: 1, discoveredAt: '2026-07-16T01:00:00.000Z', repoUrl: null, commitSha: null
          }]
        },
        {
          hash: 'hash-b',
          skillMd: '---\nname: demo\n---\n# version B',
          sources: [{
            id: 32, path: '/claude/demo', sourceOrigin: 'scan' as const, sourceTool: 'claude',
            sourceRootId: 2, discoveredAt: '2026-07-16T02:00:00.000Z',
            repoUrl: 'https://github.com/example/skills', commitSha: 'abcdef123456'
          }]
        },
        {
          hash: 'hash-c',
          skillMd: '---\nname: demo\n---\n# version C',
          sources: [{
            id: 33, path: '/agents/demo', sourceOrigin: 'scan' as const, sourceTool: 'agents',
            sourceRootId: 3, discoveredAt: '2026-07-16T03:00:00.000Z', repoUrl: null, commitSha: null
          }]
        }
      ],
      comparisons: [
        {
          leftHash: 'hash-a', rightHash: 'hash-b',
          files: [
            { path: 'SKILL.md', status: 'modified' as const, textDiff: '-# version A\n+# version B' },
            { path: 'notes/new.txt', status: 'added' as const, textDiff: '+added' }
          ]
        },
        { leftHash: 'hash-a', rightHash: 'hash-c', files: [{ path: 'SKILL.md', status: 'modified' as const, textDiff: '-A\n+C' }] },
        { leftHash: 'hash-b', rightHash: 'hash-c', files: [{ path: 'SKILL.md', status: 'modified' as const, textDiff: '-B\n+C' }] }
      ]
    }
    return { skill, plan, conflictPreview }
  }

  it('requires an explicit authoritative version and shows provenance, SKILL.md, and file text differences', async () => {
    const { skill, plan, conflictPreview } = conflictFixture()
    const api = mockWindowApi({
      getSkillLibrary: vi.fn().mockResolvedValue({
        canonicalRepository: { path: '/canonical' }, skills: [], consolidationPlan: plan,
        consolidationBatches: [], sourceRelocations: []
      }),
      previewConflictResolution: vi.fn().mockResolvedValue(conflictPreview),
      previewConsolidationBatch: vi.fn().mockResolvedValue({
        status: 'confirmation-required', confirmationId: 'confirm-87', batchId: 'batch-87',
        items: [], operations: []
      })
    })
    renderConflictSkills([skill])

    await userEvent.click(await screen.findByRole('button', { name: '批量整理 (1)' }))
    await userEvent.click(screen.getByRole('button', { name: `解决 ${skill.name} 的版本冲突` }))
    expect(api.previewConflictResolution).toHaveBeenCalledWith(skill.id)
    expect(await screen.findByText('/codex/demo')).toBeInTheDocument()
    expect(screen.getByText('/claude/demo')).toBeInTheDocument()
    expect(screen.getByText('来源：scan · codex')).toBeInTheDocument()
    expect(screen.getByText('Source Root：1')).toBeInTheDocument()
    expect(screen.getByText('发现时间：2026-07-16T01:00:00.000Z')).toBeInTheDocument()
    expect(screen.getByText('仓库：https://github.com/example/skills @ abcdef123456')).toBeInTheDocument()
    expect(screen.getAllByText(/# version A/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('notes/new.txt')).toBeInTheDocument()
    expect(screen.getByText(/-# version A/)).toBeInTheDocument()
    expect(screen.getByText('版本 A 与版本 B')).toBeInTheDocument()
    expect(screen.getByText('版本 A 与版本 C')).toBeInTheDocument()
    expect(screen.getByText('版本 B 与版本 C')).toBeInTheDocument()
    expect(screen.getByText('hash-a ↔ hash-c')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '选择版本 A 作为原名权威版本' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: '选择版本 B 作为原名权威版本' })).not.toBeChecked()

    await userEvent.click(screen.getByRole('radio', { name: '选择版本 A 作为原名权威版本' }))
    await userEvent.selectOptions(screen.getByLabelText('版本 B 的处理方式'), 'save-as')
    await userEvent.type(screen.getByLabelText('版本 B 的新 Skill 名称'), 'demo-second')
    await userEvent.type(screen.getByLabelText('版本 B 的权威库内父目录'), 'alternatives')
    await userEvent.click(screen.getByRole('button', { name: '应用冲突决策' }))

    expect(screen.getByText('冲突已解决')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: `选择 ${skill.name}` })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: '预览批量整理' }))
    expect(api.previewConsolidationBatch).toHaveBeenCalledWith({ items: [{
      candidateSourceId: 31,
      canonicalRelativeParent: '',
      conflictResolution: {
        authoritativeSourceId: 31,
        otherVersions: [{
          sourceId: 32,
          action: 'save-as',
          newSkillName: 'demo-second',
          canonicalRelativeParent: 'alternatives'
        }, { sourceId: 33, action: 'archive' }]
      }
    }] })
  })

  it('blocks an illegal save-as name before consolidation preview', async () => {
    const { skill, plan, conflictPreview } = conflictFixture()
    const api = mockWindowApi({
      getSkillLibrary: vi.fn().mockResolvedValue({
        canonicalRepository: { path: '/canonical' }, skills: [], consolidationPlan: plan,
        consolidationBatches: [], sourceRelocations: []
      }),
      previewConflictResolution: vi.fn().mockResolvedValue(conflictPreview)
    })
    renderConflictSkills([skill])
    await userEvent.click(await screen.findByRole('button', { name: '批量整理 (1)' }))
    await userEvent.click(screen.getByRole('button', { name: `解决 ${skill.name} 的版本冲突` }))
    await screen.findByText('/codex/demo')
    await userEvent.click(screen.getByRole('radio', { name: '选择版本 A 作为原名权威版本' }))
    await userEvent.selectOptions(screen.getByLabelText('版本 B 的处理方式'), 'save-as')
    await userEvent.type(screen.getByLabelText('版本 B 的新 Skill 名称'), '../escape')
    await userEvent.click(screen.getByRole('button', { name: '应用冲突决策' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('新 Skill 名称不合法')
    expect(api.previewConsolidationBatch).not.toHaveBeenCalled()
  })
})

describe('SkillsPage Source Relocation (#90)', () => {
  it('previews old/new placements and affected Deployments before confirming a move', async () => {
    const skill = buildFakeSkills(1)[0]
    skill.sources[0] = {
      ...skill.sources[0], source_role: 'canonical', path: '/canonical/old/skill-0001'
    }
    const preview = {
      status: 'confirmation-required' as const,
      confirmationId: 'relocation-confirm-90',
      relocationId: 'relocation-90',
      skillId: skill.id,
      skillName: skill.name,
      oldCanonicalPath: '/canonical/old/skill-0001',
      newCanonicalPath: '/canonical/team/backend/skill-0001',
      deployments: [
        { deploymentId: 8, targetTool: 'codex', targetPath: '/tools/codex/skill-0001', mode: 'symlink' as const },
        { deploymentId: 9, targetTool: 'agents', targetPath: '/tools/agents/skill-0001', mode: 'copy' as const }
      ]
    }
    const api = mockWindowApi({
      getSkillLibrary: vi.fn().mockResolvedValue({
        canonicalRepository: { path: '/canonical' }, skills: [], consolidationBatches: [], sourceRelocations: []
      }),
      previewSourceRelocation: vi.fn().mockResolvedValue(preview),
      confirmSourceRelocation: vi.fn().mockResolvedValue({
        status: 'completed', relocationId: 'relocation-90', sourceId: skill.sources[0].id,
        canonicalPath: preview.newCanonicalPath
      })
    })
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    render(
      <ToastProvider>
        <SkillsPage skills={[skill]} tools={[]} scanning={false} lastScan={null} loading={false}
          loadError={null} onScan={vi.fn()} onRefresh={onRefresh} onRetry={vi.fn().mockResolvedValue(undefined)} />
      </ToastProvider>
    )

    await userEvent.click(await screen.findByRole('button', { name: '移动权威 Source' }))
    await userEvent.type(screen.getByLabelText('新的权威库内父目录'), 'team/backend')
    await userEvent.click(screen.getByRole('button', { name: '预览移动' }))
    expect(api.previewSourceRelocation).toHaveBeenCalledWith({
      sourceId: skill.sources[0].id, canonicalRelativeParent: 'team/backend'
    })
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('/canonical/old/skill-0001')
    expect(dialog).toHaveTextContent('/canonical/team/backend/skill-0001')
    expect(dialog).toHaveTextContent('受影响部署（2）')
    expect(dialog).toHaveTextContent('codex · symlink')
    expect(dialog).toHaveTextContent('agents · copy')

    await userEvent.click(screen.getByRole('button', { name: '确认移动' }))
    await waitFor(() => expect(api.confirmSourceRelocation).toHaveBeenCalledWith('relocation-confirm-90'))
    expect(await screen.findByRole('alert')).toHaveTextContent('已移动')
    expect(onRefresh).toHaveBeenCalled()
  })

  it('offers undo for the latest completed relocation and surfaces a safety rejection', async () => {
    const skill = buildFakeSkills(1)[0]
    skill.sources[0] = { ...skill.sources[0], source_role: 'canonical', path: '/canonical/team/skill-0001' }
    const api = mockWindowApi({
      getSkillLibrary: vi.fn().mockResolvedValue({
        canonicalRepository: { path: '/canonical' }, skills: [], consolidationBatches: [],
        sourceRelocations: [{
          id: 'relocation-90', status: 'completed', skillId: skill.id, skillName: skill.name,
          sourceId: skill.sources[0].id, oldCanonicalPath: '/canonical/old/skill-0001',
          newCanonicalPath: '/canonical/team/skill-0001', createdAt: '2026-07-16T00:00:00.000Z',
          completedAt: '2026-07-16T00:01:00.000Z', undoneAt: null, failureMessage: null
        }]
      }),
      undoSourceRelocation: vi.fn().mockResolvedValue({
        status: 'rejected', relocationId: 'relocation-90', reason: 'plan-stale',
        message: '旧位置已被占用，无法撤销移动。'
      })
    })
    render(
      <ToastProvider>
        <SkillsPage skills={[skill]} tools={[]} scanning={false} lastScan={null} loading={false}
          loadError={null} onScan={vi.fn()} onRefresh={vi.fn().mockResolvedValue(undefined)} onRetry={vi.fn().mockResolvedValue(undefined)} />
      </ToastProvider>
    )

    await userEvent.click(await screen.findByRole('button', { name: '撤销移动' }))
    await userEvent.click(screen.getByRole('button', { name: '确认撤销移动' }))
    await waitFor(() => expect(api.undoSourceRelocation).toHaveBeenCalledWith('relocation-90'))
    expect(await screen.findByRole('alert')).toHaveTextContent('旧位置已被占用')
  })
})
