// 把 sources 按 hash 分组,用于冲突检测与"多版本"提示。
// 之前 ConflictDialog 与 SourcePanel 各自重复实现,见 #58。
export function groupByHash<T extends { hash: string }>(sources: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const s of sources) {
    const arr = groups.get(s.hash) ?? []
    arr.push(s)
    groups.set(s.hash, arr)
  }
  return groups
}
