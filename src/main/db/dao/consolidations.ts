import type { DB } from '../database'

/** Persist the registry identity and verified canonical hash produced by a committed item. */
export function markConsolidationItemRegistryCommitted(
  db: DB,
  itemId: number,
  skillId: number,
  canonicalHash: string
): void {
  db.prepare("UPDATE consolidation_items SET skill_id = ?, canonical_hash = ?, phase = 'db-committed' WHERE id = ?")
    .run(skillId, canonicalHash, itemId)
}
