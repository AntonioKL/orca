import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import { CodexCredentialAbsenceGrace } from './codex-credential-absence-grace'
import type {
  CodexMirroredHomeStatus,
  CodexRateLimitHomeResolution,
  CodexReadBackMatch,
  CodexReadBackResult,
  CodexRuntimeLogoutMarker,
  CodexRuntimeLogoutMarkerStatus,
  CodexSharedRuntimeAuthPendingProvenance,
  CodexSelfContainedManagedHomeResolution,
  CodexSharedRuntimeAuthProvenance,
  CodexSharedRuntimeAuthProvenanceFile,
  CodexSharedRuntimeAuthProvenanceStatus,
  CodexSystemDefaultSnapshot
} from './runtime-home-service-types'
import type { CodexSessionBackfillDate } from '../codex/codex-session-backfill-types'
import type { CodexPaneHomeRoute } from '../codex/codex-pane-account-registry'
import type { CodexAccountSelectionTarget } from './runtime-selection'

/** Shared state and method contracts for the focused runtime-home layers. */
export abstract class CodexRuntimeHomeState {
  // Which managed account runtime auth.json mirrors; null means it follows system-default ~/.codex instead of a managed account.
  protected lastSyncedAccountId: string | null = null
  // Last auth.json Orca wrote to the runtime home; a later diff signals an out-of-band change (Codex token refresh, or external login to adopt).
  protected lastWrittenAuthJson: string | null = null
  // Why: WSL terminals have per-distro runtime homes; sharing the host baseline can make stale WSL auth look newer than managed storage.
  protected readonly lastWrittenWslAuthJsonByDistro = new Map<string, string | null>()
  protected readonly lastSyncedWslAccountIdByDistro = new Map<string, string | null>()
  protected readonly wslRuntimeHomePathByDistro = new Map<string, string>()
  protected skipNextReadBackForAccountId: string | null = null
  // Why: a managed host account refreshes auth in its own home. Remember that provenance so a later deselect never adopts stale shared bytes.
  protected lastHostAccountUsedSelfContainedHome = false
  protected sharedAuthRefreshBlockedByManagedTransition = false
  // Why: transient auth.json read/parse failures must not deselect an account.
  protected readonly credentialAbsenceGrace = new CodexCredentialAbsenceGrace()
  protected hostSystemDefaultSessionMigrationPending = false
  protected pendingHostSystemDefaultSessionMigrationNeedsFullScan = false
  protected pendingHostSystemDefaultSessionMigrationTarget: string | null = null

  protected constructor(protected readonly store: Store) {}

  protected abstract initializeLastSyncedState(): void
  abstract prepareForCodexLaunch(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    options?: { unavailableManagedHomePath?: string }
  ): string | null
  abstract beginHostSystemDefaultSessionMigrationLaunch(
    codexHomePath: string | null,
    options?: { reattached?: boolean; launchEnv?: NodeJS.ProcessEnv }
  ): boolean | null
  abstract isHostSystemDefaultSessionMigrationEligible(): boolean
  abstract prepareHostSystemDefaultSessionMigrationPass(
    scanDates?: readonly CodexSessionBackfillDate[]
  ): boolean
  abstract finishHostSystemDefaultSessionMigrationPass(): void

  protected abstract getSelfContainedManagedHostAccount(): CodexManagedAccount | null
  protected abstract getManagedAccountHomesForSessionDiscovery(): string[]
  protected abstract getManagedHostAccountHomesForSessionDiscovery(): string[]
  protected abstract prepareSelfContainedManagedHomeForLaunch(
    account: CodexManagedAccount,
    unavailableManagedHomePath?: string
  ): string | null
  protected abstract startSelfContainedSessionBridgeForLaunch(perAccountHome: string): void
  protected abstract getSelfContainedSessionBridgeSourceHomes(): string[]
  protected abstract syncSelfContainedManagedSelection(account: CodexManagedAccount): void
  protected abstract resolveSelfContainedManagedHome(
    account: CodexManagedAccount
  ): CodexSelfContainedManagedHomeResolution
  protected abstract getTrustedSelfContainedManagedHomePath(
    account: CodexManagedAccount
  ): string | null
  protected abstract clearSelfContainedManagedSelection(
    account: CodexManagedAccount,
    reason?: string
  ): void
  protected abstract invalidateBackfillAfterManagedSystemDefaultLaunch(
    launchEnv?: NodeJS.ProcessEnv
  ): boolean | null
  protected abstract startWslSessionBridgeForLaunch(
    target: CodexAccountSelectionTarget,
    runtimeHomePath: string | null
  ): void

  abstract getHostCodexHomePathsForSessionDiscovery(): string[]
  abstract getSelectedHostAccountCodexHomePath(): string | null
  abstract resolveSelectedHostAccountCodexHomePathForResume(): string | null
  abstract resolveCodexManagedAccountHomeForInactiveFetch(
    account: CodexManagedAccount
  ): { kind: 'ready'; homePath: string } | { kind: 'skip' }
  abstract getSelectedHostCodexHomeRoute(): CodexPaneHomeRoute
  abstract getRetainedHostCodexHookHomePaths(ptyIds: readonly string[]): string[]
  abstract setRealHomeLaneGate(gate: () => boolean): void
  abstract isHostSystemDefaultRealHomeSelected(launchEnv?: NodeJS.ProcessEnv): boolean
  abstract isHostSystemDefaultRealHome(launchEnv?: NodeJS.ProcessEnv): boolean
  abstract reconcileLegacySharedHomeForRetainedPanes(): void
  abstract syncActiveWslSelectionsBeforeRestart(): void

  protected abstract getWslSystemCodexHomePath(target: CodexAccountSelectionTarget): string | null
  protected abstract syncWslConfigAndGlobalInstructionsForLaunch(
    target: CodexAccountSelectionTarget,
    runtimeHomePath: string | null
  ): void
  abstract prepareForRateLimitFetch(
    target?: CodexAccountSelectionTarget
  ): CodexRateLimitHomeResolution
  abstract syncForCurrentSelection(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv
  ): void
  abstract clearLastWrittenAuthJson(accountId?: string | null): void

  protected abstract readBackRefreshedTokensFromPath(
    runtimeAuthPath: string,
    options: {
      updateLastWrittenAuthJson: boolean
      lastWrittenAuthJson?: string | null
      setLastWrittenAuthJson?: (contents: string) => void
      expectedAccountId?: string
    }
  ): CodexReadBackResult
  protected abstract resolveSystemDefaultMirrorClaim(
    runtimeAuth: string,
    provenanceStatus: CodexSharedRuntimeAuthProvenanceStatus
  ): { ownershipProven: boolean; mirroredAuthJson: string | null }
  protected abstract safeSyncForCurrentSelection(): void
  protected abstract safeRecoverInterruptedRuntimeAuthOperation(): void
  protected abstract getActiveAccount(
    accounts: CodexManagedAccount[],
    activeAccountId: string | null
  ): CodexManagedAccount | null
  protected abstract getWslManagedHomePath(account: CodexManagedAccount | null): string | null
  protected abstract getPreparedWslRateLimitHomePath(
    target: CodexAccountSelectionTarget
  ): string | null
  protected abstract syncWslRuntimeForCurrentSelection(
    target: CodexAccountSelectionTarget
  ): string | null
  protected abstract getWslRuntimeHomePath(distro: string): string | null
  protected abstract safeReadBackActiveWslAccountBeforeRestart(
    account: CodexManagedAccount,
    selectedDistroKey: string
  ): void
  protected abstract readBackActiveWslAccountBeforeRestart(
    account: CodexManagedAccount,
    selectedDistroKey: string
  ): void
  protected abstract safeMigrateLegacyWslActiveHomePointer(
    distro: string,
    runtimeHomePath: string
  ): void
  protected abstract migrateLegacyWslActiveHomePointer(
    distro: string,
    runtimeHomePath: string
  ): void
  protected abstract dirnameLinuxPath(value: string): string
  protected abstract joinWslPath(basePath: string, ...segments: string[]): string
  protected abstract resolveWslDefaultTarget(
    target: CodexAccountSelectionTarget
  ): CodexAccountSelectionTarget
  protected abstract getWslSystemCodexAuthPath(target: CodexAccountSelectionTarget): string | null
  protected abstract seedWslRuntimeHome(
    runtimeHomePath: string,
    activeAccount: CodexManagedAccount | null,
    distro: string
  ): void
  protected abstract findManagedAccountForRuntimeAuth(
    runtimeAuthContents: string,
    expectedAccountId?: string
  ): CodexReadBackMatch
  protected abstract runtimeAuthMatchesSystemDefaultIdentity(
    runtimeAuthContents: string,
    systemDefaultAuthContents: string
  ): boolean
  protected abstract runtimeAuthIsFresher(
    runtimeAuthContents: string,
    managedAuthContents: string
  ): boolean

  protected abstract safeMigrateLegacySharedAuth(): void
  protected abstract safeMigrateLegacyManagedState(): void
  protected abstract safeMigrateLegacyActiveHomePointer(): void
  protected abstract getRuntimeHomePath(): string
  abstract getMirroredHostHomePathForStatus(): CodexMirroredHomeStatus
  protected abstract getRuntimeAuthPath(): string
  protected abstract getSystemDefaultSnapshotPath(): string
  protected abstract getRuntimeLogoutMarkerPath(): string
  protected abstract getSharedRuntimeAuthProvenancePath(): string
  protected abstract getRuntimeMetadataDir(): string
  protected abstract getLegacyHostActiveHomePath(): string
  protected abstract getMigrationMarkerPath(): string
  protected abstract getMigrationDiagnosticsPath(): string
  protected abstract getManagedAccountsRoot(): string
  protected abstract repointLegacyActiveHomePointer(
    activeHomePath: string,
    runtimeHomePath: string
  ): void
  protected abstract activeHomeAlreadyPointsToRuntimeHome(
    activeHomePath: string,
    runtimeHomePath: string
  ): boolean
  protected abstract linkTargetsMatch(
    linkTarget: string,
    linkPath: string,
    expectedTargetPath: string
  ): boolean
  protected abstract legacyActiveHomeLinkIsReplaceable(activeHomePath: string): boolean
  protected abstract legacyActiveHomePathExists(activeHomePath: string): boolean
  protected abstract removeLegacyActiveHomeLinkIfOwned(activeHomePath: string): void
  protected abstract isWindowsReadableLink(targetPath: string): boolean
  protected abstract migrateLegacyManagedStateIfNeeded(): void
  protected abstract getLegacyManagedHomes(): string[]
  protected abstract migrateLegacyHistory(managedHomePath: string): void
  protected abstract migrateLegacySessions(managedHomePath: string, accountId: string): void
  protected abstract listFilesRecursively(rootPath: string): string[]
  protected abstract appendListedFiles(target: string[], source: readonly string[]): void
  protected abstract getPreservedLegacySessionPath(
    runtimeFilePath: string,
    accountId: string
  ): string
  protected abstract appendMigrationDiagnostic(record: Record<string, string>): void

  protected abstract captureSystemDefaultSnapshot(options: { force: boolean }): void
  protected abstract syncRuntimeAuthWithSystemDefault(): void
  protected abstract syncLegacySharedSystemDefaultAuthForRetainedPanes(): void
  protected abstract restoreSystemDefaultSnapshot(options: { detectExternalLogin: boolean }): void
  protected abstract writeSystemDefaultAuth(contents: string): void
  protected abstract clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath: string): void
  protected abstract readSystemDefaultAuth(): string | null
  protected abstract writeRuntimeAuth(
    contents: string,
    owner: { owner: 'system-default' } | { owner: 'managed'; accountId: string },
    options?: { expectedContents: string | null }
  ): boolean
  protected abstract writeRuntimeAuthAtPath(authPath: string, contents: string): void
  protected abstract compareFileContents(targetPath: string, contents: string): boolean | null
  protected abstract fileContentsEqual(targetPath: string, contents: string): boolean
  protected abstract fileContentsMatchExpected(
    targetPath: string,
    expectedContents: string | null
  ): boolean
  protected abstract ensureOwnerOnlyMode(targetPath: string): void
  protected abstract getRuntimeLogoutMarkerStatus(): CodexRuntimeLogoutMarkerStatus
  protected abstract persistRuntimeLogoutMarker(systemDefaultAuthJson?: string | null): void
  protected abstract readRuntimeLogoutMarker(): CodexRuntimeLogoutMarker | null
  protected abstract clearRuntimeLogoutMarker(): void
  protected abstract persistSharedRuntimeAuthProvenance(
    provenance: CodexSharedRuntimeAuthProvenanceFile
  ): void
  protected abstract markSharedRuntimeAuthManaged(accountId: string): void
  protected abstract getUntouchedSystemDefaultBaseline(
    status: CodexSharedRuntimeAuthProvenanceStatus,
    runtimeAuthJson: string | null
  ): { authJson: string | null } | null
  protected abstract restoreUntouchedSystemDefaultProvenance(
    provenance: Extract<CodexSharedRuntimeAuthProvenance, { owner: 'managed' }>
  ): Extract<CodexSharedRuntimeAuthProvenance, { owner: 'system-default' }> | null
  protected abstract sharedRuntimeAuthProvenanceMatches(
    status: CodexSharedRuntimeAuthProvenanceStatus,
    expected: CodexSharedRuntimeAuthProvenance
  ): boolean
  protected abstract resolveSharedRuntimeAuthProvenanceStatus(): CodexSharedRuntimeAuthProvenanceStatus
  protected abstract parseSharedRuntimeAuthProvenance(
    value: unknown
  ): CodexSharedRuntimeAuthProvenance | null
  protected abstract parseSystemDefaultBaseline(value: unknown): { authJson: string | null } | null
  protected abstract parsePendingSharedRuntimeAuthProvenance(
    value: unknown
  ): CodexSharedRuntimeAuthPendingProvenance | null
  protected abstract readRuntimeAuthForProvenance(): string | null
  protected abstract readSystemDefaultSnapshot(
    snapshotPath: string
  ): CodexSystemDefaultSnapshot | null
  abstract clearSystemDefaultSnapshot(): void
}
