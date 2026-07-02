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

// hash 短码,用于组标题与弹窗中的版本标识显示。默认取前 8 位。
export function shortHash(hash: string, len = 8): string {
  return hash.slice(0, len)
}

// 给定来源列表与某条 sourcePath,返回该来源所属的版本组信息(组内来源数、hash)。
// 用于部署弹窗展示"当前 sourcePath 属于哪个版本组"。找不到返回 null。
export function findSourceGroup<T extends { hash: string; path: string }>(
  sources: readonly T[],
  sourcePath: string
): { hash: string; count: number } | null {
  const target = sources.find((s) => s.path === sourcePath)
  if (!target) return null
  let count = 0
  for (const s of sources) {
    if (s.hash === target.hash) count++
  }
  return { hash: target.hash, count }
}
