/**
 * Ratchet (#18419): `pty.inspectProcess` must NOT be in-flight coalesced the way the sibling git
 * reads are. The host mints one `observationEpoch` per request, and the renderer's foreground
 * reader commits that epoch per read; a shared reply therefore reads as a stale replay to the
 * second reader to settle. The pane foreground tracker overlaps its own probes on purpose
 * (`cancelPendingRead` bumps the generation but lets the in-flight probe finish, then reissues
 * after a 350 ms settle), so coalescing turns its would-be `live` identity read into
 * `unverifiable`. These are call counters and verdicts, not timings.
 */
import { describe, expect, it, vi } from 'vitest'
import { createPaneForegroundProcessReader } from './pane-foreground-process-reader'
import { createSshPtyProviderRpcOperations } from '../../../../main/providers/ssh-pty-provider-rpc-operations'

const CONNECTION_ID = 'conn-1'
const RELAY_PTY_ID = 'pty-1'
const APP_PTY_ID = `ssh:${CONNECTION_ID}@@${RELAY_PTY_ID}`
const INCARNATION_ID = 'inc-1'

type Deferred = { resolve: (value: unknown) => void }

/** Answers `pty.inspectProcess` with a fresh host observation per request, held open on demand. */
function createInspectingMux(): {
  operations: ReturnType<typeof createSshPtyProviderRpcOperations>
  request: ReturnType<typeof vi.fn>
  deferreds: Deferred[]
  liveEvidenceForRequest: (index: number) => unknown
} {
  const deferreds: Deferred[] = []
  const request = vi.fn(
    () =>
      new Promise((resolve) => {
        deferreds.push({ resolve })
      })
  )
  return {
    operations: createSshPtyProviderRpcOperations({
      mux: { request } as never,
      toRelayPtyId: () => RELAY_PTY_ID
    }),
    request,
    deferreds,
    // One host scan per request => one epoch per request.
    liveEvidenceForRequest: (index: number) => ({
      foregroundProcess: 'claude',
      hasChildProcesses: true,
      foregroundProcessEvidence: {
        verdict: 'live',
        processName: 'claude',
        ptyId: RELAY_PTY_ID,
        ptyIncarnationId: INCARNATION_ID,
        authorityGeneration: 'gen-1',
        observationEpoch: index + 1,
        capturedAgeMs: 0,
        fence: {
          platform: 'posix',
          shellPid: 100,
          shellStartTime: '1000',
          tty: '/dev/pts/3',
          foregroundPgid: 200
        }
      }
    })
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('SSH pty.inspectProcess observation identity', () => {
  it('gives each overlapping probe of one pane+incarnation its own host observation', async () => {
    const { operations, request, deferreds, liveEvidenceForRequest } = createInspectingMux()

    void operations.inspectProcess(APP_PTY_ID, { expectedIncarnationId: INCARNATION_ID })
    void operations.inspectProcess(APP_PTY_ID, { expectedIncarnationId: INCARNATION_ID })
    await flush()

    expect(request).toHaveBeenCalledTimes(2)
    deferreds[0].resolve(liveEvidenceForRequest(0))
    deferreds[1].resolve(liveEvidenceForRequest(1))
  })

  it('keeps a reissued read `live` when it overlaps the probe it superseded', async () => {
    const { operations, deferreds, liveEvidenceForRequest } = createInspectingMux()
    // One reader instance per pane, exactly as the foreground tracker holds it.
    const readProcess = createPaneForegroundProcessReader({
      readForegroundProcess: (ptyId, options) => operations.inspectProcess(ptyId, options) as never,
      isRemotePtyId: () => true,
      getExpectedIncarnationId: () => INCARNATION_ID
    })

    // The tracker cancels the first read (generation bump) but lets it run to completion, then
    // reissues after the settle window — so both are in flight against the same pane.
    const superseded = readProcess(APP_PTY_ID, false)
    const reissued = readProcess(APP_PTY_ID, false)
    await flush()

    // The superseded read's continuation commits its epoch first.
    deferreds[0].resolve(liveEvidenceForRequest(0))
    expect((await superseded).remoteEvidenceVerdict).toBe('live')

    deferreds[1]?.resolve(liveEvidenceForRequest(1))
    const result = await reissued
    expect(result.remoteEvidenceVerdict).toBe('live')
    expect(result.processName).toBe('claude')
  })
})
