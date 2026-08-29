export type BufferedTerminalDraftValue = string | ((current: string) => string)
export type BufferedTerminalDraftRestorationToken = object

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

export function beginBufferedTerminalDraftRestoration(
  pendingRestorations: Map<string, BufferedTerminalDraftRestorationToken>,
  handle: string
): BufferedTerminalDraftRestorationToken {
  const token = {}
  pendingRestorations.set(handle, token)
  return token
}

export function invalidateBufferedTerminalDraftRestoration(
  pendingRestorations: Map<string, BufferedTerminalDraftRestorationToken>,
  handle: string
): void {
  pendingRestorations.delete(handle)
}

export function settleBufferedTerminalDraftRestoration(
  pendingRestorations: Map<string, BufferedTerminalDraftRestorationToken>,
  handle: string,
  token: BufferedTerminalDraftRestorationToken
): boolean {
  if (pendingRestorations.get(handle) !== token) {
    return false
  }
  pendingRestorations.delete(handle)
  return true
}

/** Restore a rejected send without overwriting text composed while its RPC was in flight. */
export function restoreRejectedBufferedTerminalDraft(
  currentDrafts: Record<string, string>,
  originHandle: string,
  rejectedDraft: string
): Record<string, string> {
  if ((currentDrafts[originHandle] ?? '').length > 0) {
    return currentDrafts
  }
  return updateBufferedTerminalDraft(currentDrafts, originHandle, rejectedDraft)
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

export function pruneBufferedTerminalDraftRestorations(
  pendingRestorations: Map<string, BufferedTerminalDraftRestorationToken>,
  retainedHandles: ReadonlySet<string>
): void {
  for (const handle of pendingRestorations.keys()) {
    if (!retainedHandles.has(handle)) {
      pendingRestorations.delete(handle)
    }
  }
}
