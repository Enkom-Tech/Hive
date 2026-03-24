/**
 * Deterministic pool mobility: eligible drone ids are ordered (e.g. by internal id asc);
 * rotation advances circularly. If the current binding is not in the eligible set (e.g. drain),
 * the first eligible id is chosen.
 */
export function pickNextCircularId(sortedIds: string[], current: string | null): string | null {
  if (sortedIds.length === 0) return null;
  if (current == null) return sortedIds[0]!;
  const idx = sortedIds.indexOf(current);
  if (idx === -1) return sortedIds[0]!;
  return sortedIds[(idx + 1) % sortedIds.length]!;
}
