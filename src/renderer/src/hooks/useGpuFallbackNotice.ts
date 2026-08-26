import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { SAFE_GRAPHICS_MODE_SETTING_ID } from '@/components/settings/SafeGraphicsModeSetting'
import { translate } from '@/i18n/i18n'
import { useLocalizedToastReady } from '@/i18n/localized-toast-readiness'
import { useAppStore } from '@/store'

const GPU_FALLBACK_NOTICE_ID = 'gpu-fallback-active'
const DISMISSED_ENGAGEMENT_KEY = 'orca.gpu-fallback.notice-dismissed-engaged-at'

/**
 * "Don't show again", scoped to one engagement rather than a boolean: the downgrade is sticky
 * for the whole build, so a session-only dismissal nags on every launch for weeks, and a
 * permanent one silences a *later* engagement the user never saw.
 */
function isGpuFallbackNoticeDismissed(engagedAt: number | null): boolean {
  try {
    return (
      engagedAt !== null &&
      window.localStorage.getItem(DISMISSED_ENGAGEMENT_KEY) === String(engagedAt)
    )
  } catch {
    return false
  }
}

function dismissGpuFallbackNotice(engagedAt: number | null): void {
  if (engagedAt === null) {
    return
  }
  try {
    window.localStorage.setItem(DISMISSED_ENGAGEMENT_KEY, String(engagedAt))
  } catch {
    // Best-effort; without storage the notice returns on the next launch.
  }
}

function openSafeGraphicsModeSetting(): void {
  const store = useAppStore.getState()
  store.openSettingsPage()
  store.openSettingsTarget({
    pane: 'advanced',
    repoId: null,
    sectionId: SAFE_GRAPHICS_MODE_SETTING_ID
  })
}

/**
 * Safe Graphics Mode can engage before any window exists — repeated GPU crashes
 * at startup leave nothing to prompt on — so after-the-fact is the only place to
 * tell the user it happened. The toast is deliberately a pointer, not the
 * control: the downgrade lasts for the whole build, and a dismissed toast would
 * otherwise leave no way back. Settings > Advanced owns the state and the exit.
 *
 * "Don't show again" is persisted per engagement, so a user who accepts software
 * rendering is not warned on every launch for weeks — but a later engagement is.
 */
export function useGpuFallbackNotice(): void {
  const localeReady = useLocalizedToastReady()
  const shownThisSession = useRef(false)

  useEffect(() => {
    const getGpuFallbackStatus = window.api?.app?.getGpuFallbackStatus
    if (!localeReady || shownThisSession.current || !getGpuFallbackStatus) {
      return
    }
    let cancelled = false
    void getGpuFallbackStatus().then(
      (status) => {
        if (
          cancelled ||
          !status.active ||
          // Why: the user pinned this in Settings and accepted a dialog saying so. Warning them
          // that a crash caused it is false, and it teaches them to distrust a notice that is
          // true on the machines it was written for. Settings still reports the state.
          status.source === 'user' ||
          shownThisSession.current ||
          isGpuFallbackNoticeDismissed(status.engagedAt)
        ) {
          return
        }
        shownThisSession.current = true
        toast.warning(
          translate('auto.hooks.useGpuFallbackNotice.title', 'Orca started in Safe Graphics Mode'),
          {
            id: GPU_FALLBACK_NOTICE_ID,
            description: translate(
              'auto.hooks.useGpuFallbackNotice.description',
              "Hardware acceleration is off because Orca's graphics process crashed on repeated launches. Rendering may be slower. Open Settings > Advanced to learn more and try hardware acceleration again."
            ),
            duration: Infinity,
            // Why: the Toaster renders a close button, and dismissing a never-expiring toast
            // that way must count too — otherwise the X re-warns on every launch for weeks.
            onDismiss: () => dismissGpuFallbackNotice(status.engagedAt),
            action: {
              label: translate('auto.hooks.useGpuFallbackNotice.openSettings', 'Open Settings'),
              onClick: openSafeGraphicsModeSetting
            },
            cancel: {
              label: translate('auto.hooks.useGpuFallbackNotice.dismiss', "Don't show again"),
              onClick: () => dismissGpuFallbackNotice(status.engagedAt)
            }
          }
        )
      },
      () => {
        // Why: a failed status read is not worth a second toast; the About panel still reports it.
      }
    )
    return () => {
      cancelled = true
    }
  }, [localeReady])
}

/** Why a leaf host: the status read must not re-render the App shell. */
export function GpuFallbackNoticeHost(): null {
  useGpuFallbackNotice()
  return null
}
