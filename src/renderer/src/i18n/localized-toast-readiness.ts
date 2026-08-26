import { useTranslation } from 'react-i18next'
import { isPluginUiLanguage } from '../../../shared/ui-language'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import { resolveUiLocale } from './supported-languages'

/**
 * True once the user's locale bundle is loaded, so a launch-time toast is not
 * rendered in English and then re-rendered translated a tick later.
 */
export function useLocalizedToastReady(): boolean {
  const uiLanguage = useAppStore((s) => s.settings?.uiLanguage ?? null)
  const pluginLanguagePacks = usePluginLanguagePackStore((s) => s.packs)
  const pluginLanguagePacksLoaded = usePluginLanguagePackStore((s) => s.loaded)
  const { i18n } = useTranslation()
  const selectedPluginLanguage = pluginLanguagePacks.find((pack) => pack.id === uiLanguage)
  const targetLocale =
    uiLanguage === null || (isPluginUiLanguage(uiLanguage) && !pluginLanguagePacksLoaded)
      ? null
      : (selectedPluginLanguage?.resourceLanguage ??
        (isPluginUiLanguage(uiLanguage) ? 'en' : resolveUiLocale(uiLanguage)))
  return (
    targetLocale !== null &&
    i18n.language === targetLocale &&
    i18n.hasResourceBundle(targetLocale, 'translation')
  )
}
