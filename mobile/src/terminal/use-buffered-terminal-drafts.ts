import { useCallback, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  type BufferedTerminalDraftRestorationToken,
  type BufferedTerminalDraftValue,
  beginBufferedTerminalDraftRestoration,
  invalidateBufferedTerminalDraftRestoration,
  pruneBufferedTerminalDrafts,
  pruneBufferedTerminalDraftRestorations,
  restoreRejectedBufferedTerminalDraft,
  settleBufferedTerminalDraftRestoration,
  updateBufferedTerminalDraft
} from './buffered-terminal-draft-restoration'

interface BufferedTerminalDraftSend {
  readonly draft: string
  readonly handle: string
  readonly token: BufferedTerminalDraftRestorationToken
}

interface UseBufferedTerminalDraftsOptions {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
}

export function useBufferedTerminalDrafts({
  activeHandle,
  activeHandleRef
}: UseBufferedTerminalDraftsOptions) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const pendingRestorationsRef = useRef<Map<string, BufferedTerminalDraftRestorationToken>>(
    new Map()
  )
  const input = activeHandle ? (drafts[activeHandle] ?? '') : ''

  const setInput = useCallback(
    (value: BufferedTerminalDraftValue) => {
      const handle = activeHandleRef.current
      if (!handle) {
        return
      }
      invalidateBufferedTerminalDraftRestoration(pendingRestorationsRef.current, handle)
      setDrafts((current) => updateBufferedTerminalDraft(current, handle, value))
    },
    [activeHandleRef]
  )

  const beginBufferedTerminalDraftSend = useCallback(
    (handle: string, draft: string): BufferedTerminalDraftSend => {
      const token = beginBufferedTerminalDraftRestoration(pendingRestorationsRef.current, handle)
      setDrafts((current) => updateBufferedTerminalDraft(current, handle, ''))
      return { draft, handle, token }
    },
    []
  )

  const restoreRejectedDraft = useCallback((send: BufferedTerminalDraftSend): void => {
    if (
      !settleBufferedTerminalDraftRestoration(
        pendingRestorationsRef.current,
        send.handle,
        send.token
      )
    ) {
      return
    }
    setDrafts((current) => restoreRejectedBufferedTerminalDraft(current, send.handle, send.draft))
  }, [])

  const settleBufferedTerminalDraftSend = useCallback((send: BufferedTerminalDraftSend): void => {
    settleBufferedTerminalDraftRestoration(pendingRestorationsRef.current, send.handle, send.token)
  }, [])

  const pruneDrafts = useCallback((retainedHandles: ReadonlySet<string>): void => {
    setDrafts((current) => pruneBufferedTerminalDrafts(current, retainedHandles))
    pruneBufferedTerminalDraftRestorations(pendingRestorationsRef.current, retainedHandles)
  }, [])

  const resetDrafts = useCallback((): void => {
    pendingRestorationsRef.current.clear()
    setDrafts((current) => (Object.keys(current).length === 0 ? current : {}))
  }, [])

  const clearPendingRestorations = useCallback((): void => {
    pendingRestorationsRef.current.clear()
  }, [])

  return {
    beginBufferedTerminalDraftSend,
    clearPendingRestorations,
    input,
    pruneDrafts,
    resetDrafts,
    restoreRejectedDraft,
    setInput,
    settleBufferedTerminalDraftSend
  }
}
