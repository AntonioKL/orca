import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { sshProviders } from '../provider/registry'
import { listProcessesWithHostScopeFromRuntimeController } from './inventory-operations'
import type { PtyRuntimeControllerDeps } from './controller-deps'

/**
 * `hostScopeCensusIsComplete` treats a `runtime:` host in `omittedHostIds` as disclosure rather
 * than a gap, on the strength of one fact about this process: it has no paired-runtime PTY
 * provider, so it never queried that host and never owed it coverage.
 *
 * That fact is asserted at the client, about the host, which is exactly the kind of assumption
 * that rots silently. The consolidation moving the SSH path onto `orcad` is the change most
 * likely to introduce a runtime-backed PTY provider — at which point a runtime host really could
 * answer an inventory, `hostScopeCensusIsComplete` would start calling a genuine gap complete,
 * and nothing downstream would say so. Break here instead, at the source of the invariant.
 */
describe('the hosts a PTY inventory can report having queried', () => {
  afterEach(() => {
    sshProviders.clear()
  })

  it('never names a paired-runtime host, which is what lets the scope gate discount one', async () => {
    const listProcesses = vi.fn(async () => [])
    sshProviders.set('box-1', { listProcesses } as never)
    sshProviders.set('box-2', { listProcesses } as never)

    const { hostIds } = await listProcessesWithHostScopeFromRuntimeController({
      runtime: null
    } as unknown as PtyRuntimeControllerDeps)

    expect(hostIds.length).toBeGreaterThan(0)
    expect(hostIds.map((hostId) => parseExecutionHostId(hostId)?.kind)).not.toContain('runtime')
    expect(new Set(hostIds.map((hostId) => parseExecutionHostId(hostId)?.kind))).toEqual(
      new Set(['local', 'ssh'])
    )
  })

  it('drops a provider that threw rather than reporting its host as queried', async () => {
    sshProviders.set('box-live', { listProcesses: vi.fn(async () => []) } as never)
    sshProviders.set('box-down', {
      listProcesses: vi.fn(async () => {
        throw new Error('relay unavailable')
      })
    } as never)

    const { hostIds } = await listProcessesWithHostScopeFromRuntimeController({
      runtime: { markPtyLivenessUnverifiable: vi.fn() }
    } as unknown as PtyRuntimeControllerDeps)

    expect(hostIds).toContain('ssh:box-live')
    expect(hostIds).not.toContain('ssh:box-down')
  })
})
