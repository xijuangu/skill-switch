import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BulkSkillActionsDialog } from '../../src/renderer/src/features/skills/dialogs'
import type { SkillWithConflictView } from '../../src/preload'
import { mockWindowApi } from './api-mock'

// 批量部署对话框：按 Discovery Target 分组 + 组头三态开关 + 默认不选。
// 回归背景：旧实现默认勾选全部 skill×target 对，且只能逐对取消，
// 「20 个 skill 只部署到 1 个工具」需要 20×(N−1) 次取消点击。

function buildSkill(id: number, name: string): SkillWithConflictView {
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
    deployments: []
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
  it('按 Discovery Target 分组展示，且默认不勾选任何部署项', async () => {
    const skills = [buildSkill(1, 'alpha'), buildSkill(2, 'beta')]
    mockWindowApi({
      getDeployTargets: vi.fn().mockResolvedValue([
        target('codex-user', 'Codex'),
        target('agents-user', 'Agents')
      ])
    })
    renderDialog(skills)

    const codexGroup = await screen.findByRole('group', { name: /Codex/ })
    const agentsGroup = await screen.findByRole('group', { name: /Agents/ })
    expect(within(codexGroup).getByRole('checkbox', { name: 'alpha → Codex' })).toBeInTheDocument()
    expect(within(codexGroup).getByRole('checkbox', { name: 'beta → Codex' })).toBeInTheDocument()
    expect(within(agentsGroup).getByRole('checkbox', { name: 'alpha → Agents' })).toBeInTheDocument()

    // 默认不选：所有 pair 复选框均未勾选
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).not.toBeChecked()
    }
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

    await userEvent.click(await screen.findByRole('checkbox', { name: 'alpha → Codex' }))
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

  it('取消部署 tab 默认不勾选任何受管部署，工具筛选保留', async () => {
    const skills = [buildSkill(1, 'alpha')]
    mockWindowApi({
      getDeploymentsForSkill: vi.fn().mockResolvedValue([
        {
          id: 11, skill_id: 1, target_tool: 'codex', target_path: '/codex/alpha',
          mode: 'symlink', management: 'managed', source_path: '/canonical/alpha',
          source_id: 1, target_id: 'codex-user', deployed_at: '2026-07-15T00:00:00.000Z',
          source_hash_at_deploy: 'hash-1'
        },
        {
          id: 12, skill_id: 1, target_tool: 'agents', target_path: '/agents/alpha',
          mode: 'symlink', management: 'managed', source_path: '/canonical/alpha',
          source_id: 1, target_id: 'agents-user', deployed_at: '2026-07-15T00:00:00.000Z',
          source_hash_at_deploy: 'hash-1'
        }
      ])
    })
    renderDialog(skills)

    await userEvent.click(await screen.findByRole('button', { name: '取消部署' }))
    expect(await screen.findByRole('checkbox', { name: 'alpha → codex' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'alpha → agents' })).not.toBeChecked()
    expect(screen.getByRole('combobox', { name: '目标工具' })).toBeInTheDocument()
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
