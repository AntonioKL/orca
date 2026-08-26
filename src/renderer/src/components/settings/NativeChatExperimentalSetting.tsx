import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'

type NativeChatExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function NativeChatExperimentalSetting({
  settings,
  updateSettings
}: NativeChatExperimentalSettingProps): React.JSX.Element {
  const nativeChatEnabled = settings.experimentalNativeChat === true
  const structuredNativeChatEnabled = settings.experimentalStructuredNativeChat === true

  return (
    <SearchableSetting
      title={translate('auto.components.settings.ExperimentalPane.nativeChat.title', 'Chat UI')}
      description={translate(
        'auto.components.settings.ExperimentalPane.nativeChat.description',
        'Preview the desktop chat surface for supported agent terminal sessions.'
      )}
      keywords={getExperimentalSearchEntry().nativeChat.keywords}
      className="space-y-3 py-2"
      id="experimental-native-chat"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate('auto.components.settings.ExperimentalPane.nativeChat.title', 'Chat UI')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.nativeChat.copy',
              'Enables the experimental Chat UI for newly created supported local sessions. Existing terminal sessions keep the terminal chat path while we tune transcript fidelity, streaming, and parity.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={nativeChatEnabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.nativeChat.toggleLabel',
            'Toggle Chat UI'
          )}
          onChange={() =>
            updateSettings({
              experimentalNativeChat: !nativeChatEnabled
            })
          }
        />
      </div>
      {nativeChatEnabled ? (
        <div className="ml-4 border-l border-border pl-4">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.structuredTitle',
                  'Use updated structured native chat'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.structuredCopy',
                  'Opt in to the host-owned structured Codex runtime. Off keeps the existing terminal-backed chat path.'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.structuredScope',
                  'Local sessions only. Remote and SSH sessions continue to use terminal chat.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={structuredNativeChatEnabled}
              ariaLabel={translate(
                'auto.components.settings.ExperimentalPane.nativeChat.structuredToggleLabel',
                'Toggle updated structured native chat'
              )}
              onChange={() =>
                updateSettings({
                  experimentalStructuredNativeChat: !structuredNativeChatEnabled
                })
              }
            />
          </div>
        </div>
      ) : null}
    </SearchableSetting>
  )
}
