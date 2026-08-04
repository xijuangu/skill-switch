import { useState, useEffect, useMemo } from 'react'
import { Button, Input, Dialog, StatusDot } from '../../shared'
import { completeMutation } from '../../async-state'
import { groupByHash, shortHash, findSourceGroup } from './sourceGrouping'

export type DeployMode = 'copy' | 'symlink'
export type SkillView = Awaited<ReturnType<typeof window.api.getSkills>>[number]
export type SkillSourceView = SkillView['sources'][number]
export type DeployResultView = Extract<
  Awaited<ReturnType<typeof window.api.deploymentDeploy>>,
  { status: 'completed' }
>['result']
export type DeployTargetOptionView = Awaited<ReturnType<typeof window.api.getDeployTargets>>[number]
export type InstallResultView = Awaited<ReturnType<typeof window.api.installFromGitHub>>
export type ConsolidationPreview = Awaited<ReturnType<typeof window.api.previewConsolidation>>
export type ConsolidationBatchPreview = Awaited<ReturnType<typeof window.api.previewConsolidationBatch>>
export type ConsolidationBatch = Awaited<ReturnType<typeof window.api.getSkillLibrary>>['consolidationBatches'][number]
export type ConsolidationPlanItem = Awaited<ReturnType<typeof window.api.getSkillLibrary>>['consolidationPlan'][number]
export type ConflictResolutionPreview = Awaited<ReturnType<typeof window.api.previewConflictResolution>>
export type ConflictResolutionDecision = NonNullable<Parameters<typeof window.api.previewConsolidationBatch>[0]['items'][number]['conflictResolution']>
export type ConflictVersionAction = { action: 'archive' | 'save-as'; newSkillName: string; canonicalRelativeParent: string }
export type ConsolidationDraft = ConsolidationPlanItem & {
  selected: boolean
  canonicalRelativeParent: string
  conflictResolution?: ConflictResolutionDecision
}
export type ConflictResolutionEditor = {
  draftSkillId: number
  preview: ConflictResolutionPreview
  authoritativeSourceId: number | null
  actions: Record<string, ConflictVersionAction>
}
export type UndoBatch = { batch: ConsolidationBatch; item: ConsolidationBatch['items'][number] }
export type SourceRelocationPreview = Awaited<ReturnType<typeof window.api.previewSourceRelocation>>
export type SourceRelocation = Awaited<ReturnType<typeof window.api.getSkillLibrary>>['sourceRelocations'][number]
type BulkMutationResultView = Awaited<ReturnType<typeof window.api.bulkDeploy>>

export function sourceOriginLabel(origin: SkillSourceView['source_origin']): string {
  const labels: Record<SkillSourceView['source_origin'], string> = {
    scan: '扫描发现',
    local: '添加本地',
    github: 'GitHub 安装',
    zip: 'ZIP 安装',
    legacy: '旧版来源',
  }
  return labels[origin]
}

export function sourceRoleLabel(role: SkillSourceView['source_role']): string {
  return role === 'canonical' ? '权威来源' : '候选来源'
}

type BulkAction = 'deploy' | 'undeploy' | 'remove' | 'consolidate'
type BulkDeployPair = {
  key: string
  skillName: string
  sourceId: number
  targetId: string
  targetName: string
  eligible: boolean
  reason: string | null
  /** 该 Skill 在此 Discovery Target 上已有受管部署 */
  deployed: boolean
}
type BulkUndeployItem = {
  key: string
  skillName: string
  deploymentId: number
  targetTool: string
  targetPath: string | null
}

function deploymentRiskLabel(reason: string): string {
  return {
    'external-overwrite': '将覆盖目标中不受管理的现有内容',
    'target-modified': '受管目标已被修改',
    'mode-degraded': '当前平台需要降级部署模式',
    'source-updated': '权威来源已更新',
    'bidirectional': '来源与目标均发生变化'
  }[reason] ?? reason
}

export function BulkSkillActionsDialog({
  skills,
  allFilteredSkills,
  consolidationPlan,
  onRefresh,
  onClose,
  onConsolidate
}: {
  skills: SkillView[]
  /** 搜索词 + 部署状态筛选后的全量 Skill（整理 Tab 展示范围）。 */
  allFilteredSkills: SkillView[]
  consolidationPlan: ConsolidationPlanItem[]
  onRefresh: () => Promise<void>
  onClose: () => void
  onConsolidate: (skillIds: Set<number>) => void
}) {
  const [action, setAction] = useState<BulkAction>('deploy')
  const [mode, setMode] = useState<DeployMode>('symlink')
  const [deployPairs, setDeployPairs] = useState<BulkDeployPair[]>([])
  const [undeployItems, setUndeployItems] = useState<BulkUndeployItem[]>([])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [expandedTargets, setExpandedTargets] = useState<Set<string>>(new Set())
  const [ignoreOnRemove, setIgnoreOnRemove] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BulkMutationResultView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const skillsKey = skills.map((skill) => skill.id).join(',')

  const consolidatableIds = useMemo(
    () => new Set(consolidationPlan.map((item) => item.skillId)),
    [consolidationPlan]
  )

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    if (action === 'remove') {
      setBusy(false)
      setSelectedKeys((current) => current.size > 0
        ? current
        : new Set(skills.map((skill) => String(skill.id))))
      return () => { cancelled = true }
    }
    if (action === 'consolidate') {
      setBusy(false)
      setSelectedKeys((current) => current.size > 0
        ? current
        : new Set(allFilteredSkills.filter((skill) => consolidatableIds.has(skill.id)).map((skill) => String(skill.id))))
      return () => { cancelled = true }
    }
    setBusy(true)
    if (action === 'deploy') {
      Promise.all(skills.map(async (skill) => {
        const canonical = skill.sources.find((source) => source.source_role === 'canonical')
        if (!canonical) return []
        const targets = await window.api.getDeployTargets(canonical.id)
        return targets.map((target) => ({
          key: `${skill.id}:${target.targetId}`,
          skillName: skill.name,
          sourceId: canonical.id,
          targetId: target.targetId,
          targetName: target.displayName,
          eligible: target.eligible,
          reason: target.reason,
          deployed: skill.deployments.some(
            (deployment) => deployment.management === 'managed' && deployment.target_id === target.targetId
          )
        }))
      })).then((groups) => {
        if (cancelled) return
        setDeployPairs(groups.flat())
      }).catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (!cancelled) setBusy(false)
      })
    } else {
      Promise.all(skills.map(async (skill) => {
        const deployments = await window.api.getDeploymentsForSkill(skill.id)
        return deployments
          .filter((deployment) => deployment.management === 'managed')
          .map((deployment) => ({
            key: String(deployment.id),
            skillName: skill.name,
            deploymentId: deployment.id,
            targetTool: deployment.target_tool,
            targetPath: deployment.target_path
          }))
      })).then((groups) => {
        if (cancelled) return
        setUndeployItems(groups.flat())
      }).catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (!cancelled) setBusy(false)
      })
    }
    return () => { cancelled = true }
  }, [action, skillsKey, allFilteredSkills, consolidatableIds]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const deployTargetGroups = useMemo(() => {
    const groups: { targetId: string; targetName: string; pairs: BulkDeployPair[] }[] = []
    for (const pair of deployPairs) {
      let group = groups.find((item) => item.targetId === pair.targetId)
      if (!group) {
        group = { targetId: pair.targetId, targetName: pair.targetName, pairs: [] }
        groups.push(group)
      }
      group.pairs.push(pair)
    }
    return groups
  }, [deployPairs])

  const toggleTargetGroup = (eligibleKeys: string[], allSelected: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current)
      for (const key of eligibleKeys) {
        if (allSelected) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  const undeployToolGroups = useMemo(() => {
    const groups: { tool: string; items: BulkUndeployItem[] }[] = []
    for (const item of undeployItems) {
      let group = groups.find((candidate) => candidate.tool === item.targetTool)
      if (!group) {
        group = { tool: item.targetTool, items: [] }
        groups.push(group)
      }
      group.items.push(item)
    }
    return groups
  }, [undeployItems])

  const selectedCount = action === 'undeploy'
    ? undeployItems.filter((item) => selectedKeys.has(item.key)).length
    : selectedKeys.size

  const run = async () => {
    setBusy(true)
    try {
      let outcome: BulkMutationResultView
      if (action === 'deploy') {
        const pendingConfirmations = (result?.items ?? []).flatMap((item) =>
          item.status === 'confirmation-required' &&
          selectedKeys.has(item.key) &&
          item.outcome != null &&
          'status' in item.outcome &&
          item.outcome?.status === 'confirmation-required'
            ? [{ key: item.key, confirmationId: item.outcome.confirmationId }]
            : []
        )
        if (pendingConfirmations.length > 0) {
          const confirmed = await window.api.bulkConfirmDeploy(pendingConfirmations)
          const confirmedByKey = new Map(confirmed.items.map((item) => [item.key, item]))
          const items = (result?.items ?? []).map((item) => confirmedByKey.get(item.key) ?? item)
          outcome = {
            total: items.length,
            completed: items.filter((item) => item.status === 'completed').length,
            failed: items.filter((item) => item.status !== 'completed').length,
            items
          }
        } else {
          outcome = await window.api.bulkDeploy(
            deployPairs
              .filter((pair) => pair.eligible && selectedKeys.has(pair.key))
              .map((pair) => ({
                key: pair.key,
                sourceId: pair.sourceId,
                targetId: pair.targetId,
                requestedMode: mode
              }))
          )
        }
      } else if (action === 'undeploy') {
        outcome = await window.api.bulkUndeploy(
          undeployItems
            .filter((item) => selectedKeys.has(item.key))
            .map((item) => ({ key: item.key, deploymentId: item.deploymentId }))
        )
      } else {
        outcome = await window.api.bulkRemoveFromRegistry(
          skills
            .filter((skill) => selectedKeys.has(String(skill.id)))
            .map((skill) => ({ key: String(skill.id), skillId: skill.id })),
          ignoreOnRemove
        )
      }
      setResult(outcome)
      setSelectedKeys(new Set(outcome.items.filter((item) => item.status !== 'completed').map((item) => item.key)))
      await onRefresh()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const resultByKey = new Map(result?.items.map((item) => [item.key, item]) ?? [])
  const hasPendingConfirmation = action === 'deploy' && (result?.items ?? []).some((item) =>
    item.status === 'confirmation-required' && selectedKeys.has(item.key)
  )
  const actionLabel = action === 'deploy'
    ? hasPendingConfirmation ? '确认并继续' : '批量部署'
    : action === 'undeploy' ? '批量取消部署'
    : action === 'consolidate' ? '下一步'
    : '批量从注册表移除'

  return (
    <Dialog
      open
      onClose={onClose}
      title={`批量操作 · ${skills.length} 个 Skill`}
      description="成功项会从选择中移除；失败项保留，修正后可直接重试。"
      confirmLabel={actionLabel}
      busy={busy}
      confirmDisabled={selectedCount === 0}
      onConfirm={() => {
        if (action === 'consolidate') {
          const ids = new Set([...selectedKeys].map(Number).filter((id) => consolidatableIds.has(id)))
          if (ids.size > 0) onConsolidate(ids)
        } else if (selectedCount > 0) run()
      }}
      closeOnOverlay={false}
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          {([
            ['deploy', '部署'],
            ['undeploy', '取消部署'],
            ['remove', '从注册表移除'],
            ['consolidate', '整理']
          ] as const).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={action === value ? 'primary' : 'secondary'}
              onClick={() => {
                setAction(value)
                setResult(null)
                setSelectedKeys(new Set())
                setExpandedTargets(new Set())
              }}
            >
              {label}
            </Button>
          ))}
        </div>

        {action === 'deploy' && (
          <div>
            <p className="text-xs font-medium text-foreground mb-2">模式</p>
            <div className="flex gap-3">
              {(['symlink', 'copy'] as const).map((value) => (
                <label key={value} className="flex items-center gap-1.5 text-xs">
                  <input type="radio" name="bulk-deploy-mode" checked={mode === value} onChange={() => setMode(value)} />
                  {value}
                </label>
              ))}
            </div>
          </div>
        )}

        {action === 'remove' && (
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={ignoreOnRemove}
              onChange={(event) => setIgnoreOnRemove(event.target.checked)}
            />
            忽略这些来源目录，扫描不再登记
          </label>
        )}

        {loadError && <p className="text-xs text-danger">{loadError}</p>}
        {result && (
          <div className="rounded border border-border p-2 text-xs">
            <p className="font-medium">完成 {result.completed}，失败 {result.failed}</p>
            {result.items.filter((item) => item.status !== 'completed').map((item) => {
              const confirmation = item.outcome != null &&
                'status' in item.outcome &&
                item.outcome.status === 'confirmation-required'
                ? item.outcome
                : null
              return confirmation ? (
                <div key={item.key} className="mt-2 rounded border border-warning/30 bg-warning-subtle p-2">
                  <p className="font-medium text-warning">{confirmation.facts.skillName} → {confirmation.facts.targetDisplayName}</p>
                  <ul className="list-disc pl-4 mt-1 text-foreground-secondary">
                    {confirmation.facts.reasons.map((reason) => <li key={reason}>{deploymentRiskLabel(reason)}</li>)}
                  </ul>
                  <p className="mt-1">
                    模式：{confirmation.facts.requestedMode}
                    {confirmation.facts.actualMode !== confirmation.facts.requestedMode
                      ? ` → ${confirmation.facts.actualMode}`
                      : ''}
                  </p>
                  <p>备份：{confirmation.facts.backup.required ? confirmation.facts.backup.directory ?? '会创建备份' : '不需要'}</p>
                </div>
              ) : (
                <p key={item.key} className="text-danger mt-1">{item.key}: {item.message ?? item.status}</p>
              )
            })}
          </div>
        )}

        <div className="space-y-2">
          {action === 'deploy' && deployTargetGroups.map((group) => {
            const eligibleKeys = group.pairs.filter((pair) => pair.eligible).map((pair) => pair.key)
            const selectedInGroup = eligibleKeys.filter((key) => selectedKeys.has(key)).length
            const deployedInGroup = group.pairs.filter((pair) => pair.deployed).length
            const allSelected = eligibleKeys.length > 0 && selectedInGroup === eligibleKeys.length
            const someSelected = selectedInGroup > 0 && !allSelected
            const expanded = expandedTargets.has(group.targetId)
            const toggleExpanded = () => {
              setExpandedTargets((current) => {
                const next = new Set(current)
                if (next.has(group.targetId)) next.delete(group.targetId)
                else next.add(group.targetId)
                return next
              })
            }
            return (
              <div key={group.targetId} role="group" aria-label={`目标 ${group.targetName}`}>
                <div className="flex items-center gap-2 rounded border border-border bg-surface-secondary p-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    aria-label={`全选 ${group.targetName}`}
                    checked={allSelected}
                    disabled={busy || eligibleKeys.length === 0}
                    ref={(el) => { if (el) el.indeterminate = someSelected }}
                    onChange={() => toggleTargetGroup(eligibleKeys, allSelected)}
                  />
                  <button
                    type="button"
                    onClick={toggleExpanded}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? '收起' : '展开'} ${group.targetName}`}
                    className="flex flex-1 items-center gap-1.5 text-left text-foreground hover:text-foreground-secondary"
                  >
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                    <span>{group.targetName} · {selectedInGroup}/{eligibleKeys.length}</span>
                  </button>
                  {deployedInGroup > 0 && (
                    <span className="text-foreground-muted font-normal">{deployedInGroup}个已部署</span>
                  )}
                </div>
                {expanded && (
                  <div className="space-y-1 mt-1">
                    {group.pairs.map((pair) => (
                      <label key={pair.key} className={`flex items-start gap-2 rounded border border-border p-2 text-xs ${!pair.eligible ? 'opacity-50' : ''}`}>
                        <input type="checkbox" aria-label={`${pair.skillName} → ${pair.targetName}`} checked={selectedKeys.has(pair.key)} disabled={!pair.eligible || busy} onChange={() => toggle(pair.key)} />
                        <span className="flex-1">
                          <span className="flex items-center gap-2">
                            <span><strong>{pair.skillName}</strong> → {pair.targetName}</span>
                            {pair.deployed && <StatusDot variant="success" label="已部署" />}
                          </span>
                          {pair.reason ? <span className="block text-foreground-muted">{pair.reason}</span> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {action === 'undeploy' && undeployToolGroups.map((group) => {
            const groupKeys = group.items.map((item) => item.key)
            const selectedInGroup = groupKeys.filter((key) => selectedKeys.has(key)).length
            const allSelected = groupKeys.length > 0 && selectedInGroup === groupKeys.length
            const someSelected = selectedInGroup > 0 && !allSelected
            const expanded = expandedTargets.has(group.tool)
            const toggleExpanded = () => {
              setExpandedTargets((current) => {
                const next = new Set(current)
                if (next.has(group.tool)) next.delete(group.tool)
                else next.add(group.tool)
                return next
              })
            }
            return (
              <div key={group.tool} role="group" aria-label={`工具 ${group.tool}`}>
                <div className="flex items-center gap-2 rounded border border-border bg-surface-secondary p-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    aria-label={`全选 ${group.tool}`}
                    checked={allSelected}
                    disabled={busy || groupKeys.length === 0}
                    ref={(el) => { if (el) el.indeterminate = someSelected }}
                    onChange={() => toggleTargetGroup(groupKeys, allSelected)}
                  />
                  <button
                    type="button"
                    onClick={toggleExpanded}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? '收起' : '展开'} ${group.tool}`}
                    className="flex flex-1 items-center gap-1.5 text-left text-foreground hover:text-foreground-secondary"
                  >
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                    <span>{group.tool} · {selectedInGroup}/{groupKeys.length}</span>
                  </button>
                  <span className="text-foreground-muted font-normal">{group.items.length}个已部署</span>
                </div>
                {expanded && (
                  <div className="space-y-1 mt-1">
                    {group.items.map((item) => (
                      <label key={item.key} className="flex items-start gap-2 rounded border border-border p-2 text-xs">
                        <input type="checkbox" aria-label={`${item.skillName} → ${item.targetTool}`} checked={selectedKeys.has(item.key)} disabled={busy} onChange={() => toggle(item.key)} />
                        <span><strong>{item.skillName}</strong> → {item.targetTool}<span className="block text-foreground-muted break-all">{item.targetPath}</span></span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {action === 'remove' && skills.map((skill) => (
            <label key={skill.id} className="flex items-center gap-2 rounded border border-border p-2 text-xs">
              <input type="checkbox" aria-label={`移除 ${skill.name}`} checked={selectedKeys.has(String(skill.id))} disabled={busy} onChange={() => toggle(String(skill.id))} />
              <span>{skill.name}</span>
              {resultByKey.get(String(skill.id))?.message && <span className="text-danger ml-auto">{resultByKey.get(String(skill.id))?.message}</span>}
            </label>
          ))}
          {action === 'consolidate' && allFilteredSkills.map((skill) => {
            const consolidatable = consolidatableIds.has(skill.id)
            return (
              <label key={skill.id} className={`flex items-center gap-2 rounded border border-border p-2 text-xs ${!consolidatable ? 'opacity-50' : ''}`}>
                <input type="checkbox" aria-label={`整理 ${skill.name}`} checked={consolidatable && selectedKeys.has(String(skill.id))} disabled={!consolidatable || busy} onChange={() => toggle(String(skill.id))} />
                <span className="flex-1">{skill.name}</span>
                <span className={`text-2xs px-1.5 py-0.5 rounded ${consolidatable ? 'bg-primary-subtle text-primary' : 'bg-surface-secondary text-foreground-muted'}`}>
                  {consolidatable ? '可整理' : '无需整理'}
                </span>
              </label>
            )
          })}
        </div>
      </div>
    </Dialog>
  )
}

function conflictFileStatusLabel(status: 'added' | 'deleted' | 'modified'): string {
  return { added: '新增', deleted: '删除', modified: '修改' }[status]
}

export function ConflictDialog({
  skill,
  onCancel,
  onConfirm
}: {
  skill: SkillView
  onCancel: () => void
  onConfirm: (source: SkillSourceView) => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const hashGroups = groupByHash(skill.sources)
  const distinctVersions = hashGroups.size

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`解决版本冲突 — ${skill.name}`}
      description={`检测到 ${distinctVersions} 个不同版本 (共 ${skill.sources.length} 个来源)，请选择要使用哪个版本。`}
      confirmLabel="使用此版本"
      onConfirm={() => {
        const picked = skill.sources.find((s) => s.id === selectedId)
        if (picked) onConfirm(picked)
      }}
      closeOnOverlay={false}
    >
      <div className="space-y-2">
        {skill.sources.map((src) => {
          const sameHashCount = hashGroups.get(src.hash)?.length ?? 1
          return (
            <label
              key={src.id}
              className={`block border rounded p-2.5 cursor-pointer transition-colors duration-fast ${
                selectedId === src.id
                  ? 'border-primary bg-primary-subtle'
                  : 'border-border hover:bg-surface-hover'
              }`}
            >
              <div className="flex items-start gap-2">
                <input
                  type="radio"
                  name="conflict-source"
                  checked={selectedId === src.id}
                  onChange={() => setSelectedId(src.id)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0 text-xs space-y-0.5">
                  <div className="font-mono text-foreground break-all">{src.path}</div>
                  <div className="font-mono text-foreground-secondary text-2xs">{src.hash}</div>
                  <div className="text-foreground-muted text-2xs">
                    {sourceRoleLabel(src.source_role)} · {sourceOriginLabel(src.source_origin)} · {src.source_type}
                    {sameHashCount > 1 && ` · 与另外 ${sameHashCount - 1} 个来源内容一致`}
                  </div>
                </div>
              </div>
            </label>
          )
        })}
      </div>
    </Dialog>
  )
}

export function DeployDialogContent({
  skill,
  sourceId,
  contextMessage,
  onDone
}: {
  skill: SkillView
  sourceId: number
  contextMessage?: string
  onDone: (result: DeployResultView | null) => Promise<void>
}) {
  const source = skill.sources.find((candidate) => candidate.id === sourceId)
  const [targetOptions, setTargetOptions] = useState<DeployTargetOptionView[]>([])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<DeployMode>('symlink')
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sessionResults, setSessionResults] = useState<Map<string, BulkMutationResultView['items'][number]>>(new Map())

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setLoadError(null)
    window.api.getDeployTargets(sourceId)
      .then((options) => {
        if (cancelled) return
        setTargetOptions(options)
        setSelectedKeys((current) =>
          current.size > 0
            ? current
            : new Set(
                options
                  .filter(
                    (o) =>
                      o.eligible &&
                      !skill.deployments.some(
                        (d) => d.target_id === o.targetId && d.management === 'managed'
                      )
                  )
                  .map((o) => o.targetId)
              )
        )
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [skill.id, sourceId]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function statusFor(targetId: string): 'undeployed' | 'deployed' | 'needs-confirmation' | 'failed' {
    const session = sessionResults.get(targetId)
    if (session) {
      if (session.status === 'completed') return 'deployed'
      if (session.status === 'confirmation-required') return 'needs-confirmation'
      return 'failed'
    }
    const existing = skill.deployments.find(
      (d) => d.target_id === targetId && d.management === 'managed'
    )
    return existing ? 'deployed' : 'undeployed'
  }

  const statusLabel: Record<string, string> = {
    undeployed: '未部署',
    deployed: '已部署',
    'needs-confirmation': '需要确认',
    failed: '失败'
  }
  const statusVariant: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
    undeployed: 'neutral',
    deployed: 'success',
    'needs-confirmation': 'warning',
    failed: 'danger'
  }

  const run = async () => {
    if (!source) {
      setLoadError('所选来源已失效，请刷新后重试')
      return
    }
    setBusy(true)
    setLoadError(null)
    try {
      const pendingConfirmations = [...sessionResults.values()]
        .filter((item) => item.status === 'confirmation-required' && selectedKeys.has(item.key))
        .flatMap((item) =>
          item.outcome != null &&
          'status' in item.outcome &&
          item.outcome.status === 'confirmation-required'
            ? [{ key: item.key, confirmationId: item.outcome.confirmationId }]
            : []
        )
      let outcome: BulkMutationResultView
      if (pendingConfirmations.length > 0) {
        outcome = await window.api.bulkConfirmDeploy(pendingConfirmations)
      } else {
        outcome = await window.api.bulkDeploy(
          targetOptions
            .filter((o) => o.eligible && selectedKeys.has(o.targetId))
            .map((o) => ({
              key: o.targetId,
              sourceId: source.id,
              targetId: o.targetId,
              requestedMode: mode
            }))
        )
      }
      const nextResults = new Map(sessionResults)
      for (const item of outcome.items) {
        nextResults.set(item.key, item)
      }
      setSessionResults(nextResults)
      setSelectedKeys(
        new Set(
          [...nextResults.values()]
            .filter((item) => item.status !== 'completed' && selectedKeys.has(item.key))
            .map((item) => item.key)
        )
      )
      const firstCompleted = outcome.items.find((item) => item.status === 'completed')
      if (firstCompleted) {
        const completedOutcome = firstCompleted.outcome
        if (
          completedOutcome != null &&
          'status' in completedOutcome &&
          completedOutcome.status === 'completed' &&
          'result' in completedOutcome
        ) {
          await onDone(completedOutcome.result)
        } else {
          await onDone({
            action: 'created',
            mode,
            targetDisplayName:
              targetOptions.find((o) => o.targetId === firstCompleted.key)?.displayName ??
              firstCompleted.key
          })
        }
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const hasPendingConfirmation = [...sessionResults.values()].some(
    (item) => item.status === 'confirmation-required' && selectedKeys.has(item.key)
  )
  const actionLabel = hasPendingConfirmation ? '确认并继续' : '部署'
  const selectedCount = selectedKeys.size
  const completedCount = [...sessionResults.values()].filter((item) => item.status === 'completed').length
  const failedCount = [...sessionResults.values()].filter(
    (item) => item.status !== 'completed' && item.status !== 'confirmation-required'
  ).length
  const hasRun = sessionResults.size > 0

  return (
    <Dialog
      open
      onClose={() => !busy && onDone(null)}
      title={`部署 ${skill.name}`}
      description={contextMessage}
      confirmLabel={actionLabel}
      onConfirm={() => {
        if (selectedCount > 0) run()
      }}
      busy={busy}
      closeOnOverlay={!busy}
    >
      <div className="space-y-4">
        <p className="text-xs text-foreground-secondary font-mono break-all">
          {source?.path ?? '来源已失效'}
        </p>

        {skill.conflict.hasConflict &&
          (() => {
            const groups = groupByHash(skill.sources)
            const currentGroup = source == null ? null : findSourceGroup(skill.sources, source.path)
            const otherVersions = groups.size - (currentGroup ? 1 : 0)
            return (
              <div className="px-3 py-2 rounded border border-warning-subtle bg-warning-subtle space-y-0.5">
                {currentGroup ? (
                  <div className="text-2xs text-warning font-medium">
                    当前来源属于版本组 · {currentGroup.count} 个来源 · 哈希：{shortHash(currentGroup.hash)}
                  </div>
                ) : (
                  <div className="text-2xs text-warning font-medium">当前来源未匹配任何版本组</div>
                )}
                {otherVersions > 0 && (
                  <div className="text-2xs text-warning">另有 {otherVersions} 个不同版本</div>
                )}
              </div>
            )
          })()}

        {loadError && (
          <div className="px-3 py-2 rounded border border-danger-subtle bg-danger-subtle text-danger text-xs">
            {loadError}
          </div>
        )}

        {hasRun && (
          <div className="rounded border border-border p-2 text-xs">
            <p className="font-medium">完成 {completedCount}，失败 {failedCount}</p>
            {[...sessionResults.values()]
              .filter((item) => item.status !== 'completed')
              .map((item) => {
                const confirmation =
                  item.outcome != null &&
                  'status' in item.outcome &&
                  item.outcome.status === 'confirmation-required'
                    ? item.outcome
                    : null
                return confirmation ? (
                  <div key={item.key} className="mt-2 rounded border border-warning/30 bg-warning-subtle p-2">
                    <p className="font-medium text-warning">
                      {confirmation.facts.skillName} → {confirmation.facts.targetDisplayName}
                    </p>
                    <ul className="list-disc pl-4 mt-1 text-foreground-secondary">
                      {confirmation.facts.reasons.map((reason) => (
                        <li key={reason}>{deploymentRiskLabel(reason)}</li>
                      ))}
                    </ul>
                    <p className="mt-1">
                      模式：{confirmation.facts.requestedMode}
                      {confirmation.facts.actualMode !== confirmation.facts.requestedMode
                        ? ` → ${confirmation.facts.actualMode}`
                        : ''}
                    </p>
                    <p>
                      备份：
                      {confirmation.facts.backup.required
                        ? confirmation.facts.backup.directory ?? '会创建备份'
                        : '不需要'}
                    </p>
                  </div>
                ) : (
                  <p key={item.key} className="text-danger mt-1">
                    {item.key}: {item.message ?? item.status}
                  </p>
                )
              })}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-foreground mb-1">模式</label>
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="radio"
                name="deploy-mode"
                checked={mode === 'symlink'}
                onChange={() => setMode('symlink')}
                disabled={busy}
              />
              symlink
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="radio"
                name="deploy-mode"
                checked={mode === 'copy'}
                onChange={() => setMode('copy')}
                disabled={busy}
              />
              copy
            </label>
          </div>
          <p className="text-2xs text-foreground-muted mt-1">
            {mode === 'symlink'
              ? '请求链接部署；如平台只能使用 copy，会先请求确认'
              : '快照副本 — 源更新需手动重新部署'}
          </p>
        </div>

        <div className="max-h-72 overflow-auto space-y-1">
          {targetOptions.map((o) => {
            const status = statusFor(o.targetId)
            return (
              <label
                key={o.targetId}
                className={`flex items-start gap-2 rounded border border-border p-2 text-xs ${!o.eligible ? 'opacity-50' : ''}`}
              >
                <input
                  type="checkbox"
                  aria-label={o.displayName}
                  checked={selectedKeys.has(o.targetId)}
                  disabled={!o.eligible || busy}
                  onChange={() => toggle(o.targetId)}
                />
                <span className="flex-1">
                  <span className="flex items-center gap-2">
                    <strong>{o.displayName}</strong>
                    <StatusDot variant={statusVariant[status]} label={statusLabel[status]} />
                  </span>
                  {o.reason ? <span className="block text-foreground-muted">{o.reason}</span> : null}
                </span>
              </label>
            )
          })}
          {targetOptions.length === 0 && !busy && (
            <p className="text-xs text-foreground-muted">无可用工具目标</p>
          )}
        </div>
      </div>
    </Dialog>
  )
}


export function InstallDialogContent({
  initialTab,
  onInstalled,
  onRefresh,
  onClose
}: {
  initialTab: 'github' | 'zip' | 'local-dir'
  onInstalled: (result: InstallResultView) => Promise<void>
  onRefresh: () => Promise<void>
  onClose: () => void
}) {
  const [tab, setTab] = useState<'github' | 'zip' | 'local-dir'>(initialTab)
  const [githubUrl, setGithubUrl] = useState('')
  const [zipPath, setZipPath] = useState<string | null>(null)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installedSkill, setInstalledSkill] = useState<SkillView | null>(null)

  const handleSelectZip = async () => {
    const path = await window.api.selectZipFile()
    if (path) setZipPath(path)
  }

  const handleSelectDir = async () => {
    const path = await window.api.selectLocalDir()
    if (path) setLocalPath(path)
  }

  const handleInstall = async () => {
    setBusy(true)
    setError(null)
    try {
      let result: InstallResultView
      if (tab === 'github') {
        if (!githubUrl.trim()) {
          setError('请输入 GitHub URL')
          setBusy(false)
          return
        }
        result = await window.api.installFromGitHub(githubUrl.trim())
      } else if (tab === 'zip') {
        if (!zipPath) {
          setError('请选择 ZIP 文件')
          setBusy(false)
          return
        }
        result = await window.api.installFromZip(zipPath)
      } else {
        if (!localPath) {
          setError('请选择目录')
          setBusy(false)
          return
        }
        result = await window.api.installFromLocalDir(localPath)
      }
      await completeMutation(result, onInstalled)
      const skills = await window.api.getSkills()
      const installed = skills.find((skill) => skill.id === result.skillId)
      if (!installed) throw new Error('安装已完成，但刷新后未找到对应 Skill')
      setInstalledSkill(installed)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (installedSkill) {
    const canonical = installedSkill.sources.find((source) => source.source_role === 'canonical')
    if (!canonical) {
      return (
        <Dialog
          open
          onClose={onClose}
          title={`已安装 ${installedSkill.name}`}
          description="安装已完成，但未找到可部署的权威 Source。"
          hideCancel
          confirmLabel="关闭"
          onConfirm={onClose}
        />
      )
    }
    return (
      <DeployDialogContent
        skill={installedSkill}
        sourceId={canonical.id}
        contextMessage="安装完成，可继续部署到多个工具；每次成功后弹窗会保持打开。"
        onDone={async (result) => {
          if (!result) {
            onClose()
            return
          }
          await onRefresh()
          const refreshed = (await window.api.getSkills()).find((skill) => skill.id === installedSkill.id)
          if (refreshed) setInstalledSkill(refreshed)
        }}
      />
    )
  }

  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title="安装 Skill"
      confirmLabel="安装"
      onConfirm={handleInstall}
      busy={busy}
    >
      <div className="space-y-4">
        {error && (
          <div className="px-3 py-2 rounded border border-danger-subtle bg-danger-subtle text-danger text-xs">{error}</div>
        )}

        <div className="flex gap-1 border-b border-border">
          {(['github', 'zip', 'local-dir'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              disabled={busy}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors -mb-px ${
                tab === t ? 'border-primary text-primary' : 'border-transparent text-foreground-secondary hover:text-foreground'
              }`}
            >
              {t === 'github' ? 'GitHub URL' : t === 'zip' ? 'ZIP 文件' : '本地目录'}
            </button>
          ))}
        </div>

        {tab === 'github' && (
          <div>
            <label className="block text-xs text-foreground-secondary mb-1">GitHub 仓库 URL</label>
            <Input
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              disabled={busy}
              placeholder="https://github.com/owner/repo[/tree/main/skills/grilling]"
              mono
              className="w-full"
            />
            <p className="text-2xs text-foreground-muted mt-1">
              单 skill 仓库或子路径（如 <code className="font-mono text-2xs">/tree/main/skills/grilling</code>）
            </p>
          </div>
        )}

        {tab === 'zip' && (
          <div>
            <label className="block text-xs text-foreground-secondary mb-1">ZIP 文件</label>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleSelectZip} disabled={busy} size="sm">
                选择 ZIP…
              </Button>
              {zipPath && <code className="text-xs font-mono text-foreground-secondary truncate">{zipPath}</code>}
            </div>
          </div>
        )}

        {tab === 'local-dir' && (
          <div>
            <label className="block text-xs text-foreground-secondary mb-1">本地目录</label>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleSelectDir} disabled={busy} size="sm">
                选择目录…
              </Button>
              {localPath && <code className="text-xs font-mono text-foreground-secondary truncate">{localPath}</code>}
            </div>
            <p className="text-2xs text-foreground-muted mt-1">
              将内容复制到权威源码库；原目录保持不变。
            </p>
          </div>
        )}
      </div>
    </Dialog>
  )
}

export function ViewMdDialog({
  skillName,
  content,
  path,
  onClose
}: {
  skillName: string
  content: string
  path: string
  onClose: () => void
}) {
  return (
    <Dialog open onClose={onClose} title={`${skillName} — SKILL.md`} hideCancel confirmLabel="关闭" onConfirm={onClose}>
      <p className="text-2xs text-foreground-muted mb-2 font-mono break-all">{path}</p>
      <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">{content}</pre>
    </Dialog>
  )
}

export function ViewMdSourcePicker({
  skill,
  onPick,
  onCancel
}: {
  skill: SkillView
  onPick: (source: SkillSourceView) => void
  onCancel: () => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`选择 Source — ${skill.name}`}
      description="存在多个 source，请选择要查看哪个 SKILL.md"
      confirmLabel="查看"
      onConfirm={() => {
        const picked = skill.sources.find((s) => s.id === selectedId)
        if (picked) onPick(picked)
      }}
    >
      <div className="space-y-2">
        {skill.sources.map((src) => (
          <label
            key={src.id}
            className={`block border rounded p-2 cursor-pointer transition-colors ${
              selectedId === src.id ? 'border-primary bg-primary-subtle' : 'border-border hover:bg-surface-hover'
            }`}
          >
            <div className="flex items-start gap-2">
              <input
                type="radio"
                name="viewmd-source"
                checked={selectedId === src.id}
                onChange={() => setSelectedId(src.id)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0 text-xs space-y-0.5">
                <div className="font-mono text-foreground break-all">{src.path}</div>
                <div className="font-mono text-foreground-secondary text-2xs">{src.hash}</div>
                <div className="text-foreground-muted text-2xs">
                  {sourceRoleLabel(src.source_role)} · {sourceOriginLabel(src.source_origin)}
                </div>
              </div>
            </div>
          </label>
        ))}
      </div>
    </Dialog>
  )
}

export function UndeployDialog({
  skill,
  deployments,
  busy,
  onUndeploy,
  onClose
}: {
  skill: SkillView
  deployments: { id: number; target_tool: string; mode: string; target_path?: string | null }[]
  busy: boolean
  onUndeploy: (deploymentId: number) => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={`从…取消部署 ${skill.name}`}
      description={`${deployments.length} 个部署。此操作只移除部署（链接/副本），不删源文件。`}
      hideCancel
      closeOnOverlay={!busy}
    >
      <div className="space-y-2 max-h-48 overflow-auto">
        {deployments.map((d) => (
          <div key={d.id} className="flex items-center justify-between border border-border rounded px-2.5 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{d.target_tool}</span>
                  <span className="text-2xs px-1 py-px rounded bg-surface-secondary text-foreground-secondary">{d.mode}</span>
                </div>
                {d.target_path && <div className="text-2xs text-foreground-muted truncate">{d.target_path}</div>}
              </div>
            </div>
            <Button variant="danger" size="sm" onClick={() => onUndeploy(d.id)} disabled={busy}>
              取消部署
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
          关闭
        </Button>
      </div>
    </Dialog>
  )
}

export function RemoveRegistryDialog({
  skill,
  busy,
  onConfirm,
  onCancel
}: {
  skill: SkillView
  busy: boolean
  onConfirm: (ignoreSourcePaths: boolean) => void
  onCancel: () => void
}) {
  const [ignoreSources, setIgnoreSources] = useState(true)
  // 忽略名单只登记中央仓库外的来源;中央仓库实体会被删除,无需忽略。
  const ignorablePaths = skill.sources
    .filter((source) => source.source_type !== 'central-repo')
    .map((source) => source.path)
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`从注册表移除「${skill.name}」？`}
      variant="danger"
      description={`这会彻底删除 skill-switch 对「${skill.name}」的管理记录。执行前会备份权威源码目录（如存在），然后从所有已接管工具中取消部署，并删除权威源码目录、来源记录和 Skill 记录。若仍有未接管的外部订阅，操作会被拒绝。删除后不能一键撤销；备份仅可用于恢复文件内容，原部署关系需要重新建立。`}
      confirmLabel="从注册表移除"
      onConfirm={() => onConfirm(ignorablePaths.length > 0 && ignoreSources)}
      busy={busy}
      closeOnOverlay={false}
    >
      {ignorablePaths.length > 0 && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={ignoreSources}
              onChange={(event) => setIgnoreSources(event.target.checked)}
            />
            忽略这些来源目录，扫描不再登记
          </label>
          <ul className="space-y-0.5 pl-6">
            {ignorablePaths.map((path) => (
              <li key={path} className="font-mono text-2xs text-foreground-muted break-all">{path}</li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  )
}

function ConsolidationOperations({ operations }: { operations: ConsolidationPreview['operations'] }) {
  const operationStyles: Record<ConsolidationPreview['operations'][number]['kind'], { label: string; icon: string; className: string }> = {
    'write-canonical': { label: '写入权威源码库', icon: '✦', className: 'text-primary' },
    'archive-candidate': { label: '永久归档候选来源', icon: '▸', className: 'text-foreground-muted' },
    'remove-observed-entry': { label: '移除外部订阅入口', icon: '✕', className: 'text-warning' },
    'redirect-deployment': { label: '重定向部署链接', icon: '↻', className: 'text-primary' },
    'redeploy-copy': { label: '重新部署副本', icon: '↻', className: 'text-primary' }
  }
  type Operation = ConsolidationPreview['operations'][number]
  const groups: Array<{ skillId: number; skillName: string; operations: Operation[] }> = []
  for (const operation of operations) {
    let group = groups.find((candidate) => candidate.skillId === operation.skillId)
    if (!group) {
      group = { skillId: operation.skillId, skillName: operation.skillName, operations: [] }
      groups.push(group)
    }
    group.operations.push(operation)
  }
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {groups.map((group) => (
          <div key={group.skillId} className="rounded-md border border-border overflow-hidden">
            <div className="px-2.5 py-1.5 bg-surface-secondary border-b border-border">
              <span className="text-xs font-semibold text-foreground">{group.skillName}</span>
            </div>
            <div className="p-2 space-y-1.5">
              {group.operations.map((operation, index) => {
                const style = operationStyles[operation.kind]
                return (
                  <div key={`${operation.kind}:${operation.path}:${index}`} className="flex items-start gap-2">
                    <span className={`text-xs leading-4 ${style.className} shrink-0`} aria-hidden>{style.icon}</span>
                    <div className="min-w-0">
                      <p className={`text-2xs font-medium ${style.className}`}>{style.label}</p>
                      <code className="block text-2xs text-foreground-muted break-all">{operation.path}</code>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-warning">归档会永久保留，直到你手动清理归档批次。</p>
      <p className="text-xs text-foreground-secondary">整理只建立权威来源；受管部署会自动重定向，不会新增部署到任何工具。</p>
    </div>
  )
}

export function ConsolidationDialog({
  skill,
  source,
  preview,
  busy,
  onPreview,
  onConfirm,
  onClose
}: {
  skill: SkillView
  source: SkillSourceView
  preview: ConsolidationPreview | null
  busy: boolean
  onPreview: (canonicalRelativeParent: string) => void
  onConfirm: () => void
  onClose: () => void
}) {
  const [canonicalRelativeParent, setCanonicalRelativeParent] = useState('')
  return (
    <Dialog
      open
      onClose={onClose}
      title={preview ? `确认整理「${skill.name}」` : `整理「${skill.name}」`}
      busy={busy}
      confirmLabel={preview ? '确认整理' : '预览整理'}
      onConfirm={preview ? onConfirm : () => onPreview(canonicalRelativeParent)}
      closeOnOverlay={false}
    >
      {preview ? (
        <ConsolidationOperations operations={preview.operations} />
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="canonical-relative-parent" className="block text-xs font-medium text-foreground-secondary">
              权威库内父目录
            </label>
            <Input
              id="canonical-relative-parent"
              aria-label="权威库内父目录"
              value={canonicalRelativeParent}
              onChange={(event) => setCanonicalRelativeParent(event.target.value)}
              placeholder="留空表示权威库根目录"
              mono
              className="w-full"
            />
          </div>
          <p className="text-2xs text-foreground-muted">
            这里只填写权威库内的相对父目录；Skill 名称会自动保留。
          </p>
        </div>
      )}
    </Dialog>
  )
}

export function BatchConsolidationDialog({
  drafts,
  preview,
  busy,
  onApplyBatchParent,
  onToggleDraft,
  onDraftParentChange,
  onResolveConflict,
  onPreview,
  onConfirm,
  onClose
}: {
  drafts: ConsolidationDraft[]
  preview: ConsolidationBatchPreview | null
  busy: boolean
  onApplyBatchParent: (parent: string) => void
  onToggleDraft: (skillId: number, selected: boolean) => void
  onDraftParentChange: (skillId: number, parent: string) => void
  onResolveConflict: (draft: ConsolidationDraft) => void
  onPreview: () => void
  onConfirm: () => void
  onClose: () => void
}) {
  const [batchRelativeParent, setBatchRelativeParent] = useState('')
  return (
    <Dialog
      open
      onClose={onClose}
      title={preview ? '确认批量整理' : '选择要整理的 Skill'}
      description="无冲突项默认选中；冲突项需在冲突解决流程中明确版本后才能选择。"
      busy={busy}
      confirmLabel={preview ? '确认批量整理' : '预览批量整理'}
      onConfirm={preview ? onConfirm : onPreview}
      closeOnOverlay={false}
    >
      {preview ? (
        <ConsolidationOperations operations={preview.operations} />
      ) : (
        <div className="space-y-3">
          <div className="rounded border border-border p-3 space-y-2">
            <label htmlFor="batch-relative-parent" className="block text-xs font-medium text-foreground-secondary">
              批量设置权威库内父目录
            </label>
            <div className="flex gap-2">
              <Input
                id="batch-relative-parent"
                aria-label="批量设置权威库内父目录"
                value={batchRelativeParent}
                onChange={(event) => setBatchRelativeParent(event.target.value)}
                placeholder="留空表示权威库根目录"
                mono
                className="flex-1"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onApplyBatchParent(batchRelativeParent)}
              >
                应用到已选
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            {drafts.map((draft) => (
              <div key={draft.skillId} className="rounded border border-border p-3 space-y-2">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${draft.skillName}`}
                    checked={draft.selected}
                    disabled={draft.hasConflict && !draft.conflictResolution}
                    onChange={(event) => onToggleDraft(draft.skillId, event.target.checked)}
                  />
                  <span>{draft.skillName}</span>
                  <span className="text-2xs text-foreground-muted">
                    {draft.hasConflict
                      ? draft.conflictResolution ? '冲突已解决' : `${draft.versions.length} 个冲突版本（未选择）`
                      : `${draft.versions[0].candidateSourceIds.length} 个同内容来源`}
                  </span>
                </label>
                {draft.hasConflict && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onResolveConflict(draft)}
                    aria-label={`解决 ${draft.skillName} 的版本冲突`}
                  >
                    {draft.conflictResolution ? '修改冲突决策' : '解决冲突'}
                  </Button>
                )}
                <Input
                  aria-label={`${draft.skillName} 权威库内父目录`}
                  value={draft.canonicalRelativeParent}
                  disabled={!draft.selected}
                  onChange={(event) => onDraftParentChange(draft.skillId, event.target.value)}
                  placeholder="权威库根目录"
                  mono
                  className="w-full"
                />
              </div>
            ))}
          </div>
          <p className="text-2xs text-foreground-muted">最终目录名固定使用 Skill 名称；未选 Candidate 不会被本批次修改。</p>
        </div>
      )}
    </Dialog>
  )
}

export function ConflictResolutionDialog({
  editor,
  busy,
  onEditorChange,
  onApply,
  onClose
}: {
  editor: ConflictResolutionEditor
  busy: boolean
  onEditorChange: (updater: (editor: ConflictResolutionEditor) => ConflictResolutionEditor) => void
  onApply: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`解决「${editor.preview.skillName}」的版本冲突`}
      description="不会自动选版或合并；请明确原名权威版本，并处理每个其他版本。"
      busy={busy}
      confirmLabel="应用冲突决策"
      onConfirm={onApply}
      closeOnOverlay={false}
    >
      <div className="space-y-4">
        {editor.preview.versions.map((version, index) => {
          const label = 'ABCDEFGH'[index] ?? String(index + 1)
          const selectedVersion = version.sources.some((source) => source.id === editor.authoritativeSourceId)
          const action = editor.actions[version.hash]
          return (
            <section key={version.hash} className="rounded border border-border p-3 space-y-2">
              <label className="flex items-center gap-2 text-xs font-medium">
                <input
                  type="radio"
                  name="authoritative-conflict-version"
                  aria-label={`选择版本 ${label} 作为原名权威版本`}
                  checked={selectedVersion}
                  onChange={() => onEditorChange((prev) => ({ ...prev, authoritativeSourceId: version.sources[0].id }))}
                />
                <span>版本 {label}</span>
                <code className="text-2xs text-foreground-muted">{shortHash(version.hash)}</code>
              </label>
              <div className="space-y-1">
                {version.sources.map((source) => (
                  <div key={source.id} className="rounded bg-surface-secondary p-2">
                    <code className="block text-2xs break-all">{source.path}</code>
                    <span className="text-2xs text-foreground-muted">
                      来源：{source.sourceOrigin}{source.sourceTool ? ` · ${source.sourceTool}` : ''}
                    </span>
                    {source.sourceRootId !== null && (
                      <span className="block text-2xs text-foreground-muted">Source Root：{source.sourceRootId}</span>
                    )}
                    <span className="block text-2xs text-foreground-muted">发现时间：{source.discoveredAt}</span>
                    {source.repoUrl && (
                      <span className="block text-2xs text-foreground-muted break-all">
                        仓库：{source.repoUrl}{source.commitSha ? ` @ ${source.commitSha}` : ''}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div>
                <p className="text-2xs font-medium text-foreground-secondary mb-1">SKILL.md</p>
                <pre className="max-h-32 overflow-auto rounded bg-surface-secondary p-2 text-2xs whitespace-pre-wrap">{version.skillMd || '（无 SKILL.md）'}</pre>
              </div>
              {editor.authoritativeSourceId !== null && !selectedVersion && action && (
                <div className="space-y-2 border-t border-border-subtle pt-2">
                  <label className="block text-2xs text-foreground-secondary">
                    处理方式
                    <select
                      aria-label={`版本 ${label} 的处理方式`}
                      value={action.action}
                      onChange={(event) => onEditorChange((prev) => ({
                        ...prev,
                        actions: { ...prev.actions, [version.hash]: { ...action, action: event.target.value as 'archive' | 'save-as' } }
                      }))}
                      className="mt-1 h-8 w-full rounded border border-border bg-surface px-2 text-xs"
                    >
                      <option value="archive">仅归档原版本</option>
                      <option value="save-as">另存为新 Skill</option>
                    </select>
                  </label>
                  {action.action === 'save-as' && (
                    <>
                      <Input
                        aria-label={`版本 ${label} 的新 Skill 名称`}
                        value={action.newSkillName}
                        onChange={(event) => onEditorChange((prev) => ({
                          ...prev,
                          actions: { ...prev.actions, [version.hash]: { ...action, newSkillName: event.target.value } }
                        }))}
                        placeholder="新名称也将成为目录名"
                        className="w-full"
                      />
                      <Input
                        aria-label={`版本 ${label} 的权威库内父目录`}
                        value={action.canonicalRelativeParent}
                        onChange={(event) => onEditorChange((prev) => ({
                          ...prev,
                          actions: { ...prev.actions, [version.hash]: { ...action, canonicalRelativeParent: event.target.value } }
                        }))}
                        placeholder="留空表示权威库根目录"
                        mono
                        className="w-full"
                      />
                    </>
                  )}
                </div>
              )}
            </section>
          )
        })}
        <section className="space-y-2">
          <h4 className="text-xs font-medium">文件差异</h4>
          {editor.preview.comparisons.map((comparison) => {
            const leftIndex = editor.preview.versions.findIndex((version) => version.hash === comparison.leftHash)
            const rightIndex = editor.preview.versions.findIndex((version) => version.hash === comparison.rightHash)
            const leftLabel = 'ABCDEFGH'[leftIndex] ?? String(leftIndex + 1)
            const rightLabel = 'ABCDEFGH'[rightIndex] ?? String(rightIndex + 1)
            return (
              <div key={`${comparison.leftHash}-${comparison.rightHash}`} className="rounded border border-border p-2 space-y-2">
                <p className="text-2xs font-medium">版本 {leftLabel} 与版本 {rightLabel}</p>
                <p className="text-2xs text-foreground-muted font-mono break-all">
                  {comparison.leftHash} ↔ {comparison.rightHash}
                </p>
                {comparison.files.map((file) => (
                  <div key={file.path} className="rounded border border-border-subtle p-2">
                    <div className="flex items-center gap-2 text-2xs">
                      <code>{file.path}</code>
                      <span className="text-foreground-muted">{conflictFileStatusLabel(file.status)}</span>
                    </div>
                    {file.textDiff && <pre className="mt-1 overflow-auto whitespace-pre-wrap text-2xs bg-surface-secondary p-2 rounded">{file.textDiff}</pre>}
                  </div>
                ))}
              </div>
            )
          })}
        </section>
      </div>
    </Dialog>
  )
}

export function UndoConsolidationDialog({
  undoBatch,
  busy,
  onConfirm,
  onClose
}: {
  undoBatch: UndoBatch
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`撤销整理「${undoBatch.item.skillName}」`}
      description="将尝试恢复原候选来源并移除本次写入的权威来源；若恢复位置已被占用，操作会被拒绝。"
      busy={busy}
      confirmLabel="确认撤销"
      onConfirm={onConfirm}
      closeOnOverlay={false}
    />
  )
}

export function SourceRelocationDialog({
  skill,
  source,
  preview,
  busy,
  onPreview,
  onConfirm,
  onClose
}: {
  skill: SkillView
  source: SkillSourceView
  preview: SourceRelocationPreview | null
  busy: boolean
  onPreview: (canonicalRelativeParent: string) => void
  onConfirm: () => void
  onClose: () => void
}) {
  const [relocationRelativeParent, setRelocationRelativeParent] = useState('')
  return (
    <Dialog
      open
      onClose={onClose}
      title={preview ? `确认移动「${skill.name}」` : `移动权威 Source「${skill.name}」`}
      description="只改变权威库内的位置；Skill 名称和内容保持不变。"
      busy={busy}
      confirmLabel={preview ? '确认移动' : '预览移动'}
      onConfirm={preview ? onConfirm : () => onPreview(relocationRelativeParent)}
      closeOnOverlay={false}
    >
      {preview ? (
        <div className="space-y-3 text-xs">
          <div><p className="text-foreground-muted">旧位置</p><code className="break-all">{preview.oldCanonicalPath}</code></div>
          <div><p className="text-foreground-muted">新位置</p><code className="break-all">{preview.newCanonicalPath}</code></div>
          <div>
            <p className="font-medium">受影响部署（{preview.deployments.length}）</p>
            {preview.deployments.map((deployment) => (
              <div key={deployment.deploymentId} className="mt-1 rounded border border-border p-2">
                <span>{deployment.targetTool} · {deployment.mode}</span>
                <code className="block text-2xs break-all text-foreground-muted">{deployment.targetPath}</code>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <label htmlFor="relocation-relative-parent" className="block text-xs font-medium text-foreground-secondary">新的权威库内父目录</label>
          <Input id="relocation-relative-parent" aria-label="新的权威库内父目录" value={relocationRelativeParent}
            onChange={(event) => setRelocationRelativeParent(event.target.value)} placeholder="例如 team/backend" mono className="w-full" />
        </div>
      )}
    </Dialog>
  )
}

export function UndoRelocationDialog({
  relocation,
  busy,
  onConfirm,
  onClose
}: {
  relocation: SourceRelocation
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`撤销 Source 移动「${relocation.skillName}」`}
      description="仅当旧位置空闲、权威内容未变化且没有新增外部订阅时才能撤销。"
      busy={busy}
      confirmLabel="确认撤销移动"
      onConfirm={onConfirm}
      closeOnOverlay={false}
    />
  )
}
