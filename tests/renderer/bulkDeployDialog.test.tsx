import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BulkSkillActionsDialog } from '../../src/renderer/src/features/skills/dialogs'
import type { SkillDeploymentView, SkillWithConflictView } from '../../src/preload'
import { mockWindowApi } from './api-mock'

// 批量部署对话框：按 Discovery Target 分组 + 组头三态开关 + 默认不选。
// 回归背景：旧实现默认勾选全部 skill×target 对，且只能逐对取消，
// 「20 个 skill 只部署到 1 个工具」需要 20×(N−1) 次取消点击。

function buildSkill(id: number, name: string, deployments: SkillDeploymentView[] = []): SkillWithConflictView {
  return {
    id,
    name,
    primary_source_path: `/canonical/${name}`,
    created_at: new Date(2025, 0, 1).toISOString(),
    sources: [{
      id,
      skill_id: id,
      path: `/canonical/${name}`,
      hash: `hash-${id}`,
      mtime: Date.now(),
      source_type: 'central-repo',
      source_role: 'canonical',
      source_origin: 'scan',
      source_tool: null,
      discovered_at: new Date().toISOString(),
      repo_url: null,
      commit_sha: null
    }],
    conflict: { skillId: id, sourceCount: 1, distinctHashCount: 1, hasConflict: false, primarySource: null },
    deployments
  }
}

function managedDeployment(id: number, skillId: number, targetId: string): SkillDeploymentView {
  return {
    id,
    skill_id: skillId,
    target_tool: targetId.split('-')[0],
    target_path: `/${targetId}/skill`,
    mode: 'symlink',
    management: 'managed',
    source_path: `/canonical/skill`,
    source_id: skillId,
    target_id: targetId,
    deployed_at: new Date().toISOString(),
    source_hash_at_deploy: `hash-${skillId}`,
    status: 'normal'
  }
}

function target(targetId: string, displayName: string, eligible = true, reason: string | null = null) {
  return { targetId, targetTool: targetId.split('-')[0], displayName, eligible, reason }
}

function renderDialog(skills: SkillWithConflictView[]) {
  return render(
    <BulkSkillActionsDialog
      skills={skills}
      allFilteredSkills={skills}
      consolidationPlan={[]}
      onRefresh={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
      onConsolidate={vi.fn()}
    />
  )
}

describe('BulkSkillActionsDialog deploy（按目标分组）', () => {
  it('分组默认折叠：只见组头，展开后才出现部署项，且默认不勾选', async () => {
    const skills = [buildSkill(1, 'alpha'), buildSkill(2, 'beta')]
    mockWindowApi({
      getDeployTargets: vi.fn().mockResolvedValue([
        target('codex-user', 'Codex'),
        target('agents-user', 'Agents')
      ])
    })
    renderDialog(skills)

    await screen.findByRole('checkbox', { name: '全选 Codex' })
    // 默认折叠：pair 复选框不在文档中
    expect(screen.queryByRole('checkbox', { name: 'alpha → Codex' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'alpha → Agents' })).not.toBeInTheDocument()

    // 展开 Codex 组后出现该组 pair，且默认不勾选
    await userEvent.click(screen.getByRole('button', { name: '展开 Codex' }))
    expect(screen.getByRole('checkbox', { name: 'alpha → Codex' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'beta → Codex' })).not.toBeChecked()
    // 未展开的组仍不可见
    expect(screen.queryByRole('checkbox', { name: 'alpha → Agents' })).not.toBeInTheDocument()
  })

  it('组头开关一次选中该目标下全部 Skill，提交只包含该目标的 pair', async () => {
    const skills = [buildSkill(1, 'alpha'), buildSkill(2, 'beta')]
    const api = mockWindowApi({
      getDeployTargets: vi.fn().mockResolvedValue([
        target('codex-user', 'Codex'),
        target('agents-user', 'Agents')
      ])
    })
    renderDialog(skills)

    const codexHeader = await screen.findByRole('checkbox', { name: '全选 Codex' })
    await userEvent.click(codexHeader)
    await userEvent.click(screen.getByRole('button', { name: '展开 Codex' }))
    await userEvent.click(screen.getByRole('button', { name: '展开 Agents' }))

    expect(screen.getByRole('checkbox', { name: 'alpha → Codex' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'beta → Codex' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'alpha → Agents' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'beta → Agents' })).not.toBeChecked()
    expect(codexHeader).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: '批量部署' }))
    await waitFor(() => expect(api.bulkDeploy).toHaveBeenCalledWith([
      { key: '1:codex-user', sourceId: 1, targetId: 'codex-user', requestedMode: 'symlink' },
      { key: '2:codex-user', sourceId: 2, targetId: 'codex-user', requestedMode: 'symlink' }
    ]))
  })

  it('组头三态：部分勾选时 indeterminate，再次点击清空整组', async () => {
    const skills = [buildSkill(1, 'alpha'), buildSkill(2, 'beta')]
    mockWindowApi({
      getDeployTargets: vi.fn().mockResolvedValue([target('codex-user', 'Codex')])
    })
    renderDialog(skills)

    await userEvent.click(await screen.findByRole('button', { name: '展开 Codex' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'alpha → Codex' }))
    const header = screen.getByRole('checkbox', { name: '全选 Codex' })
    expect(header).not.toBeChecked()
    expect((header as HTMLInputElement).indeterminate).toBe(true)

    // 部分选中时点击组头 → 补齐全选
    await userEvent.click(header)
    expect(screen.getByRole('checkbox', { name: 'alpha → Codex' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'beta → Codex' })).toBeChecked()
    expect((header as HTMLInputElement).indeterminate).toBe(false)

    // 全选时点击组头 → 清空整组
    await userEvent.click(header)
    expect(screen.getByRole('checkbox', { name: 'alpha → Codex' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'beta → Codex' })).not.toBeChecked()
  })

  it('展开/收起不改变勾选状态，组头复选框不触发折叠', async () => {
    const skills = [buildSkill(1, 'alpha')]
    mockWindowApi({
      getDeployTargets: vi.fn().mockResolvedValue([target('codex-user', 'Codex')])
    })
    renderDialog(skills)

    await userEvent.click(await screen.findByRole('button', { name: '展开 Codex' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'alpha → Codex' }))

    // 收起后勾选状态保留在组头上
    await userEvent.click(screen.getByRole('button', { name: '收起 Codex' }))
    expect(screen.queryByRole('checkbox', { name: 'alpha → Codex' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '全选 Codex' })).toBeChecked()

    // 重新展开，pair 勾选仍在
    await userEvent.click(screen.getByRole('button', { name: '展开 Codex' }))
    expect(screen.getByRole('checkbox', { name: 'alpha → Codex' })).toBeChecked()

    // 点组头复选框只改选择，不改展开态
    await userEvent.click(screen.getByRole('checkbox', { name: '全选 Codex' }))
    expect(screen.getByRole('checkbox', { name: 'alpha → Codex' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'alpha → Codex' })).not.toBeChecked()
  })

  it('部署项展示已部署状态：已有受管部署的 pair 带「已部署」标记', async () => {
    const skills = [
      buildSkill(1, 'alpha', [managedDeployment(11, 1, 'codex-user')]),
      buildSkill(2, 'beta')
    ]
    mockWindowApi({
      getDeployTargets: vi.fn().mockResolvedValue([target('codex-user', 'Codex')])
    })
    renderDialog(skills)

    await userEvent.click(await screen.findByRole('button', { name: '展开 Codex' }))
    const alphaRow = screen.getByRole('checkbox', { name: 'alpha → Codex' }).closest('label')!
    expect(within(alphaRow).getByText('已部署')).toBeInTheDocument()
    const betaRow = screen.getByRole('checkbox', { name: 'beta → Codex' }).closest('label')!
    expect(within(betaRow).queryByText('已部署')).not.toBeInTheDocument()
  })

  it('取消部署 tab 按工具分组：默认折叠，展开后默认不勾选', async () => {
    const skills = [buildSkill(1, 'alpha')]
    mockWindowApi({
      getDeploymentsForSkill: vi.fn().mockResolvedValue([
        managedDeployment(11, 1, 'codex-user'),
        managedDeployment(12, 1, 'agents-user')
      ])
    })
    renderDialog(skills)

    await userEvent.click(await screen.findByRole('button', { name: '取消部署' }))
    expect(await screen.findByRole('checkbox', { name: '全选 codex' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '全选 agents' })).toBeInTheDocument()
    // 默认折叠：部署项不在文档中
    expect(screen.queryByRole('checkbox', { name: 'alpha → codex' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '展开 codex' }))
    expect(screen.getByRole('checkbox', { name: 'alpha → codex' })).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'alpha → agents' })).not.toBeInTheDocument()
  })

  it('取消部署组头一次选中该工具下全部部署，提交只包含该组', async () => {
    const skills = [buildSkill(1, 'alpha'), buildSkill(2, 'beta')]
    const api = mockWindowApi({
      getDeploymentsForSkill: vi.fn().mockImplementation((skillId: number) =>
        Promise.resolve(skillId === 1
          ? [managedDeployment(11, 1, 'codex-user'), managedDeployment(13, 1, 'agents-user')]
          : [managedDeployment(12, 2, 'codex-user')])),
      bulkUndeploy: vi.fn().mockResolvedValue({ total: 2, completed: 2, failed: 0, items: [] })
    })
    renderDialog(skills)

    await userEvent.click(await screen.findByRole('button', { name: '取消部署' }))
    await userEvent.click(await screen.findByRole('checkbox', { name: '全选 codex' }))
    await userEvent.click(screen.getByRole('button', { name: '展开 codex' }))
    await userEvent.click(screen.getByRole('button', { name: '展开 agents' }))
    expect(screen.getByRole('checkbox', { name: 'alpha → codex' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'beta → codex' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'alpha → agents' })).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: '批量取消部署' }))
    await waitFor(() => expect(api.bulkUndeploy).toHaveBeenCalledWith([
      { key: '11', deploymentId: 11 },
      { key: '12', deploymentId: 12 }
    ]))
  })

  it('未选择任何项时禁用确认按钮并提示，勾选后启用', async () => {
    const skills = [buildSkill(1, 'alpha')]
    mockWindowApi({
      getDeployTargets: vi.fn().mockResolvedValue([target('codex-user', 'Codex')])
    })
    renderDialog(skills)

    await screen.findByRole('checkbox', { name: '全选 Codex' })
    expect(screen.getByRole('button', { name: '批量部署' })).toBeDisabled()
    expect(screen.getByText(/请先勾选/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: '全选 Codex' }))
    expect(screen.getByRole('button', { name: '批量部署' })).toBeEnabled()
    expect(screen.queryByText(/请先勾选/)).not.toBeInTheDocument()
  })
})
