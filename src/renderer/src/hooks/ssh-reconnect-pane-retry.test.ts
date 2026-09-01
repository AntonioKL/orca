import { describe, expect, it } from 'vitest'
import { shouldRetryPaneSpawnOnSshReconnect } from './ssh-reconnect-pane-retry'

describe('shouldRetryPaneSpawnOnSshReconnect', () => {
  it('retries tabs with no ptyId at all', () => {
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: null,
        deferredSessionId: undefined
      })
    ).toBe(true)
  })

  it('retries tabs still holding a deferred session for this target', () => {
    // Why: the stale wake-hint ptyId reads as live, but an unconsumed deferred
    // entry proves no pane ever reattached — the pane is stranded.
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: 'ssh:conn-1@@pty-7',
        deferredSessionId: 'ssh:conn-1@@pty-7'
      })
    ).toBe(true)
  })

  it('leaves tabs whose deferred entry was already consumed alone', () => {
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: 'ssh:conn-1@@pty-7',
        deferredSessionId: undefined
      })
    ).toBe(false)
  })

  it('ignores deferred sessions that belong to another target', () => {
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: 'ssh:conn-2@@pty-3',
        deferredSessionId: 'ssh:conn-2@@pty-3'
      })
    ).toBe(false)
  })

  it('leaves a split tab alone whose leaf PTYs are live but whose tab.ptyId is null', () => {
    // workspace-terminal-reconnect fills ptyIdsByTabId from the leaf map but writes tab.ptyId only
    // when a tab-level id survives, so a split SSH tab reaches this gate with live leaf PTYs and a
    // null fallback field. Respawning there puts a second agent on the running one's transcript.
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: null,
        tabPtyIds: ['ssh:conn-1@@pty-4', 'ssh:conn-1@@pty-5'],
        leafPtyIds: ['ssh:conn-1@@pty-4', 'ssh:conn-1@@pty-5'],
        deferredSessionId: undefined
      })
    ).toBe(false)
  })

  it('leaves a hydrated tab alone whose ptyId was nulled but whose layout still names its PTY', () => {
    // clearTransientTerminalState nulls tab.ptyId on every hydrated row unconditionally, and
    // finalizeHydratedTerminals runs this gate straight afterwards — while hydrating the host's
    // own snapshot of the sessions it is still running.
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: null,
        tabPtyIds: undefined,
        leafPtyIds: ['ssh:conn-1@@pty-9'],
        deferredSessionId: undefined
      })
    ).toBe(false)
  })

  it('still retries a tab with no PTY in any record', () => {
    // The genuine "spawn failed outright" case the gate exists for must keep working.
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: null,
        tabPtyIds: [],
        leafPtyIds: [],
        deferredSessionId: undefined
      })
    ).toBe(true)
  })

  it('still retries a stranded tab whose only records are empty slots', () => {
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: null,
        tabPtyIds: [null],
        leafPtyIds: [undefined],
        deferredSessionId: undefined
      })
    ).toBe(true)
  })
})
