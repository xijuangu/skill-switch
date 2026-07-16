import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../../src/renderer/src/app/App'
import { ToastProvider } from '../../src/renderer/src/app/Toast'
import { SkillsPage } from '../../src/renderer/src/features/skills/SkillsPage'
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
      consolidationBatches: []
    }),
    previewConsolidation: vi.fn(),
    confirmConsolidation: vi.fn(),
    undoConsolidation: vi.fn(),
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
    adoptDeployment: vi.fn(),
    getBulkAdoptionFacts: vi.fn().mockResolvedValue({ total: 0, tools: [] }),
    previewBulkAdoption: vi.fn().mockResolvedValue({ status: 'empty', facts: { total: 0, tools: [] } }),
    confirmBulkAdoption: vi.fn(),
    getTools: vi.fn().mockResolvedValue([]),
    removeFromManifest: vi.fn(),
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
    await userEvent.click(screen.getByRole('button', { name: '技能' }))
    // 切回 skills 时不抛错即可
    expect(screen.getByRole('button', { name: '技能' })).toBeInTheDocument()
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
