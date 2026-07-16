import { useState, useCallback } from 'react'
import type {
  SkillView,
  SkillSourceView,
  ConsolidationPreview,
  ConsolidationBatchPreview,
  ConsolidationBatch,
  ConsolidationPlanItem,
  ConflictResolutionDecision,
  ConsolidationDraft,
  ConflictResolutionEditor,
  UndoBatch,
  SourceRelocationPreview,
  SourceRelocation,
} from './dialogs'

type SkillLibraryView = Awaited<ReturnType<typeof window.api.getSkillLibrary>>

/** 四个 flow hook 共享的依赖:全局 busy 锁、刷新回调与 toast。 */
interface FlowDeps {
  actionBusy: boolean
  setActionBusy: (busy: boolean) => void
  onRefresh: () => Promise<void>
  success: (msg: string) => void
  toastError: (msg: string) => void
}

/** busy-guard 包裹器,消除跨 hook 的重复 try/catch/finally 模式。 */
async function withBusy<T>(deps: FlowDeps, fn: () => Promise<T>): Promise<T | undefined> {
  deps.setActionBusy(true)
  try {
    return await fn()
  } catch (e) {
    deps.toastError(e instanceof Error ? e.message : String(e))
    return undefined
  } finally {
    deps.setActionBusy(false)
  }
}

// ---------------------------------------------------------------------------
// useConsolidationFlow — 单 Skill 整理 + 撤销
// ---------------------------------------------------------------------------

interface ConsolidationState {
  target: { skill: SkillView; source: SkillSourceView }
  preview: ConsolidationPreview | null
}

export function useConsolidationFlow(
  deps: FlowDeps,
  refreshLibrary: () => Promise<SkillLibraryView>
) {
  // target + preview 打包为单个 state 对象,消除 Data Clumps
  const [state, setState] = useState<ConsolidationState | null>(null)
  const [batches, setBatches] = useState<ConsolidationBatch[]>([])
  const [undoBatch, setUndoBatch] = useState<UndoBatch | null>(null)

  const target = state?.target ?? null
  const preview = state?.preview ?? null

  const open = useCallback((skill: SkillView, source: SkillSourceView) => {
    setState({ target: { skill, source }, preview: null })
  }, [])

  const close = useCallback(() => {
    if (deps.actionBusy) return
    setState(null)
  }, [deps.actionBusy])

  const handlePreview = useCallback(async (canonicalRelativeParent: string) => {
    if (!state) return
    await withBusy(deps, async () => {
      const p = await window.api.previewConsolidation({
        candidateSourceId: state.target.source.id,
        canonicalRelativeParent: canonicalRelativeParent.trim()
      })
      setState((prev) => prev ? { ...prev, preview: p } : null)
    })
  }, [state, deps])

  const handleConfirm = useCallback(async () => {
    if (!state?.preview) return
    await withBusy(deps, async () => {
      const outcome = await window.api.confirmConsolidation(state.preview!.confirmationId)
      if (outcome.status !== 'completed') {
        deps.toastError('message' in outcome ? outcome.message : '整理未完成，请刷新后重试。')
        return
      }
      deps.success(`「${state.preview!.skillName}」整理完成；请按需手动部署`)
      setState(null)
      await Promise.all([refreshLibrary(), deps.onRefresh()])
    })
  }, [state, deps, refreshLibrary])

  const handleUndo = useCallback(async () => {
    if (!undoBatch) return
    await withBusy(deps, async () => {
      const outcome = await window.api.undoConsolidation(undoBatch.batch.id)
      if (outcome.status !== 'undone') {
        deps.toastError('message' in outcome ? outcome.message : '撤销未完成，请刷新后重试。')
        return
      }
      deps.success(`已撤销「${undoBatch.item.skillName}」的整理`)
      setUndoBatch(null)
      await Promise.all([refreshLibrary(), deps.onRefresh()])
    })
  }, [undoBatch, deps, refreshLibrary])

  const applyLibrary = useCallback((library: SkillLibraryView) => {
    setBatches(library.consolidationBatches ?? [])
  }, [])

  return {
    target, preview, batches, undoBatch,
    open, close, handlePreview, handleConfirm, handleUndo,
    setUndoBatch, applyLibrary,
  }
}

// ---------------------------------------------------------------------------
// useBatchConsolidationFlow — 批量整理
// ---------------------------------------------------------------------------

interface BatchConsolidationState {
  drafts: ConsolidationDraft[]
  preview: ConsolidationBatchPreview | null
}

export function useBatchConsolidationFlow(
  deps: FlowDeps,
  refreshLibrary: () => Promise<SkillLibraryView>
) {
  const [plan, setPlan] = useState<ConsolidationPlanItem[]>([])
  // drafts + preview 打包为单个 state 对象,消除 Data Clumps
  const [state, setState] = useState<BatchConsolidationState | null>(null)

  const drafts = state?.drafts ?? null
  const preview = state?.preview ?? null

  const open = useCallback(() => {
    setState({
      drafts: plan.map((item) => ({
        ...item,
        selected: item.selectedByDefault,
        canonicalRelativeParent: item.canonicalRelativeParent
      })),
      preview: null
    })
  }, [plan])

  const close = useCallback(() => {
    if (deps.actionBusy) return
    setState(null)
  }, [deps.actionBusy])

  const applyBatchParent = useCallback((parent: string) => {
    setState((prev) => prev ? {
      ...prev,
      drafts: prev.drafts.map((draft) =>
        draft.selected ? { ...draft, canonicalRelativeParent: parent } : draft
      )
    } : null)
  }, [])

  const toggleDraft = useCallback((skillId: number, selected: boolean) => {
    setState((prev) => prev ? {
      ...prev,
      drafts: prev.drafts.map((item) =>
        item.skillId === skillId ? { ...item, selected } : item
      )
    } : null)
  }, [])

  const draftParentChange = useCallback((skillId: number, parent: string) => {
    setState((prev) => prev ? {
      ...prev,
      drafts: prev.drafts.map((item) =>
        item.skillId === skillId ? { ...item, canonicalRelativeParent: parent } : item
      )
    } : null)
  }, [])

  /** 冲突解决后更新对应 draft (#95 hook 间通信) */
  const updateDraft = useCallback((skillId: number, patch: Partial<ConsolidationDraft>) => {
    setState((prev) => prev ? {
      ...prev,
      drafts: prev.drafts.map((item) =>
        item.skillId === skillId ? { ...item, ...patch } : item
      )
    } : null)
  }, [])

  const handlePreview = useCallback(async () => {
    if (!state) return
    const selectedDrafts = state.drafts.filter((draft) => draft.selected)
    if (selectedDrafts.length === 0) {
      deps.toastError('请至少选择一个无冲突 Skill')
      return
    }
    await withBusy(deps, async () => {
      const p = await window.api.previewConsolidationBatch({
        items: selectedDrafts.map((draft) => ({
          candidateSourceId: draft.conflictResolution?.authoritativeSourceId ?? draft.versions[0].candidateSourceIds[0],
          canonicalRelativeParent: draft.canonicalRelativeParent.trim(),
          ...(draft.conflictResolution ? { conflictResolution: draft.conflictResolution } : {})
        }))
      })
      setState((prev) => prev ? { ...prev, preview: p } : null)
    })
  }, [state, deps])

  const handleConfirm = useCallback(async () => {
    if (!state?.preview) return
    await withBusy(deps, async () => {
      const outcome = await window.api.confirmConsolidation(state.preview!.confirmationId)
      if (outcome.status !== 'completed') {
        deps.toastError('message' in outcome ? outcome.message : '整理未完成，请刷新后重试。')
        return
      }
      deps.success(`已整理 ${state.preview!.items.length} 个 Skill；请按需手动部署`)
      setState(null)
      await Promise.all([refreshLibrary(), deps.onRefresh()])
    })
  }, [state, deps, refreshLibrary])

  const applyLibrary = useCallback((library: SkillLibraryView) => {
    setPlan(library.consolidationPlan ?? [])
  }, [])

  return {
    plan, drafts, preview,
    open, close, applyBatchParent, toggleDraft, draftParentChange, updateDraft,
    handlePreview, handleConfirm, applyLibrary,
  }
}

// ---------------------------------------------------------------------------
// useConflictResolutionFlow — 冲突解决编辑器
// ---------------------------------------------------------------------------

export function useConflictResolutionFlow(
  deps: Pick<FlowDeps, 'actionBusy' | 'setActionBusy' | 'toastError'>,
  skills: SkillView[],
  onApply: (skillId: number, conflictResolution: ConflictResolutionDecision) => void
) {
  const [editor, setEditor] = useState<ConflictResolutionEditor | null>(null)

  const open = useCallback(async (draft: ConsolidationDraft) => {
    await withBusy(deps, async () => {
      const preview = await window.api.previewConflictResolution(draft.skillId)
      setEditor({
        draftSkillId: draft.skillId,
        preview,
        authoritativeSourceId: draft.conflictResolution?.authoritativeSourceId ?? null,
        actions: Object.fromEntries(preview.versions.map((version) => {
          const existing = draft.conflictResolution?.otherVersions.find((decision) =>
            version.sources.some((source) => source.id === decision.sourceId)
          )
          return [version.hash, {
            action: existing?.action ?? 'archive',
            newSkillName: existing?.newSkillName ?? '',
            canonicalRelativeParent: existing?.canonicalRelativeParent ?? ''
          }]
        }))
      })
    })
  }, [deps])

  const apply = useCallback(() => {
    if (!editor?.authoritativeSourceId) {
      deps.toastError('请选择一个版本作为原名权威版本')
      return
    }
    const authoritative = editor.preview.versions.find((version) =>
      version.sources.some((source) => source.id === editor.authoritativeSourceId)
    )
    if (!authoritative) {
      deps.toastError('所选权威版本已不可用')
      return
    }
    const otherVersions: ConflictResolutionDecision['otherVersions'] = []
    const reservedNames = new Set(skills.map((skill) => skill.name))
    for (const version of editor.preview.versions) {
      if (version.hash === authoritative.hash) continue
      const action = editor.actions[version.hash]
      if (!action) {
        deps.toastError('请为每个其他版本选择处理方式')
        return
      }
      const decision: ConflictResolutionDecision['otherVersions'][number] = {
        sourceId: version.sources[0].id,
        action: action.action
      }
      if (action.action === 'save-as') {
        const newName = action.newSkillName.trim()
        if (!newName || newName === '.' || newName === '..' || /[\\/\u0000-\u001f\u007f]/.test(newName)) {
          deps.toastError('新 Skill 名称不合法')
          return
        }
        if (reservedNames.has(newName)) {
          deps.toastError(`新 Skill 名称「${newName}」已存在`)
          return
        }
        reservedNames.add(newName)
        decision.newSkillName = newName
        decision.canonicalRelativeParent = action.canonicalRelativeParent.trim()
      }
      otherVersions.push(decision)
    }
    const conflictResolution: ConflictResolutionDecision = {
      authoritativeSourceId: editor.authoritativeSourceId,
      otherVersions
    }
    onApply(editor.draftSkillId, conflictResolution)
    setEditor(null)
  }, [editor, skills, deps, onApply])

  const close = useCallback(() => {
    if (deps.actionBusy) return
    setEditor(null)
  }, [deps.actionBusy])

  const updateEditor = useCallback((updater: (editor: ConflictResolutionEditor) => ConflictResolutionEditor) => {
    setEditor((prev) => prev ? updater(prev) : null)
  }, [])

  return { editor, open, apply, close, updateEditor }
}

// ---------------------------------------------------------------------------
// useSourceRelocationFlow — Source 移动 + 撤销
// ---------------------------------------------------------------------------

interface RelocationState {
  target: { skill: SkillView; source: SkillSourceView }
  preview: SourceRelocationPreview | null
}

export function useSourceRelocationFlow(
  deps: FlowDeps,
  refreshLibrary: () => Promise<SkillLibraryView>
) {
  // target + preview 打包为单个 state 对象,消除 Data Clumps
  const [state, setState] = useState<RelocationState | null>(null)
  const [relocations, setRelocations] = useState<SourceRelocation[]>([])
  const [undo, setUndo] = useState<SourceRelocation | null>(null)

  const target = state?.target ?? null
  const preview = state?.preview ?? null

  const open = useCallback((skill: SkillView, source: SkillSourceView) => {
    setState({ target: { skill, source }, preview: null })
  }, [])

  const close = useCallback(() => {
    if (deps.actionBusy) return
    setState(null)
  }, [deps.actionBusy])

  const handlePreview = useCallback(async (canonicalRelativeParent: string) => {
    if (!state) return
    await withBusy(deps, async () => {
      const p = await window.api.previewSourceRelocation({
        sourceId: state.target.source.id,
        canonicalRelativeParent: canonicalRelativeParent.trim()
      })
      setState((prev) => prev ? { ...prev, preview: p } : null)
    })
  }, [state, deps])

  const handleConfirm = useCallback(async () => {
    if (!state?.preview) return
    await withBusy(deps, async () => {
      const outcome = await window.api.confirmSourceRelocation(state.preview!.confirmationId)
      if (outcome.status !== 'completed') {
        deps.toastError('message' in outcome ? outcome.message : '移动未完成，请刷新后重试。')
        return
      }
      deps.success(`已移动「${state.preview!.skillName}」的权威 Source`)
      setState(null)
      await Promise.all([refreshLibrary(), deps.onRefresh()])
    })
  }, [state, deps, refreshLibrary])

  const handleUndo = useCallback(async () => {
    if (!undo) return
    await withBusy(deps, async () => {
      const outcome = await window.api.undoSourceRelocation(undo.id)
      if (outcome.status !== 'undone') {
        deps.toastError('message' in outcome ? outcome.message : '撤销移动未完成，请刷新后重试。')
        return
      }
      deps.success(`已撤销「${undo.skillName}」的 Source 移动`)
      setUndo(null)
      await Promise.all([refreshLibrary(), deps.onRefresh()])
    })
  }, [undo, deps, refreshLibrary])

  const applyLibrary = useCallback((library: SkillLibraryView) => {
    setRelocations(library.sourceRelocations ?? [])
  }, [])

  return {
    target, preview, relocations, undo,
    open, close, handlePreview, handleConfirm, handleUndo,
    setUndo, applyLibrary,
  }
}
