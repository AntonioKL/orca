import { readFileSync } from 'node:fs'
import type { Store } from '../persistence'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { ClaudeRuntimeAuthSync } from './runtime-auth/runtime-auth-sync'
import {
  CLAUDE_MANAGED_FOREIGN_LOGIN_PROVENANCE,
  CLAUDE_MANAGED_KEYCHAIN_UNAVAILABLE_PROVENANCE,
  type ClaudeRuntimeAuthPreparation
} from './runtime-auth/runtime-auth-types'
import { migrateLegacySharedClaudeAuth } from './legacy-shared-claude-auth-migration'
import {
  isTransientKeychainError,
  readActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials
} from './keychain'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export class ClaudeRuntimeAuthService extends ClaudeRuntimeAuthSync {
  private managedForeignLoginAccountId: string | null = null
  private managedKeychainUnavailable: {
    accountId: string
    preparation: ClaudeRuntimeAuthPreparation
  } | null = null

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
    // Isolated accounts are already Claude's runtime store; legacy accounts
    // with valid credentials still use the shared runtime before launch.
    const legacyCredentials =
      selected && selected.managedAuthRuntime === undefined
        ? await this.readManagedCredentials(selected)
        : null
    let cleanupMissingLegacy = false
    if (selected && selected.managedAuthRuntime === undefined && legacyCredentials === null) {
      const runtimeCredentials = this.readRuntimeCredentialsFile()
      const managedOauth = await this.readManagedOauthAccount(selected)
      cleanupMissingLegacy = this.runtimeCredentialsBelongToAccount(
        runtimeCredentials,
        selected,
        managedOauth
      )
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
    const preparation = this.getPreparation(effectiveTarget)
    // Claude Code on macOS reads the config-scoped Keychain item, while Orca
    // stores managed credentials under its account-scoped service. Bridge the
    // two surfaces only for the selected managed home; never touch the legacy
    // unsuffixed service.
    if (
      process.platform === 'darwin' &&
      selected?.managedAuthRuntime === 'host' &&
      preparation.provenance.startsWith(`managed:${selected.id}`) &&
      // Why: provenance alone can say `managed:` while the pane is routed at the system dir;
      // bridging then writes the account's token into an item no reader ever reads.
      preparation.envPatch.CLAUDE_CONFIG_DIR === preparation.configDir
    ) {
      try {
        const scoped = await readActiveClaudeKeychainCredentialsStrict(preparation.configDir)
        const skipScopedReadBack = this.skipNextReadBackForAccountId === selected.id
        if (skipScopedReadBack) {
          // Re-auth writes managed storage first; let the managed→scoped write
          // below repair any stale Keychain item left by the previous login.
          this.skipNextReadBackForAccountId = null
        }
        // Both stores in the managed home are real credential sources: the CLI reads the
        // Keychain first and falls back to the file, and persists rotations to whichever it
        // can write.
        const runtimeOauthAccount = this.readRuntimeOauthAccount(preparation.configDir)
        const fileCandidate = await this.readManagedCredentialsFileCandidate(selected)
        if (!skipScopedReadBack) {
          // Adopt the freshest candidate that proves it belongs to this account.
          for (const candidate of [scoped, fileCandidate]) {
            if (!candidate || !this.isValidCredentialsJsonObject(candidate)) {
              continue
            }
            const current = await this.readManagedCredentials(selected)
            if (!current || candidate === current) {
              continue
            }
            const match = await this.findManagedAccountForRuntimeCredentials(
              candidate,
              runtimeOauthAccount
            )
            if (
              match.kind === 'matched' &&
              match.account.id === selected.id &&
              this.runtimeCredentialsCanReplaceManagedCredentials(candidate, current)
            ) {
              await this.writeManagedCredentials(selected, candidate)
              if (candidate === fileCandidate) {
                // Consumed: the managed store now holds this rotation, so drop the outage
                // copy rather than leave a second source that can go stale.
                await this.clearManagedCredentialsFile(selected)
              }
            }
          }
        }
        const managed = await this.readManagedCredentials(selected)
        // A login the home's own identity record proves belongs to someone else is not a rotation
        // to preserve: discarding it replays nothing, and the selected account must win.
        const foreignLogin = this.runtimeIdentityIsProvablyForeign(runtimeOauthAccount, selected)
        // Otherwise an unadopted candidate may be the CLI's newer rotation, in either store.
        // Overwriting it would hand the next reader an already-consumed refresh token, and the
        // CLI reads the Keychain first, so seeding an empty item shadows a live file too.
        const unadoptedFresher =
          managed !== null &&
          [scoped, fileCandidate].some(
            (candidate) =>
              candidate !== null &&
              candidate !== managed &&
              this.isValidCredentialsJsonObject(candidate) &&
              this.runtimeCredentialsAreFresher(candidate, managed)
          )
        const wouldShadowLiveFile =
          scoped === null &&
          fileCandidate !== null &&
          fileCandidate !== managed &&
          this.isValidCredentialsJsonObject(fileCandidate)
        const refuseManagedWrite = foreignLogin || unadoptedFresher || wouldShadowLiveFile
        if (managed && !refuseManagedWrite && this.isValidCredentialsJsonObject(managed)) {
          await writeActiveClaudeKeychainCredentials(managed, preparation.configDir)
        } else if (foreignLogin) {
          // Someone signed in as a different identity inside this account's home. Reverting it
          // would mean rewriting the CLI's own identity record, which Orca does not own — so
          // report it and leave both stores alone.
          console.warn('[claude-runtime-auth] Managed Claude home is signed in as another account')
          this.managedForeignLoginAccountId = selected.id
        } else if (refuseManagedWrite) {
          console.warn(
            '[claude-runtime-auth] Refusing to overwrite an unadopted Claude credential rotation'
          )
        }
        if (!foreignLogin && this.managedForeignLoginAccountId === selected.id) {
          this.managedForeignLoginAccountId = null
        }
        if (this.managedKeychainUnavailable?.accountId === selected.id) {
          this.managedKeychainUnavailable = null
        }
      } catch (bridgeError) {
        console.warn('[claude-runtime-auth] Failed to bridge macOS managed Claude Keychain')
        // Degrade the medium before the identity: the CLI reads the config dir's own
        // credentials file when the Keychain is unusable, so keep the pane on its account.
        // A locked or prompt-blocked Keychain is recoverable, so never spill a plaintext
        // credential for it; report the degraded state and let the user unlock instead.
        try {
          if (
            !isTransientKeychainError(bridgeError) &&
            (await this.materializeManagedCredentialsFile(selected))
          ) {
            return preparation
          }
        } catch {
          console.warn(
            '[claude-runtime-auth] Failed to materialize managed Claude credentials file'
          )
        }
        // Only with no readable managed credential is there nothing to route at; fall
        // back to the system lane and surface it.
        const fallbackPreparation: ClaudeRuntimeAuthPreparation = {
          configDir: this.pathResolver.getRuntimePaths().configDir,
          runtime: 'host',
          wslDistro: null,
          wslLinuxConfigDir: null,
          envPatch: this.pathResolver.getRuntimePaths().envPatch,
          stripAuthEnv: false,
          provenance: CLAUDE_MANAGED_KEYCHAIN_UNAVAILABLE_PROVENANCE
        }
        this.managedKeychainUnavailable = {
          accountId: selected.id,
          preparation: fallbackPreparation
        }
        return fallbackPreparation
      }
    }
    return preparation
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    // Rate-limit reads must never materialize or refresh credentials.
    const preparation = this.getPreparation(effectiveTarget)
    const selectedId = getSelectedClaudeAccountIdForTarget(
      this.store.getSettings(),
      effectiveTarget
    )
    if (this.managedKeychainUnavailable?.accountId === selectedId) {
      return this.managedKeychainUnavailable.preparation
    }
    // Keep the pane on its own home; only the reported state changes.
    return this.managedForeignLoginAccountId === selectedId
      ? { ...preparation, provenance: CLAUDE_MANAGED_FOREIGN_LOGIN_PROVENANCE }
      : preparation
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
    } catch {
      console.warn('[claude-runtime-auth] Failed to sync runtime auth state')
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
        readLegacyOauthAccount: () => {
          try {
            const parsed = JSON.parse(readFileSync(paths.configPath, 'utf-8')) as Record<
              string,
              unknown
            >
            return parsed.oauthAccount ?? null
          } catch {
            return null
          }
        },
        readManagedCredentials: (account) => this.readManagedCredentials(account),
        writeManagedCredentials: (account, contents) =>
          this.writeManagedCredentials(account, contents)
      })
    } catch {
      console.warn('[claude-runtime-auth] Legacy auth migration deferred')
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
