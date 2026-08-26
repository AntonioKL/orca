import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useLocalizedToastReady } from '@/i18n/localized-toast-readiness'
import { FULL_DISK_ACCESS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import {
  dismissMacosTccPromptNotice,
  subscribeToMacosTccPromptNotice
} from './macos-tcc-prompt-notice-subscription'

/**
 * Shows the Full Disk Access hint after macOS raises a consent dialog naming
 * Orca (#9756). Users who never see one never see this.
 */
export function useMacosTccPromptNotice(): void {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const localeReady = useLocalizedToastReady()

  useEffect(() => {
    if (!localeReady) {
      return
    }
    return subscribeToMacosTccPromptNotice(window.api?.macosTccPrompts, (_, acknowledge) => {
      toast.warning(
        translate(
          'auto.hooks.useMacosTccPromptNotice.title',
          'Seeing “Orca would like to access…” prompts?'
        ),
        {
          description: translate(
            'auto.hooks.useMacosTccPromptNotice.description',
            'Permission messages from macOS may appear when an agent or terminal tool running in Orca attempts to access protected files. Grant Full Disk Access in Settings to reduce these prompts.'
          ),
          duration: Infinity,
          onDismiss: acknowledge,
          action: {
            label: translate('auto.hooks.useMacosTccPromptNotice.openSettings', 'Open Settings'),
            onClick: () => {
              acknowledge()
              openSettingsPage()
              openSettingsTarget({
                pane: 'developer-permissions',
                repoId: null,
                sectionId: FULL_DISK_ACCESS_SETTINGS_TARGET_ID
              })
            }
          },
          cancel: {
            label: translate('auto.hooks.useMacosTccPromptNotice.dismiss', "Don't show again"),
            onClick: () => {
              void dismissMacosTccPromptNotice(window.api?.macosTccPrompts)
            }
          }
        }
      )
    })
  }, [localeReady, openSettingsPage, openSettingsTarget])
}
