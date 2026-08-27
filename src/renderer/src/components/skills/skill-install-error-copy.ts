import { translate } from '@/i18n/i18n'

const ERROR_MESSAGES = {
  enterShareLink: () =>
    translate('auto.components.skills.install.enterShareLink', 'Enter an Orca skill share link.'),
  shareUnavailable: () =>
    translate(
      'auto.components.skills.install.shareUnavailable',
      'This share is unavailable. The link may be invalid, expired, or revoked.'
    ),
  requestedVersionVerificationFailed: () =>
    translate(
      'auto.components.skills.install.requestedVersionVerificationFailed',
      'Installation failed before Orca could verify the requested version.'
    ),
  reconnectBeforeInstalling: () =>
    translate(
      'auto.components.skills.install.reconnectBeforeInstalling',
      'Reconnect your Orca account before installing.'
    ),
  destinationAlreadyFinished: () =>
    translate(
      'auto.components.skills.install.destinationAlreadyFinished',
      'The destination had already finished this installation.'
    ),
  inspectManagedFailed: () =>
    translate(
      'auto.components.skills.install.inspectManagedFailed',
      'Orca could not inspect managed installs on this machine.'
    ),
  reconnectForVersionHistory: () =>
    translate(
      'auto.components.skills.install.reconnectForVersionHistory',
      'Reconnect your Orca account to load version history.'
    ),
  versionHistoryUnavailable: () =>
    translate(
      'auto.components.skills.install.versionHistoryUnavailable',
      'Version history is unavailable for this skill.'
    ),
  bundleSkillsMissing: () =>
    translate(
      'auto.components.skills.install.bundleSkillsMissing',
      'This version does not contain any of the installed bundle skills.'
    ),
  reconnectBeforeVersionChange: () =>
    translate(
      'auto.components.skills.install.reconnectBeforeVersionChange',
      'Reconnect your Orca account before changing versions.'
    ),
  versionVerificationFailed: () =>
    translate(
      'auto.components.skills.install.versionVerificationFailed',
      'Orca could not verify the requested version.'
    ),
  removeFailed: () =>
    translate(
      'auto.components.skills.install.removeFailed',
      'Orca could not safely remove this skill.'
    )
} as const

export function getSkillInstallErrorMessage(name: keyof typeof ERROR_MESSAGES): string {
  return ERROR_MESSAGES[name]()
}
