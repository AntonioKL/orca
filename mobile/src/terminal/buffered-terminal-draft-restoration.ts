/** Restore a rejected send without overwriting text composed while its RPC was in flight. */
export function restoreRejectedBufferedTerminalDraft(
  currentDraft: string,
  rejectedDraft: string
): string {
  return currentDraft.length === 0 ? rejectedDraft : currentDraft
}
