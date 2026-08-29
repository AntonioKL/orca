export type BufferedTerminalDraftValue = string | ((current: string) => string)

export function updateBufferedTerminalDraft(
  currentDrafts: Record<string, string>,
  handle: string | null,
  value: BufferedTerminalDraftValue
): Record<string, string> {
  if (!handle) {
    return currentDrafts
  }
  const current = currentDrafts[handle] ?? ''
  const next = typeof value === 'function' ? value(current) : value
  return next === current ? currentDrafts : { ...currentDrafts, [handle]: next }
}

/** Restore a rejected send without overwriting text composed while its RPC was in flight. */
export function restoreRejectedBufferedTerminalDraft(
  currentDrafts: Record<string, string>,
  originHandle: string,
  rejectedDraft: string
): Record<string, string> {
  return (currentDrafts[originHandle] ?? '').length === 0
    ? { ...currentDrafts, [originHandle]: rejectedDraft }
    : currentDrafts
}

export function pruneBufferedTerminalDrafts(
  currentDrafts: Record<string, string>,
  retainedHandles: ReadonlySet<string>
): Record<string, string> {
  let next = currentDrafts
  for (const handle of Object.keys(currentDrafts)) {
    if (retainedHandles.has(handle)) {
      continue
    }
    if (next === currentDrafts) {
      next = { ...currentDrafts }
    }
    delete next[handle]
  }
  return next
}
