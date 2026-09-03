import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MobileWebShellViewRef } from '@orca/expo-mobile-web-shell'
import * as ExpoCrypto from 'expo-crypto'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage,
  type MobileWebResumeRoute
} from '../../src/shared/mobile-web/bridge-contract'
import { MobileWebCapabilityBroker } from '../src/mobile-web/mobile-web-capability-broker'
import {
  useMobileWebCapabilityBroker,
  type MobileWebBrokerPageIdentity
} from '../src/mobile-web/use-mobile-web-capability-broker'
import { MOBILE_WEB_PRODUCTION_GRANTS } from '../src/mobile-web/mobile-web-production-grants'
import { MobileWebHealthDeadline } from '../src/mobile-web/mobile-web-health-deadline'
import { useMobileWebAlertSafePackageSession } from '../src/mobile-web/use-mobile-web-alert-safe-package-session'
import { createMobileWebNativeCapabilityAuthority } from '../src/mobile-web/mobile-web-native-capability-authority'
import { MobileWebHybridShellPresentation } from '../src/mobile-web/MobileWebHybridShellPresentation'
import { mobileWebShellLoadFailureWarning } from '../src/mobile-web/mobile-web-shell-load-failure-warning'
import { useMobileWebNavigationIntentHandoff } from '../src/mobile-web/use-mobile-web-navigation-intent-handoff'
import { useMobileWebColdResumeRoute } from '../src/mobile-web/use-mobile-web-cold-resume-route'
import { mobileWebBridgeConnectionState } from '../src/mobile-web/mobile-web-bridge-connection-state'
import { MobileWebOneShotResponseDrop } from '../src/mobile-web/mobile-web-one-shot-response-drop'
import { useMobileWebE2eHostSelection } from '../src/mobile-web/mobile-web-e2e-host-selection'
import { useMobileWebAppForegroundAuthority } from '../src/mobile-web/use-mobile-web-app-foreground-authority'
import { useMobileWebHostCatalog } from '../src/mobile-web/use-mobile-web-host-catalog'
import { mobileWebDiagnosticsStore } from '../src/mobile-web/mobile-web-diagnostics-store'
import { useMobileWebBridgeRuntimeRef } from '../src/mobile-web/use-mobile-web-bridge-runtime-ref'
import { useMobileWebHardwareBackHandoff } from '../src/mobile-web/use-mobile-web-hardware-back-handoff'
import { MobileWebNativeRouteHandoff } from '../src/mobile-web/mobile-web-native-route-handoff'
import { useMobileWebNavigationAuthority } from '../src/mobile-web/use-mobile-web-navigation-authority'
import { handleMobileWebBrokerMessage } from '../src/mobile-web/mobile-web-broker-message-handoff'
import {
  useForceReconnect,
  useForgetHostClient,
  useHostClient
} from '../src/transport/client-context'
import {
  useLastConnectedAt,
  useReconnectAttempt
} from '../src/transport/client-context-connection-metrics'
import { leaveHostRoute } from '../src/host-route-exit'

export default function HybridScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ hostId?: string }>()
  const viewRef = useRef<MobileWebShellViewRef>(null)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const initializedSessionRef = useRef<string | undefined>(undefined)
  const resumeRouteRef = useRef<MobileWebResumeRoute>({ kind: 'workspaceList' })
  const healthDeadlineRef = useRef(new MobileWebHealthDeadline(10_000))
  const brokerRef = useRef<MobileWebCapabilityBroker | null>(null)
  const postInitRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const nativeRouteHandoffRef = useRef(new MobileWebNativeRouteHandoff())
  useMobileWebAppForegroundAuthority(brokerRef)
  const responseDropRef = useRef(
    new MobileWebOneShotResponseDrop(process.env.EXPO_PUBLIC_ORCA_E2E_MOBILE_WEB_DROP_RESPONSE_ONCE)
  )
  const { hosts, hostsLoading, hostLoadError, refreshHosts } = useMobileWebHostCatalog()
  const [selectedHostId, setSelectedHostId] = useState<string | undefined>(params.hostId)
  const [pageReadySessionId, setPageReadySessionId] = useState<string>()
  const [brokerSessionId, setBrokerSessionId] = useState<string>()
  const [hostedViewActive, setHostedViewActive] = useState(true)
  const selectHost = useCallback((hostId: string | undefined) => setSelectedHostId(hostId), [])
  const e2eHostId = useMobileWebE2eHostSelection(hosts, selectedHostId, selectHost)
  const { client, state } = useHostClient(selectedHostId)
  const closeHostClient = useForgetHostClient()
  const forceReconnectHost = useForceReconnect()
  const reconnects = useReconnectAttempt(selectedHostId)
  const lastConnected = useLastConnectedAt(selectedHostId)
  const selectedHost = useMemo(
    () => hosts.find((host) => host.id === selectedHostId),
    [hosts, selectedHostId]
  )
  const hostName = selectedHost?.name
  const {
    session,
    sessionHostId,
    viewEpoch,
    packageLoading,
    packageProgress,
    packageWarning,
    markHealthy,
    handleHealthTimeout: onHealthTimeout,
    handleProcessTerminated,
    retryPackage,
    recoverPrevious,
    clearCache,
    showWarning
  } = useMobileWebAlertSafePackageSession({ client, host: selectedHost, state })
  const bridgeRuntimeRef = useMobileWebBridgeRuntimeRef(client, state, session?.sessionId)
  const coldResumeRoute = useMobileWebColdResumeRoute({
    hosts,
    hostsLoading,
    hostsLoadFailed: hostLoadError,
    explicitHostId: params.hostId ?? e2eHostId,
    selectedHostId,
    shellSessionId: session?.sessionId,
    selectHost
  })
  const handleBack = useCallback(() => {
    coldResumeRoute.clearRoute()
    leaveHostRoute(router)
  }, [coldResumeRoute.clearRoute, router])

  useEffect(() => {
    if (hostsLoading || selectedHost || e2eHostId) {
      return
    }
    coldResumeRoute.clearRoute()
    leaveHostRoute(router)
  }, [coldResumeRoute.clearRoute, e2eHostId, hostsLoading, router, selectedHost])

  useEffect(() => {
    activeSessionIdRef.current = sessionHostId === selectedHostId ? session?.sessionId : undefined
  }, [selectedHostId, session?.sessionId, sessionHostId])

  useFocusEffect(
    useCallback(() => {
      setHostedViewActive(true)
      const sessionId = session?.sessionId
      const view = viewRef.current
      if (sessionId && view) {
        void view.activateSessionView(sessionId).catch(() => {
          if (activeSessionIdRef.current === sessionId) {
            showWarning('Hosted session could not be restored.')
          }
        })
      }
      return () => setHostedViewActive(false)
    }, [session?.sessionId, showWarning])
  )

  useEffect(() => {
    if (params.hostId) {
      setSelectedHostId(params.hostId)
    }
  }, [params.hostId])

  useEffect(() => {
    resumeRouteRef.current = { kind: 'workspaceList' }
  }, [session?.sessionId])

  // A view-epoch bump replaces the document, so every page-scoped grant retires with it.
  useEffect(() => {
    initializedSessionRef.current = undefined
    nativeRouteHandoffRef.current.clear()
    setPageReadySessionId(undefined)
    healthDeadlineRef.current.clear()
    return () => healthDeadlineRef.current.clear()
  }, [session?.sessionId, viewEpoch])

  const postToWeb = useCallback(async (message: MobileWebBridgeShellMessage) => {
    if (responseDropRef.current.shouldDrop(message)) {
      return
    }
    const view = viewRef.current
    if (!view) {
      return
    }
    await view.postMessage(JSON.stringify(message))
  }, [])
  const hardwareBackHandoff = useMobileWebHardwareBackHandoff({
    shellSessionId: session?.sessionId,
    buildId: session?.buildId,
    forwardingEnabled: hostedViewActive,
    postMessage: postToWeb,
    onUnhandled: handleBack
  })

  const navigationAuthority = useMobileWebNavigationAuthority({
    hostId: selectedHost?.id,
    hostPublicKeyB64: selectedHost?.publicKeyB64,
    routeHandoffRef: nativeRouteHandoffRef,
    router,
    clearColdResumeRoute: coldResumeRoute.clearRoute,
    closeHostClient,
    forceReconnectHost
  })
  const createBroker = useCallback(
    (page: MobileWebBrokerPageIdentity) => {
      if (!selectedHost || sessionHostId !== selectedHostId) {
        return null
      }
      return new MobileWebCapabilityBroker({
        context: { shellSessionId: page.sessionId, buildId: page.buildId },
        getClient: () =>
          bridgeRuntimeRef.current.sessionId === page.sessionId
            ? bridgeRuntimeRef.current.client
            : null,
        isConnected: () =>
          bridgeRuntimeRef.current.sessionId === page.sessionId &&
          bridgeRuntimeRef.current.state === 'connected',
        isActive: () => activeSessionIdRef.current === page.sessionId,
        postMessage: postToWeb,
        nativeAuthority: createMobileWebNativeCapabilityAuthority({
          hostIdentity: selectedHost.publicKeyB64,
          buildIdentity: page.buildId
        }),
        navigationAuthority,
        terminalClientId: selectedHost.deviceToken,
        onTerminalFlowMetrics: (metrics) =>
          mobileWebDiagnosticsStore.terminalFlow(selectedHost.id, metrics),
        onTerminalResync: (reason) =>
          mobileWebDiagnosticsStore.terminalResync(selectedHost.id, reason),
        rememberRoute(route) {
          resumeRouteRef.current = route
        },
        rememberHostRoute: coldResumeRoute.rememberHostRoute,
        randomBytes: ExpoCrypto.getRandomBytes
      })
    },
    [
      coldResumeRoute.rememberHostRoute,
      navigationAuthority,
      postToWeb,
      selectedHost?.deviceToken,
      selectedHost?.id,
      selectedHost?.publicKeyB64,
      sessionHostId,
      selectedHostId
    ]
  )
  const onBrokerReady = useCallback(() => {
    void postInitRef.current().catch(() => {})
  }, [])
  const { retireBroker } = useMobileWebCapabilityBroker({
    brokerRef,
    sessionId: session?.sessionId,
    buildId: session?.buildId,
    viewEpoch,
    createBroker,
    onBrokerReady,
    onBrokerSessionChange: setBrokerSessionId
  })

  useEffect(() => {
    brokerRef.current?.replaceClient(client)
  }, [client])

  const postInit = useCallback(async () => {
    const current = session
    if (!current || activeSessionIdRef.current !== current.sessionId || !brokerRef.current) {
      return
    }
    initializedSessionRef.current = current.sessionId
    healthDeadlineRef.current.arm(current.sessionId, (sessionId) => {
      if (activeSessionIdRef.current === sessionId) {
        void onHealthTimeout(sessionId)
      }
    })
    await postToWeb({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      shellSessionId: current.sessionId,
      buildId: current.buildId,
      connection: mobileWebBridgeConnectionState(state),
      hostDisplayName: hostName,
      reconnectAttempts: reconnects,
      lastConnectedAt: lastConnected,
      resumeRoute: resumeRouteRef.current,
      grants: [...MOBILE_WEB_PRODUCTION_GRANTS]
    })
  }, [hostName, lastConnected, onHealthTimeout, postToWeb, reconnects, session, state])
  useEffect(() => {
    postInitRef.current = postInit
  }, [postInit])

  useEffect(() => {
    brokerRef.current?.updateConnectionState(mobileWebBridgeConnectionState(state))
    const current = session
    if (!current || initializedSessionRef.current !== current.sessionId) {
      return
    }
    void postToWeb({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'connection',
      shellSessionId: current.sessionId,
      buildId: current.buildId,
      state: mobileWebBridgeConnectionState(state),
      reconnectAttempts: reconnects,
      lastConnectedAt: lastConnected
    })
  }, [lastConnected, postToWeb, reconnects, session, state])

  const handleBridgeMessage = useCallback(
    async (raw: string) => {
      const current = session
      if (!current || activeSessionIdRef.current !== current.sessionId) {
        return
      }
      const parsed = parseMobileWebBridgePageMessage(raw, {
        shellSessionId: current.sessionId,
        buildId: current.buildId
      })
      if (!parsed.ok) {
        return
      }
      responseDropRef.current.recordRequest(parsed.value)
      const backMessageHandled = hardwareBackHandoff.handlePageMessage(parsed.value)
      if (parsed.value.type === 'ready') {
        // `ready` acknowledges init; echoing init here starves the health frame.
        if (activeSessionIdRef.current === current.sessionId) {
          setPageReadySessionId(current.sessionId)
        }
      } else if (!backMessageHandled) {
        if (parsed.value.type === 'health') {
          healthDeadlineRef.current.acknowledge(current.sessionId)
          await markHealthy(current.sessionId)
        } else if (parsed.value.type === 'routeState') {
          brokerRef.current?.rememberRoute(parsed.value.route)
        } else {
          await handleMobileWebBrokerMessage({
            message: parsed.value,
            brokerRef,
            activeSessionIdRef,
            sessionId: current.sessionId,
            viewRef,
            routeHandoff: nativeRouteHandoffRef.current,
            setHostedViewActive,
            navigateToTerminalSettings: () => router.push('/terminal-settings'),
            onNavigationFailure: () => showWarning('Terminal settings could not be opened.')
          })
        }
      }
    },
    [hardwareBackHandoff, markHealthy, postInit, router, session, showWarning]
  )
  const shellContext = useMemo(
    () => (session ? { sessionId: session.sessionId, buildId: session.buildId } : null),
    [session?.buildId, session?.sessionId]
  )

  const getBroker = useCallback(() => brokerRef.current, [])
  const rememberRoute = useCallback((route: MobileWebResumeRoute) => {
    resumeRouteRef.current = route
  }, [])
  useMobileWebNavigationIntentHandoff({
    hosts,
    hostsLoading,
    selectedHostId,
    connectionState: state,
    shellContext,
    pageReadySessionId,
    brokerSessionId,
    getBroker,
    selectHost,
    refreshHosts,
    postMessage: postToWeb,
    rememberRoute,
    onNavigationResolved: coldResumeRoute.onNavigationResolved,
    showWarning
  })

  return (
    <MobileWebHybridShellPresentation
      viewRef={viewRef}
      selectedHost={selectedHost}
      session={sessionHostId === selectedHostId ? session : null}
      viewEpoch={viewEpoch}
      packageLoading={packageLoading || !selectedHost || sessionHostId !== selectedHostId}
      packageProgress={packageProgress}
      packageWarning={packageWarning}
      hostedViewActive={hostedViewActive}
      onBack={handleBack}
      onShowHosts={() => {
        coldResumeRoute.clearRoute()
        leaveHostRoute(router)
      }}
      onRetryRecovery={async () => {
        if (selectedHost && state !== 'connected') {
          await forceReconnectHost(selectedHost.id)
        }
        retryPackage()
      }}
      onUsePrevious={recoverPrevious}
      onClearCache={clearCache}
      onRecoveryFailure={() =>
        showWarning('The workspace interface recovery action could not be completed.')
      }
      onBridgeMessage={(message) => void handleBridgeMessage(message)}
      onPageLoaded={() => {
        hardwareBackHandoff.resetPage()
        void postInit()
      }}
      onLoadFailed={(reason) => {
        healthDeadlineRef.current.clear()
        showWarning(mobileWebShellLoadFailureWarning(reason))
      }}
      onNavigationBlocked={() => showWarning('Navigation outside Orca was blocked.')}
      onProcessTerminated={(sessionId) => {
        hardwareBackHandoff.resetPage()
        healthDeadlineRef.current.clear()
        retireBroker()
        void handleProcessTerminated(sessionId)
      }}
    />
  )
}
