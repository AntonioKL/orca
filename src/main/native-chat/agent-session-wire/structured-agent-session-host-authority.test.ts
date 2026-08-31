import { describe, expect, it } from 'vitest'
import { supportsCodexStructuredLocation } from '../../codex/codex-structured-location-support'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { adjudicateAgentSessionRestart } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionLease } from '../../../shared/agent-session-record'
import { SshReconnectLadder } from '../../ssh/ssh-reconnect-ladder'
import { resolveStructuredAgentSessionHostVerdict } from './structured-agent-session-host-authority'

const BASE_LEASE: AgentSessionLease = {
  sessionId: 'session-ssh-boundary',
  runtimeKind: 'native',
  runtimeFence: 4,
  handoffStage: null,
  provenHandleLinkId: 'link-1',
  ownerProcess: {
    hostId: 'ssh:builder',
    pid: 42,
    processStartTimeMs: 1_000,
    spawnToken: 'spawn-token'
  },
  reservedSpawnToken: null,
  leaseDeadlineAt: 10_000,
  lastRenewedAt: 9_000,
  handoffOperationId: null,
  journalCheckpoint: null,
  claimKeyId: 'key-1',
  claimStatus: 'live',
  unreconciled: true,
  deathEvidence: null
}

describe('structured SSH host authority', () => {
  it.each(['disconnected', 'half-open', 'reconnect-exhausted'] as const)(
    'keeps %s transport loss unverifiable',
    (transport) => {
      expect(
        resolveStructuredAgentSessionHostVerdict({
          transport,
          owner: { outcome: 'pid-absent' },
          journal: 'readable'
        })
      ).toBe('unverifiable')
    }
  )

  it('requires positive connected-host evidence before returning exited', () => {
    expect(
      resolveStructuredAgentSessionHostVerdict({
        transport: 'connected',
        owner: { outcome: 'pid-absent' },
        journal: 'readable'
      })
    ).toBe('exited')
    expect(
      resolveStructuredAgentSessionHostVerdict({
        transport: 'connected',
        owner: { outcome: 'indeterminate', reason: 'host probe unavailable' },
        journal: 'readable'
      })
    ).toBe('unverifiable')
  })

  it('keeps an SSH session unverifiable when the remote journal is unreadable', () => {
    expect(
      resolveStructuredAgentSessionHostVerdict({
        transport: 'connected',
        owner: { outcome: 'identity-matched', matchedOn: ['spawn-token'] },
        journal: 'unreadable'
      })
    ).toBe('unverifiable')
  })

  it('does not enable the local Codex adapter for an SSH location on Linux', () => {
    expect(
      supportsCodexStructuredLocation({
        executionHostId: 'ssh:builder',
        wslDistro: null,
        workspaceId: 'workspace-ssh',
        workspaceKind: 'git-worktree'
      })
    ).toBe(false)
    expect(
      supportsCodexStructuredLocation({
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'workspace-local',
        workspaceKind: 'git-worktree'
      })
    ).toBe(true)
  })

  it('keeps a remote owner fenced across host restart without evidence', () => {
    expect(
      adjudicateAgentSessionRestart({
        lease: BASE_LEASE,
        probe: { outcome: 'indeterminate', reason: 'SSH transport unavailable' },
        observedAt: 11_000
      })
    ).toMatchObject({ disposition: 'recovering', stage: 'recovering' })
  })

  it('evicts only after the owning host proves the recorded process absent', () => {
    expect(
      adjudicateAgentSessionRestart({
        lease: BASE_LEASE,
        probe: { outcome: 'pid-absent' },
        observedAt: 11_000
      })
    ).toMatchObject({ disposition: 'evicted', evidence: { kind: 'pid-absent' } })
  })

  it('bounds reconnect exhaustion without converting the remote process to exited', () => {
    const ladder = new SshReconnectLadder()
    for (let attempt = 0; attempt < 9; attempt += 1) {
      ladder.markAttemptFailed()
      const decision = ladder.next(attempt * 1_000)
      if (attempt < 8) {
        expect(decision.kind).toBe('retry')
      } else {
        expect(decision).toEqual({ kind: 'give-up' })
      }
    }
    expect(
      resolveStructuredAgentSessionHostVerdict({
        transport: 'reconnect-exhausted',
        owner: { outcome: 'indeterminate', reason: 'reconnect ladder exhausted' },
        journal: 'unknown'
      })
    ).toBe('unverifiable')
  })
})
