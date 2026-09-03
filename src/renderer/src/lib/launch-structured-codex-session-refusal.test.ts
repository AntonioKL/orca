import { describe, expect, it, vi } from 'vitest'
import { isThrownStructuredRefusal } from './launch-structured-codex-session'

describe('isThrownStructuredRefusal', () => {
  it('recognises the unsupported-location sentinel the host throws', () => {
    expect(isThrownStructuredRefusal(new Error('structured_agent_session_unsupported'))).toBe(true)
  })

  it('recognises it when the transport prefixes the message', () => {
    expect(
      isThrownStructuredRefusal(new Error('rpc error: structured_agent_session_unsupported'))
    ).toBe(true)
  })

  it('recognises a runtime that needs repair', () => {
    expect(
      isThrownStructuredRefusal(new Error('Project runtime requires repair: wsl-distro-missing'))
    ).toBe(true)
  })

  it('does NOT swallow an unrelated failure', () => {
    expect(isThrownStructuredRefusal(new Error('ECONNRESET'))).toBe(false)
    expect(isThrownStructuredRefusal(Object.assign(new Error('x'), { message: '' }))).toBe(false)
    expect(isThrownStructuredRefusal('not an error')).toBe(false)
    expect(isThrownStructuredRefusal(undefined)).toBe(false)
  })
})

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async () => {
    throw new Error('structured_agent_session_unsupported')
  })
}))

describe('launchStructuredCodexSession', () => {
  // Without the mapping the host's throw arrives as a generic RPC rejection and
  // every caller's legacy-terminal fallback (which keys on the refusal class)
  // silently fails to engage, stranding the launch.
  it('converts a thrown host refusal into the refusal class callers key on', async () => {
    const { launchStructuredCodexSession, StructuredAgentSessionCreateRefusalError } =
      await import('./launch-structured-codex-session')
    await expect(
      launchStructuredCodexSession({
        sessionId: 's1',
        worktreeId: 'folder:f1',
        params: {} as never
      } as never)
    ).rejects.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
  })
})
