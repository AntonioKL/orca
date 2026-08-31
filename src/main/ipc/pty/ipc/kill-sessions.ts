import type { IPtyProvider, PtyProcessInfo } from '../../../providers/types'
import type {
  PtyKillIntent,
  PtyKillSessionRef,
  PtyKillSessionResult
} from '../../../../shared/pty-kill-sessions'
import type { PtyShutdownResult } from '../../../providers/pty-provider-contract'
import { shutdownSinglePty, type SinglePtyKillDeps } from './shutdown-single'

export type KillSessionsDeps = {
  listProviders: () => readonly { provider: IPtyProvider; connectionId?: string | null }[]
  providerForSession: (id: string) => IPtyProvider | undefined
  /** Main-owned ownership evidence. `true` means the session is still claimed. */
  isOwned?: (ref: PtyKillSessionRef) => { owned: boolean; reason?: string }
  shutdown: (provider: IPtyProvider, ref: PtyKillSessionRef) => Promise<PtyShutdownResult | void>
  singleKill?: SinglePtyKillDeps
  supportsIncarnationFence?: (provider: IPtyProvider) => boolean | Promise<boolean>
  concurrency?: number
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const result: R[] = Array.from({ length: values.length })
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= values.length) {
        return
      }
      result[index] = await fn(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()))
  return result
}

/** Bulk kill coordinator. Authorization is evaluated for every attempt and
 * owner-close deliberately bypasses orphan authorization. */
export async function killPtySessions(
  refs: readonly PtyKillSessionRef[],
  intent: PtyKillIntent,
  deps: KillSessionsDeps
): Promise<PtyKillSessionResult[]> {
  const shutdownResults = new Map<string, PtyShutdownResult | void>()
  const fenceCapabilities = new Map<string, boolean>()
  const results = await mapWithConcurrency<PtyKillSessionRef, PtyKillSessionResult>(
    refs,
    deps.concurrency ?? 4,
    async (ref): Promise<PtyKillSessionResult> => {
      const evidence = intent === 'orphan-cleanup' ? deps.isOwned?.(ref) : undefined
      if (evidence?.owned) {
        return { ...ref, verdict: 'refused', reason: evidence.reason ?? 'session is owned' }
      }
      const provider = deps.providerForSession(ref.id)
      const fenceCapable =
        provider && deps.supportsIncarnationFence
          ? await deps.supportsIncarnationFence(provider)
          : false
      if (intent === 'orphan-cleanup') {
        const latest = deps.isOwned?.(ref)
        if (latest?.owned) {
          return { ...ref, verdict: 'refused', reason: latest.reason ?? 'session is owned' }
        }
      }
      fenceCapabilities.set(ref.id, fenceCapable)
      if (fenceCapable && !ref.incarnationId) {
        return { ...ref, verdict: 'refused', reason: 'missing incarnation fence' }
      }
      try {
        const shutdownResult = deps.singleKill
          ? await shutdownSinglePty(
              { ...ref, intent, ...(provider ? { provider } : {}) },
              deps.singleKill
            )
          : provider
            ? await deps.shutdown(provider, ref)
            : undefined
        shutdownResults.set(ref.id, shutdownResult)
        return { ...ref, verdict: 'unverifiable' as const, reason: 'pending verification' }
      } catch (error) {
        return {
          ...ref,
          verdict: 'unverifiable',
          reason: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
  const snapshots = new Map<IPtyProvider, PtyProcessInfo[] | null>()
  await Promise.all(
    deps.listProviders().map(async ({ provider }) => {
      snapshots.set(provider, await provider.listProcesses().catch(() => null))
    })
  )
  return results.map((result) => {
    if (result.verdict !== 'unverifiable' || result.reason !== 'pending verification') {
      return result
    }
    const provider = deps.providerForSession(result.id)
    const listed = provider ? snapshots.get(provider) : null
    if (!listed) {
      return { ...result, verdict: 'unverifiable', reason: 'inventory unavailable' }
    }
    const survivor = listed.find((row) => {
      if (row.id !== result.id) {
        return false
      }
      if (!fenceCapabilities.get(result.id) || !result.incarnationId) {
        return true
      }
      return row.incarnationId === result.incarnationId
    })
    const sameId = listed.find((row) => row.id === result.id)
    if (
      fenceCapabilities.get(result.id) &&
      result.incarnationId &&
      sameId &&
      !sameId.incarnationId
    ) {
      return { ...result, verdict: 'unverifiable', reason: 'incarnation evidence unavailable' }
    }
    if (
      fenceCapabilities.get(result.id) &&
      result.incarnationId &&
      sameId?.incarnationId &&
      sameId.incarnationId !== result.incarnationId
    ) {
      return { ...result, verdict: 'refused', reason: 'session was replaced' }
    }
    const shutdownResult = shutdownResults.get(result.id)
    const treeUnverified = Boolean(shutdownResult?.treeUnverified)
    return survivor
      ? {
          ...result,
          verdict: 'live' as const,
          reason: 'session still running',
          ...(treeUnverified ? { treeUnverified: true } : {})
        }
      : {
          ...result,
          verdict: 'exited' as const,
          ...(treeUnverified
            ? { treeUnverified: true, reason: 'descendant tree could not be verified' }
            : {})
        }
  })
}

/** Utility used by the IPC adapter to take one pre-wave provider snapshot. */
export async function listProviderSessions(deps: KillSessionsDeps): Promise<PtyProcessInfo[]> {
  const snapshots = await Promise.all(
    deps.listProviders().map(({ provider }) => provider.listProcesses().catch(() => []))
  )
  return snapshots.flat()
}
