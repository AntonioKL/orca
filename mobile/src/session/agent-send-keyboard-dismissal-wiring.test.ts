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
      '[activeSessionTab, dismissSoftwareKeyboard]\n  )'
    )
    expect(slice).toContain('shouldDismissKeyboardAfterTerminalSend(activeSessionTab, accepted)')
    expect(slice).toContain('dismissSoftwareKeyboard()')
    expect(sessionRouteSource).toContain(
      "import { shouldDismissKeyboardAfterTerminalSend } from '../../../../src/session/agent-send-keyboard-dismissal'"
    )
  })

  it('dismisses after the live input submits, which is the only Enter path', () => {
    // terminal-live-input.ts deliberately keeps Enter off the key map, so
    // onSubmitEditing is the single send seam for the live field.
    const slice = routeSlice('ref={liveInputRef}', 'importantForAutofill="no"')
    expect(slice).toContain('handleLiveInputSubmit().then(dismissKeyboardAfterAgentSend)')
    // Explicit dismissal replaces RN's blur, which stays off so a shell send
    // does not drop focus.
    expect(slice).toContain('blurOnSubmit={false}')
  })

  it('dismisses the buffered command send only once the write is accepted', () => {
    const slice = routeSlice('async function handleSend() {', 'async function handleAccessoryKey(')
    const dismissAt = slice.indexOf(
      'dismissKeyboardAfterAgentSend(isTerminalSendRpcAccepted(response))'
    )
    const responseAt = slice.indexOf('const response = await client.sendRequest(')
    const catchAt = slice.indexOf('} catch {')
    expect(dismissAt).toBeGreaterThan(0)
    expect(responseAt).toBeGreaterThan(0)
    expect(dismissAt).toBeGreaterThan(responseAt)
    expect(catchAt).toBeGreaterThan(0)
    // Rejected responses stay focused; transport failures restore the draft in catch.
    expect(dismissAt).toBeLessThan(catchAt)
    expect(slice.slice(catchAt)).not.toContain('dismissKeyboardAfterAgentSend(')
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
