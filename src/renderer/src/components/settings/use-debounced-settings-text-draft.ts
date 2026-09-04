import { useCallback, useEffect, useRef, useState } from 'react'

// Matches the repository-hook script draft, the established debounce for settings text in this pane.
const SETTINGS_TEXT_COMMIT_DEBOUNCE_MS = 700

export type DebouncedSettingsTextDraft = {
  value: string
  onChange: (next: string) => void
  onBlur: () => void
}

/**
 * Local draft for a free-text setting, committed on a debounce and flushed on blur and unmount.
 *
 * Why: binding an `<Input>` straight to `updateSettings` sends one IPC round trip per keystroke,
 * and each one replaces the `settings` object identity in every other window, re-rendering every
 * component subscribed to it. The committed value is unchanged — only the number of commits is.
 */
export function useDebouncedSettingsTextDraft(args: {
  value: string
  commit: (next: string) => void
}): DebouncedSettingsTextDraft {
  const { value, commit } = args
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(draft)
  const dirtyRef = useRef(false)
  const commitRef = useRef(commit)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  commitRef.current = commit

  // Why gated on dirty: an external write (another window, a reset) should land in the field, but
  // must not yank characters out from under someone mid-edit.
  useEffect(() => {
    if (dirtyRef.current) {
      return
    }
    draftRef.current = value
    setDraft(value)
  }, [value])

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!dirtyRef.current) {
      return
    }
    dirtyRef.current = false
    commitRef.current(draftRef.current)
  }, [])

  const onChange = useCallback(
    (next: string) => {
      draftRef.current = next
      dirtyRef.current = true
      setDraft(next)
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
      timerRef.current = setTimeout(flush, SETTINGS_TEXT_COMMIT_DEBOUNCE_MS)
    },
    [flush]
  )

  // Why on unmount too: closing the pane mid-word must persist the same value typing it would have.
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => {
    return () => {
      flushRef.current()
    }
  }, [])

  return { value: draft, onChange, onBlur: flush }
}
