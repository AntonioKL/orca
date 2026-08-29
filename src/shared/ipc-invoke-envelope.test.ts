import { describe, expect, it } from 'vitest'
import { stripIpcInvokeEnvelope, stripIpcInvokeEnvelopeFrom } from './ipc-invoke-envelope'

describe('stripIpcInvokeEnvelope', () => {
  it('returns the reason behind the invoke envelope', () => {
    expect(
      stripIpcInvokeEnvelope("Error invoking remote method 'fs:readFile': Error: Access denied")
    ).toBe('Access denied')
  })

  // Why: Electron builds the tail from the main side's `error.toString()`, which has no
  // `Error: ` prefix when the handler rejected with a plain value.
  it('strips an envelope whose tail carries no Error: prefix', () => {
    expect(
      stripIpcInvokeEnvelope("Error invoking remote method 'fs:readFile': Access denied")
    ).toBe('Access denied')
  })

  it('strips an Error subclass name from the tail', () => {
    expect(
      stripIpcInvokeEnvelope("Error invoking remote method 'fs:readFile': TypeError: boom")
    ).toBe('boom')
  })

  // Why: the null branch is what stops a bare class name or an empty toast reaching a user.
  it('returns null when the envelope carried no readable reason', () => {
    expect(stripIpcInvokeEnvelope("Error invoking remote method 'fs:readFile': Error")).toBeNull()
    expect(stripIpcInvokeEnvelope("Error invoking remote method 'fs:readFile': ")).toBeNull()
    expect(stripIpcInvokeEnvelope("Error invoking remote method 'fs:readFile':")).toBeNull()
  })

  // Why: callers prefix the envelope with their own context, so anchoring at ^ would leave
  // the whole wrapper on screen. The caller's prefix is kept; only the wrapper goes.
  it('strips an envelope a caller has prefixed, keeping the prefix', () => {
    expect(
      stripIpcInvokeEnvelope(
        "SSH connection failed: Error invoking remote method 'ssh:connect': Error: relay missing"
      )
    ).toBe('SSH connection failed: relay missing')
  })

  // Why: Electron's `replyWithError` logs this name in main. Covered so a message that has
  // crossed either boundary reads the same.
  it('strips the main-side handler envelope', () => {
    expect(
      stripIpcInvokeEnvelope(
        "Error occurred in handler for 'claudeAccounts:login': Error: Signed out"
      )
    ).toBe('Signed out')
  })

  it('passes through a message that never crossed IPC', () => {
    expect(stripIpcInvokeEnvelope('Access denied')).toBe('Access denied')
  })

  it('is not scoped to any channel', () => {
    expect(
      stripIpcInvokeEnvelope("Error invoking remote method 'codexAccounts:login': Error: nope")
    ).toBe('nope')
    expect(
      stripIpcInvokeEnvelope("Error invoking remote method 'worktrees:remove': Error: nope")
    ).toBe('nope')
  })
})

describe('stripIpcInvokeEnvelopeFrom', () => {
  it('reads an Error message', () => {
    expect(
      stripIpcInvokeEnvelopeFrom(new Error("Error invoking remote method 'x': Error: boom"))
    ).toBe('boom')
  })

  it('reads a rejected non-Error value', () => {
    expect(stripIpcInvokeEnvelopeFrom('boom')).toBe('boom')
  })

  // Why: String(undefined) is "undefined", which is not a reason and must not reach copy.
  it('returns null for a nullish rejection rather than printing "undefined"', () => {
    expect(stripIpcInvokeEnvelopeFrom(undefined)).toBeNull()
    expect(stripIpcInvokeEnvelopeFrom(null)).toBeNull()
  })
})
