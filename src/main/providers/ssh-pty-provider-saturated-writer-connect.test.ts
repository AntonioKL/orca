import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION,
  AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION
} from '../../shared/agent-session-host-authority'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import { encodeFrame, HEADER_LENGTH, MessageType } from '../ssh/relay-protocol'
import {
  SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
  SSH_PTY_CONNECT_WORST_CASE_MS,
  SSH_PTY_SPAWN_TIMEOUT_MS,
  SSH_RELAY_REQUEST_TIMEOUT_MS,
  sshRelayQueueWaitMs
} from '../../shared/ssh-relay-request-budget'
import { SshPtyProvider } from './ssh-pty-provider'

type SaturatingTransport = MultiplexerTransport & {
  deliver: (data: Buffer) => void
  drain: () => void
  setAccepting: (accepting: boolean) => void
  written: Buffer[]
}

function createTransport(): SaturatingTransport {
  let deliver = (_data: Buffer): void => {}
  let drain = (): void => {}
  let accepting = true
  const written: Buffer[] = []
  return {
    write: (data) => {
      written.push(data)
      return accepting
    },
    onDrain: (callback) => {
      drain = callback
    },
    onData: (callback) => {
      deliver = callback
    },
    onClose: () => {},
    deliver: (data) => deliver(data),
    drain: () => drain(),
    setAccepting: (value) => {
      accepting = value
    },
    written
  }
}

function requestIds(transport: SaturatingTransport, method: string): number[] {
  return transport.written.flatMap((frame) => {
    if (frame[0] !== MessageType.Regular) {
      return []
    }
    const length = frame.readUInt32BE(9)
    const payload = JSON.parse(
      frame.subarray(HEADER_LENGTH, HEADER_LENGTH + length).toString()
    ) as { method?: string; id?: number }
    return payload.method === method && typeof payload.id === 'number' ? [payload.id] : []
  })
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve()
  }
}

const claim = {
  digestVersion: 1 as const,
  keyId: 'key',
  identityDigest: 'a'.repeat(43),
  worktreeScopeDigest: 'b'.repeat(43),
  agent: 'codex' as const
}
const surface = {
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  terminalHandle: 'term_claimed'
}

describe('SSH pane connect over a saturated writer', () => {
  let transport: SaturatingTransport
  let mux: SshChannelMultiplexer
  let provider: SshPtyProvider

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    transport = createTransport()
    mux = new SshChannelMultiplexer(transport)
    provider = new SshPtyProvider('conn-1', mux)
  })

  afterEach(() => {
    mux.dispose()
    vi.useRealTimers()
  })

  function saturate(): void {
    transport.setAccepting(false)
    mux.notify('pty.data', { id: 'pty-1', data: 'x' })
  }

  async function drainOnce(): Promise<void> {
    transport.setAccepting(true)
    transport.drain()
    await flush()
    saturate()
    await flush()
  }

  function respond(id: number, result: unknown): void {
    transport.deliver(
      encodeFrame(
        MessageType.Regular,
        id,
        0,
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }))
      )
    )
  }

  // Why: the capability probe gates spawn, so on the FIRST spawn of a connection
  // (nothing cached yet) a probe that expired in the queue meant pty.spawn was
  // never enqueued and its wire-started budget never engaged.
  it('reaches the wire with the first spawn of a connection whose writer is saturated', async () => {
    saturate()
    await flush()

    const spawned = provider.spawn({
      cols: 80,
      rows: 24,
      command: 'codex',
      agentSessionCreateOperationId: 'a'.repeat(43)
    })
    await flush()

    vi.advanceTimersByTime(SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS + 1_000)
    await flush()
    expect(requestIds(transport, 'pty.getCapabilities')).toHaveLength(0)

    await drainOnce()
    const [probeId] = requestIds(transport, 'pty.getCapabilities')
    expect(probeId).toBeDefined()
    respond(probeId, {
      agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
    })
    await flush()

    await drainOnce()
    const [spawnId] = requestIds(transport, 'pty.spawn')
    expect(spawnId).toBeDefined()
    respond(spawnId, { id: 'pty-remote', incarnationId: 'incarnation-remote' })

    await expect(spawned).resolves.toMatchObject({ id: 'ssh:conn-1@@pty-remote' })
  })

  // Why: the pane-connect backstops must outlast the whole sequence — BOTH
  // capability probes (claims, then create-operations: separate cache entries, so
  // one launch that asks for both sends both), the spawn, then the cleanup
  // shutdown a failed claim validation issues — not the spawn alone, or they
  // settle a live connect as timed out.
  it('settles the whole claimed connect sequence inside the connect worst case', async () => {
    saturate()
    await flush()

    const spawned = provider.spawn({
      cols: 80,
      rows: 24,
      agentSessionEnsure: { claim, surface },
      agentSessionCreateOperationId: 'a'.repeat(43)
    })
    const outcome = spawned.then(
      () => 'resolved',
      (error: Error) => error.message
    )
    await flush()

    // Each phase drains one tick short of its queue bound, then goes unanswered
    // until one tick short of its response budget: the true worst case.
    vi.advanceTimersByTime(sshRelayQueueWaitMs(SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS) - 1)
    await drainOnce()
    vi.advanceTimersByTime(SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS - 1)
    respond(requestIds(transport, 'pty.getCapabilities')[0], {
      agentSessionClaimVersion: AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION
    })
    await flush()

    vi.advanceTimersByTime(sshRelayQueueWaitMs(SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS) - 1)
    await drainOnce()
    vi.advanceTimersByTime(SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS - 1)
    const probeIds = requestIds(transport, 'pty.getCapabilities')
    expect(probeIds).toHaveLength(2)
    respond(probeIds[1], {
      agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
    })
    await flush()

    vi.advanceTimersByTime(sshRelayQueueWaitMs(SSH_PTY_SPAWN_TIMEOUT_MS) - 1)
    await drainOnce()
    vi.advanceTimersByTime(SSH_PTY_SPAWN_TIMEOUT_MS - 1)
    respond(requestIds(transport, 'pty.spawn')[0], {
      id: 'pty-claimed',
      incarnationId: 'incarnation-claimed',
      agentSessionEnsure: {
        disposition: 'created',
        // Mismatched owner id: validation fails with a created PTY to clean up.
        owner: { claim, generation: 'gen-1', phase: 'live', ptyId: 'pty-other', surface }
      }
    })
    await flush()

    // The cleanup shutdown did not opt in, so it spends its budget from enqueue.
    vi.advanceTimersByTime(SSH_RELAY_REQUEST_TIMEOUT_MS)
    await flush()

    await expect(outcome).resolves.toBe('execution_owner_unavailable')
    expect(Date.now()).toBeLessThan(SSH_PTY_CONNECT_WORST_CASE_MS)
  })
})
