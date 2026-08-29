import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

function routeSlice(anchorStart: string, anchorEnd: string): string {
  const start = sessionRouteSource.indexOf(anchorStart)
  expect(start).toBeGreaterThanOrEqual(0)
  // Why: a duplicated start anchor would silently slice the wrong region.
  expect(sessionRouteSource.indexOf(anchorStart, start + 1)).toBe(-1)
  const end = sessionRouteSource.indexOf(anchorEnd, start)
  expect(end).toBeGreaterThan(start)
  return sessionRouteSource.slice(start, end + anchorEnd.length)
}

describe('terminal send keyboard dismissal wiring', () => {
  it('gates the dismissal on the agent-session predicate', () => {
    const slice = routeSlice(
      'const dismissKeyboardAfterAgentSend = useCallback(',
      '[dismissSoftwareKeyboard, getSendCompletionGeneration]\n  )'
    )
    expect(slice).toContain('shouldDismissKeyboardAfterTerminalSend(origin.tab, accepted)')
    expect(slice).toContain('origin.generation === getSendCompletionGeneration()')
    expect(slice).toContain('dismissSoftwareKeyboard()')
    expect(sessionRouteSource).toContain(
      "import { shouldDismissKeyboardAfterTerminalSend } from '../../../../src/session/agent-send-keyboard-dismissal'"
    )
  })

  it('invalidates pending terminal sends when the focused input surface changes', () => {
    const slice = routeSlice(
      'const getSendCompletionGeneration = useMobileSendCompletionGeneration({',
      '})'
    )
    expect(slice).toContain(
      'surfaceKey: JSON.stringify([activeSessionTabId, activeHandle, showNativeChat, liveInputEnabled])'
    )
  })

  it('dismisses after the live input submits, which is the only Enter path', () => {
    // terminal-live-input.ts deliberately keeps Enter off the key map, so
    // onSubmitEditing is the single send seam for the live field.
    const slice = routeSlice('ref={liveInputRef}', 'importantForAutofill="no"')
    expect(slice).toContain('generation: getSendCompletionGeneration()')
    expect(slice).toContain('dismissKeyboardAfterAgentSend(sendOrigin, accepted)')
    // Explicit dismissal replaces RN's blur, which stays off so a shell send
    // does not drop focus.
    expect(slice).toContain('blurOnSubmit={false}')
  })

  it('dismisses the buffered command send only once the write is accepted', () => {
    const slice = routeSlice('async function handleSend() {', 'async function handleAccessoryKey(')
    const acceptedAt = slice.indexOf('const accepted = isTerminalSendRpcAccepted(response)')
    const restoreAt = slice.indexOf('restoreRejectedDraft()', acceptedAt)
    const dismissAt = slice.indexOf('dismissKeyboardAfterAgentSend(sendOrigin, accepted)')
    const responseAt = slice.indexOf('const response = await client.sendRequest(')
    const catchAt = slice.indexOf('} catch {')
    expect(dismissAt).toBeGreaterThan(0)
    expect(responseAt).toBeGreaterThan(0)
    expect(acceptedAt).toBeGreaterThan(responseAt)
    expect(restoreAt).toBeGreaterThan(acceptedAt)
    expect(dismissAt).toBeGreaterThan(responseAt)
    expect(catchAt).toBeGreaterThan(0)
    // Both resolved rejections and transport failures restore the raw draft.
    expect(dismissAt).toBeLessThan(catchAt)
    expect(slice.slice(catchAt)).not.toContain('dismissKeyboardAfterAgentSend(')
    expect(slice.slice(catchAt)).toContain('restoreRejectedDraft()')
  })

  it('restores a rejected buffered draft by origin without generation fencing', () => {
    const sendSlice = routeSlice(
      'async function handleSend() {',
      'async function handleAccessoryKey('
    )
    const originAt = sendSlice.indexOf('handle: activeHandle')
    const requestAt = sendSlice.indexOf('await client.sendRequest(')
    const restoreSlice = routeSlice('const restoreRejectedDraft = () =>', "setInput('')")
    expect(originAt).toBeGreaterThan(0)
    expect(originAt).toBeLessThan(requestAt)
    expect(restoreSlice).toContain(
      'restoreRejectedBufferedTerminalDraft(current, sendOrigin.handle, draft)'
    )
    expect(restoreSlice).not.toContain('getSendCompletionGeneration()')
    expect(sendSlice.match(/restoreRejectedDraft\(\)/g)).toHaveLength(2)
    const dismissalSlice = routeSlice(
      'const dismissKeyboardAfterAgentSend = useCallback(',
      '[dismissSoftwareKeyboard, getSendCompletionGeneration]\n  )'
    )
    expect(dismissalSlice).toContain('origin.generation === getSendCompletionGeneration()')
  })

  it('keeps buffered draft callbacks scoped to the active handle and prunes ended handles', () => {
    const draftSlice = routeSlice(
      'const input = activeHandle',
      '// Reactive teardown signal for the native-chat covered stream'
    )
    expect(draftSlice).toContain('const setInput = useCallback(')
    expect(draftSlice).toContain('updateBufferedTerminalDraft(previous, activeHandle, value)')
    expect(draftSlice).toContain('[activeHandle]')
    expect(sessionRouteSource).toContain(
      'setBufferedTerminalDrafts((drafts) => pruneBufferedDrafts(drafts, retainedHandles))'
    )
  })

  it('leaves the accessory shortcut keys alone, Enter included', () => {
    // Why: the accessory bar sits on top of the keyboard — dismissing would
    // pull away the very row the user is tapping.
    const slice = routeSlice(
      'async function handleAccessoryKey(',
      'const sendLiveTerminalInput = useCallback('
    )
    expect(slice).not.toContain('dismissKeyboardAfterAgentSend')
  })
})
