import type { Store } from '../persistence'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { ClaudeRuntimeAuthSync } from './runtime-auth/runtime-auth-sync'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import { migrateLegacySharedClaudeAuth } from './legacy-shared-claude-auth-migration'
import { readActiveClaudeKeychainCredentialsStrict } from './keychain'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export class ClaudeRuntimeAuthService extends ClaudeRuntimeAuthSync {
  constructor(store: Store) {
    super(store)
    this.initializeLastSyncedState()
    // Sync the selected runtime first; migration must not race a cleanup and
    // repopulate a managed account from a stale shared Keychain entry.
    void this.safeSyncForCurrentSelection().finally(() => this.migrateLegacySharedAuth())
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    const settings = this.store.getSettings()
    const selectedId = getSelectedClaudeAccountIdForTarget(settings, effectiveTarget)
    const selected = selectedId
      ? settings.claudeManagedAccounts.find((account) => account.id === selectedId)
      : null
    // Isolated accounts are already Claude's runtime store; never copy them into ~/.claude.
    // Legacy accounts with valid credentials still use the shared runtime and
    // must be synchronized before launch; missing legacy credentials are left
    // for the background cleanup path to handle without a second restore.
    const legacyCredentials =
      selected && selected.managedAuthRuntime === undefined
        ? await this.readManagedCredentials(selected)
        : null
    let cleanupMissingLegacy = false
    if (selected && selected.managedAuthRuntime === undefined && legacyCredentials === null) {
      const runtimeCredentials = this.readRuntimeCredentialsFile()
      const managedOauth = await this.readManagedOauthAccount(selected)
      const runtimeMatches = this.runtimeCredentialsBelongToAccount(
        runtimeCredentials,
        selected,
        managedOauth
      )
      cleanupMissingLegacy = runtimeMatches
    }
    if (
      !selected ||
      selected.managedAuthRuntime === 'wsl' ||
      (selected.managedAuthRuntime === undefined &&
        legacyCredentials !== null &&
        this.isValidCredentialsJsonObject(legacyCredentials)) ||
      cleanupMissingLegacy
    ) {
      await this.syncForCurrentSelection(effectiveTarget)
    }
    return this.getPreparation(effectiveTarget)
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    // Rate-limit reads must never materialize or refresh credentials.
    return this.getPreparation(effectiveTarget)
  }

  async syncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    await this.serializeMutation(() =>
      this.doSyncForCurrentSelection(target ?? this.getDefaultAccountSelectionTarget())
    )
  }

  async forceMaterializeCurrentSelectionForRollback(): Promise<void> {
    await this.serializeMutation(async () => {
      const settings = this.store.getSettings()
      if (!settings.activeClaudeManagedAccountId) {
        const previousAccount = this.getActiveAccount(
          settings.claudeManagedAccounts,
          this.lastSyncedAccountId
        )
        await this.restoreSystemDefaultSnapshot(
          previousAccount ? await this.readManagedCredentials(previousAccount) : null,
          previousAccount ? await this.readManagedOauthAccount(previousAccount) : undefined
        )
        this.lastSyncedAccountId = null
        return
      }
      await this.doSyncForCurrentSelection()
    })
  }

  getRuntimeConfigDir(target?: ClaudeAccountSelectionTarget): string {
    return this.getPreparation(target).configDir
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      await this.syncForCurrentSelection()
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to sync runtime auth state:', error)
    }
  }

  private async migrateLegacySharedAuth(): Promise<void> {
    const settings = this.store.getSettings()
    const paths = this.pathResolver.getRuntimePaths()
    const metadataDir = this.getRuntimeMetadataDir()
    try {
      await migrateLegacySharedClaudeAuth({
        accounts: settings.claudeManagedAccounts,
        activeAccountId: settings.activeClaudeManagedAccountId,
        sharedAuthPath: paths.credentialsPath,
        metadataDir,
        readLegacyKeychain:
          process.platform === 'darwin'
            ? () => readActiveClaudeKeychainCredentialsStrict()
            : undefined,
        readManagedCredentials: (account) => this.readManagedCredentials(account),
        writeManagedCredentials: (account, contents) =>
          this.writeManagedCredentials(account, contents)
      })
    } catch (error) {
      console.warn('[claude-runtime-auth] Legacy auth migration deferred:', error)
    }
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  // Why: re-auth/add-account write fresh managed tokens; skip the next read-back so stale runtime tokens can't overwrite them.
  clearLastWrittenCredentialsJson(
    accountId = this.store.getSettings().activeClaudeManagedAccountId
  ): void {
    if (accountId === this.store.getSettings().activeClaudeManagedAccountId) {
      this.lastWrittenCredentialsJson = null
    }
    this.skipNextReadBackForAccountId = accountId
  }
}
