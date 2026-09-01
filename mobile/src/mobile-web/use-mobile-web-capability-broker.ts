import { useCallback, useEffect, type MutableRefObject } from 'react'
import type { MobileWebCapabilityBroker } from './mobile-web-capability-broker'

export type MobileWebBrokerPageIdentity = { sessionId: string; buildId: string }

// A view-epoch bump loads a fresh document over the same shell session, so the previous page's
// broker (subscriptions, terminal streams, speech authority, replay window, rate limiter) has to
// be retired before the new document can post against it.
export function useMobileWebCapabilityBroker({
  brokerRef,
  sessionId,
  buildId,
  viewEpoch,
  createBroker,
  onBrokerReady,
  onBrokerSessionChange
}: {
  brokerRef: MutableRefObject<MobileWebCapabilityBroker | null>
  sessionId: string | undefined
  buildId: string | undefined
  viewEpoch: number
  createBroker: (page: MobileWebBrokerPageIdentity) => MobileWebCapabilityBroker | null
  onBrokerReady: () => void
  onBrokerSessionChange: (sessionId: string | undefined) => void
}): { retireBroker: () => void } {
  const retireBroker = useCallback(() => {
    brokerRef.current?.dispose()
    brokerRef.current = null
    onBrokerSessionChange(undefined)
  }, [brokerRef, onBrokerSessionChange])

  useEffect(() => {
    retireBroker()
    if (!sessionId || !buildId) {
      return
    }
    const broker = createBroker({ sessionId, buildId })
    if (!broker) {
      return
    }
    brokerRef.current = broker
    onBrokerSessionChange(sessionId)
    onBrokerReady()
    return () => {
      broker.dispose()
      if (brokerRef.current === broker) {
        brokerRef.current = null
      }
      onBrokerSessionChange(undefined)
    }
  }, [
    brokerRef,
    buildId,
    createBroker,
    onBrokerReady,
    onBrokerSessionChange,
    retireBroker,
    sessionId,
    viewEpoch
  ])

  return { retireBroker }
}
