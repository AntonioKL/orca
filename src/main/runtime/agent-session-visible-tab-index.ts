export function parseVisibleSessionIds(
  raw: unknown,
  schemaVersion: number,
  currentSchemaVersion: number
): { ids: string[]; valid: boolean } {
  if (raw === undefined) {
    return { ids: [], valid: true }
  }
  if (!Array.isArray(raw)) {
    return { ids: [], valid: schemaVersion !== currentSchemaVersion }
  }
  const ids: string[] = []
  for (const value of raw) {
    if (typeof value === 'string' && value.length > 0) {
      ids.push(value)
    } else if (schemaVersion === currentSchemaVersion) {
      return { ids: [], valid: false }
    }
  }
  return { ids, valid: true }
}
