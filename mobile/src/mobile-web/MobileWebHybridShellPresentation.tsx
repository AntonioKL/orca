import type { RefObject } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import {
  MobileWebShellView,
  type MobileWebShellSession,
  type MobileWebShellViewRef
} from '@orca/expo-mobile-web-shell'
import { ChevronLeft, MonitorSmartphone } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '../theme/mobile-theme'
import type { HostProfile } from '../transport/types'
import { hybridShellStyles as styles } from './hybrid-shell-styles'
import { MobileWebRecoveryActions } from './MobileWebRecoveryActions'
import { MobileWebPackageProgress } from './MobileWebPackageProgress'
import {
  mobileWebShellPresentationState,
  mobileWebShellShowsNativeChrome
} from './mobile-web-shell-presentation-state'
import type { MobileWebPackageDownloadProgress } from './mobile-web-package-downloader'

type MobileWebHybridShellPresentationProps = {
  viewRef: RefObject<MobileWebShellViewRef | null>
  selectedHost: HostProfile | undefined
  session: MobileWebShellSession | null
  viewEpoch: number
  packageLoading: boolean
  packageProgress: MobileWebPackageDownloadProgress | undefined
  packageWarning: string | undefined
  hostedViewActive: boolean
  onBack: () => void
  onShowHosts: () => void
  onRetryRecovery: () => void | Promise<void>
  onUsePrevious: () => void | Promise<void>
  onClearCache: () => void | Promise<void>
  onRecoveryFailure: () => void
  onBridgeMessage: (message: string) => void
  onPageLoaded: () => void
  onLoadFailed: (reason: string | undefined) => void
  onNavigationBlocked: () => void
  onProcessTerminated: (sessionId: string) => void
}

export function MobileWebHybridShellPresentation({
  viewRef,
  selectedHost,
  session,
  viewEpoch,
  packageLoading,
  packageProgress,
  packageWarning,
  hostedViewActive,
  onBack,
  onShowHosts,
  onRetryRecovery,
  onUsePrevious,
  onClearCache,
  onRecoveryFailure,
  onBridgeMessage,
  onPageLoaded,
  onLoadFailed,
  onNavigationBlocked,
  onProcessTerminated
}: MobileWebHybridShellPresentationProps) {
  const insets = useSafeAreaInsets()
  const presentationState = mobileWebShellPresentationState({
    hasSelectedHost: Boolean(selectedHost),
    hasSession: Boolean(session),
    packageLoading
  })
  const showNativeChrome = mobileWebShellShowsNativeChrome(presentationState)

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {showNativeChrome ? (
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            hitSlop={8}
            style={styles.headerButton}
            onPress={onBack}
          >
            <ChevronLeft size={22} color={colors.textSecondary} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text numberOfLines={1} style={styles.heading}>
              {selectedHost?.name ?? 'Hybrid workspace UI'}
            </Text>
            <Text style={styles.headerMeta}>Verified desktop-served interface</Text>
          </View>
          {selectedHost ? (
            <Pressable
              accessibilityLabel="Show paired hosts"
              accessibilityRole="button"
              style={styles.hostsButton}
              onPress={onShowHosts}
            >
              <Text style={styles.hostsButtonText}>Hosts</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {presentationState === 'hosted-interface' && session ? (
        <View style={styles.webContainer}>
          {packageLoading && packageProgress ? (
            <MobileWebPackageProgress progress={packageProgress} />
          ) : null}
          {packageWarning ? (
            <>
              <Text accessibilityRole="alert" style={styles.warning}>
                {packageWarning}
              </Text>
              <MobileWebRecoveryActions
                canUsePrevious
                onClearCache={onClearCache}
                onFailure={onRecoveryFailure}
                onRetry={onRetryRecovery}
                onShowHosts={onShowHosts}
                onUsePrevious={onUsePrevious}
              />
            </>
          ) : null}
          <MobileWebShellView
            key={`${session.sessionId}:${viewEpoch}`}
            ref={viewRef}
            sessionId={hostedViewActive ? session.sessionId : null}
            onBridgeMessage={(event) => onBridgeMessage(event.nativeEvent.data)}
            onLoadState={(event) => {
              if (event.nativeEvent.state === 'loaded') {
                onPageLoaded()
                return
              }
              if (event.nativeEvent.state === 'failed') {
                onLoadFailed(event.nativeEvent.reason)
              }
            }}
            onNavigationBlocked={onNavigationBlocked}
            onProcessTerminated={(event) => onProcessTerminated(event.nativeEvent.sessionId)}
            style={styles.webView}
          />
        </View>
      ) : (
        <View style={styles.loadingState}>
          {packageLoading ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : (
            <MonitorSmartphone size={26} color={colors.textMuted} />
          )}
          <Text accessibilityLiveRegion="polite" style={styles.loadingTitle}>
            {presentationState === 'package-loading'
              ? 'Preparing verified interface…'
              : 'Workspace interface unavailable'}
          </Text>
          {packageLoading && packageProgress ? (
            <MobileWebPackageProgress progress={packageProgress} />
          ) : null}
          {packageWarning ? (
            <>
              <Text accessibilityRole="alert" style={styles.loadingBody}>
                {packageWarning}
              </Text>
              <MobileWebRecoveryActions
                canUsePrevious={false}
                onClearCache={onClearCache}
                onFailure={onRecoveryFailure}
                onRetry={onRetryRecovery}
                onShowHosts={onShowHosts}
                onUsePrevious={onUsePrevious}
              />
            </>
          ) : null}
        </View>
      )}
    </View>
  )
}
