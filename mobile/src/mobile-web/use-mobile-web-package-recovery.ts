import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import ExpoMobileWebShell, { type MobileWebShellSession } from '@orca/expo-mobile-web-shell'
import type { HostProfile } from '../transport/types'
import { mobileWebDiagnosticsStore } from './mobile-web-diagnostics-store'
import { removeMobileWebHostCache } from './mobile-web-native-stager'
import type { MobileWebProcessFailureTracker } from './mobile-web-process-failure-tracker'

type PackageRecoveryState = {
  host: HostProfile | undefined
  hostEpochRef: RefObject<number>
  activeHostIdRef: RefObject<string | null>
  ownedSessionRef: RefObject<MobileWebShellSession | null>
  processFailuresRef: RefObject<MobileWebProcessFailureTracker>
  rejectedBuildIdsRef: RefObject<Set<string>>
  setSession: Dispatch<SetStateAction<MobileWebShellSession | null>>
  setViewEpoch: Dispatch<SetStateAction<number>>
  setPackageLoading: Dispatch<SetStateAction<boolean>>
  setPackageWarning: Dispatch<SetStateAction<string | undefined>>
  setRefreshEpoch: Dispatch<SetStateAction<number>>
}

export type MobileWebPackageRecoveryActions = {
  markHealthy: (sessionId: string) => Promise<void>
  handleHealthTimeout: (sessionId: string) => Promise<void>
  handleProcessTerminated: (sessionId: string) => Promise<void>
  retryPackage: () => void
  recoverPrevious: () => Promise<void>
  clearCache: () => Promise<void>
}

export function useMobileWebPackageRecovery({
  host,
  hostEpochRef,
  activeHostIdRef,
  ownedSessionRef,
  processFailuresRef,
  rejectedBuildIdsRef,
  setSession,
  setViewEpoch,
  setPackageLoading,
  setPackageWarning,
  setRefreshEpoch
}: PackageRecoveryState): MobileWebPackageRecoveryActions {
  const recoverSession = useCallback(
    async (sessionId: string, warning: string, failureCode: string) => {
      const current = ownedSessionRef.current
      const hostEpoch = hostEpochRef.current
      const hostId = activeHostIdRef.current
      if (!current || !hostId || current.sessionId !== sessionId) {
        return
      }
      rejectedBuildIdsRef.current.add(current.buildId)
      try {
        const recovered = await ExpoMobileWebShell.recoverSession(sessionId)
        if (
          hostEpochRef.current !== hostEpoch ||
          ownedSessionRef.current?.sessionId !== sessionId
        ) {
          await ExpoMobileWebShell.closeSession(recovered.sessionId).catch(() => {})
          return
        }
        ownedSessionRef.current = recovered
        setSession(recovered)
        setViewEpoch(0)
        setPackageWarning(warning)
        mobileWebDiagnosticsStore.recovered(hostId, recovered.buildId, failureCode)
      } catch {
        if (
          hostEpochRef.current === hostEpoch &&
          ownedSessionRef.current?.sessionId === sessionId
        ) {
          setViewEpoch((value) => value + 1)
          setPackageWarning(
            'The workspace view restarted; no previous healthy interface is available.'
          )
          mobileWebDiagnosticsStore.restarted(hostId, current.buildId)
        }
      }
    },
    [
      activeHostIdRef,
      hostEpochRef,
      ownedSessionRef,
      rejectedBuildIdsRef,
      setPackageWarning,
      setSession,
      setViewEpoch
    ]
  )

  const markHealthy = useCallback(
    async (sessionId: string) => {
      if (ownedSessionRef.current?.sessionId !== sessionId) {
        return
      }
      try {
        await ExpoMobileWebShell.markSessionHealthy(sessionId)
        if (ownedSessionRef.current?.sessionId === sessionId) {
          const hostId = activeHostIdRef.current
          if (hostId) {
            mobileWebDiagnosticsStore.healthy(hostId, ownedSessionRef.current.buildId)
          }
        }
      } catch {
        if (ownedSessionRef.current?.sessionId === sessionId) {
          setPackageWarning('The workspace interface is running but could not be marked healthy.')
          const hostId = activeHostIdRef.current
          if (hostId) {
            mobileWebDiagnosticsStore.warning(hostId, 'health_mark_failed')
          }
        }
      }
    },
    [activeHostIdRef, ownedSessionRef, setPackageWarning]
  )

  const handleHealthTimeout = useCallback(
    async (sessionId: string) => {
      await recoverSession(
        sessionId,
        'The refreshed interface did not become healthy; the previous verified version was restored.',
        'health_timeout'
      )
    },
    [recoverSession]
  )

  const handleProcessTerminated = useCallback(
    async (sessionId: string) => {
      const current = ownedSessionRef.current
      if (!current || current.sessionId !== sessionId) {
        return
      }
      if (!processFailuresRef.current.record(current.buildId)) {
        setViewEpoch((value) => value + 1)
        setPackageWarning('The workspace view stopped and was restarted.')
        const hostId = activeHostIdRef.current
        if (hostId) {
          mobileWebDiagnosticsStore.restarted(hostId, current.buildId)
        }
        return
      }
      await recoverSession(
        sessionId,
        'The workspace view stopped repeatedly; the previous verified version was restored.',
        'webview_crash_loop'
      )
    },
    [
      activeHostIdRef,
      ownedSessionRef,
      processFailuresRef,
      recoverSession,
      setPackageWarning,
      setViewEpoch
    ]
  )

  const retryPackage = useCallback(() => {
    if (!activeHostIdRef.current) {
      return
    }
    setPackageLoading(true)
    setPackageWarning(undefined)
    setRefreshEpoch((value) => value + 1)
  }, [activeHostIdRef, setPackageLoading, setPackageWarning, setRefreshEpoch])

  const recoverPrevious = useCallback(async () => {
    const current = ownedSessionRef.current
    if (!current) {
      setPackageWarning('No previous verified workspace interface is available.')
      return
    }
    await recoverSession(
      current.sessionId,
      'The previous verified workspace interface was restored.',
      'manual_recovery'
    )
  }, [ownedSessionRef, recoverSession, setPackageWarning])

  const clearCache = useCallback(async () => {
    // Invalidate refresh/open continuations before any await so a clear cannot race a
    // download that publishes a session into the cache being removed.
    const hostEpoch = hostEpochRef.current + 1
    hostEpochRef.current = hostEpoch
    const current = ownedSessionRef.current
    if (!host || !activeHostIdRef.current) {
      return
    }
    ownedSessionRef.current = null
    setSession(null)
    setViewEpoch(0)
    setPackageLoading(true)
    setPackageWarning(undefined)
    if (current) {
      await ExpoMobileWebShell.closeSession(current.sessionId).catch(() => {})
    }
    try {
      await removeMobileWebHostCache(host.publicKeyB64)
    } catch {
      if (hostEpochRef.current === hostEpoch) {
        setPackageLoading(false)
        setPackageWarning('The workspace interface cache could not be cleared.')
      }
      return
    }
    if (hostEpochRef.current === hostEpoch) {
      processFailuresRef.current.reset()
      rejectedBuildIdsRef.current.clear()
      setRefreshEpoch((value) => value + 1)
    }
  }, [
    activeHostIdRef,
    host,
    hostEpochRef,
    ownedSessionRef,
    processFailuresRef,
    rejectedBuildIdsRef,
    setPackageLoading,
    setPackageWarning,
    setRefreshEpoch,
    setSession,
    setViewEpoch
  ])

  return {
    markHealthy,
    handleHealthTimeout,
    handleProcessTerminated,
    retryPackage,
    recoverPrevious,
    clearCache
  }
}
