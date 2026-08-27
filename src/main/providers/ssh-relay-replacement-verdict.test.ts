import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from './types'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import { SSH_RELAY_REPLACED_ERROR, SSH_SESSION_EXPIRED_ERROR } from './ssh-pty-errors'
import { markSshExpiryFromReplacedRelay } from './ssh-relay-replacement-verdict'

const BOUND_AT = 1_000_000
const CONNECTION_ID = 'target-a'
const RELAY_PTY_ID = 'pty-7'

function lease(overrides: Partial<SshRemotePtyLease> = {}): SshRemotePtyLease {
  return {
    targetId: CONNECTION_ID,
    ptyId: RELAY_PTY_ID,
    state: 'attached',
    createdAt: BOUND_AT,
    updatedAt: BOUND_AT,
    lastAttachedAt: BOUND_AT,
    ...overrides
  }
}

async function mark(args: {
  lease: SshRemotePtyLease | null
  requestHostRpc?: IPtyProvider['requestHostRpc']
}): Promise<string> {
  const error = new Error(`${SSH_SESSION_EXPIRED_ERROR}: ${RELAY_PTY_ID}`)
  await markSshExpiryFromReplacedRelay({
    error,
    provider: { requestHostRpc: args.requestHostRpc },
    store: { getSshRemotePtyLease: () => args.lease },
    connectionId: CONNECTION_ID,
    relayPtyId: RELAY_PTY_ID
  })
  return error.message
}

describe('markSshExpiryFromReplacedRelay', () => {
  it('marks the expiry when the answering relay started after the last attach', async () => {
    // now() - uptimeMs lands after BOUND_AT: this daemon cannot have held the PTY.
    vi.spyOn(Date, 'now').mockReturnValue(BOUND_AT + 60_000)
    const requestHostRpc = vi.fn().mockResolvedValue({ pid: 42, uptimeMs: 30_000 })

    const message = await mark({ lease: lease(), requestHostRpc })

    expect(message).toBe(
      `${SSH_SESSION_EXPIRED_ERROR}: ${RELAY_PTY_ID} ${SSH_RELAY_REPLACED_ERROR}`
    )
    expect(requestHostRpc).toHaveBeenCalledWith('relay.status', {}, expect.objectContaining({}))
    vi.restoreAllMocks()
  })

  it('leaves the expiry alone when the relay predates the last attach', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(BOUND_AT + 60_000)
    const requestHostRpc = vi.fn().mockResolvedValue({ pid: 42, uptimeMs: 120_000 })

    expect(await mark({ lease: lease(), requestHostRpc })).toBe(
      `${SSH_SESSION_EXPIRED_ERROR}: ${RELAY_PTY_ID}`
    )
    vi.restoreAllMocks()
  })

  it('produces no verdict when the relay never answers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(BOUND_AT + 60_000)
    const requestHostRpc = vi.fn().mockRejectedValue(new Error('request timed out'))

    expect(await mark({ lease: lease(), requestHostRpc })).toBe(
      `${SSH_SESSION_EXPIRED_ERROR}: ${RELAY_PTY_ID}`
    )
    vi.restoreAllMocks()
  })

  it('produces no verdict against a relay too old to report its uptime', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(BOUND_AT + 60_000)
    const requestHostRpc = vi.fn().mockResolvedValue({ capabilities: ['skills.install.bundle.v1'] })

    expect(await mark({ lease: lease(), requestHostRpc })).toBe(
      `${SSH_SESSION_EXPIRED_ERROR}: ${RELAY_PTY_ID}`
    )
    vi.restoreAllMocks()
  })

  it('does not ask the relay when nothing records an attach for the binding', async () => {
    const requestHostRpc = vi.fn()

    expect(await mark({ lease: lease({ lastAttachedAt: undefined }), requestHostRpc })).toBe(
      `${SSH_SESSION_EXPIRED_ERROR}: ${RELAY_PTY_ID}`
    )
    expect(await mark({ lease: null, requestHostRpc })).toBe(
      `${SSH_SESSION_EXPIRED_ERROR}: ${RELAY_PTY_ID}`
    )
    expect(requestHostRpc).not.toHaveBeenCalled()
  })

  it('produces no verdict when the provider cannot reach a relay at all', async () => {
    expect(await mark({ lease: lease() })).toBe(`${SSH_SESSION_EXPIRED_ERROR}: ${RELAY_PTY_ID}`)
  })
})
