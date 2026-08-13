/* eslint-disable max-lines -- Why: OrcaRuntimeService still owns the mutable live graph, PTY handles, waiters, mobile floor/layout state, and managed-worktree reconciliation. Stateless browser and file command adapters live beside it; the remaining split points need state-owner extraction before enforcing max-lines. */
/* eslint-disable unicorn/no-useless-spread -- Why: waiter sets and handle keys are cloned intentionally before mutation so resolution and rejection can safely remove entries while iterating. */
/* eslint-disable no-control-regex -- Why: terminal normalization must strip ANSI and OSC control sequences from PTY output before returning bounded text to agents. */
import {
  detectAgentStatusFromTitle,
  isClaudeManagementTitle,
  isCursorAgentTitle,
  isCursorNativeAgentTitle,
  normalizeTerminalTitle
} from '../../shared/agent-detection'
import { extractOscTitleScanTail } from '../../shared/osc-title-scan-tail'
import { extractLastOsc7Uri, extractOscScanTail } from '../daemon/osc7-uri-extraction'
import { parseFileUriPathParts } from '../daemon/osc7-file-uri'
import type { AgentStatus } from '../../shared/agent-detection'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalOutputSourceRange } from '../../shared/terminal-output-source-range'
import type {
  RemoteTerminalSourceRangeConsumerHooks,
  RemoteTerminalSourceRangeReplacementPublication,
  RemoteTerminalSourceRangeReplacementReservation,
  RemoteTerminalSourceRangeStreamIdentity
} from './remote-terminal-source-range-consumer'
import {
  createTerminalTitleTracker,
  type TerminalTitleFactMeta
} from '../../shared/terminal-output-side-effects'
import { getDecorativeAgentTitleSignature } from '../../shared/agent-decorative-title-signature'
import { createCommandCodeOutputStatusDetector } from '../../shared/command-code-output-status'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../shared/terminal-side-effect-facts'
import type { TerminalGitHubPRLink } from '../../shared/terminal-github-pr-link-detector'
import { TerminalKittyKeyboardModeTracker } from '../../shared/terminal-kitty-keyboard-mode-tracker'
import { parseTerminalKittyKeyboardFlags } from '../../shared/terminal-kitty-keyboard-flags'
import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload,
  AgentStatusOrchestrationContext,
  AgentStatusEntry
} from '../../shared/agent-status-types'
import type { AgentHookAuthorityAttestation } from '../agent-hooks/server'
import type {
  AgentLaunchPreferences,
  RuntimeAgentSessionRpcCaller,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../shared/agent-session-host-authority'
import {
  canonicalizeAgentSessionIdentity,
  createEphemeralAgentSessionClaimSigner,
  type AgentSessionClaimSigner
} from './agent-session-claim-identity'
import {
  hasCompatibleAgentTitleIdentity,
  normalizeCompatibleAgentTitleForOwner
} from '../../shared/agent-title-owner'
import {
  createAgentStatusOscProcessor,
  type ProcessedAgentStatusChunk
} from '../../shared/agent-status-osc'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from './orchestration/db'
import { reconcileRequestedWorkerTerminalReleases } from './orchestration/worker-terminal-release-reconciliation'
import {
  classifyWorkerTerminalProcessIncarnation,
  parseWorkerTerminalHostScope
} from './orchestration/worker-terminal-process-liveness'
import { OrchestrationError } from './orchestration/orchestration-error'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import { createSetupCompletionScanner } from './orchestration/setup-completion-signal'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import type {
  ArtifactCloudOperation,
  ArtifactCloudOptions,
  ArtifactListOptions,
  ArtifactListPage,
  ArtifactListItem,
  ArtifactPublishedLink,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../shared/artifacts'
import type { ArtifactCloudService } from '../artifacts/artifact-cloud-service'
import { shouldForwardHeadlessTerminalQueryReply } from './headless-terminal-query-reply-policy'
import type {
  OrchestrationCompatibilityEvidence,
  OrchestrationCompatibilityHostStamp
} from '../../shared/orchestration-compatibility-evidence'
import type {
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from './orchestration/environment-transport'
import { formatMessagePointer } from './orchestration/formatter'
import { MailPointerRepointScheduler } from './orchestration/mail-pointer-repoint-scheduler'
import { selectExactWorkerProviderSession } from './orchestration/worker-provider-session'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { CreateWorktreeResult, ForceDeleteWorktreeBranchResult, RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { DetectedWorktreeListResult, GitHubPrStartPoint, GitPushTarget, GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { Repo } from '../../shared/repo-types'
import type { StatsSummary, MemorySnapshot } from '../../shared/process-stats-types'
import type { WorktreeLineage, WorkspaceLineage, WorktreeLineageWarning } from '../../shared/worktree/lineage-types'
import type { WorkspaceKey, FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { WorktreeBaseStatusEvent } from '../../shared/worktree/base-ref-drift-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { Tab, TabGroupLayoutNode } from '../../shared/tab-types'
import type { TerminalQuickCommand } from '../../shared/terminal-quick-command-types'
import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { getRegisteredSshState } from '../ipc/ssh'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { ExactWorkerProviderSession } from '../../shared/orchestration-worker-output'
import { applyBrowserSessionTabSelection } from './browser-session-tab-selection-snapshot'
import type { BrowserSessionTabSelectionOptions } from './browser-tab-create-publication'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { toRuntimeActivateWorktreeEvent } from '../../shared/runtime-client-events'
import {
  navigationTargetsClients,
  navigationTargetsHost,
  type RuntimeNavigationTarget
} from '../../shared/runtime-navigation'
import {
  isAutomaticTabActivation,
  type TabActivationIntent
} from '../../shared/tab-activation-intent'
import type { SshConnectionState } from '../../shared/ssh-types'
import { getPublicSshState } from './public-ssh-state'
import { closeTerminalTabInWorkspaceSession } from '../../shared/workspace-session-terminal-tab-close'
import {
  BROWSER_UNAVAILABLE_ERROR_CODE,
  browserUnavailableMessage,
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeDegradation,
  type RuntimeDesktopWindowStatus,
  type RuntimeGraphStatus,
  type RuntimeRepoSearchRefs,
  type RuntimeTerminalRead,
  type RuntimeTerminalRename,
  type RuntimeTerminalAgentStatus,
  type RuntimeTerminalSend,
  type RuntimeTerminalCreate,
  type RuntimeTerminalPresentation,
  type RuntimeTerminalSplit,
  type RuntimeTerminalFocus,
  type RuntimeTerminalClose,
  type RuntimeTerminalListResult,
  type RuntimeTerminalOrphanAdoptionRequest,
  type RuntimeTerminalOrphanAdoptionResult,
  type RuntimeWorktreeTerminalSleepResult,
  type RuntimeTerminalResolvePane,
  type RuntimeStatus,
  type RuntimeSyncWindowGraphResult,
  type RuntimeTerminalWait,
  type RuntimeTerminalWaitCondition,
  type RuntimeWorktreePsSummary,
  type RuntimeTerminalShow,
  type RuntimeTerminalSummary,
  type RuntimeSyncedLeaf,
  type RuntimeSyncedTab,
  type RuntimeMarkdownReadTabResult,
  type RuntimeMarkdownSaveTabResult,
  type RuntimeMobileSessionCreateTerminalResult,
  type RuntimeMobileSessionClientTab,
  type RuntimeMobileSessionTabCloseResult,
  type RuntimeMobileSessionMarkdownTab,
  type RuntimeMobileSessionTabMove,
  type RuntimeMobileSessionTabMoveResult,
  type RuntimeMobileSessionTabGroup,
  type RuntimeMobileSessionSnapshotTab,
  type RuntimeMobileSessionTerminalTab,
  type RuntimeMobileSessionBrowserTab,
  type RuntimeMobileSessionTabsRemovedResult,
  type RuntimeMobileSessionTabsResult,
  type RuntimeMobileSessionTabsSnapshot,
  type RuntimeSessionTabCloseReason,
  type RuntimeTerminalDriverState,
  type RuntimeRendererSyncWindowGraph,
  type RuntimeSyncWindowGraph,
  type RuntimeWorktreeListResult,
  type BrowserTabInfo,
  UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
} from '../../shared/runtime-types'
import {
  RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
  RuntimeGraphReloadLifecycle
} from './runtime-graph-reload-lifecycle'
import type { FeatureInteractionId } from '../../shared/feature-interactions'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import {
  WORKTREE_ID_SEPARATOR,
  getRepoIdFromWorktreeId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../shared/worktree/id'
import { isFolderRepo } from '../../shared/repo-kind'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import { FIRST_PANE_ID } from '../../shared/pane-key'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { isValidHostTerminalTabId, isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type { TerminalQuickCommandMutation } from '../../shared/terminal-quick-commands'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan
} from '../../shared/tui-agent-startup'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isWindowsAbsolutePathLike, isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { findRuntimeWorkspaceFileOwner } from '../../shared/runtime-workspace-file-owner'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import { isWslUncPath, parseWslUncPath } from '../../shared/wsl-paths'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../shared/workspace-scope'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import type { WorktreeVisibilitySourceMatcher } from '../../shared/worktree/visibility-sources'
import { folderWorkspaceToWorktree } from '../../shared/folder-workspace-worktree'
import { nativeChatTranscriptIncludesPath } from '../native-chat/native-chat-file-provenance'
import { isAgentScratchRepoRootPath } from '../../shared/agent-scratch-worktrees'
import {
  BROWSER_HEADLESS_RUNTIME_CAPABILITY,
  BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
import { configureAiVaultSessionSources } from '../ai-vault/cached-session-list'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type {
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortProbe,
  WorkspacePortScanResult
} from '../../shared/workspace-ports'
import {
  filterWorkspacePortProbes,
  killWorkspacePort,
  scanWorkspacePortProbes
} from '../ports/workspace-port-ownership'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import type { AutomationService } from '../automations/service'
import {
  runtimeBrowserCommandsFactoryIsHeadless,
  runtimeBrowserUnavailableCause
} from './runtime-browser-commands-factory'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { ClientHostedBrowserRowPublisher } from './client-hosted-browser-row-publication'
import {
  persistClientHostedBrowserPages,
  rehydrateClientHostedBrowserPages
} from './client-hosted-browser-page-persistence'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'
import { closeClientHostedBrowserPagesForWorktree } from './worktree-browser-client-page-close'
import {
  routeRuntimeBrowserClientAutomation,
  type ClientHostedBrowserRpcRoute
} from './runtime-browser-client-automation'
import { resolveRuntimeBrowserNetworkExecutionHost } from './runtime-browser-network-execution-host'
import { ClientHostedPageReconciliationWindow } from './client-hosted-page-reconciliation-window'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'
import { browserNetworkExecutionHostKey } from '../browser/browser-network-execution-route'
import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import { sameRuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'
import { RuntimeArtifactController } from './runtime-artifact-controller'
import {
  RuntimeAutomationController,
  type RuntimeAutomationCreateInput,
  type RuntimeAutomationUpdateInput
} from './runtime-automation-controller'
import { RuntimeBrowserDriverController } from './runtime-browser-driver-controller'
import {
  RuntimeClientSettingsController,
  type RuntimeClientSettingsUpdate
} from './runtime-client-settings'
import { RuntimeOrchestrationFederation } from './runtime-orchestration-federation'
import { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryInventory,
  LegacyWorkerTerminalRecoveryResult,
  TerminalWorkspaceLaunchScope
} from './runtime-legacy-worker-terminal-recovery-types'
export type { LegacyWorkerTerminalRecoveryResult } from './runtime-legacy-worker-terminal-recovery-types'
export type {
  RuntimeAutomationCreateInput,
  RuntimeAutomationUpdateInput
} from './runtime-automation-controller'
import { RuntimeGitLabMutationCommands } from './runtime-gitlab-mutation-commands'
import { RuntimeGitLabQueryCommands } from './runtime-gitlab-query-commands'
import { RuntimeGitHubProjectCommands } from './runtime-github-project-commands'
import { RuntimeGitHubIssueCommentCommands } from './runtime-github-issue-comment-commands'
import { RuntimeGitHubReviewMutationCommands } from './runtime-github-review-mutation-commands'
import { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'
import { RuntimeGitHubRepositoryQueryCommands } from './runtime-github-repository-query-commands'
import { RuntimeHostedReviewCommands } from './runtime-hosted-review-commands'
import { RuntimeRepositoryHooksCommands } from './runtime-repository-hooks-commands'
import { RuntimeRepositoryIssueCommand } from './runtime-repository-issue-command'
import { RuntimeSubscriptionRegistry } from './runtime-subscription-registry'
import { RuntimeMobileNotificationController } from './runtime-mobile-notification-controller'
import { RuntimeAccountController } from './runtime-account-controller'
import { RuntimeMobileSpeechCatalog } from './runtime-mobile-speech-catalog'
import { RuntimeMobileDictationController } from './runtime-mobile-dictation-controller'
import { RuntimeMessageWaiters } from './runtime-message-waiters'
import { RuntimeClientEventBus } from './runtime-client-event-bus'
import { RuntimeNativeChatDraftResolutions } from './runtime-native-chat-draft-resolutions'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import { RuntimeNestedRepoImport } from './runtime-nested-repo-import'
import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'
import { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'
import { RuntimeRepositorySettingsController } from './runtime-repository-settings-controller'
import { RuntimeRepositorySparsePresets } from './runtime-repository-sparse-presets'
import { RuntimeRepositoryRefQueries } from './runtime-repository-ref-queries'
import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'
import { RuntimeAiVaultCommands } from './runtime-ai-vault-commands'
import { RuntimeTerminalDriverController } from './runtime-terminal-driver-controller'
import { RuntimeTerminalViewSubscribers } from './runtime-terminal-view-subscribers'
import {
  attachRuntimeWorktreeAgentRows,
  type RuntimeAgentRowSnapshot
} from './runtime-worktree-agent-rows'
import { RuntimeServerEnvironmentCommands } from './runtime-server-environment-commands'
import { RuntimeRepositoryForkBackfill } from './runtime-repository-fork-backfill'
import { RuntimeWorktreeLifecycleEvents } from './runtime-worktree-lifecycle-events'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import {
  applyRuntimeWorktreePsSessionActivity,
  applyRuntimeWorktreePsTerminalActivity
} from './runtime-worktree-ps-activity'
import type {
  HeadlessSeedMetadata,
  ProviderBufferAcquisition,
  RuntimeHeadlessTerminal,
  RuntimeLeafRecord,
  RuntimePtyTitleTrackerEntry,
  RuntimePtyWorktreeRecord,
  RuntimeTerminalBufferSnapshot,
  RuntimeVisibleTerminalState
} from './runtime-terminal-state-records'
import type {
  AgentSessionCreateOperation,
  OrchestrationCompatibilityCallerAuthority,
  OrchestrationCompatibilitySshAttachmentAuthority,
  OrchestrationCompatibilityTerminalAuthority,
  PtyForegroundProcessRead,
  RestoredOrchestrationAuthorityReceipt,
  RuntimePtyDataAdmission,
  RuntimeTerminalAgentStatusEvent,
  TerminalCreateOptions,
  TerminalHandleRecord,
  TerminalWaiter
} from './runtime-terminal-contracts'
export type {
  OrchestrationCompatibilityCallerAuthority,
  OrchestrationCompatibilityTerminalAuthority,
  RuntimePtyDataAdmission,
  RuntimeTerminalAgentStatusEvent
} from './runtime-terminal-contracts'
export type { MessageWaitResult } from './runtime-message-waiters'
export type { AccountsSnapshot, CodexRateLimitResetRpcResult } from './runtime-account-controller'
export type {
  MobileNotificationDispatchEvent,
  MobileNotificationDismissEvent,
  MobileNotificationEvent
} from './runtime-mobile-notification-controller'
import {
  RuntimeEdgeCommandController,
  type RuntimeEdgeCommandSurface
} from './runtime-edge-command-controller'
import {
  committedMobileSessionTabClose,
  delegatedMobileSessionTabClose,
  refusedMobileSessionTabClose,
  type MobileSessionTabCloseOutcome
} from './mobile-session-tab-close-outcome'
import {
  assertTerminalInputWithinLimitWithYield,
  buildTerminalSendPayload
} from './terminal-send-payload'
import { notifyRuntimeListeners, withTimeout, withTimeoutResult } from './runtime-async-boundaries'
import { readRepoWorktreeAdminFingerprint } from './repo-worktree-admin-fingerprint'
import { RuntimeLinearBrowseCommands } from './runtime-linear-browse-commands'
import { RuntimeLinearCommands } from './runtime-linear-connection-commands'
import {
  installRuntimeLinearCommandSurface,
  type RuntimeLinearCommandSurface
} from './runtime-linear-command-surface'
import {
  RuntimeTerminalStreamConsumers,
  type RuntimeTerminalDataMeta
} from './runtime-terminal-stream-consumers'
export type { RuntimeTerminalDataMeta } from './runtime-terminal-stream-consumers'
import {
  RuntimeRemoteFetchController,
  type RemoteFetchResult,
  type RemoteTrackingBase
} from './runtime-remote-fetch-controller'
import { RuntimeWorktreeBaseReconciliation } from './runtime-worktree-base-reconciliation'
import {
  buildWorktreeStartupForAgent,
  buildWorktreeStartupForDraft,
  markLocalWorktreeTrusted,
  markRemoteWorktreeTrusted,
  type WorktreeStartupDraftPaste,
  type WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import {
  pasteWorktreeStartupDraftWhenReady,
  sendWorktreeStartupFollowupWhenReady,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'
import {
  provisionWorktreeTerminals,
  type WorktreeProvisionTerminalOptions,
  type WorktreeTerminalProvisioningHost
} from './runtime-worktree-terminal-provisioning'
import { recordCreatedWorktreeLineage as recordCreatedWorktreeLineageState } from './runtime-worktree-lineage-recording'
export type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
import { RemoteRuntimeTerminalCreateIdempotency } from './remote-runtime-terminal-create-idempotency'
import { deriveRemoteRuntimeTerminalCreateHandle } from './remote-runtime-terminal-create-identity'
import {
  buildHeadlessTerminalSplitLayout,
  countTerminalLayoutLeaves,
  terminalLayoutContainsLeaf
} from './headless-terminal-split-layout'
import { RECENT_PTY_OUTPUT_LIMIT, RecentPtyOutputBuffer } from './recent-pty-output-buffer'
import {
  buildHeadlessTabGroupMove,
  buildHeadlessTabGroupSplit
} from './headless-tab-group-split-layout'
import {
  retireTerminalSurfacesFromSnapshot,
  type RetiredTerminalSurface
} from './mobile-session-terminal-retirement'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'
import {
  advanceTerminalTopologyRevision,
  hasHostAuthoritativeTerminalMembership
} from './workspace-session-terminal-membership-authority'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import { getRuntimeFileTargetExecutionHostId, RuntimeFileCommands } from './orca-runtime-files'
import { RuntimeGitCommands } from './orca-runtime-git'
import {
  installRuntimeFileCommandSurface,
  type RuntimeFileCommandSurface
} from './runtime-file-command-surface'
import {
  installRuntimeGitCommandSurface,
  type RuntimeGitCommandSurface
} from './runtime-git-command-surface'
import {
  installRuntimeRepositoryCommandSurface,
  type RuntimeRepositoryCommandSurface
} from './runtime-repository-command-surface'
import {
  installRuntimeReviewCommandSurface,
  type RuntimeReviewCommandSurface
} from './runtime-review-command-surface'
import {
  installRuntimeServiceCommandSurface,
  type RuntimeServiceCommandSurface
} from './runtime-service-command-surface'
import {
  activateClientSessionTabSelection,
  ClientSessionTabSelectionStore,
  deriveClientSessionTabSelection,
  projectClientSessionTabSelection
} from './client-session-tab-selection'
import type { PtyProviderBufferSnapshot, IPtyProvider, PtyTransientFact } from '../providers/types'
import { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import type {
  AgentTeamsTmuxCompatRequest,
  AgentTeamsTmuxCompatResponse
} from './claude-agent-teams-service'
import {
  buildClaudeAgentTeamsLaunchPlan,
  ensureClaudeAgentTeamsShimDir,
  resolveClaudeAgentTeamsShimBin
} from './claude-agent-teams-shim-env'
import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess
} from '../../shared/claude-agent-teams-tmux-compat'
import { collectMemorySnapshot } from '../memory/collector'
import { BrowserWindow, ipcMain } from 'electron'
import { RendererPublicationThrottle } from '../window/renderer-publication-throttle'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend } from '../browser/browser-backend'
import { recordGitLabProjectRecent } from '../gitlab/gitlab-project-recents'
import {
  getLocalProjectWorktreeGitOptions,
  getLocalProjectWorktreeGitOptionsForRuntime,
  resolveLocalProjectRuntimeForRepo,
  resolveLocalProjectRuntimesForRepos
} from '../project-runtime-git-options'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { resolveTerminalOrchestrationCliCommand } from './orchestration/cli-command'
import {
  scanLocalRepoWorktreesForResolution,
  type RuntimeWorktreeScanResult
} from './repo-worktree-resolution-scan'
import {
  listStoredWorktreeRowsForRepo,
  resolveRepoWorktreeRows,
  resolveScopedWorktreeIdRow,
  RESOLVED_WORKTREE_REPO_TIMEOUT_MS,
  type RepoWorktreeRowDeps
} from './repo-worktree-row-resolution'
import { removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval } from '../local-worktree-removal-recovery'
import { listWorktreesStrict } from '../git/worktree'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { pruneLineageForMissingRepoWorktrees } from '../worktree-lineage-pruning'
import { deleteWorktreeHistoryDir } from '../terminal-history-deletion'
import { cleanupUnusedWorktreePushTargetRemote } from '../ipc/worktree-remote'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { AgentDetector } from '../stats/agent-detector'
import {
  formatWorktreeRemovalError,
  mergeWorktree,
  areWorktreePathsEqual
} from '../ipc/worktree-logic'
import { findRegisteredDeletableWorktree } from '../worktree-removal-safety'
import {
  hasWorktreeRemovalRepoOwnerOnOtherHost,
  resolveWorktreeRemovalMetadata,
  resolveWorktreeRemovalRepoOwner
} from '../worktree-removal-repo-owner'
import { prefetchWorktreeCreateBase } from '../worktree-create-base-prefetch'
import { createRuntimeFileWatcherRemoval } from './runtime-file-watcher-removal'
import { RuntimeTerminalAgentPresence } from './runtime-terminal-agent-presence'
import {
  RuntimeResolvedWorktreeCache,
  type ResolvedWorktreeSnapshot
} from './runtime-resolved-worktree-cache'
import {
  WorktreeIdRequiresFullPathError,
  type WorktreeLineageInput,
  type WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import { RuntimeAgentOrchestrationProjection } from './runtime-agent-orchestration-projection'
import { RuntimeTerminalList } from './runtime-terminal-list'
import { RuntimeTerminalWaiterRegistry } from './runtime-terminal-waiter-registry'
import { RuntimeTerminalWriter, type RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimeRemoteWorktreeCreateArgs } from './runtime-remote-worktree-create-request'
import { createRuntimeRemoteManagedWorktree } from './runtime-remote-managed-worktree-create'
import {
  RuntimeTerminalAgentStatusQuery,
  type RuntimeTerminalAgentStatusSnapshot
} from './runtime-terminal-agent-status-query'
import { RuntimeAgentRowStore } from './runtime-agent-row-store'
import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import { adoptRuntimeTerminalOrphansFromInventory } from './runtime-terminal-orphan-adoption'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import { RuntimeTerminalWait as RuntimeTerminalWaitController } from './runtime-terminal-wait'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import { withWorktreeSpan } from '../observability/instrumentation'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { PtyShellOwnershipMirror } from './pty-shell-ownership-mirror'
import {
  isNativeWindowsConptyPty,
  registerConptyDa1OverrideInstaller,
  shouldModelAnswerHiddenPtyQueries
} from './terminal-model-query-authority'
import {
  getTerminalViewAttributes,
  getTerminalViewColorQueryReplyColors,
  registerTerminalViewAttributesApplier
} from './terminal-view-attribute-store'
import { killAllProcessesForWorktree, teardownRpcDeadline } from './worktree-teardown'
import { stopMissingWorktreeTerminals } from './missing-worktree-terminal-reconciliation'
import { MOBILE_SUBSCRIBE_SCROLLBACK_ROWS } from './scrollback-limits'
import {
  createMobileSessionTabsNotifyCoalescer,
  type MobileSessionTabsNotifyCoalescer
} from './mobile-session-tabs-notify-coalescer'
import {
  createMobileSessionTabsAgentStatusHeartbeat,
  type MobileSessionTabsAgentStatusHeartbeat
} from './mobile-session-tabs-agent-status-heartbeat'
import { TerminalFocusNavigationCoalescer } from './terminal-focus-navigation-coalescer'
import {
  appendRecentPtyPathCandidates,
  recentTerminalOutputIncludesPath,
  recentTerminalPathCandidatesIncludePath
} from './terminal-output-path-candidates'
import { getRuntimeFolderWorkspaceRootId } from './runtime-folder-workspace'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus,
  inferFolderWorkspacePathConnection
} from '../project-groups/folder-workspace-path-status'
import {
  getSshGitProvider,
  getSshGitProviderGeneration,
  requireSshGitProvider
} from '../providers/ssh-git-dispatch'
import { enrichMissingRepoGitRemoteIdentities } from '../repo-git-remote-identity-enrichment'
import {
  copySleepingAgentLaunchConfig,
  deterministicAgentSessionUuid,
  getAgentLaunchPlatformForRepo,
  inferCapturedClaudeAgentTeamsMode,
  isAgentSessionOperationOutcomeUnknown,
  mergeTerminalEnvDeletionKeys,
  resolveBareAgentLaunchCommand
} from './runtime-agent-launch-resolution'
import {
  getExplicitWorktreeIdSelector,
  getRuntimeWorktreeRemovalOptionsKey,
  type RuntimeWorktreeRemovalTarget
} from './runtime-worktree-selection'
import {
  isRuntimeWorktreePathMissing,
  listRuntimeFolderWorkspaces
} from './runtime-worktree-filesystem'
import { resolveRuntimeGitHubWorktreeBase } from './runtime-github-worktree-base'
import { resolveRuntimeGitLabWorktreeBase } from './runtime-gitlab-worktree-base'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'
import { removeRuntimeUnregisteredWorktree } from './runtime-unregistered-worktree-removal'
import { removeRuntimeRegisteredLocalWorktree } from './runtime-registered-local-worktree-removal'
import { RuntimePreservedBranchCleanup } from './runtime-preserved-branch-cleanup'
import { removeRuntimeRegisteredRemoteWorktree } from './runtime-registered-remote-worktree-removal'
import { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'
import { prepareRuntimeLocalWorktreeSetup } from './runtime-local-worktree-setup'
import { probeRuntimeWorktreeDrift } from './runtime-worktree-drift-probe'
import { createRuntimeLocalManagedWorktree } from './runtime-local-worktree-create'
import { RuntimeWorktreeRemovalInFlight } from './runtime-worktree-removal-in-flight'
import { resolveRuntimeWorktreeRemovalTarget } from './runtime-worktree-removal-target'
import {
  persistRuntimeManagedWorktreeSortOrder,
  updateRuntimeManagedWorktreeMetadata
} from './runtime-managed-worktree-metadata'
import { clampTerminalViewport } from './terminal-viewport'
import { RemoteDesktopTerminalFloor } from './remote-desktop-terminal-floor'
import type { RuntimeStore } from './runtime-store-contract'
import type {
  PtyControllerInventory,
  PtyControllerTerminalIdentity,
  RuntimePtyController
} from './runtime-pty-controller-contract'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import { headlessMobileSnapshotContentUnchanged } from './mobile-session-snapshot-equality'
import { headlessBrowserTabsUnchanged } from './mobile-session-browser-equality'
import {
  appendBrowserTabOrder,
  collectBrowserGroupAssignment
} from './mobile-session-browser-group-projection'
import {
  getMobileSessionSnapshotTabIdentityKeys,
  mergeMobileSessionSnapshotTabs,
  mergeMobileSessionTabGroups
} from './mobile-session-tab-merge'
import {
  buildHeadlessMobileSessionTabGroups,
  buildMaterializedHeadlessParentLayout,
  cloneTerminalLayoutSnapshot,
  collectHeadlessParentTabOrder,
  distributeHeadlessTabsAcrossGroups,
  getHeadlessMobileSessionGroupId,
  pickHeadlessActiveTerminalTab
} from './mobile-session-layout-projection'
import { detectExplicitIdleStatusFromTitle } from './terminal-wait-detection'
import {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason,
  type TerminalTailWaitState
} from './terminal-wait-tail-state'
import {
  buildPtyTerminalWaitResult,
  buildTerminalWaitResult,
  getTerminalState
} from './terminal-wait-results'

export {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason,
  type TerminalTailWaitState
} from './terminal-wait-tail-state'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import {
  appendCompletedTerminalTranscript,
  buildPreview,
  tailStateMatches
} from './terminal-tail-state'
import {
  buildRestoredTerminalTailSeed,
  applyRestoredTerminalTailSeed,
  restoredTerminalTailSeedAllowed
} from './terminal-tail-restore-seed'
import {
  buildVisibleSnapshotReadFallback,
  readTerminalTail,
  shouldFallbackToVisibleTerminalSnapshot,
  terminalReadLimit,
  visibleNonBlankTerminalLines
} from './terminal-tail-read'
import { DEFAULT_TERMINAL_READ_LIMIT, MAX_TAIL_CHARS } from './terminal-tail-limits'

export { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
export { appendNormalizedToMultilineTailBufferUnwindowed } from './terminal-tail-redraw-buffer'
export { buildPreview } from './terminal-tail-state'
export { buildRestoredTerminalTailSeed } from './terminal-tail-restore-seed'
import {
  branchSelectorMatches,
  createIncrementalResolvedWorktreeLookup,
  findResolvedWorktreeIdForPath,
  includeTargetResolvedWorktree,
  inferWorktreeIdFromPtyId,
  parseRuntimeWorktreeId,
  resolveTerminalSessionWorktreeId,
  runtimePathsEqual,
  runtimeWorktreeIdentityKey,
  runtimeWorktreeIdsEqual,
  type ResolvedWorktree
} from './runtime-worktree-path-identity'
import {
  indexPersistedPtySurfaceBindings,
  indexPersistedPtyWorktreeBindings,
  setsEqual
} from './runtime-worktree-binding-index'
import {
  buildRuntimeWorktreeSummaryPathIndex,
  findRuntimeWorktreeSummaryByPath,
  type RuntimeWorktreeSummaryPathIndex
} from './runtime-worktree-summary-paths'
import {
  compareWorktreePs,
  getLatestLeafTitle,
  getLatestPtyTitle,
  maxTimestamp,
  terminalTitleBlocksExplicitAgentStatus
} from './runtime-worktree-status-projection'

type RuntimeWorktreeScanCache = {
  generation: number
  runtimeKey: string
  result: RuntimeWorktreeScanResult
  expiresAt: number
  adminFingerprint: string | null
  scannedAt: number
}

type RuntimeWorktreeScanInFlight = {
  generation: number
  runtimeKey: string
  promise: Promise<RuntimeWorktreeScanRefresh>
}

type RuntimeWorktreeScanRefresh = {
  result: RuntimeWorktreeScanResult
  adminFingerprint: string | null
  adminFingerprintProbe: Promise<string | null> | null
  scannedAt: number
}

type ResolvedTerminalWorkspaceLaunchTarget = {
  scope: TerminalWorkspaceLaunchScope
  managedWorktree: ResolvedWorktree | null
}

function isCursorAgentOrchestrationTarget(
  leaf: RuntimeLeafRecord,
  tabTitle: string | null | undefined
): boolean {
  return [leaf.lastOscTitle, leaf.paneTitle, tabTitle].some(isCursorAgentTitle)
}

const AGENT_SESSION_OPERATION_PER_CLIENT_LIMIT = 512
const AGENT_SESSION_OPERATION_GLOBAL_LIMIT = 4_096

// Why: long enough for a phone to reconnect and retry a create whose response
// was lost, short enough that an intentional later re-resume forks fresh.
const MOBILE_TERMINAL_CREATE_RESULT_TTL_MS = 60_000
// Why: same idempotency window for worktree.create — a phone whose create was
// interrupted by a connection migration retries with the same clientMutationId
// and reuses the just-created worktree instead of spawning a duplicate.
const WORKTREE_CREATE_RESULT_TTL_MS = 60_000
const MOBILE_TERMINAL_SURFACE_TIMEOUT_MS = 10_000
// Why: the split already failed; the caller waits on this teardown only to learn whether the
// fallback kill is needed, so keep it short — an unreachable host must not stall the rejection.
const REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS = 2_000
const CLAUDE_AGENT_PROMPT_RENDER_TIMEOUT_MS = 8000
const CLAUDE_AGENT_PROMPT_RENDER_QUIET_MS = 1500
// Why: Claude emits show-cursor while rendering its composer; output must settle afterward.
const CLAUDE_AGENT_PROMPT_RENDER_MARKER = '\x1b[?25h'
const MOBILE_TERMINAL_READY_FALLBACK_MS = 1000
const SSH_PANE_RECOVERY_GRACE_MS = 30_000
// Why: long enough that a keystroke burst to a proven-dead leaf probes once,
// short enough that a recreated session id regains writability quickly even if
// its runtime record (which also invalidates the verdict) is late.
const PROVEN_ABSENT_LEAF_PTY_TTL_MS = 15_000

function isClientDisconnectedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'client_disconnected'
}

function createTerminalRevealWarning(handle: string, error?: unknown): string {
  const reason =
    error instanceof Error && error.message.trim().length > 0
      ? ` Reason: ${error.message.trim()}.`
      : ''
  return [
    `Terminal ${handle} is running, but Orca could not make it discoverable.${reason}`,
    `Run \`orca terminal focus --terminal ${handle}\` to reveal and focus it.`
  ].join(' ')
}

// Why: an absent `surfaceOwner` means "default", so surfacing callers must omit
// the key rather than send `true`.
function ownerSurfacing(shouldSurface: boolean): { surfaceOwner?: false } {
  return shouldSurface ? {} : { surfaceOwner: false }
}

function resolveTerminalPresentation(opts: {
  presentation?: RuntimeTerminalPresentation
  focus?: boolean
  activate?: boolean
}): RuntimeTerminalPresentation | undefined {
  if (opts.presentation) {
    return opts.presentation
  }
  if (opts.focus === true || opts.activate === true) {
    return 'focused'
  }
  return undefined
}

// Subscribe a listener to a per-key Set, pruning the key's entry once its last
// listener unsubscribes. Returns the unsubscribe callback.
function addListenerToMap<T>(map: Map<string, Set<T>>, key: string, listener: T): () => void {
  let listeners = map.get(key)
  if (!listeners) {
    listeners = new Set<T>()
    map.set(key, listeners)
  }
  const set = listeners
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      map.delete(key)
    }
  }
}

const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

// Why: notificationSeq is the desktop-assigned monotonic sequence used for
// mobile reconnect catch-up (#8129). It is added on dispatch (and replay) so a
// client can watermark the last event it delivered and request exactly the
// events after it — idempotent, no duplicate local pushes.
export type RuntimeWorktreeLifecycleEvent =
  | { kind: 'created'; worktreeId: string; path: string; branch: string }
  | { kind: 'removed'; worktreeId: string; path: string }

// Why: presence-based driver state for the mobile-presence lock. Exactly one
// driver per PTY at any moment. See docs/mobile-presence-lock.md.
//   - `idle`: no mobile subscribers; desktop input flows freely
//   - `desktop`: at least one mobile client subscribed but desktop reclaimed
//      (or all mobile clients are passive `desktop`-mode watchers); desktop
//      input flows freely
//   - `mobile{clientId}`: a mobile client is the active driver; desktop
//      input/resize are dropped server-side and the lock banner is mounted.
//      `clientId` is the most recent mobile actor for this PTY.
export type DriverState = RuntimeTerminalDriverState

// Why: per-PTY layout target — what the PTY *should* be at right now.
// `desktop` ⇒ runs at the desktop renderer's pane geometry; mobile passive
// watchers (mode='desktop') still receive scrollback. `phone` ⇒ runs at
// `ownerClientId`'s viewport; the desktop renderer's auto-fit is suppressed.
// See docs/mobile-terminal-layout-state-machine.md.
export type PtyLayoutTarget =
  | { kind: 'desktop'; cols: number; rows: number }
  | { kind: 'phone'; cols: number; rows: number; ownerClientId: string }
  | { kind: 'remote-desktop'; cols: number; rows: number; ownerSubscriptionKey: string }

// Why: authoritative layout state with monotonic seq. Bumped on every
// applyLayout success; emitted on mobile subscribe-stream events so clients
// drop stale events that arrive after a newer transition.
export type PtyLayoutState = PtyLayoutTarget & {
  seq: number
  appliedAt: number
}

// Why: applyLayout result discriminator. Callers (especially RPC handlers)
// need to distinguish "shipped a new state at seq N" from "no-op — caller
// should not claim a seq it didn't produce." `pty-exited` is terminal;
// `resize-failed` is transient and the caller may retry.
export type ApplyLayoutResult =
  | { ok: true; state: PtyLayoutState }
  | { ok: false; reason: 'pty-exited' | 'resize-failed' }

type LayoutQueueEntry = {
  running: Promise<ApplyLayoutResult> | null
  pending: {
    target: PtyLayoutTarget
    waiters: ((r: ApplyLayoutResult) => void)[]
  }[]
}

type RuntimeInstalledCommandSurfaces = RuntimeEdgeCommandSurface &
  RuntimeLinearCommandSurface &
  RuntimeFileCommandSurface &
  RuntimeGitCommandSurface &
  RuntimeRepositoryCommandSurface &
  RuntimeReviewCommandSurface &
  RuntimeServiceCommandSurface

type RuntimeCommandSurfaceHost<T> = T & RuntimeInstalledCommandSurfaces

export type RuntimeRendererReloadFence = Readonly<{
  revision: number
  recovery: 'renderer' | 'headless' | 'reloading'
}>

class OrcaRuntimeService {
  private readonly runtimeId = randomUUID()
  private readonly startedAt = Date.now()
  private readonly store: RuntimeStore | null
  private readonly clientSettings: RuntimeClientSettingsController
  private readonly automation: RuntimeAutomationController
  private readonly artifacts = new RuntimeArtifactController()
  private readonly orchestrationEnvironmentTransport: OrchestrationEnvironmentTransport | null
  private readonly orchestrationFederation: RuntimeOrchestrationFederation
  private rendererGraphEpoch = 0
  private graphStatus: RuntimeGraphStatus = 'unavailable'
  private authoritativeWindowId: number | null = null
  private headlessGraphFallbackAvailable = false
  private pendingHeadlessPromotionWindowId: number | null = null
  private rendererGeneration: string | null = null
  private readonly graphReloadLifecycle = new RuntimeGraphReloadLifecycle({
    timeoutMs: RUNTIME_GRAPH_RELOAD_TIMEOUT_MS,
    onSettled: ({ revision, windowId, outcome, durationMs }) => {
      console.info(
        `[runtime-graph] reload revision=${revision} window=${windowId} outcome=${outcome} durationMs=${durationMs}`
      )
    },
    onTimeout: (_revision, windowId) => this.handleGraphReloadTimeout(windowId)
  })
  // Why: paired graph transactions need foreground timer cadence only until their publication settles.
  private readonly rendererPublicationThrottle = new RendererPublicationThrottle()
  private tabs = new Map<string, RuntimeSyncedTab>()
  private mobileSessionTabsByWorktree = new Map<string, RuntimeMobileSessionTabsSnapshot>()
  private readonly clientHostedPageReconciliation = new ClientHostedPageReconciliationWindow(
    Date.now()
  )
  // Why: renderer publication ordering must be judged against the renderer's
  // own last-accepted (epoch, version) — never against the stored snapshot's
  // version, which main-local touches bump independently and can push
  // permanently ahead of the renderer's counter. The renderer reuses one pair
  // for byte-identical content, so a same-epoch version <= this one is a no-op
  // resend (or stale) and is skipped without touching the stored entry.
  private acceptedRendererMobileSnapshotByWorktree = new Map<
    string,
    {
      publicationEpoch: string
      rendererVersion: number
      rendererTabCount: number
      rendererTabIdentityKeys: ReadonlySet<string>
    }
  >()
  private clientSessionTabSelections = new ClientSessionTabSelectionStore()
  // Why: idempotency map for mobile terminal creation — a retried create with the
  // same clientMutationId returns the in-flight operation instead of duplicating.
  private mobileTerminalCreateByMutationId = new Map<
    string,
    Promise<RuntimeMobileSessionCreateTerminalResult>
  >()
  private readonly terminalCreateIdempotency = new RemoteRuntimeTerminalCreateIdempotency()
  // Why: concurrent clients sleeping one host workspace must share one physical teardown.
  private terminalSleepByWorktreeId = new Map<string, Promise<RuntimeWorktreeTerminalSleepResult>>()
  private terminalMutationTailByWorktreeId = new Map<string, Promise<void>>()
  private terminalSleepStateByWorktreeId = new Map<
    string,
    {
      worktreeId: string
      generation: number
      phase: 'stopping' | 'partial' | 'sleeping'
      ptyIds: string[]
      terminalHandles: string[]
      terminalHandlesByPtyId: Record<string, string[]>
    }
  >()
  private terminalSleepGeneration = 0
  private terminalPaneRecoveryByIdentity = new Map<string, Promise<RuntimeTerminalResolvePane>>()
  // Why: idempotency map for worktree.create — a create interrupted by a mobile
  // connection migration is retried with the same clientMutationId and returns
  // the in-flight (or just-finished) operation instead of a duplicate worktree.
  private worktreeCreateByMutationId = new Map<string, Promise<unknown>>()
  // Why: a mobile create waits for the renderer to publish the new tab's surface
  // via graph-sync, but a throttled/hidden renderer can park that past the surface
  // timeout and the create would then destroy the live PTY (#7587). This lets the
  // renderer's own PTY spawn publish the surface main-side, scoped to in-flight
  // creates so ordinary renderer spawns never publish here.
  private pendingMobileTerminalCreatesByKey = new Map<
    string,
    {
      activate: boolean
      paired: boolean
      selectIfNoActiveTab: boolean
      viewMode?: 'terminal' | 'chat'
      /** Resolved agent launch command, kept so a settle over a bare renderer
       *  PTY can still deliver the launch instead of succeeding silently (STA-3214). */
      startupCommand?: string
    }
  >()
  private mobileSessionTabListeners = new Set<{
    listener: (snapshot: RuntimeMobileSessionTabsResult) => void
    clientNavigationId?: string
  }>()
  // Why: one watermark per repo replaces per-closed-pane fences while preserving stale-write safety.
  private terminalTopologyRevisionByRepoId = new Map<string, number>()
  // Why: provider exit can beat surface registration; that exact dead incarnation must never publish.
  private earlyExitedPtyIncarnations = new Map<string, PtyIncarnationId | null>()
  private pendingPtyRegistrationIncarnations = new Map<string, PtyIncarnationId | null>()
  // Why: exact-stop is the current sleep transaction boundary; its exit must
  // leave the renderer's intentional sleeping surface available for wake.
  private intentionalHandlelessPtyStops = new Map<string, string | null>()
  // Why: coalesces title/status-driven session.tabs emits so spinner churn
  // doesn't fan out (and per-client JSON.stringify) a snapshot several times a
  // second. Emit reads the latest snapshot, so only the freshest version ships.
  private readonly mobileSessionTabsNotifyCoalescer: MobileSessionTabsNotifyCoalescer =
    createMobileSessionTabsNotifyCoalescer((worktreeId) =>
      this.notifyMobileSessionTabsChangedNow(worktreeId)
    )
  private readonly mobileSessionTabsAgentStatusHeartbeat: MobileSessionTabsAgentStatusHeartbeat =
    createMobileSessionTabsAgentStatusHeartbeat(
      (ptyId) => this.getMobileSessionWorktreeIdsForPty(ptyId),
      (worktreeId) => this.touchMobileSessionTabsForWorktree(worktreeId)
    )
  // Why: concurrent host terminal.focus storms (CLI switch fan-out / bulk open)
  // each await a full host reveal; only one terminal can be focused, so latest-wins
  // single-flight bounds host work. Does not replace cheaper activation or
  // reconnect-scan bounding for sequential soft freezes.
  private readonly terminalFocusNavigationCoalescer =
    new TerminalFocusNavigationCoalescer<RuntimeTerminalFocus>()
  private pendingMobileSessionPtyInventoryRefresh: Promise<Set<string> | null> | null = null
  private leaves = new Map<string, RuntimeLeafRecord>()
  // Why: PTY output is a per-keystroke hot path. Looking up affected leaves by
  // ptyId keeps active TUI redraws independent of the total open terminal count.
  private leavesByPtyId = new Map<string, RuntimeLeafRecord[]>()
  private handles = new Map<string, TerminalHandleRecord>()
  private handleByLeafKey = new Map<string, string>()
  private handleByPtyId = new Map<string, string>()
  // Why: pointer state is process-local; one harmless replay after restart avoids a wire or schema change.
  private readonly lastPointedMessageSequenceByHandle = new Map<string, number>()
  // Why: a waiter can reserve an older row while a newer row advances the sequence watermark.
  private readonly pointedMessageIdsByHandle = new Map<string, Set<string>>()
  private readonly mailPointerRepointScheduler = new MailPointerRepointScheduler((handle) =>
    this.repointPendingMessagesForHandle(handle)
  )
  private syntheticTerminalHandles = new Set<string>()
  private detachedPreAllocatedLeaves = new Map<string, RuntimeLeafRecord>()
  private graphSyncCallbacks: (() => void)[] = []
  private readonly terminalWaiters = new RuntimeTerminalWaiterRegistry()
  private readonly terminalWriter = new RuntimeTerminalWriter(
    (ptyId, data) => this.ptyController?.write(ptyId, data) ?? false
  )
  private readonly terminalIdlePolls = new RuntimeTerminalIdlePolls({
    intervalMs: TUI_IDLE_POLL_INTERVAL_MS,
    quiescenceMs: TUI_IDLE_QUIESCENCE_MS,
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title ?? null,
    getForegroundProcess: (ptyId) => this.ptyController?.getForegroundProcess(ptyId) ?? null,
    getAdoptedPtyIdleStatus: (pty) => this.getAdoptedPtyExplicitIdleStatus(pty),
    resolve: (waiter, result) => this.terminalWaiters.resolve(waiter, result)
  })
  private readonly terminalWait = new RuntimeTerminalWaitController(
    {
      defaultTimeoutMs: TUI_IDLE_DEFAULT_TIMEOUT_MS,
      getLivePty: (handle) => this.getLivePtyForHandle(handle),
      getLiveLeaf: (handle) => this.getLiveLeafForHandle(handle),
      getAdoptedPtyIdleStatus: (pty) => this.getAdoptedPtyExplicitIdleStatus(pty),
      getTabTitle: (tabId) => this.tabs.get(tabId)?.title ?? null
    },
    this.terminalWaiters,
    this.terminalIdlePolls
  )
  private ptyController: RuntimePtyController | null = null
  private readonly terminalAgentPresence = new RuntimeTerminalAgentPresence({
    getLivePty: (handle) => this.getLivePtyForHandle(handle)?.pty ?? null,
    getLiveLeaf: (handle) => this.getLiveLeafForHandle(handle).leaf,
    getPrimaryLeaf: (ptyId) => this.getLeavesForPty(ptyId)[0] ?? null,
    getTrackedPty: (ptyId) => this.ptysById.get(ptyId) ?? null,
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title?.trim() || null,
    getForegroundProcess: (ptyId) => this.ptyController?.getForegroundProcess(ptyId) ?? null
  })
  private notifier: RuntimeNotifier | null = null
  private readonly clientEvents = new RuntimeClientEventBus({
    makeTitleGateKey: (rawTitle, normalizedTitle) =>
      this.makeDecorativeTitleGateKey(rawTitle, normalizedTitle),
    onConsumerAvailabilityChanged: () => this.refreshTerminalSideEffectConsumerAvailability()
  })
  private readonly nativeChatDraftResolutions = new RuntimeNativeChatDraftResolutions({
    resolveOwner: (handle) => this.resolveNativeChatLaunchDraftOwner(handle),
    listMobileSnapshots: () => this.mobileSessionTabsByWorktree,
    setMobileSnapshot: (worktreeId, snapshot) =>
      this.mobileSessionTabsByWorktree.set(worktreeId, snapshot),
    scheduleMobileSnapshot: (worktreeId) =>
      this.mobileSessionTabsNotifyCoalescer.schedule(worktreeId),
    notifyResolved: (tabId, resolution, event) => {
      this.notifier?.nativeChatLaunchDraftResolved?.(tabId, resolution)
      this.emitClientEvent(event)
    }
  })
  private readonly worktreeLifecycleEvents =
    new RuntimeWorktreeLifecycleEvents<RuntimeWorktreeLifecycleEvent>()
  private agentBrowserBridge: AgentBrowserBridge | null = null
  private offscreenBrowserBackend: BrowserBackend | null = null
  private emulatorBridge: EmulatorBridge | null = null
  private readonly resolvedWorktrees = new RuntimeResolvedWorktreeCache()
  private worktreeScanGenerations = new Map<string, number>()
  private worktreeScanCache = new Map<string, RuntimeWorktreeScanCache>()
  private worktreeScanInFlight = new Map<string, RuntimeWorktreeScanInFlight>()
  /** Repos whose Git-admin probe has not settled yet; caps abandoned fs work at one per repo. */
  private worktreeAdminFingerprintProbes = new Set<string>()
  private readonly worktreeLineage = new RuntimeWorktreeLineageController({
    getStore: () => this.store,
    getCachedWorktrees: () => this.resolvedWorktrees.peek()?.worktrees ?? [],
    getDb: () => this.getOrchestrationDbIfAvailable(),
    resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
    listResolvedWorktrees: () => this.listResolvedWorktrees(),
    showTerminal: (handle) => this.showTerminal(handle)
  })
  private readonly agentOrchestrationProjection = new RuntimeAgentOrchestrationProjection({
    getDb: () => this.getOrchestrationDbIfAvailable(),
    getLeaves: () => this.leaves.values(),
    getPtys: () => this.ptysById.values(),
    issueLeafHandle: (leaf) => this.issueHandle(leaf),
    issuePtyHandle: (pty) => this.issuePtyHandle(pty),
    makePaneKey: (leaf) => this.makeRuntimePaneKey(leaf),
    getWorktreeId: (handle) => this.getWorktreeIdForTerminalHandle(handle),
    getHandleForPaneKey: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
    getPaneKey: (handle) => this.getPaneKeyForTerminalHandle(handle),
    getDispatchAuthority: (handle) => this.getOrchestrationDispatchAuthority(handle)
  })
  private readonly terminalList = new RuntimeTerminalList({
    getGraphEpoch: () => (this.graphStatus === 'ready' ? this.rendererGraphEpoch : null),
    assertGraphEpoch: (epoch) => this.assertStableReadyGraph(epoch),
    getExplicitWorktreeId: (selector) => this.getValidatedExplicitWorktreeIdSelector(selector),
    getResolvedCache: () => this.resolvedWorktrees.peek(),
    buildWorktreeFromId: (worktreeId) => this.buildResolvedWorktreeFromId(worktreeId),
    resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
    listKnownWorktrees: (worktreeId, target) =>
      this.listKnownResolvedWorktreesForExplicitTarget(worktreeId, target),
    getWorktreeMap: () => this.getResolvedWorktreeMap(),
    refreshPtys: (worktrees, targetId) =>
      this.refreshPtyWorktreeRecordsWithControllerInventory(worktrees, targetId),
    getPtys: () => this.ptysById.values(),
    getLeaves: () => this.leaves.values(),
    buildLeafSummary: (leaf, worktrees, livePtyIds) =>
      this.buildTerminalSummary(leaf, worktrees, livePtyIds),
    buildPtySummary: (pty, worktrees) => this.buildPtyTerminalSummary(pty, worktrees),
    getSnapshots: () => this.mobileSessionTabsByWorktree,
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title ?? null,
    getTopologyRevision: (worktreeId) => this.getTerminalTopologyRevision(worktreeId)
  })
  private readonly managedWorktreeQueries = new RuntimeManagedWorktreeQueries({
    getStore: () => this.store,
    listResolved: () => this.listResolvedWorktrees(),
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    selectRepos: (selector) => this.selectReposBySelector(selector),
    scanRepo: (repo) => this.listRepoWorktreesForResolution(repo)
  })
  private agentDetector: AgentDetector | null = null
  private readonly ptyForegroundAgent = new RuntimePtyForegroundAgent({
    getController: () => this.ptyController,
    getPty: (ptyId) => this.ptysById.get(ptyId) ?? null,
    touchSnapshot: (ptyId) => this.touchMobileSessionSnapshotsForPty(ptyId),
    finishDelayedSnapshot: (ptyId, changed) => {
      if (this.mobileSessionTabListeners.size > 0) {
        this.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
      }
      if (!changed) {
        this.touchMobileSessionSnapshotsForPty(ptyId)
      }
    }
  })
  get ptyForegroundProcessReads() {
    return this.ptyForegroundAgent.getReads()
  }
  refreshPtyForegroundAgentFromController(ptyId: string): Promise<boolean> {
    return this.ptyForegroundAgent.refresh(ptyId)
  }
  private readonly terminalAgentStatus = new RuntimeTerminalAgentStatusQuery({
    getController: () => this.ptyController,
    getLivePty: (handle) => this.getLivePtyForHandle(handle),
    getLiveLeaf: (handle) => this.getLiveLeafForHandle(handle),
    getPrimaryLeaf: (ptyId) => this.getPrimaryLeafForPty(ptyId),
    getTabTitle: (tabId) => this.tabs.get(tabId)?.title ?? null,
    getExplicitStatus: (handle) => this.getFreshExplicitAgentStatusForHandle(handle),
    isRunning: (handle) => this.isTerminalRunningAgent(handle)
  })
  private _orchestrationDb: OrchestrationDb | null = null
  private readonly messageWaiters = new RuntimeMessageWaiters((handle, reservedTypes) =>
    this.deliverPendingMessagesForHandle(handle, reservedTypes)
  )
  // Why: mobile clients subscribe to terminal output via terminal.subscribe.
  // These listeners fire on every onPtyData call, enabling real-time streaming
  // without polling. Keyed by ptyId for O(1) lookup per data event.
  private readonly terminalStreamConsumers = new RuntimeTerminalStreamConsumers()
  // Why: startup draft paste can subscribe after the agent already emitted its
  // ready marker. Keep a bounded raw buffer so fast startup output is replayed.
  private recentPtyOutputById = new Map<string, RecentPtyOutputBuffer>()
  private setupCompletionTokenByPtyId = new Map<string, string>()
  // Why: mobile clients need to know when the desktop restores a terminal
  // from mobile-fit so they can update their UI. These listeners are
  // invoked from resizeForClient and onClientDisconnected/onPtyExit.
  private fitOverrideListeners = new Map<
    string,
    Set<
      (event: {
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    >
  >()
  private readonly subscriptions = new RuntimeSubscriptionRegistry()
  private readonly mobileNotifications = new RuntimeMobileNotificationController()
  private ptysById = new Map<string, RuntimePtyWorktreeRecord>()
  private readonly pairedRendererSessionOwnedPtyIds = new Set<string>()
  private wslDistroByPtyId = new Map<string, string>()
  private titleObservationSequence = 0
  private headlessTerminals = new Map<string, RuntimeHeadlessTerminal>()
  private ptyOutputSequenceById = new Map<string, number>()
  private providerSequenceInitializedPtys = new Set<string>()
  private providerSequenceOffsetByPtyId = new Map<string, number>()
  private providerSnapshotPreferredPtys = new Set<string>()
  private providerModeTrackersByPtyId = new Map<string, TerminalKittyKeyboardModeTracker>()
  private providerModeSnapshotScansByPtyId = new Map<
    string,
    Set<TerminalKittyKeyboardModeTracker>
  >()
  private providerBufferAcquisitionsByPtyId = new Map<string, ProviderBufferAcquisition>()
  private providerVisibleStateByPtyId = new Map<string, RuntimeVisibleTerminalState>()
  private providerVisibleStateReadsByPtyId = new Map<
    string,
    { generation: number; promise: Promise<RuntimeVisibleTerminalState | null> }
  >()
  private providerVisibleRetryAtByPtyId = new Map<string, number>()
  private providerSnapshotsWithLiveModeTransition = new WeakSet<PtyProviderBufferSnapshot>()
  private ptyLifecycleGenerationById = new Map<string, number>()
  private nextPtyLifecycleGeneration = 1
  private recentPtyPathCandidatesById = new Map<string, string[]>()
  // Why: candidates only feed mobile file-tap provenance; desktop-only
  // sessions skip the 3-regex extraction on every PTY chunk until a
  // mobile/remote client authenticates (sticky, backfilled on activation).
  private recentPtyPathCandidateTrackingActive = false
  // Why: OSC 9999 status can span PTY chunks. Keeping parser state in the
  // runtime lets hidden/model-owned terminals observe agent state without a
  // mounted xterm view.
  // Why a throttle: the blocked-reason check builds and scans two full wait
  // texts (<=256KB each, lowercased) — measured at ~85% of onPtyData's cost
  // under a TUI flood (findings log 2026-07-03). PTY chunk boundaries are
  // arbitrary, so running the identical computation over coalesced chunks at
  // a bounded cadence (plus a trailing-edge timer so burst-final state is
  // always evaluated) preserves semantics while removing it from the hot path.
  private waitBlockedCheckStateByPtyId = new Map<
    string,
    {
      lastAt: number
      lastWaitState: TerminalTailWaitState | null
      appended: string
      keywordCarry: string
      timer: ReturnType<typeof setTimeout> | null
    }
  >()

  private agentStatusOscProcessorsByPtyId = new Map<
    string,
    ReturnType<typeof createAgentStatusOscProcessor>
  >()
  // Why: per-PTY shared title trackers (all-titles ordering + stale-working
  // timer) replace last-title-per-chunk scanning so main observes the same
  // intra-chunk working→idle transitions the renderer does (issue #1083).
  // Lazily created like agentStatusOscProcessorsByPtyId; disposed on PTY exit.
  private ptyTitleTrackersByPtyId = new Map<string, RuntimePtyTitleTrackerEntry>()
  // Why: the Command Code output detector arms early from the launch command
  // when known (banner detection covers user-typed launches), mirroring the
  // renderer detector's startupCommand seed.
  private terminalSpawnCommandsByPtyId = new Map<string, string>()
  // Why: ordinary OSC 0/1/2 titles can split across PTY chunks, especially over
  // SSH/relay buffering. Keep a small raw scan tail and feed reconstructed
  // chunks into the title tracker instead of falling back to last-title scans.
  private oscTitleScanTailByPtyId = new Map<string, string>()
  // Why: mobile file taps resolve relative paths on the host. OSC 7 is the
  // terminal-owned cwd signal, and it can arrive in live output between snapshots.
  private osc7ScanTailByPtyId = new Map<string, string>()
  private terminalCwdByPtyId = new Map<string, string>()
  private terminalFileUriHostnameByPtyId = new Map<string, string>()
  // Why: latest agent-status payload per pane, retained so worktree.ps can serve
  // mobile the same inline agent rows the desktop sidebar renders. Cleared on pty
  // teardown so dead agents don't linger. See RuntimeAgentRowSnapshot.
  private readonly agentRows = new RuntimeAgentRowStore()
  // Why: per-PTY hydration state guards against double-hydration. Keys:
  //   'pending'  → maybeHydrateHeadlessFromRenderer is in flight
  //   'done'     → hydration completed (success or skip); never run again
  // Absent  → hydration has not been considered yet for this PTY.
  // See docs/mobile-prefer-renderer-scrollback.md.
  private headlessHydrationState = new Map<string, 'pending' | 'done'>()
  // Why: mobile-fit overrides are keyed by ptyId (not terminal handle) because
  // handles can be reissued while the PTY identity is stable. In-memory only —
  // a stale phone override should not survive an app restart.
  private terminalFitOverrides = new Map<
    string,
    {
      mode: 'mobile-fit'
      cols: number
      rows: number
      previousCols: number | null
      previousRows: number | null
      updatedAt: number
      clientId: string
    }
  >()

  // Why: server-authoritative display mode per terminal. 'auto' (default)
  // means phone-fit when mobile subscribes, desktop otherwise. 'desktop'
  // locks to no-resize regardless of subscriber state. The third historical
  // value ('phone' = sticky phone-fit after unsubscribe) was removed since
  // the toggle UI never produced it and nothing in product depended on it.
  // In-memory only — modes reset on restart.
  private mobileDisplayModes = new Map<string, 'desktop'>()

  // Why: tracks active mobile subscribers per PTY so the runtime can restore
  // desktop dimensions on unsubscribe and prevent orphaned overrides during
  // rapid tab switches. Keyed by ptyId → inner map of clientId → subscriber.
  // The two-level map preserves multi-mobile soundness: phone B subscribing
  // does not silently overwrite phone A's record. See
  // docs/mobile-presence-lock.md "Multi-mobile subscriber model".
  // subscribedAt drives "earliest-by-subscribe-time" restore-target selection
  // (only among subscribers with non-null previousCols/Rows; desktop-mode
  // joins carry null and are skipped). lastActedAt drives "most-recent
  // actor's viewport wins" for active phone-fit dims.
  private mobileSubscribers = new Map<
    string,
    Map<
      string,
      {
        clientId: string
        viewport: { cols: number; rows: number } | null
        wasResizedToPhone: boolean
        previousCols: number | null
        previousRows: number | null
        subscribedAt: number
        lastActedAt: number
      }
    >
  >()

  // Why: Phase-5 query-responder suppression — a terminal-RPC subscribe
  // stream feeds a remote xterm view (mobile/web/remote desktop) that answers
  // queries with view authority, so main must yield while one is attached
  // (terminal-query-authority.md). Ref-counted per PTY because multiple
  // streams can attach concurrently; mobileSubscribers is consulted too so
  // grace-window mobile records keep suppressing.
  private readonly terminalViewSubscribers = new RuntimeTerminalViewSubscribers({
    notifyPresenceChanged: (ptyId) => this.notifyRemoteTerminalViewPresenceChanged(ptyId),
    hasMobileSubscribers: (ptyId) => (this.mobileSubscribers.get(ptyId)?.size ?? 0) > 0,
    isUnattachedLocalCandidate: (ptyId) => {
      if (
        this.headlessTerminals.has(ptyId) ||
        this.providerSnapshotPreferredPtys.has(ptyId) ||
        this.pendingPtyRegistrationIncarnations.has(ptyId) ||
        parseAppSshPtyId(ptyId)
      ) {
        return false
      }
      const pty = this.ptysById.get(ptyId)
      return pty !== undefined && pty.connectionId === null && pty.connected
    },
    attachProvider: (ptyId) => {
      const attach = this.ptyController?.attach
      return attach ? (async () => attach(ptyId))() : null
    }
  })

  // Why: per-PTY driver state. The "driver" is whoever currently owns the
  // input/resize floor. While `kind === 'mobile'` the desktop renderer drops
  // xterm.onData/onResize and shows the lock banner; `terminal.send` /
  // `pty:write` and `pty:resize` IPC handlers also drop desktop-side calls
  // server-side as defense-in-depth. The `clientId` carried on the mobile
  // variant is the most recent mobile actor — used by
  // `applyMobileDisplayMode` to pick the active phone-fit viewport. See
  // docs/mobile-presence-lock.md.
  private readonly terminalDrivers = new RuntimeTerminalDriverController({
    notifyChanged: (ptyId, next) => this.notifier?.terminalDriverChanged(ptyId, next),
    canClaimMobileFloor: (ptyId, clientId) => {
      const softLeaver = this.pendingSoftLeavers.get(ptyId)
      return this.mobileSubscribers.get(ptyId)?.has(clientId) || softLeaver?.clientId === clientId
    },
    commitMobileFloor: (ptyId, clientId, previousFloor, isCurrent) =>
      this.mobileTookFloor(ptyId, clientId, previousFloor, isCurrent)
  })
  private readonly edgeCommands = new RuntimeEdgeCommandController({
    browserHost: {
      getAgentBrowserBridge: () => this.agentBrowserBridge,
      resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
      resolveBrowserWorkspace: (selector) => this.resolveBrowserWorkspace(selector),
      getBrowserHostLeaseRegistry: () => getBrowserHostLeaseRegistry(this),
      getRuntimeBrowserPageRegistry: () => getRuntimeBrowserPageRegistry(this),
      resolveBrowserNetworkExecutionHost: (worktree) =>
        this.resolveBrowserNetworkExecutionHostForWorktree(worktree),
      getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
      getAvailableAuthoritativeWindow: () => this.getAvailableAuthoritativeWindow(),
      getOffscreenBrowserBackend: () => this.offscreenBrowserBackend,
      markHeadlessBrowserSessionTabActive: this.markHeadlessBrowserSessionTabActive.bind(this),
      notifyHeadlessBrowserSessionTabsChanged: (worktreeId) =>
        this.notifyMobileSessionTabsChanged(worktreeId),
      retireRuntimeOwnedBrowserSessionTab: (worktreeId, browserPageId) =>
        this.retireRuntimeOwnedBrowserSessionTab(worktreeId, browserPageId)
    },
    screencast: {
      registerSubscriptionCleanup: (subscriptionId, cleanup, connectionId) =>
        (this as RuntimeCommandSurfaceHost<this>).registerSubscriptionCleanup(
          subscriptionId,
          cleanup,
          connectionId
        ),
      cleanupSubscription: (subscriptionId) =>
        (this as RuntimeCommandSurfaceHost<this>).cleanupSubscription(subscriptionId),
      getDriver: (browserPageId) => this.browserDrivers.get(browserPageId),
      setDriver: (browserPageId, next) => this.browserDrivers.set(browserPageId, next),
      notifyRemoteViewersChanged: (browserPageId, hasRemoteViewers) =>
        this.notifier?.browserRemoteViewersChanged?.(browserPageId, hasRemoteViewers)
    },
    getBrowserCommands: () => this.browserCommands,
    emulatorHost: {
      getEmulatorBridge: () => this.emulatorBridge,
      resolveEmulatorWorkspaceId: (selector) => this.resolveEmulatorWorkspaceId(selector),
      resolveEmulatorCleanupWorkspaceId: (selector) =>
        this.resolveEmulatorCleanupWorkspaceId(selector),
      getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
      getSettings: () => this.requireStore().getSettings()
    }
  })
  // Why: tests and diagnostic seams replace only screencast startup; ordinary edge methods stay pre-bound.
  private browserCommands = this.edgeCommands.getBrowserCommands()
  private readonly browserDrivers = new RuntimeBrowserDriverController({
    notifyChanged: (browserPageId, next) =>
      this.notifier?.browserDriverChanged?.(browserPageId, next),
    cancelScreencast: (browserPageId) => this.edgeCommands.cancelScreencast(browserPageId)
  })

  private readonly remoteDesktopFloor = new RemoteDesktopTerminalFloor({
    isMobileDriven: (ptyId) => this.getDriver(ptyId).kind === 'mobile',
    getTerminalSize: (ptyId) => this.getTerminalSize(ptyId) ?? null,
    resolveHostTarget: (ptyId) => this.resolveDesktopRestoreTarget(ptyId),
    applyLayout: async (ptyId, target) => {
      this.freshSubscribeGuard.add(ptyId)
      try {
        return await this.enqueueLayout(ptyId, target)
      } finally {
        this.freshSubscribeGuard.delete(ptyId)
      }
    }
  })

  // Why: resubscribe-grace window. When the last mobile subscriber for a
  // PTY unsubscribes, we hold the driver=mobile{clientId} state and the
  // inner-map record open for ~250ms. If the same (ptyId, clientId)
  // re-subscribes inside the window — typically because the mobile app
  // tore down the stream to reconfigure (rare with the new
  // updateMobileViewport path, but still possible on reconnects, network
  // hiccups, or older client builds) — we cancel the deferred idle and
  // restore-timer so the desktop banner doesn't flash and the new
  // subscriber doesn't capture an already-phone-fitted PTY size as its
  // restore baseline. Keyed by ptyId; carries the timer plus the snapshot
  // of the leaving subscriber so we can re-insert it on cancel. See
  // docs/mobile-presence-lock.md.
  private pendingSoftLeavers = new Map<
    string,
    {
      clientId: string
      timer: ReturnType<typeof setTimeout>
      record: {
        clientId: string
        viewport: { cols: number; rows: number } | null
        wasResizedToPhone: boolean
        previousCols: number | null
        previousRows: number | null
        subscribedAt: number
        lastActedAt: number
      }
    }
  >()

  // Why: tracks the last PTY size set by the desktop renderer (via pty:resize
  // IPC). Unlike ptySizes (which is overwritten by server-side phone-fit
  // resizes), this map preserves the actual pane geometry. Used as the
  // preferred source for previousCols so desktop restore uses the correct
  // split-pane width instead of a stale full-width value.
  private lastRendererSizes = new Map<string, { cols: number; rows: number }>()

  // Why: when a desktop-fit override change fires, the desktop renderer's
  // re-render cascade (triggered by setOverrideTick) runs safeFit on ALL
  // panes — not just the affected one. Background tab panes get measured at
  // full-width (214) instead of their correct split width (105). The stale
  // pty:resize IPCs overwrite both the actual PTY size and lastRendererSizes.
  // This global window suppresses ALL pty:resize for 200ms after any
  // desktop-fit notification. The server has already set the correct PTY
  // size via ptyController.resize(), so desktop renderer resizes during
  // this window are redundant (for the restored pane) or wrong (collateral).
  private resizeSuppressedUntil = 0

  // Why: delays PTY restore by 300ms after mobile unsubscribe so rapid tab
  // switches don't cause unnecessary resize thrashing. Keyed by clientId
  // Why: keyed by ptyId so each PTY gets its own independent restore timer.
  // The old clientId-keyed design lost timers when two PTYs were unsubscribed
  // back-to-back (only the last timer survived).
  private pendingRestoreTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; clientId: string }
  >()

  // Why: inline resize events replace the unsubscribe→resubscribe pattern.
  // Listeners are notified when mode changes or desktop restores, allowing
  // the subscribe stream to emit a 'resized' event with fresh scrollback.
  // `seq` is the layout state-machine sequence number bumped on every
  // applyLayout success; mobile clients use it to drop stale events that
  // arrive after a newer transition. See docs/mobile-terminal-layout-state-machine.md.
  private resizeListeners = new Map<
    string,
    Set<
      (event: {
        cols: number
        rows: number
        displayMode: string
        reason: string
        seq?: number
      }) => void
    >
  >()

  // Why: per-PTY layout state machine. `applyLayout` is the sole writer of
  // `layouts`, `terminalFitOverrides`, and `ptyController.resize`; every
  // trigger method routes through `enqueueLayout`. The monotonic `seq` is
  // emitted on the mobile subscribe stream so clients can drop stale events.
  // See docs/mobile-terminal-layout-state-machine.md.
  private layouts = new Map<string, PtyLayoutState>()

  // Why: per-PTY async serialization queue for applyLayout. Without
  // serialization, two concurrent triggers can interleave around the
  // ptyController.resize await and bump seq in the wrong order, defeating
  // seq-as-truth. Coalesces same-kind same-owner viewport ticks so the
  // keyboard-show/hide animation doesn't queue 10+ resizes; mode flips,
  // take-floor, and different-owner targets always append (preserves
  // multi-mobile fairness). See docs/mobile-terminal-layout-state-machine.md
  // "enqueueLayout coalescing".
  private layoutQueues = new Map<string, LayoutQueueEntry>()

  // Why: gate so enqueueLayout's "no layouts entry" short-circuit doesn't
  // fire on the very first transition for a PTY (where the entry doesn't
  // exist yet *because* we're about to create it). `handleMobileSubscribe`
  // adds the ptyId before calling enqueueLayout and removes it after the
  // call resolves.
  private freshSubscribeGuard = new Set<string>()

  private stats: StatsCollector | null = null
  // Why: create and drift probes must share one fetch/freshness owner.
  private readonly remoteFetches = new RuntimeRemoteFetchController()
  private readonly worktreeBaseReconciliation = new RuntimeWorktreeBaseReconciliation(
    this.remoteFetches,
    () => this.notifier
  )
  // Why: retained as read-only compatibility seams for cache-boundary tests.
  private get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
    return this.remoteFetches.getCanonicalFetchKeyCache()
  }
  private get fetchLastCompletedAt(): ReadonlyMap<string, number> {
    return this.remoteFetches.getFetchLastCompletedAt()
  }
  private readonly removeManagedWorktreeInFlight = new RuntimeWorktreeRemovalInFlight()
  private readonly preservedBranchCleanup = new RuntimePreservedBranchCleanup(() =>
    this.store ? this.requireStore() : null
  )
  private readonly getLocalProviderFn: (() => IPtyProvider) | null
  private readonly getSshProviderFn: ((connectionId: string) => IPtyProvider | undefined) | null
  private readonly onPtyStopped: ((ptyId: string) => void) | null
  private readonly onTerminalAgentStatus: ((event: RuntimeTerminalAgentStatusEvent) => void) | null
  private readonly onTerminalSideEffects: ((batch: TerminalSideEffectBatch) => void) | null
  private terminalSideEffectLocalConsumerAvailable = false
  private terminalSideEffectConsumerAvailable = false
  private readonly getAgentStatusSnapshotFn: (() => AgentStatusIpcPayload[]) | null
  private readonly getAgentProviderSessionSnapshotFn: (() => AgentStatusIpcPayload[]) | null
  private readonly getAgentProviderSessionRowsForPaneFn:
    | ((paneKey: string) => AgentStatusIpcPayload[])
    | null
  private readonly attestAgentHookCompatibilityAuthorityFn:
    | ((candidate: {
        paneKey: string
        launchTokenHash: string
        connectionId: string | null
        terminalProvenance: 'current_runtime' | 'restored'
      }) => AgentHookAuthorityAttestation | null)
    | null
  private readonly retireAgentHookCompatibilityAuthorityFn: ((paneKey: string) => void) | null
  private readonly canRecoverPersistentLocalPtysFn: () => boolean
  private readonly getPairedDeviceNameFn: (pairedDeviceId: string) => string | null
  private readonly buildAgentHookPtyEnv: (() => Record<string, string>) | null
  private readonly getDesktopWindowStatusFn: () => RuntimeDesktopWindowStatus
  private readonly prepareAiVaultSessionResumeFn:
    | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
    | null
  private readonly agentSessionClaimSigner: AgentSessionClaimSigner
  private readonly agentSessionCreateOperations = new Map<string, AgentSessionCreateOperation>()
  private readonly orchestrationCompatibilitySshAttachments = new Map<
    string,
    OrchestrationCompatibilitySshAttachmentAuthority
  >()
  private sshRelayRecoveryGenerationByTargetId = new Map<string, number>()
  private readonly legacyWorkerRecoveryPersistence =
    new RuntimeLegacyWorkerTerminalRecoveryPersistence(
      () => this.store,
      () => this.getOrchestrationDb(),
      (worktreeId) => this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    )
  private readonly legacyWorkerRecovery = new RuntimeLegacyWorkerTerminalRecoveryController({
    preparePlan: () => this.legacyWorkerRecoveryPersistence.prepare(),
    resolveWorkspace: async (candidate) => {
      const scope = await this.resolveTerminalWorkspaceLaunchScope(`id:${candidate.worktreeId}`)
      const resolved = scope.folderWorkspace
        ? this.folderWorkspaceToResolvedWorktree(scope.folderWorkspace)
        : await this.resolveWorktreeSelector(`id:${scope.id}`)
      return { scope, resolved }
    },
    refreshInventory: (worktrees, connectionId) =>
      this.refreshPtyWorktreeRecordsWithControllerInventory(
        worktrees,
        null,
        undefined,
        connectionId
      ),
    getActivation: (worktreeId) => this.getLegacyWorkerRecoveryActivation(worktreeId),
    hasExactPersistedSurface: (candidate) =>
      this.hasExactPersistedTerminalSurfaceIdentity(candidate),
    hasExactSurface: (candidate) => this.hasExactTerminalSurfaceIdentity(candidate),
    adopt: (candidate, workspace, inventory, activation) =>
      this.adoptLegacyWorkerTerminal(candidate, workspace, inventory, activation),
    getRendererEpoch: () => this.rendererGraphEpoch,
    reveal: (candidate) => this.revealLegacyWorkerTerminal(candidate),
    onPtyExit: (candidate) => this.onPtyExit(candidate.ptyId, 0, candidate.incarnationId),
    persist: (resolutions) => this.legacyWorkerRecoveryPersistence.persist(resolutions),
    rollback: (candidate) => this.rollbackLegacyWorkerTerminalSurface(candidate),
    reconcileMissing: (candidate) =>
      this.legacyWorkerRecoveryPersistence.reconcileMissing(candidate),
    notifyResolution: (candidate, resolution) =>
      this.notifier?.resolveLegacyWorkerTerminalRecovery?.(candidate.paneKey, resolution),
    canRecoverPersistentLocalPtys: () => this.canRecoverPersistentLocalPtysFn(),
    reconcileRequestedReleases: () =>
      reconcileRequestedWorkerTerminalReleases(this as RuntimeCommandSurfaceHost<this>),
    reconcile: (options) => this.reconcileLegacyWorkerTerminals(options),
    updateRetry: (plan, deferredDispatchIds, options) =>
      this.updateLegacyWorkerTerminalRecoveryRetry(plan, deferredDispatchIds, options)
  })
  private restoredOrchestrationAuthorityByPtyId = new Map<
    string,
    RestoredOrchestrationAuthorityReceipt
  >()
  private ptyControllerInventorySequence = 0
  private ptyControllerAggregateInventoryGeneration = 0
  private ptyControllerInventoryGenerationByProvider = new Map<string, number>()
  private readonly accounts = new RuntimeAccountController()
  private readonly mobileSpeech = new RuntimeMobileSpeechCatalog(() => this.store)
  private readonly mobileDictation = new RuntimeMobileDictationController(() => this.store)
  private readonly projectHostSetups = new RuntimeProjectHostSetupController({
    getStore: () => this.store,
    listRepos: () => this.listRepos(),
    addRepo: (path, kind, hostId) =>
      (this as RuntimeCommandSurfaceHost<this>).addRepo(path, kind, hostId),
    cloneRepo: (url, destination, hostId) =>
      (this as RuntimeCommandSurfaceHost<this>).cloneRepo(url, destination, hostId),
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
  })
  private readonly projectGroups = new RuntimeProjectGroupController({
    getStore: () => this.store,
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    notifyReposChanged: () => this.notifyReposChanged()
  })
  private readonly nestedRepoImport = new RuntimeNestedRepoImport({
    getStore: () => this.store,
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
  })
  private readonly repositoryRegistrations = new RuntimeRepositoryRegistrationController({
    getStore: () => this.store,
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
  })
  private readonly repositoryClones = new RuntimeRepositoryCloneController({
    getStore: () => this.store,
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
  })
  private readonly repositorySettings = new RuntimeRepositorySettingsController({
    getStore: () => this.store,
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    forgetTerminalTopology: (repoId) => this.terminalTopologyRevisionByRepoId.delete(repoId),
    invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
    invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
    notifyReposChanged: () => this.notifyReposChanged()
  })
  private readonly repositorySparsePresets = new RuntimeRepositorySparsePresets({
    getStore: () => this.store,
    resolveRepo: (selector) => this.resolveRepoSelector(selector)
  })
  private readonly repositoryRefQueries = new RuntimeRepositoryRefQueries({
    resolveRepo: (selector) => this.resolveRepoSelector(selector)
  })
  private readonly serverEnvironment = new RuntimeServerEnvironmentCommands()
  private readonly repositoryForkBackfill = new RuntimeRepositoryForkBackfill(
    () => this.store,
    () => this.notifyReposChanged()
  )
  private readonly workspaceSessions = new RuntimeWorkspaceSessionController({
    getStore: () => this.store,
    resolveFolderConnectionId: (workspace) => this.resolveFolderWorkspaceConnectionId(workspace),
    hasRuntimeOwnedPtyCandidate: (session, worktreeId, tabs) =>
      this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(session, worktreeId, tabs)
  })
  private readonly aiVault = new RuntimeAiVaultCommands(() => this.prepareAiVaultSessionResumeFn)
  private readonly claudeAgentTeams = new ClaudeAgentTeamsService()

  constructor(
    store: RuntimeStore | null = null,
    stats?: StatsCollector,
    deps?: {
      getLocalProvider?: () => IPtyProvider
      getSshProvider?: (connectionId: string) => IPtyProvider | undefined
      onPtyStopped?: (ptyId: string) => void
      onTerminalAgentStatus?: (event: RuntimeTerminalAgentStatusEvent) => void
      onTerminalSideEffects?: (batch: TerminalSideEffectBatch) => void
      // Why: agent status mostly arrives via hooks (agent-hooks/server), not OSC
      // terminal output. worktree.ps reads this at query time so mobile shows the
      // same inline agent rows the desktop sidebar does — same source, 1:1.
      getAgentStatusSnapshot?: () => AgentStatusIpcPayload[]
      /** Same rows, but including the resume-identity-only ones `getAgentStatusSnapshot`
       *  filters out so they can't read as running agents. Mobile native chat needs
       *  them: for an agent that publishes identity separately (Pi), that row is the
       *  only carrier of the provider session a transcript is addressed by. */
      getAgentProviderSessionSnapshot?: () => AgentStatusIpcPayload[]
      getAgentProviderSessionRowsForPane?: (paneKey: string) => AgentStatusIpcPayload[]
      attestAgentHookCompatibilityAuthority?: (candidate: {
        paneKey: string
        launchTokenHash: string
        connectionId: string | null
        terminalProvenance: 'current_runtime' | 'restored'
      }) => AgentHookAuthorityAttestation | null
      retireAgentHookCompatibilityAuthority?: (paneKey: string) => void
      canRecoverPersistentLocalPtys?: () => boolean
      // Why: the device registry lives on the RPC server, which is constructed with this runtime;
      // a closure defers the lookup past that ordering instead of inverting ownership.
      getPairedDeviceName?: (pairedDeviceId: string) => string | null
      // Why: codex-home paths for the Agent Session History scan must be sourced
      // here, not via the window-only registerCoreHandlers path — that path never
      // runs under `orca serve`, so remote/SSH hosts would silently drop
      // managed-Codex sessions. The runtime ctor runs in BOTH window and serve.
      getAdditionalAiVaultCodexHomePaths?: () => readonly string[]
      prepareAiVaultSessionResume?: (
        args: AiVaultPrepareSessionResumeArgs
      ) => Promise<AiVaultPrepareSessionResumeResult>
      buildAgentHookPtyEnv?: () => Record<string, string>
      getDesktopWindowStatus?: () => RuntimeDesktopWindowStatus
      agentSessionClaimSigner?: AgentSessionClaimSigner
      orchestrationEnvironmentTransport?: OrchestrationEnvironmentTransport
    }
  ) {
    const runtime = this as RuntimeCommandSurfaceHost<this>
    installRuntimeFileCommandSurface(runtime, this.fileCommands)
    installRuntimeGitCommandSurface(runtime, this.gitCommands)
    installRuntimeRepositoryCommandSurface(runtime, {
      projectHostSetups: this.projectHostSetups,
      projectGroups: this.projectGroups,
      nestedRepoImport: this.nestedRepoImport,
      serverEnvironment: this.serverEnvironment,
      repositorySparsePresets: this.repositorySparsePresets,
      repositoryRegistrations: this.repositoryRegistrations,
      repositoryClones: this.repositoryClones,
      repositorySettings: this.repositorySettings,
      repositoryRefQueries: this.repositoryRefQueries,
      hostedReviews: this.hostedReviews,
      gitHubRepositoryQueries: this.gitHubRepositoryQueries,
      repositoryHooks: this.repositoryHooks,
      repositoryIssueCommand: this.repositoryIssueCommand
    })
    installRuntimeReviewCommandSurface(runtime, {
      gitLabQueries: this.gitLabQueryCommands,
      gitLabMutations: this.gitLabMutationCommands,
      gitHubReviewQueries: this.gitHubReviewQueries,
      gitHubReviewMutations: this.gitHubReviewMutations,
      gitHubIssueComments: this.gitHubIssueComments,
      gitHubProjects: this.gitHubProjectCommands
    })
    installRuntimeServiceCommandSurface(runtime, {
      aiVault: this.aiVault,
      clientEvents: this.clientEvents,
      nativeChatDraftResolutions: this.nativeChatDraftResolutions,
      subscriptions: this.subscriptions,
      mobileNotifications: this.mobileNotifications,
      accounts: this.accounts,
      mobileSpeech: this.mobileSpeech,
      mobileDictation: this.mobileDictation,
      browserDrivers: this.browserDrivers,
      messageWaiters: this.messageWaiters
    })
    Object.assign(this, this.edgeCommands.surface)
    // Why: keep cache-boundary test seams live while the fetch owner holds the mutable maps.
    void this.canonicalFetchKeyCache
    void this.fetchLastCompletedAt
    this.store = store
    this.clientSettings = new RuntimeClientSettingsController(store)
    this.automation = new RuntimeAutomationController(store, {
      showRepo: (selector) => runtime.showRepo(selector),
      showManagedWorktree: (selector) => this.showManagedWorktree(selector)
    })
    // Why: per-device tab selections must survive host restarts, or every phone snaps back to the first tab on return.
    const persistedClientTabSelections = store?.getMobileClientTabSelections?.()
    if (persistedClientTabSelections) {
      this.clientSessionTabSelections.hydrate(persistedClientTabSelections)
    }
    this.clientSessionTabSelections.setPersistListener((state) => {
      this.store?.setMobileClientTabSelections?.(state)
    })
    this.orchestrationEnvironmentTransport = deps?.orchestrationEnvironmentTransport ?? null
    this.orchestrationFederation = new RuntimeOrchestrationFederation(
      runtime,
      this.orchestrationEnvironmentTransport
    )
    if (stats) {
      this.stats = stats
      this.agentDetector = new AgentDetector(stats)
    }
    this.getAgentStatusSnapshotFn = deps?.getAgentStatusSnapshot ?? null
    this.getAgentProviderSessionSnapshotFn =
      deps?.getAgentProviderSessionSnapshot ?? deps?.getAgentStatusSnapshot ?? null
    this.getAgentProviderSessionRowsForPaneFn = deps?.getAgentProviderSessionRowsForPane ?? null
    this.attestAgentHookCompatibilityAuthorityFn =
      deps?.attestAgentHookCompatibilityAuthority ?? null
    this.retireAgentHookCompatibilityAuthorityFn =
      deps?.retireAgentHookCompatibilityAuthority ?? null
    this.canRecoverPersistentLocalPtysFn = deps?.canRecoverPersistentLocalPtys ?? (() => true)
    this.getPairedDeviceNameFn = deps?.getPairedDeviceName ?? (() => null)
    // Why: configure the shared AiVault scan cache from a serve-mode-reachable
    // seam so the aiVault.listSessions RPC includes managed-Codex + WSL sessions
    // even on headless `orca serve` hosts where registerCoreHandlers never runs.
    if (deps?.getAdditionalAiVaultCodexHomePaths) {
      configureAiVaultSessionSources({
        getAdditionalCodexHomePaths: deps.getAdditionalAiVaultCodexHomePaths
      })
      configureHostReadableTranscriptPathSources({
        getAdditionalCodexHomePaths: deps.getAdditionalAiVaultCodexHomePaths
      })
    }
    // Why: the daemon adapter is installed via `setLocalPtyProvider()` during
    // attachMainWindowServices, AFTER this service is constructed. Capturing
    // `getLocalPtyProvider()` at construction time would freeze a reference to
    // the pre-daemon `LocalPtyProvider` and miss the routed adapter. Resolve
    // lazily via thunk so teardown always sees the currently-installed
    // provider (design §4.3 wire-up).
    this.getLocalProviderFn = deps?.getLocalProvider ?? null
    this.getSshProviderFn = deps?.getSshProvider ?? null
    this.onPtyStopped = deps?.onPtyStopped ?? null
    this.onTerminalAgentStatus = deps?.onTerminalAgentStatus ?? null
    this.buildAgentHookPtyEnv = deps?.buildAgentHookPtyEnv ?? null
    this.getDesktopWindowStatusFn = deps?.getDesktopWindowStatus ?? (() => 'openable')
    this.prepareAiVaultSessionResumeFn = deps?.prepareAiVaultSessionResume ?? null
    this.agentSessionClaimSigner =
      deps?.agentSessionClaimSigner ?? createEphemeralAgentSessionClaimSigner(this.runtimeId)
    this.onTerminalSideEffects = deps?.onTerminalSideEffects ?? null
    // Why: the ConPTY spawn mark can land after daemon stream data already
    // created this PTY's emulator; the mark retrofits the DA1 override here
    // (terminal-query-authority.md §ConPTY DA1).
    registerConptyDa1OverrideInstaller((ptyId) => this.ensureNativeWindowsConptyDa1Override(ptyId))
    // Why: a renderer attribute push must reach already-live emulators too —
    // cursor options for DECRQSS/DECRQM parity plus the per-PTY OSC color
    // override reset a theme apply implies (terminal-query-authority.md
    // §View-attribute bridge).
    registerTerminalViewAttributesApplier((attributes) => {
      for (const state of this.headlessTerminals.values()) {
        state.emulator.applyPushedViewAttributes(attributes)
      }
    })
  }

  /**
   * Republishes persisted client-hosted pages as held rows, before any host can attach.
   *
   * Without this a runtime restart takes the only record of a client-hosted page with it. When the
   * client restarted too -- a fleet update restarts both -- its guests died with it, so its
   * inventory has nothing to adopt from and no participant can name the page any more.
   *
   * Called from each host's startup rather than the constructor so the ordering against attach is
   * explicit, and so constructing a runtime stays free of persistence reads.
   */
  rehydrateClientHostedBrowserPages(): void {
    if (!this.store?.getWorkspaceSession) {
      return
    }
    try {
      const registry = getRuntimeBrowserPageRegistry(this)
      const liveRepoIds = new Set((this.store.getRepos?.() ?? []).map((repo) => repo.id))
      rehydrateClientHostedBrowserPages(registry, {
        listWorkspaceSessions: () => this.listWorkspaceSessionPartitions(),
        // Why the same discriminant hydration uses: session keys are `${repoId}::${path}` and are
        // not pruned when a repo leaves this client's view, so a row whose repo is gone would
        // surface a tab with no live workspace behind it. Unparseable keys are left alone.
        isKnownWorktree: (worktreeId) => {
          const ownerRepoId = splitWorktreeIdForFilesystem(worktreeId)?.repoId
          return !ownerRepoId || liveRepoIds.has(ownerRepoId)
        }
      })
      for (const page of registry.listPages()) {
        this.persistedClientHostedBrowserWorktreeIds.add(page.workspaceId)
      }
    } catch (error) {
      console.warn('[browser-host-lease] client page rehydration failed:', error)
    }
  }

  /**
   * Rewrites one worktree's persisted client-hosted rows.
   *
   * Guarded because it hangs off the runtime's tab-change announcement, which also fires on
   * terminal and editor churn: a workspace that has never had a client page must not pay a session
   * read for every one of those.
   */
  private persistClientHostedBrowserPagesForWorktree(worktreeId: string): void {
    const registry = getRuntimeBrowserPageRegistry(this)
    const hasPages = registry.listPages(worktreeId).length > 0
    if (!hasPages && !this.persistedClientHostedBrowserWorktreeIds.has(worktreeId)) {
      return
    }
    if (hasPages) {
      this.persistedClientHostedBrowserWorktreeIds.add(worktreeId)
    } else {
      this.persistedClientHostedBrowserWorktreeIds.delete(worktreeId)
    }
    persistClientHostedBrowserPages(
      {
        getWorkspaceSession: (id) => this.getWorkspaceSessionForWorktree(id),
        setWorkspaceSession: (id, session) => this.setWorkspaceSessionForWorktree(id, session)
      },
      registry,
      worktreeId
    )
  }

  private listWorkspaceSessionPartitions(): WorkspaceSessionState[] {
    const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    for (const repo of this.store?.getRepos?.() ?? []) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    return [...hostIds].flatMap((hostId) => {
      const session = this.store?.getWorkspaceSession?.(hostId)
      return session ? [session] : []
    })
  }

  getLocalProvider(): IPtyProvider | null {
    return this.getLocalProviderFn ? this.getLocalProviderFn() : null
  }

  private async stopPtysForDestructiveWorktreeRemoval(
    worktreeId: string,
    options: { connectionId?: string; allowUnverifiedStop?: boolean } = {}
  ): Promise<void> {
    const { connectionId, allowUnverifiedStop } = options
    const provider = connectionId ? this.getSshProviderFn?.(connectionId) : this.getLocalProvider()
    if (!provider) {
      throw new Error(`PTY provider unavailable for worktree deletion: ${worktreeId}`)
    }
    const teardownResult = await killAllProcessesForWorktree(worktreeId, {
      runtime: this as RuntimeCommandSurfaceHost<this>,
      // Why: `repoId::path` ids repeat across hosts, so an unfenced sweep stops a same-id
      // workspace's terminals on another connection (mirrors the IPC removal path).
      resolvedWorktreeId: worktreeId,
      ...(connectionId ? { resolvedConnectionId: connectionId } : {}),
      localProvider: provider,
      onPtyStopped: this.onPtyStopped ?? undefined,
      requirePhysicalStop: true,
      // Why (#11960): set only by an explicit Force Delete, never by the ordinary
      // confirmation — otherwise the gate would be off on the primary delete path.
      ...(allowUnverifiedStop ? { allowUnverifiedStop: true } : {}),
      ...(connectionId ? { includeLocalRegistry: false } : {})
    })
    const total =
      teardownResult.runtimeStopped +
      teardownResult.providerStopped +
      teardownResult.registryStopped
    if (total > 0) {
      console.info(
        `[worktree-teardown] ${worktreeId} killed runtime=${teardownResult.runtimeStopped} provider=${teardownResult.providerStopped} registry=${teardownResult.registryStopped}`
      )
    }
  }

  getStatsSummary(): StatsSummary | null {
    return this.stats?.getSummary() ?? null
  }

  getMemorySnapshot(): Promise<MemorySnapshot> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return collectMemorySnapshot(this.store)
  }

  getUIState(): PersistedUIState {
    if (!this.store?.getUI) {
      throw new Error('runtime_unavailable')
    }
    return this.store.getUI()
  }

  updateUIState(updates: Partial<PersistedUIState>): PersistedUIState {
    if (!this.store?.getUI || !this.store.updateUI) {
      throw new Error('runtime_unavailable')
    }
    this.store.updateUI(updates)
    return this.store.getUI()
  }

  recordFeatureInteraction(id: FeatureInteractionId): PersistedUIState {
    if (!this.store?.recordFeatureInteraction) {
      throw new Error('runtime_unavailable')
    }
    return this.store.recordFeatureInteraction(id)
  }

  getClientSettings() {
    return this.clientSettings.get()
  }

  async updateClientSettings(updates: RuntimeClientSettingsUpdate) {
    return await this.clientSettings.update(updates)
  }

  getClientTerminalQuickCommands(): TerminalQuickCommand[] {
    return this.clientSettings.getTerminalQuickCommands()
  }

  updateClientTerminalQuickCommands(
    mutation: TerminalQuickCommandMutation
  ): TerminalQuickCommand[] {
    return this.clientSettings.updateTerminalQuickCommands(mutation)
  }

  updateClientPRBotAuthorOverride(args: { author: string; isBot: boolean }) {
    return this.clientSettings.updatePRBotAuthorOverride(args)
  }

  listAutomations(): Automation[] {
    return this.automation.list()
  }

  listAutomationRuns(automationId?: string): AutomationRun[] {
    return this.automation.listRuns(automationId)
  }

  showAutomation(id: string): Automation {
    return this.automation.show(id)
  }

  createAutomation(input: RuntimeAutomationCreateInput): Promise<Automation> {
    return this.automation.create(input)
  }

  updateAutomation(id: string, updates: RuntimeAutomationUpdateInput): Promise<Automation> {
    return this.automation.update(id, updates)
  }

  deleteAutomation(id: string): { removed: boolean; id: string } {
    return this.automation.delete(id)
  }

  runAutomationNow(id: string): Promise<AutomationRun> {
    return this.automation.runNow(id)
  }

  // Why: lazy initialization — the DB path depends on Electron's userData
  // which may not be finalized until after app.ready. Also allows unit tests
  // to inject an in-memory DB without touching the filesystem.
  getOrchestrationDb(): OrchestrationDb {
    if (!this._orchestrationDb) {
      const { app } = require('electron')
      const dbPath = join(app.getPath('userData'), 'orchestration.db')
      this._orchestrationDb = new OrchestrationDb(dbPath)
      this.ensureOrchestrationFederationRelay()
      this.scheduleRestoredMessageRepoints()
    }
    return this._orchestrationDb
  }

  setOrchestrationDb(db: OrchestrationDb): void {
    this.orchestrationFederation.resetForDatabaseChange()
    this._orchestrationDb = db
    this.ensureOrchestrationFederationRelay()
    this.scheduleRestoredMessageRepoints()
  }

  prepareLegacyWorkerTerminalRecovery(): LegacyWorkerTerminalRecoveryPlan {
    return this.legacyWorkerRecovery.prepare()
  }

  private async flushWorkspaceSessionOrThrowAsync(): Promise<void> {
    const store = this.store
    if (store?.flushPendingOrThrowAsync) {
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      return
    }
    if (store?.flushOrThrow) {
      store.flushOrThrow()
      return
    }
    throw new Error('workspace_session_persistence_unavailable')
  }

  async reconcileLegacyWorkerTerminals(
    options: { connectionId?: string; materializeRenderer?: boolean } = {}
  ): Promise<LegacyWorkerTerminalRecoveryResult> {
    return this.legacyWorkerRecovery.reconcile(options)
  }

  private updateLegacyWorkerTerminalRecoveryRetry(
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: { connectionId?: string; materializeRenderer?: boolean }
  ): void {
    this.legacyWorkerRecovery.updateRetry(plan, deferredDispatchIds, options)
  }

  async refreshRestoredOrchestrationAuthority(connectionId: string | null = null): Promise<void> {
    if (connectionId === null && !this.canRecoverPersistentLocalPtysFn()) {
      return
    }
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      [...(await this.getResolvedWorktreeMap()).values()],
      null,
      undefined,
      connectionId
    )
    if (!inventory) {
      throw new Error('terminal_liveness_unavailable')
    }
  }

  private hasExactTerminalSurfaceIdentity(expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    terminalHandle: string
    incarnationId: string
  }): boolean {
    if (this.graphStatus !== 'ready') {
      return false
    }
    const pty = this.ptysById.get(expected.ptyId)
    if (
      !pty?.connected ||
      pty.incarnationId !== expected.incarnationId ||
      pty.tabId !== expected.tabId ||
      pty.paneKey !== makePaneKey(expected.tabId, expected.leafId) ||
      !runtimeWorktreeIdsEqual(pty.worktreeId, expected.worktreeId) ||
      this.handleByPtyId.get(expected.ptyId) !== expected.terminalHandle
    ) {
      return false
    }
    const tab = this.tabs.get(expected.tabId)
    const leaf = this.leaves.get(this.getLeafKey(expected.tabId, expected.leafId))
    const ptyLeaves = this.getLeavesForPty(expected.ptyId)
    return (
      Boolean(tab && runtimeWorktreeIdsEqual(tab.worktreeId, expected.worktreeId)) &&
      Boolean(
        leaf &&
        leaf.ptyId === expected.ptyId &&
        runtimeWorktreeIdsEqual(leaf.worktreeId, expected.worktreeId)
      ) &&
      ptyLeaves.length === 1 &&
      ptyLeaves[0]?.tabId === expected.tabId &&
      ptyLeaves[0]?.leafId === expected.leafId
    )
  }

  private hasExactPersistedTerminalSurfaceIdentity(expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    incarnationId: string
  }): boolean {
    const session = this.getWorkspaceSessionForWorktree(expected.worktreeId)
    const sessionWorktreeId = session
      ? resolveTerminalSessionWorktreeId(session, expected.worktreeId)
      : null
    if (!session || !sessionWorktreeId) {
      return false
    }
    const tab = session.tabsByWorktree[sessionWorktreeId]?.find(
      (candidate) => candidate.id === expected.tabId
    )
    const paneKey = makePaneKey(expected.tabId, expected.leafId)
    return Boolean(
      tab &&
      session.terminalLayoutsByTabId[expected.tabId]?.ptyIdsByLeafId?.[expected.leafId] ===
        expected.ptyId &&
      session.terminalPtyIncarnationsByPaneKey?.[paneKey] === expected.incarnationId
    )
  }

  private rollbackLegacyWorkerTerminalSurface(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(candidate.worktreeId)
    if (snapshot) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId: candidate.ptyId,
        exactSurfaces: [{ parentTabId: candidate.tabId, leafId: candidate.leafId }],
        exactOnly: true
      })
      if (retired) {
        this.mobileSessionTabsByWorktree.set(candidate.worktreeId, retired.snapshot)
        this.notifyMobileSessionTabsChanged(candidate.worktreeId)
      }
    }

    const leafKey = this.getLeafKey(candidate.tabId, candidate.leafId)
    const leaf = this.leaves.get(leafKey)
    const pty = this.ptysById.get(candidate.ptyId)
    if (
      leaf?.ptyId === candidate.ptyId &&
      runtimeWorktreeIdsEqual(leaf.worktreeId, candidate.worktreeId)
    ) {
      this.leaves.delete(leafKey)
      const surfaceHandle = this.handleByLeafKey.get(leafKey)
      this.handleByLeafKey.delete(leafKey)
      const handleRecord = surfaceHandle ? this.handles.get(surfaceHandle) : undefined
      if (
        surfaceHandle &&
        handleRecord?.tabId === candidate.tabId &&
        handleRecord.leafId === candidate.leafId &&
        handleRecord.ptyId === candidate.ptyId
      ) {
        this.handles.delete(surfaceHandle)
      }
      this.rebuildLeafPtyIndex()
      if (![...this.leaves.values()].some((entry) => entry.tabId === candidate.tabId)) {
        this.tabs.delete(candidate.tabId)
      }
    }
    if (pty?.tabId === candidate.tabId) {
      pty.tabId = null
      pty.paneKey = null
    }
    this.notifier?.resolveLegacyWorkerTerminalRecovery?.(
      candidate.paneKey,
      'rolled_back',
      candidate.ptyId
    )
  }

  private getLegacyWorkerRecoveryActivation(worktreeId: string): {
    activeTabId?: string
    activeGroupId?: string
  } {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const sessionWorktreeId = session ? resolveTerminalSessionWorktreeId(session, worktreeId) : null
    return {
      ...(sessionWorktreeId && session?.activeTabIdByWorktree?.[sessionWorktreeId]
        ? { activeTabId: session.activeTabIdByWorktree[sessionWorktreeId] }
        : {}),
      ...(sessionWorktreeId && session?.activeGroupIdByWorktree?.[sessionWorktreeId]
        ? { activeGroupId: session.activeGroupIdByWorktree[sessionWorktreeId] }
        : {})
    }
  }

  private async adoptLegacyWorkerTerminal(
    candidate: LegacyWorkerRecoveryCandidate,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: LegacyWorkerRecoveryInventory,
    activation: { activeTabId?: string; activeGroupId?: string }
  ): Promise<void> {
    await this.adoptTerminalOrphansFromInventory(
      {
        worktree: `id:${candidate.worktreeId}`,
        expectedTopologyRevision: this.getTerminalTopologyRevision(candidate.worktreeId),
        ...activation,
        claims: [
          {
            terminal: candidate.terminalHandle,
            ptyId: candidate.ptyId,
            incarnationId: candidate.incarnationId,
            tabId: candidate.tabId,
            leafId: candidate.leafId
          }
        ]
      },
      workspace,
      inventory
    )
  }

  private async revealLegacyWorkerTerminal(
    candidate: LegacyWorkerRecoveryCandidate
  ): Promise<boolean | null> {
    const pty = this.ptysById.get(candidate.ptyId)
    if (!pty || !this.notifier?.revealTerminalSession) {
      return null
    }
    const reveal = await this.notifier.revealTerminalSession(candidate.worktreeId, {
      ptyId: candidate.ptyId,
      title: getLatestPtyTitle(pty) ?? pty.controllerTitle,
      activate: false,
      presentation: 'background',
      tabId: candidate.tabId,
      leafId: candidate.leafId,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: candidate.terminalHandle,
        incarnationId: candidate.incarnationId
      }
    })
    const identity = reveal?.identity
    return Boolean(
      identity &&
      runtimeWorktreeIdsEqual(identity.worktreeId, candidate.worktreeId) &&
      identity.tabId === candidate.tabId &&
      identity.leafId === candidate.leafId &&
      identity.ptyId === candidate.ptyId
    )
  }

  setAutomationService(service: AutomationService): void {
    this.automation.setService(service)
  }

  setArtifactService(service: ArtifactCloudService): void {
    this.artifacts.setService(service)
  }

  listArtifacts(options: ArtifactListOptions): Promise<ArtifactCloudOperation<ArtifactListPage>> {
    return this.artifacts.list(options)
  }

  getPublishedArtifactLink(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<ArtifactPublishedLink | null>> {
    return this.artifacts.getPublishedLink(request)
  }

  shareArtifact(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.artifacts.share(request)
  }

  publishArtifact(
    request: ArtifactWriteRequest
  ): Promise<ArtifactCloudOperation<ArtifactPublishResult>> {
    return this.artifacts.publish(request)
  }

  updateArtifact(request: ArtifactWriteRequest): Promise<ArtifactCloudOperation<ArtifactListItem>> {
    return this.artifacts.update(request)
  }

  unshareArtifact(
    request: ArtifactCloudOptions & { sourceKey: string }
  ): Promise<ArtifactCloudOperation<void>> {
    return this.artifacts.unshare(request)
  }

  deleteArtifact(id: string, options: ArtifactCloudOptions): Promise<ArtifactCloudOperation<void>> {
    return this.artifacts.delete(id, options)
  }

  getRuntimeId(): string {
    return this.runtimeId
  }

  resolveOrchestrationWorkerServer(selector: string): OrchestrationWorkerServer {
    return this.orchestrationFederation.resolveWorkerServer(selector)
  }

  callOrchestrationWorkerServer(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
    envelope?: RuntimeOrchestrationEnvelope
  ): Promise<unknown> {
    return this.orchestrationFederation.callWorkerServer(
      selector,
      method,
      params,
      timeoutMs,
      envelope
    )
  }

  syncOrchestrationFederation(runId?: string): Promise<void> {
    return this.orchestrationFederation.sync(runId)
  }

  syncOrchestrationFederatedDispatch(dispatchId: string): Promise<void> {
    return this.orchestrationFederation.syncDispatch(dispatchId)
  }

  syncOrchestrationFederatedDispatchAfterCurrent(dispatchId: string): Promise<void> {
    return this.orchestrationFederation.syncDispatchAfterCurrent(dispatchId)
  }

  ensureOrchestrationFederationRelay(runId?: string): void {
    this.orchestrationFederation.ensureRelay(runId)
  }

  stopOrchestrationFederationRelay(): void {
    this.orchestrationFederation.stopRelay()
  }

  getStartedAt(): number {
    return this.startedAt
  }

  private tryGetWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId | null {
    return this.workspaceSessions.tryGetHostId(worktreeId)
  }

  private getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId {
    return this.workspaceSessions.getHostId(worktreeId)
  }

  private getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null {
    return this.workspaceSessions.get(worktreeId)
  }

  private setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void {
    this.workspaceSessions.set(worktreeId, session)
  }

  private getKnownWorkspaceSessionWorktreeIds(): Set<string> {
    return this.workspaceSessions.getKnownWorktreeIds()
  }

  private getWorkspaceSessionHydrationTargets(
    includeAllPersistedWorktrees: boolean
  ): Map<string, WorkspaceSessionState> {
    return this.workspaceSessions.getHydrationTargets(includeAllPersistedWorktrees)
  }

  getStatus(): RuntimeStatus {
    // Why: browser panes need a backend that can create and stream a page. A
    // desktop renderer provides one via <webview>; a headless serve provides one
    // via the offscreen backend. Either way the same browser.screencast.v1 path
    // works, so advertise it when either is present. browser.headless.v1
    // additionally tells clients this host owns browser pages with no renderer,
    // so they must not fall back to a local desktop browser tab.
    const hasRenderer = Boolean(this.getAvailableAuthoritativeWindow())
    const hasOffscreen = !hasRenderer && Boolean(this.offscreenBrowserBackend)
    const hasHeadlessCommands = runtimeBrowserCommandsFactoryIsHeadless()
    const canBrowse = hasRenderer || hasOffscreen
    const capabilities: RuntimeCapability[] = RUNTIME_CAPABILITIES.filter(
      (capability) =>
        (capability !== 'browser.screencast.v1' || canBrowse) &&
        // Why: the nested-runtime E2E needs a real legacy transport without maintaining an old binary fixture.
        (process.env.ORCA_E2E_DISABLE_RUNTIME_SHARED_CONTROL !== '1' ||
          capability !== REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY) &&
        (process.env.ORCA_E2E_DISABLE_PAIRED_TERMINAL_PARKING !== '1' ||
          capability !== TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY)
    )
    if (hasOffscreen || hasHeadlessCommands) {
      capabilities.push(BROWSER_HEADLESS_RUNTIME_CAPABILITY)
    }
    // Why: certificate proceed is owned by the browser-hosting process for both
    // desktop webviews and offscreen pages. Advertise whenever either backend
    // can host a page so remote clients can surface Proceed Anyway (Unsafe).
    if (canBrowse) {
      capabilities.push(BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY)
    }
    // Why the cause and not one fixed sentence: the operator can only act on the reason
    // that actually applies, and a host that says "set ORCA_BROWSER_EXECUTABLE" to someone
    // who already set it sends them to fix a thing that is not broken.
    const cause = canBrowse || hasHeadlessCommands ? null : runtimeBrowserUnavailableCause()
    const degradations: RuntimeDegradation[] = cause
      ? [
          {
            code: BROWSER_UNAVAILABLE_ERROR_CODE,
            capability: BROWSER_HEADLESS_RUNTIME_CAPABILITY,
            message: browserUnavailableMessage(cause.reason, cause.detail),
            reason: cause.reason,
            ...(cause.detail ? { detail: cause.detail } : {})
          }
        ]
      : []
    return {
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      graphStatus: this.graphStatus,
      authoritativeWindowId: this.authoritativeWindowId,
      desktopWindowStatus: hasRenderer ? 'available' : this.getDesktopWindowStatusFn(),
      liveTabCount: this.tabs.size,
      liveLeafCount: this.leaves.size,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      // Why: headless orca serve cannot create/stream BrowserViews, so clients
      // must not treat browser panes as supported just because runtime RPC is up.
      capabilities,
      ...(degradations.length > 0 ? { degradations } : {}),
      hostPlatform: process.platform,
      terminalWindowsShell: this.store?.getSettings?.().terminalWindowsShell ?? null,
      floatingWorkspaceEnabled: this.store?.getSettings?.().floatingTerminalEnabled !== false,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleMobileVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    }
  }

  setPtyController(controller: RuntimePtyController | null): void {
    // Why: CLI terminal writes must go through the main-owned PTY registry
    // instead of tunneling back through renderer IPC, or live handles could
    // drift from the process they are supposed to control during reloads.
    this.ptyController = controller
  }

  setNotifier(notifier: RuntimeNotifier | null): void {
    this.notifier = notifier
    if (notifier) {
      this.repositoryForkBackfill.start()
    }
  }

  private countTerminalSideEffectConsumingClientEventListeners(): number {
    return this.clientEvents.countTerminalSideEffectConsumers()
  }

  getTerminalSleepClientEventSnapshot(): RuntimeClientEvent[] {
    const events: RuntimeClientEvent[] = []
    const sleepStates = [...this.terminalSleepStateByWorktreeId.values()].sort((a, b) =>
      a.worktreeId.localeCompare(b.worktreeId)
    )
    for (const state of sleepStates) {
      const committedPtyIds = new Set(state.ptyIds)
      if (state.phase === 'stopping') {
        const pendingPtyIds = Object.keys(state.terminalHandlesByPtyId)
          .filter((ptyId) => !committedPtyIds.has(ptyId))
          .sort()
        if (pendingPtyIds.length > 0) {
          events.push({
            type: 'worktreeTerminalSleepState',
            worktreeId: state.worktreeId,
            generation: state.generation,
            phase: 'started',
            ptyIds: pendingPtyIds,
            terminalHandles: this.getRecordedTerminalSleepHandles(
              pendingPtyIds,
              state.terminalHandlesByPtyId
            )
          })
        }
      }
      if (state.ptyIds.length > 0) {
        events.push({
          type: 'worktreeTerminalSleepState',
          worktreeId: state.worktreeId,
          generation: state.generation,
          phase: 'committed',
          ptyIds: [...state.ptyIds].sort(),
          terminalHandles: this.getRecordedTerminalSleepHandles(
            state.ptyIds,
            state.terminalHandlesByPtyId
          )
        })
      }
    }
    return events
  }

  getNativeChatLaunchDraftResolutionClientEventSnapshot =
    this.nativeChatDraftResolutions.snapshot.bind(this.nativeChatDraftResolutions)

  private emitClientEvent = this.clientEvents.emit.bind(this.clientEvents)

  private resolveNativeChatLaunchDraftOwner(
    handle: string
  ): { tabId: string; worktreeId: string } | null {
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    if (!record.tabId.startsWith('pty:')) {
      return { tabId: record.tabId, worktreeId: record.worktreeId }
    }
    const pty = record.ptyId ? this.ptysById.get(record.ptyId) : null
    const tabId =
      pty?.tabId && !pty.tabId.startsWith('pty:')
        ? pty.tabId
        : parsePaneKey(pty?.paneKey ?? '')?.tabId
    if (!pty || !tabId || tabId.startsWith('pty:')) {
      return null
    }
    return { tabId, worktreeId: pty.worktreeId }
  }

  private notifyWorktreesChanged(repoId: string): void {
    this.notifier?.worktreesChanged(repoId)
    this.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  /** Detail-level worktree lifecycle tap (plugin event bus). The coarse
   *  worktreesChanged client event carries only repoId, which is not enough
   *  for subscribers that need the affected worktree's identity.
   *  Removal payloads carry no branch: the removal target resolves before
   *  the git worktree is torn down and only pins id + path. */
  onWorktreeLifecycle(listener: (event: RuntimeWorktreeLifecycleEvent) => void): () => void {
    return this.worktreeLifecycleEvents.on(listener)
  }

  private emitWorktreeLifecycle(event: RuntimeWorktreeLifecycleEvent): void {
    this.worktreeLifecycleEvents.emit(event)
  }

  private notifyReposChanged(): void {
    this.notifier?.reposChanged()
    this.emitClientEvent({ type: 'reposChanged' })
  }

  // Why: automation writes land in the automation service and IPC handlers, so
  // like SSH state they need a public entry point onto the client-event stream.
  // Old clients drop the unknown event type; nothing is negotiated for it.
  notifyAutomationsChanged(payload: AutomationsChangedPayload = {}): void {
    this.notifier?.automationsChanged?.(payload)
    this.emitClientEvent({ type: 'automationsChanged', ...payload })
  }

  // Why: SSH state changes originate in main's ssh handlers, not in runtime
  // methods, so they need a public entry point onto the client-event stream.
  notifySshStateChanged(targetId: string, state: SshConnectionState): void {
    this.bumpSshRelayRecoveryGeneration(targetId)
    this.invalidateSshWorktreeScanCache(targetId)
    if (state.status !== 'connected') {
      this.legacyWorkerRecovery.cancelScope(`ssh:${targetId}`)
    }
    this.emitClientEvent({ type: 'sshStateChanged', targetId, state: getPublicSshState(state)! })
  }

  notifySshRelayReady(targetId: string): void {
    const generation = this.bumpSshRelayRecoveryGeneration(targetId)
    const publish = async (): Promise<void> => {
      try {
        await this.publishRecoveredSshMobileSessionTabs(targetId, generation)
      } catch (error) {
        if (this.sshRelayRecoveryGenerationByTargetId.get(targetId) === generation) {
          console.warn('[runtime] failed to publish recovered SSH session tabs', {
            targetId,
            error
          })
        }
      }
    }
    const initialPublication = publish()
    void initialPublication
    void this.refreshRestoredOrchestrationAuthority(targetId)
      .then(() =>
        this.reconcileLegacyWorkerTerminals({
          connectionId: targetId,
          materializeRenderer: this.notifier !== null
        })
      )
      .then(async () => {
        await initialPublication
        await publish()
      })
      .catch((error) => {
        if (this.sshRelayRecoveryGenerationByTargetId.get(targetId) !== generation) {
          return
        }
        console.warn('[orchestration] legacy worker reconcile failed on relay ready', {
          targetId,
          error
        })
      })
  }

  private bumpSshRelayRecoveryGeneration(targetId: string): number {
    const generation = (this.sshRelayRecoveryGenerationByTargetId.get(targetId) ?? 0) + 1
    this.sshRelayRecoveryGenerationByTargetId.set(targetId, generation)
    return generation
  }

  private async publishRecoveredSshMobileSessionTabs(
    targetId: string,
    generation: number
  ): Promise<void> {
    const repoIds = new Set(
      (this.store?.getRepos() ?? [])
        .filter((repo) => repo.connectionId === targetId)
        .map((repo) => repo.id)
    )
    if (repoIds.size === 0) {
      return
    }
    const worktreeIds = new Set<string>()
    for (const worktreeId of [
      ...this.getKnownWorkspaceSessionWorktreeIds(),
      ...this.mobileSessionTabsByWorktree.keys()
    ]) {
      const parsed = splitWorktreeId(worktreeId)
      if (parsed && repoIds.has(parsed.repoId)) {
        worktreeIds.add(worktreeId)
      }
    }
    if (worktreeIds.size === 0) {
      return
    }

    // Why: relay readiness follows PTY reattach; rebuild the HUB-owned panes before paired clients consume the connected event.
    for (const worktreeId of worktreeIds) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    await this.refreshMobileSessionPtyRecords()
    if (this.sshRelayRecoveryGenerationByTargetId.get(targetId) !== generation) {
      return
    }
    for (const worktreeId of worktreeIds) {
      this.notifyMobileSessionTabsChangedNow(worktreeId)
    }
  }

  invalidateSshWorktreeScanCache(targetId: string): void {
    this.invalidateSshWorktreeScanCacheInternal(targetId)
  }

  // Why: renderer-initiated meta updates intentionally skip the renderer
  // notifier (the renderer already applied them optimistically), but remote
  // clients hold no optimistic copy and need the invalidation event.
  notifyWorktreesChangedForRemoteClients(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  // Why: structural catalog changes require a fresh Git scan; renderer metadata edits do not.
  notifyWorktreeCatalogChangedForRemoteClients(repoId: string): void {
    this.invalidateWorktreeScanCacheForRepo(repoId)
    const matchingRepos = this.store?.getRepos().filter((repo) => repo.id === repoId) ?? []
    if (matchingRepos.length !== 1 || matchingRepos[0]?.connectionId) {
      return
    }
    this.notifyWorktreesChangedForRemoteClients(repoId)
  }

  // Why: host-local repo IPC mutations never enter runtime methods, so paired
  // clients need an explicit catalog invalidation; the local renderer already
  // got its own repos:changed and must not be re-notified (#11994).
  notifyReposChangedForRemoteClients(): void {
    this.emitClientEvent({ type: 'reposChanged' })
  }

  private notifyActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    this.notifyHostActivateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
    this.notifyClientsActivateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
  }

  private notifyHostActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    this.notifier?.activateWorktree(repoId, worktreeId, setup, startup, defaultTabs)
  }

  private notifyClientsActivateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void {
    this.emitClientEvent(
      toRuntimeActivateWorktreeEvent(repoId, worktreeId, setup, startup, defaultTabs)
    )
  }

  setAgentBrowserBridge(bridge: AgentBrowserBridge | null): void {
    this.agentBrowserBridge = bridge
  }

  getAgentBrowserBridge(): AgentBrowserBridge | null {
    return this.agentBrowserBridge
  }

  setOffscreenBrowserBackend(backend: BrowserBackend | null): void {
    this.offscreenBrowserBackend = backend
  }

  getOffscreenBrowserBackend(): BrowserBackend | null {
    return this.offscreenBrowserBackend
  }

  setEmulatorBridge(bridge: EmulatorBridge | null): void {
    this.emulatorBridge = bridge
  }

  getEmulatorBridge(): EmulatorBridge | null {
    return this.emulatorBridge
  }

  attachWindow(windowId: number): void {
    if (this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID) {
      if (
        this.pendingHeadlessPromotionWindowId !== null &&
        windowId !== this.pendingHeadlessPromotionWindowId
      ) {
        return
      }
      // Why: promotion is a renderer reload of the same graph owner, not a new
      // runtime; stale handles must transition before the real window publishes.
      this.persistWindowlessPtyBindingsForDesktopAttach()
      this.pendingHeadlessPromotionWindowId = windowId
      this.authoritativeWindowId = windowId
      this.beginGraphReload(windowId)
      return
    }
    if (this.authoritativeWindowId === null) {
      // Why: a promoted serve can close and later reopen its window while new
      // background PTYs keep arriving; every windowless gap needs this handoff.
      this.persistWindowlessPtyBindingsForDesktopAttach()
      this.authoritativeWindowId = windowId
    }
  }

  private persistWindowlessPtyBindingsForDesktopAttach(): void {
    if (!this.store?.getWorkspaceSession || !this.store.setWorkspaceSession) {
      return
    }
    const partitions = new Map<
      ExecutionHostId,
      { session: WorkspaceSessionState; ptys: RuntimePtyWorktreeRecord[] }
    >()
    for (const pty of this.ptysById.values()) {
      if (!pty.connected || !pty.tabId) {
        continue
      }
      const hostId = this.getWorkspaceSessionHostIdForWorktree(pty.worktreeId)
      const session = this.store.getWorkspaceSession(hostId)
      const tab = session.tabsByWorktree[pty.worktreeId]?.find(
        (candidate) => candidate.id === pty.tabId
      )
      if (!tab) {
        continue
      }
      const layoutPtyIds = Object.values(
        session.terminalLayoutsByTabId[pty.tabId]?.ptyIdsByLeafId ?? {}
      )
      if (tab.ptyId !== pty.ptyId && !layoutPtyIds.includes(pty.ptyId)) {
        continue
      }
      const partition = partitions.get(hostId) ?? { session, ptys: [] }
      partition.ptys.push(pty)
      partitions.set(hostId, partition)
    }

    for (const [hostId, { session, ptys }] of partitions) {
      // Why: windowless SSH PTYs must be handed to the desktop through their SSH partition, never the local session.
      const activeWorktreeIdsOnShutdown = [
        ...new Set([
          ...(session.activeWorktreeIdsOnShutdown ?? []),
          ...ptys.map((pty) => pty.worktreeId)
        ])
      ]
      const activeConnectionIdsAtShutdown = [
        ...new Set([
          ...(session.activeConnectionIdsAtShutdown ?? []),
          ...ptys
            .map((pty) => pty.connectionId)
            .filter((connectionId): connectionId is string => connectionId !== null)
        ])
      ]
      const remoteSessionIdsByTabId = { ...session.remoteSessionIdsByTabId }
      for (const pty of ptys) {
        if (pty.connectionId && pty.tabId) {
          remoteSessionIdsByTabId[pty.tabId] = pty.ptyId
        }
      }

      this.store.setWorkspaceSession(
        {
          ...session,
          activeWorktreeIdsOnShutdown,
          ...(activeConnectionIdsAtShutdown.length > 0 ? { activeConnectionIdsAtShutdown } : {}),
          ...(Object.keys(remoteSessionIdsByTabId).length > 0 ? { remoteSessionIdsByTabId } : {})
        },
        hostId
      )
    }
  }

  syncWindowGraph(
    windowId: number,
    graph: RuntimeSyncWindowGraph | RuntimeRendererSyncWindowGraph
  ): RuntimeSyncWindowGraphResult {
    if (
      windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      this.headlessGraphFallbackAvailable
    ) {
      if (windowId !== this.pendingHeadlessPromotionWindowId) {
        throw new Error('Runtime graph publisher does not match the pending desktop promotion')
      }
      // Why: a renderer may publish after a failed promotion was restored to
      // headless authority; accepting that late healthy graph is self-healing.
      this.attachWindow(windowId)
    }
    if (this.authoritativeWindowId === null) {
      this.authoritativeWindowId = windowId
    }
    if (windowId !== this.authoritativeWindowId) {
      throw new Error('Runtime graph publisher does not match the authoritative window')
    }
    const rendererGeneration =
      windowId === HEADLESS_RUNTIME_WINDOW_ID
        ? null
        : 'rendererGeneration' in graph && typeof graph.rendererGeneration === 'string'
          ? graph.rendererGeneration
          : undefined
    if (
      typeof rendererGeneration === 'string' &&
      rendererGeneration === this.rendererGeneration &&
      this.graphStatus !== 'ready'
    ) {
      throw new Error('Runtime graph publisher belongs to a superseded renderer generation')
    }
    if (windowId === HEADLESS_RUNTIME_WINDOW_ID) {
      this.headlessGraphFallbackAvailable = true
      this.rendererGeneration = null
    }

    const graphWasReady = this.graphStatus === 'ready'
    const previousTabs = this.tabs
    const previousLeaves = this.leaves
    this.tabs = new Map(graph.tabs.map((tab) => [tab.tabId, tab]))
    const lifecycleLeaves = this.reconcileMobileSessionRetirementFences(graph.leaves)
    const mobileSessionResyncWorktrees = new Set<string>()
    const changedMobileWorktrees = this.syncMobileSessionTabs(
      graph.mobileSessionTabs,
      graph.unchangedMobileSessionWorktrees,
      mobileSessionResyncWorktrees
    )
    const nextLeaves = new Map<string, RuntimeLeafRecord>()
    const graphSyncedAt = this.nextTitleObservationSequence()

    // Why: renderer reloads can briefly republish the same leaf with no ptyId;
    // keep live CLI handles usable while the UI graph rebuilds.
    const preserveLivePtysDuringReload = this.graphStatus === 'reloading'
    for (const leaf of lifecycleLeaves) {
      const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
      const existing = this.leaves.get(leafKey)
      const ptyId =
        preserveLivePtysDuringReload && leaf.ptyId === null && existing?.ptyId
          ? existing.ptyId
          : leaf.ptyId
      const ptyGeneration =
        existing && existing.ptyId !== ptyId
          ? existing.ptyGeneration + 1
          : (existing?.ptyGeneration ?? 0)
      const existingPty = ptyId ? this.ptysById.get(ptyId) : undefined
      const tailSource = existing?.ptyId === ptyId ? existing : existingPty

      nextLeaves.set(leafKey, {
        ...leaf,
        ptyId,
        ptyGeneration,
        connected: ptyId !== null,
        writable: this.graphStatus === 'ready' && ptyId !== null,
        lastOutputAt: tailSource?.lastOutputAt ?? null,
        lastExitCode: tailSource?.lastExitCode ?? null,
        tailBuffer: tailSource?.tailBuffer ?? [],
        tailTranscriptBuffer: tailSource?.tailTranscriptBuffer ?? [],
        tailTranscriptChars: tailSource?.tailTranscriptChars ?? 0,
        tailPartialLine: tailSource?.tailPartialLine ?? '',
        tailPendingAnsi: tailSource?.tailPendingAnsi ?? '',
        tailRedrawCursor: tailSource?.tailRedrawCursor ?? null,
        tailTruncated: tailSource?.tailTruncated ?? false,
        tailLinesTotal: tailSource?.tailLinesTotal ?? 0,
        preview: tailSource?.preview ?? '',
        waitBlockedAt: tailSource?.waitBlockedAt ?? null,
        lastAgentStatus: tailSource?.lastAgentStatus ?? null,
        lastAgentStatusObservedLive: tailSource?.lastAgentStatusObservedLive ?? false,
        lastOscTitle: tailSource?.lastOscTitle ?? null,
        lastOscTitleAt: tailSource?.lastOscTitleAt ?? null,
        paneTitleUpdatedAt:
          existing?.ptyId === ptyId && existing.paneTitle === leaf.paneTitle
            ? existing.paneTitleUpdatedAt
            : graphSyncedAt
      })

      if (leaf.ptyId) {
        this.recordPtyWorktree(leaf.ptyId, leaf.worktreeId, {
          connected: true,
          lastOutputAt: existing?.ptyId === leaf.ptyId ? existing.lastOutputAt : null,
          preview: existing?.ptyId === leaf.ptyId ? existing.preview : '',
          tabId: leaf.tabId,
          paneKey: this.makeRuntimePaneKey(leaf)
        })
      }

      if (existing && (existing.ptyId !== ptyId || existing.ptyGeneration !== ptyGeneration)) {
        // Why: mobile can subscribe while the pane is waiting for its first PTY.
        // Keep that handle usable after the recovery mount binds it.
        const adoptedFirstPty =
          existing.ptyId === null && this.adoptFirstPtyForLeafHandle(leafKey, ptyId, ptyGeneration)
        if (!adoptedFirstPty) {
          this.invalidateLeafHandle(leafKey)
        }
      }
    }

    // Why: computed BEFORE preserving stale leaves so preservation can refuse a
    // leaf whose PTY the incoming graph already rebound to a live leaf. Two
    // leaves on one PTY resolve to the same handle (handles are ptyId-keyed) and
    // crash paired clients with a duplicate React key.
    const nextPtyIds = new Set(
      [...nextLeaves.values()].map((leaf) => leaf.ptyId).filter((ptyId): ptyId is string => !!ptyId)
    )
    for (const oldLeafKey of this.leaves.keys()) {
      if (!nextLeaves.has(oldLeafKey)) {
        const oldLeaf = this.leaves.get(oldLeafKey)
        if (
          preserveLivePtysDuringReload &&
          oldLeaf?.ptyId &&
          this.handleByPtyId.has(oldLeaf.ptyId) &&
          !nextPtyIds.has(oldLeaf.ptyId)
        ) {
          // Why: a CLI-created agent keeps using its exported handle even if
          // the reloaded renderer has not rebound the pane yet.
          nextLeaves.set(oldLeafKey, oldLeaf)
          nextPtyIds.add(oldLeaf.ptyId)
        } else if (oldLeaf?.ptyId && nextPtyIds.has(oldLeaf.ptyId)) {
          // Why: the incoming graph already rebound this PTY to a live leaf (e.g.
          // a woken agent re-keyed to a new leaf during renderer reload). Keeping
          // the old leaf too would put two leaves on ONE PTY, which emit the same
          // terminal handle and crash paired clients. Drop the stale leaf; if its
          // handle is the shared ptyId-keyed one it belongs to the live leaf now,
          // so release only this dead leaf key's alias. A leaf-unique handle has
          // no next owner — invalidate it so in-flight CLI waiters fail fast
          // instead of hanging on a dead leaf.
          const oldHandle = this.handleByLeafKey.get(oldLeafKey)
          if (oldHandle !== undefined && oldHandle === this.handleByPtyId.get(oldLeaf.ptyId)) {
            this.handleByLeafKey.delete(oldLeafKey)
          } else {
            this.invalidateLeafHandle(oldLeafKey)
          }
        } else {
          this.invalidateLeafHandle(oldLeafKey)
        }
      }
    }

    for (const [ptyId, leaf] of this.detachedPreAllocatedLeaves) {
      if (nextPtyIds.has(ptyId) || !this.handleByPtyId.has(ptyId)) {
        this.detachedPreAllocatedLeaves.delete(ptyId)
        continue
      }
      nextLeaves.set(this.getLeafKey(leaf.tabId, leaf.leafId), leaf)
      nextPtyIds.add(ptyId)
    }

    this.leaves = nextLeaves
    this.rebuildLeafPtyIndex()
    // Why: the emitted client payload is a function of the stored snapshot AND
    // the tab/leaf graph (handles/titles/connected resolve from leaf state), so
    // a graph-only change — e.g. a restored leaf binding its ptyId while the
    // snapshot pair is unchanged — must also fan out, or a paired client stays
    // on pending-handle forever. Schedule the union on the same 50ms trailing
    // edge as the OSC-title path; the coalescer emit reads the latest state at
    // fire time so no final version is ever lost.
    for (const worktreeId of this.collectMobileVisibleGraphChangedWorktrees(
      previousTabs,
      previousLeaves
    )) {
      if (changedMobileWorktrees.has(worktreeId)) {
        continue
      }
      const stored = this.mobileSessionTabsByWorktree.get(worktreeId)
      if (!stored) {
        continue
      }
      // Why: web clients drop same-epoch frames whose version isn't strictly
      // newer, so a graph-only change must mint a fresh stored version (like
      // the PTY touch path does) or the re-emitted payload — e.g. the
      // pending-handle → ready flip — is discarded and the client stays stale.
      // The accepted-renderer tracking is untouched: this is a main-local bump.
      this.mobileSessionTabsByWorktree.set(worktreeId, {
        ...stored,
        snapshotVersion: stored.snapshotVersion + 1
      })
      changedMobileWorktrees.add(worktreeId)
    }
    for (const worktreeId of changedMobileWorktrees) {
      if (this.mobileSessionTabsByWorktree.has(worktreeId)) {
        this.mobileSessionTabsNotifyCoalescer.schedule(worktreeId)
      }
    }
    this.markGraphReady(windowId)
    if (rendererGeneration !== undefined) {
      this.rendererGeneration = rendererGeneration
    }
    for (const leaf of this.leaves.values()) {
      this.adoptPreAllocatedHandle(leaf)
      const previousLeaf = previousLeaves.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (
        this._orchestrationDb &&
        leaf.lastAgentStatus === 'idle' &&
        leaf.lastAgentStatusObservedLive &&
        leaf.writable &&
        (!graphWasReady ||
          previousLeaf?.ptyId !== leaf.ptyId ||
          !previousLeaf.writable ||
          previousLeaf.lastAgentStatus !== 'idle' ||
          !previousLeaf.lastAgentStatusObservedLive)
      ) {
        this.deliverPendingMessagesForLeaf(leaf)
      }
    }

    // Why: createTerminal waits for the renderer's graph sync to populate the
    // new leaf so it can return a handle. Drain callbacks after leaves update.
    for (const cb of [...this.graphSyncCallbacks]) {
      cb()
    }

    const agentOrchestrationByPaneKey = this.agentOrchestrationProjection.buildByPaneKey()
    const nativeChatLaunchDraftResolutions =
      this.getNativeChatLaunchDraftResolutionClientEventSnapshot().map(
        ({ tabId, text, createdAt }) => ({ tabId, text, createdAt })
      )
    return {
      ...this.getStatus(),
      ...(agentOrchestrationByPaneKey ? { agentOrchestrationByPaneKey } : {}),
      ...(nativeChatLaunchDraftResolutions.length > 0 ? { nativeChatLaunchDraftResolutions } : {}),
      ...(mobileSessionResyncWorktrees.size > 0
        ? { mobileSessionResyncWorktrees: [...mobileSessionResyncWorktrees] }
        : {})
    }
  }

  // Why: toMobileSessionTabsResult resolves handles/titles from this.tabs and
  // this.leaves, so any tab/leaf delta a graph sync installs can flip the
  // client payload (pending-handle → ready, tab title) with zero change to the
  // stored snapshot. Compare exactly the projection-relevant fields and report
  // the affected worktrees; false positives only cost a coalesced no-op emit.
  private collectMobileVisibleGraphChangedWorktrees(
    previousTabs: Map<string, RuntimeSyncedTab>,
    previousLeaves: Map<string, RuntimeLeafRecord>
  ): Set<string> {
    const changed = new Set<string>()
    for (const [tabId, tab] of this.tabs) {
      const prev = previousTabs.get(tabId)
      if (!prev || prev.title !== tab.title) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [tabId, tab] of previousTabs) {
      if (!this.tabs.has(tabId)) {
        changed.add(tab.worktreeId)
      }
    }
    for (const [leafKey, leaf] of this.leaves) {
      const prev = previousLeaves.get(leafKey)
      if (
        !prev ||
        prev.ptyId !== leaf.ptyId ||
        prev.connected !== leaf.connected ||
        prev.paneTitle !== leaf.paneTitle
      ) {
        changed.add(leaf.worktreeId)
      }
    }
    for (const [leafKey, leaf] of previousLeaves) {
      if (!this.leaves.has(leafKey)) {
        changed.add(leaf.worktreeId)
      }
    }
    return changed
  }

  async listMobileSessionTabs(
    worktreeSelector: string,
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    if (explicitWorktreeId) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(explicitWorktreeId)
      await this.refreshMobileSessionPtyRecords(explicitWorktreeId)
      this.restoreLivePairedRendererSessionOwnedMobileTerminals(explicitWorktreeId)
      return this.getMobileSessionTabsForWorktree(explicitWorktreeId, clientNavigationId)
    }
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id)
    await this.refreshMobileSessionPtyRecords()
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(worktree.id)
    return this.getMobileSessionTabsForWorktree(worktree.id, clientNavigationId)
  }

  async listAllMobileSessionTabs(
    clientNavigationId?: string
  ): Promise<RuntimeMobileSessionTabsResult[]> {
    for (const worktreeId of this.getKnownWorkspaceSessionWorktreeIds()) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    await this.refreshMobileSessionPtyRecords()
    return [...this.mobileSessionTabsByWorktree.values()].map((snapshot) =>
      this.projectMobileSessionTabsForClient(
        this.toMobileSessionTabsResult(snapshot),
        clientNavigationId
      )
    )
  }

  private hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId?: string,
    options: {
      force?: boolean
      allowAttachedWindow?: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
      workspaceSession?: WorkspaceSessionState
    } = {}
  ): Set<string> {
    // Why: report which worktrees were reconciled in place so callers don't
    // reconcile them a second time (see notifyMobileSessionTabsChanged).
    const reconciledWorktreeIds = new Set<string>()
    if (this.getAvailableAuthoritativeWindow() && options.allowAttachedWindow !== true) {
      return reconciledWorktreeIds
    }
    const session =
      options.workspaceSession ??
      (worktreeId
        ? this.getWorkspaceSessionForWorktree(worktreeId)
        : this.store?.getWorkspaceSession?.())
    if (!session) {
      return reconciledWorktreeIds
    }
    // Why: with no runtime-owned candidate in the session and no offscreen
    // browser backend, this hydrate provably builds zero tabs for
    // every worktree — skip the per-worktree rebuild entirely (hot on every
    // graph sync). Scoped to onlyRuntimeOwnedTerminals so full hydrates are
    // untouched.
    if (
      options.onlyRuntimeOwnedTerminals === true &&
      !this.offscreenBrowserBackend &&
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId ?? '').length === 0 &&
      options.runtimeOwnedTerminalCandidateKnown !== true &&
      !(worktreeId
        ? this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
            session,
            worktreeId,
            session.tabsByWorktree[worktreeId] ?? []
          )
        : this.workspaceSessionHasRuntimeOwnedPtyCandidate(session))
    ) {
      return reconciledWorktreeIds
    }
    const entries =
      worktreeId !== undefined
        ? ([[worktreeId, session.tabsByWorktree[worktreeId] ?? []]] as const)
        : Object.entries(session.tabsByWorktree ?? {})
    // Why: workspaceSession keys are `${repoId}::${path}` and are not pruned when
    // a repo disappears from this client's view (e.g. removed on another client,
    // or a stale browser-persisted session). Hydrating such a key would surface a
    // phantom "unknown"/duplicate workspace with no live repo behind it. Only
    // hydrate sessions whose repo still exists; leave unparseable keys alone.
    // Resolved lazily so unparseable keys (floating terminals) never pay for a
    // repo inventory on the hot poll path, and `null` when the store cannot
    // report repos — an unavailable list must not read as "every repo is gone".
    let liveRepoIds: Set<string> | null | undefined
    for (const [entryWorktreeId, persistedTabs] of entries) {
      const ownerRepoId = splitWorktreeIdForFilesystem(entryWorktreeId)?.repoId
      if (ownerRepoId) {
        if (liveRepoIds === undefined) {
          const knownRepos = this.store?.getRepos?.()
          liveRepoIds = knownRepos ? new Set(knownRepos.map((repo) => repo.id)) : null
        }
        if (liveRepoIds && !liveRepoIds.has(ownerRepoId)) {
          continue
        }
      }
      const existing = this.mobileSessionTabsByWorktree.get(entryWorktreeId)
      if (
        existing &&
        existing.tabs.length > 0 &&
        options.force !== true &&
        options.onlyRuntimeOwnedTerminals !== true
      ) {
        // Why: terminals are stable/persisted so we normally skip a rebuild, but
        // offscreen browser tabs are live and may have been created/closed since.
        // Reconcile just the browser tabs against the live bridge instead of
        // leaving a stale snapshot that omits a freshly-opened browser tab.
        this.reconcileHeadlessMobileSessionBrowserTabs(entryWorktreeId, existing)
        reconciledWorktreeIds.add(entryWorktreeId)
        continue
      }
      const terminalTabs = buildHeadlessMobileSessionTerminalTabs(
        entryWorktreeId,
        persistedTabs,
        session
      ).filter(
        (tab) =>
          options.onlyRuntimeOwnedTerminals !== true ||
          this.hasServeOrSshOwnedBinding(tab) ||
          this.hasRecentExpiredSshLeasePane(entryWorktreeId, tab)
      )
      // Why: offscreen browser panes are live-only (no persisted session entry),
      // so include them on every hydrate regardless of the onlyRuntimeOwnedTerminals
      // filter, which is about terminal PTY ownership and never applies to browsers.
      const browserTabs = this.buildHeadlessMobileSessionBrowserTabs(entryWorktreeId)
      const tabs: RuntimeMobileSessionSnapshotTab[] = [...terminalTabs, ...browserTabs]
      if (tabs.length === 0) {
        continue
      }
      const activeTab = pickHeadlessActiveTerminalTab(terminalTabs)
      const tabOrder = [
        ...collectHeadlessParentTabOrder(terminalTabs),
        ...browserTabs.map((tab) => tab.id)
      ]
      const groupId = getHeadlessMobileSessionGroupId(entryWorktreeId)
      const mergedTabs =
        options.onlyRuntimeOwnedTerminals === true && existing
          ? mergeMobileSessionSnapshotTabs(existing.tabs, tabs)
          : tabs
      const mergedActiveTab =
        existing?.tabs.find((tab) => tab.id === existing.activeTabId) ??
        activeTab ??
        mergedTabs[0] ??
        null
      const mergedTerminalTabs = mergedTabs.filter(
        (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
      )
      const mergedBrowserOrder = mergedTabs
        .filter((tab): tab is RuntimeMobileSessionBrowserTab => tab.type === 'browser')
        .map((tab) => tab.id)
      // Why: a persisted multi-group split must be restored on cold rebuild, or
      // the headless serve coalesces the user's group layout back into one group
      // (the persisted tabGroups/tabGroupLayouts would otherwise be write-only).
      const persistedGroups = session.tabGroups?.[entryWorktreeId]
      const persistedLayout = session.tabGroupLayouts?.[entryWorktreeId]
      const hasPersistedSplit =
        options.onlyRuntimeOwnedTerminals !== true &&
        persistedGroups !== undefined &&
        persistedGroups.length > 1
      const activeTopLevelId = mergedActiveTab
        ? mergedActiveTab.type === 'terminal'
          ? mergedActiveTab.parentTabId
          : mergedActiveTab.id
        : null
      const nextTabGroups: RuntimeMobileSessionTabGroup[] = hasPersistedSplit
        ? appendBrowserTabOrder(
            distributeHeadlessTabsAcrossGroups(
              persistedGroups.map((group) => ({
                id: group.id,
                activeTabId: group.activeTabId,
                tabOrder: [...group.tabOrder],
                ...(group.recentTabIds ? { recentTabIds: [...group.recentTabIds] } : {})
              })),
              collectHeadlessParentTabOrder(mergedTerminalTabs),
              activeTopLevelId
            ),
            mergedBrowserOrder,
            undefined,
            // Why: distribute drops browser ids (terminal-only), so carry each
            // browser's persisted group forward instead of coalescing left.
            collectBrowserGroupAssignment(persistedGroups, mergedBrowserOrder)
          )
        : options.onlyRuntimeOwnedTerminals === true && existing?.tabGroups
          ? appendBrowserTabOrder(
              mergeMobileSessionTabGroups(
                entryWorktreeId,
                existing.tabGroups,
                mergedTerminalTabs,
                mergedActiveTab?.type === 'terminal' ? mergedActiveTab : null
              ),
              mergedBrowserOrder
            )
          : [
              {
                id: groupId,
                activeTabId: mergedActiveTab?.id
                  ? (activeTab?.parentTabId ?? mergedActiveTab.id)
                  : (tabOrder[0] ?? null),
                tabOrder
              }
            ]
      // Why: merging runtime tabs INTO a renderer publication must not reclass
      // the snapshot as headless-built — the preservation predicate would then
      // treat the renderer's own tabs as runtime-owned and resurrect tabs the
      // renderer later closes. Keep the renderer base epoch with a merge suffix
      // (idempotent) so ownership stays derivable from the epoch.
      const mergedIntoRendererPublication =
        options.onlyRuntimeOwnedTerminals === true &&
        existing !== undefined &&
        !this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)
      const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
        worktree: existing?.worktree ?? entryWorktreeId,
        publicationEpoch: mergedIntoRendererPublication
          ? this.getMergedMobileSessionPublicationEpoch(existing, tabs)
          : `headless-hydrated:${Date.now().toString(36)}`,
        snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
        activeGroupId: existing?.activeGroupId ?? groupId,
        activeTabId: mergedActiveTab?.id ?? null,
        activeTabType: mergedActiveTab?.type ?? null,
        tabGroups: nextTabGroups,
        // Why: the runtime-owned rebuild runs on every graph sync — carry the
        // existing split layout forward or each sync drops it and fans out.
        ...(hasPersistedSplit && persistedLayout
          ? { tabGroupLayout: persistedLayout }
          : options.onlyRuntimeOwnedTerminals === true && existing?.tabGroupLayout
            ? { tabGroupLayout: existing.tabGroupLayout }
            : {}),
        tabs: mergedTabs
      }
      // Why: the runtime-owned hydrate runs on EVERY graph sync; when the rebuilt
      // projection matches the existing snapshot, keep the existing object and
      // (epoch, version) untouched so identity-based change detection stays a
      // pure no-op and unchanged runtime/browser worktrees never fan out.
      if (existing && headlessMobileSnapshotContentUnchanged(existing, nextSnapshot)) {
        continue
      }
      this.mobileSessionTabsByWorktree.set(entryWorktreeId, nextSnapshot)
    }
    return reconciledWorktreeIds
  }

  // Why: keep an existing snapshot's browser tabs in sync with the live bridge
  // without rebuilding stable terminal state. Replaces browser entries with the
  // current live set and rewrites the browser portion of the primary group order.
  private reconcileHeadlessMobileSessionBrowserTabs(
    worktreeId: string,
    existing: RuntimeMobileSessionTabsSnapshot
  ): void {
    const liveBrowserTabs = this.buildHeadlessMobileSessionBrowserTabs(worktreeId)
    const liveIds = liveBrowserTabs.map((tab) => tab.id)
    const existingBrowserTabs = existing.tabs.filter(
      (tab): tab is RuntimeMobileSessionBrowserTab => tab.type === 'browser'
    )
    const existingBrowserIds = existingBrowserTabs.map((tab) => tab.id)
    if (headlessBrowserTabsUnchanged(liveBrowserTabs, existingBrowserTabs)) {
      return
    }
    const nonBrowserTabs = existing.tabs.filter((tab) => tab.type !== 'browser')
    const nextTabs: RuntimeMobileSessionSnapshotTab[] = [...nonBrowserTabs, ...liveBrowserTabs]
    const liveIdSet = new Set(liveIds)
    const tabGroups = appendBrowserTabOrder(
      (existing.tabGroups ?? []).map((group) => ({
        ...group,
        // Drop closed browser ids; appendBrowserTabOrder re-adds the live ones.
        tabOrder: group.tabOrder.filter(
          (id) => liveIdSet.has(id) || !existingBrowserIds.includes(id)
        )
      })),
      liveIds
    )
    const activeStillPresent = nextTabs.some((tab) => tab.id === existing.activeTabId)
    const active = activeStillPresent
      ? null
      : (nextTabs.find((tab) => tab.isActive) ?? nextTabs[0] ?? null)
    this.mobileSessionTabsByWorktree.set(worktreeId, {
      ...existing,
      publicationEpoch: `headless-hydrated:${Date.now().toString(36)}`,
      snapshotVersion: existing.snapshotVersion + 1,
      ...(activeStillPresent
        ? {}
        : { activeTabId: active?.id ?? null, activeTabType: active?.type ?? null }),
      tabGroups,
      tabs: nextTabs
    })
  }

  private isServeOwnedPtyId(ptyId: string | null | undefined): boolean {
    return typeof ptyId === 'string' && ptyId.startsWith('serve-')
  }

  private isSshOwnedPtyId(ptyId: string | null | undefined): boolean {
    return typeof ptyId === 'string' && parseAppSshPtyId(ptyId) !== null
  }

  private workspaceSessionHasRuntimeOwnedPtyCandidate(session: WorkspaceSessionState): boolean {
    return Object.entries(session.tabsByWorktree ?? {}).some(([worktreeId, tabs]) =>
      this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(session, worktreeId, tabs)
    )
  }

  private workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
    session: WorkspaceSessionState,
    worktreeId: string,
    tabs: WorkspaceSessionState['tabsByWorktree'][string]
  ): boolean {
    return tabs.some((tab) => {
      if (this.isServeOrSshOwnedPtyId(tab.ptyId)) {
        return true
      }
      const leafPtyIds = session.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId
      return (
        (leafPtyIds &&
          Object.values(leafPtyIds).some((ptyId) => this.isServeOrSshOwnedPtyId(ptyId))) ||
        // Why: expiry keeps pane coordinates so paired viewers can request a fresh shell.
        this.getRecentExpiredSshLease(worktreeId, tab.id, undefined) !== null
      )
    })
  }

  private getRecentExpiredSshLease(
    worktreeId: string,
    tabId: string,
    leafId: string | undefined,
    ptyId?: string
  ): ReturnType<NonNullable<RuntimeStore['getSshRemotePtyLeases']>>[number] | null {
    const now = Date.now()
    return (
      this.store
        ?.getSshRemotePtyLeases?.()
        .find(
          (lease) =>
            lease.state === 'expired' &&
            lease.worktreeId === worktreeId &&
            lease.tabId === tabId &&
            (ptyId === undefined || lease.ptyId === ptyId) &&
            (leafId === undefined || lease.leafId === undefined || lease.leafId === leafId) &&
            lease.updatedAt <= now &&
            now - lease.updatedAt <= SSH_PANE_RECOVERY_GRACE_MS
        ) ?? null
    )
  }

  private hasRecentExpiredSshLeasePane(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    return this.getRecentExpiredSshLease(worktreeId, tab.parentTabId, tab.leafId) !== null
  }

  // Why: serve-* (local serve) and ssh:<conn>@@<relay> (SSH relay) ids are minted
  // ONLY for runtime-owned terminals and are preserved/re-hydrated, so tear them
  // down even if the renderer adopted a view (else they resurrect). The daemon
  // session form <worktreeId>@@<shortUuid> is deliberately NOT here: the daemon
  // mints it for ordinary renderer-owned local terminals too, so id shape can't
  // classify ownership for that form — renderer-graph membership does (below).
  private isServeOrSshOwnedPtyId(ptyId: string | null | undefined): boolean {
    return this.isServeOwnedPtyId(ptyId) || this.isSshOwnedPtyId(ptyId)
  }

  private hasServeOrSshOwnedBinding(tab: RuntimeMobileSessionTerminalTab): boolean {
    if (this.isServeOrSshOwnedPtyId(tab.ptyId)) {
      return true
    }
    return Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {}).some((ptyId) =>
      this.isServeOrSshOwnedPtyId(ptyId)
    )
  }

  // Why: a snapshot tab can keep a serve/SSH-owned ptyId after the runtime
  // terminal died and was de-persisted, so id shape alone must not preserve it
  // against a renderer publication. Require the binding to be backed by a live
  // PTY or by the persisted workspace session (a dormant persisted serve/SSH
  // binding is still re-hydratable, so it stays preserved).
  private hasLiveOrPersistedServeOrSshOwnedPtyBinding(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    const boundPtyIds = [
      tab.ptyId,
      ...Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {})
    ].filter((ptyId): ptyId is string => this.isServeOrSshOwnedPtyId(ptyId))
    const boundSshPtyIds = boundPtyIds.filter((ptyId) => this.isSshOwnedPtyId(ptyId))
    if (boundPtyIds.length === 0) {
      return this.hasRecentExpiredSshLeasePane(worktreeId, tab)
    }
    // Why: exited PTY records are archived in ptysById, so require a connected
    // record — a dead serve shell whose persisted binding is also gone must
    // stop being preserved.
    if (boundPtyIds.some((ptyId) => this.ptysById.get(ptyId)?.connected === true)) {
      return true
    }
    const now = Date.now()
    if (
      boundPtyIds.some((ptyId) => {
        const pty = this.ptysById.get(ptyId)
        return (
          pty?.connectionId != null &&
          pty.lastExitCode != null &&
          pty.lastExitCode < 0 &&
          pty.disconnectedAt != null &&
          now - pty.disconnectedAt <= SSH_PANE_RECOVERY_GRACE_MS
        )
      })
    ) {
      // Why: an abnormal SSH transport exit can beat paired-viewer recovery; retain its pane briefly so the HUB remains addressable.
      return true
    }
    if (
      now - this.startedAt <= SSH_PANE_RECOVERY_GRACE_MS &&
      boundSshPtyIds.some((ptyId) => {
        const pty = this.ptysById.get(ptyId)
        return !pty || (!pty.connected && pty.lastExitCode === null)
      })
    ) {
      // Why: after a HUB restart, failed SSH reattach can remove persistence before the fresh runtime records an exit; keep the pane reachable for ensure.
      return true
    }
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session) {
      return false
    }
    const persistedTab = (session.tabsByWorktree?.[worktreeId] ?? []).find(
      (candidate) => candidate.id === tab.parentTabId
    )
    if (!persistedTab) {
      return false
    }
    const persistedPtyIds = new Set(
      [
        persistedTab.ptyId,
        ...Object.values(session.terminalLayoutsByTabId?.[persistedTab.id]?.ptyIdsByLeafId ?? {})
      ].filter((ptyId): ptyId is string => typeof ptyId === 'string')
    )
    return boundPtyIds.some((ptyId) => persistedPtyIds.has(ptyId))
  }

  private hasLiveRuntimeSessionOwnedPtyBinding(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
    return pty?.connected === true && pty.runtimeSessionOwned
  }

  private clearRuntimeSessionOwnershipForMobileTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    parentTabId: string
  ): void {
    for (const tab of snapshot.tabs) {
      if (tab.type !== 'terminal' || tab.parentTabId !== parentTabId) {
        continue
      }
      const ptyIds = [tab.ptyId, ...Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {})].filter(
        (ptyId): ptyId is string => typeof ptyId === 'string'
      )
      for (const ptyId of ptyIds) {
        const pty = this.ptysById.get(ptyId)
        if (pty?.worktreeId === worktreeId && pty.tabId === parentTabId) {
          pty.runtimeSessionOwned = false
          this.setPairedRendererSessionOwnership(pty.ptyId, false)
        }
      }
    }
  }

  // Why: a tab needs authoritative runtime teardown (kill + de-persist + prune)
  // only when the renderer can't durably tear it down: either it's serve/SSH
  // (preserved + re-hydrated, would resurrect) or the renderer graph never
  // published it (a leaked/unadopted shell — incl. daemon-session `@@` tabs the
  // host materialized but the renderer never showed). A tab the renderer graph
  // DOES list — including an ordinary daemon-backed local terminal or a pending
  // tab whose PTY hasn't bound — is renderer-owned: delegate, do not de-persist.
  private isRuntimeOwnedHeadlessMobileTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    if (this.hasServeOrSshOwnedBinding(tab)) {
      return true
    }
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
    if (pty && this.isServeOrSshOwnedPtyId(pty.ptyId)) {
      return true
    }
    return !this.tabs.has(tab.parentTabId)
  }

  /**
   * Publishes a PTY-backed terminal tab snapshot to the synced mobile session,
   * normalizing Pi-compatible titles based on launch or foreground ownership.
   */
  private publishPtyBackedMobileSessionTerminal(
    worktreeId: string,
    pty: RuntimePtyWorktreeRecord,
    args: {
      tabId: string
      leafId: string
      title: string | null
      activate: boolean
      selectIfNoActiveTab?: boolean
      startupCwd?: string
      viewMode?: 'terminal' | 'chat'
      split?: { splitFromLeafId: string; direction: 'horizontal' | 'vertical' }
      notify?: boolean
    }
  ): void {
    if (
      !this.isMobileSessionSurfaceMembershipAllowed(worktreeId, args.tabId, args.leafId, pty.ptyId)
    ) {
      return
    }
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    const ownerAgent = pty.launchAgent ?? pty.foregroundAgent
    const title = normalizeCompatibleAgentTitleForOwner(
      args.title ?? getLatestPtyTitle(pty) ?? 'Terminal',
      ownerAgent
    )
    const existingTab = existing?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === args.tabId &&
        candidate.leafId === args.leafId
    )
    // Why: a split inserts into the parent tab's layout, which lives on the
    // sibling surface, not this new leaf's (empty) existing surface.
    const baseLayout = args.split
      ? (existing?.tabs.find(
          (candidate): candidate is RuntimeMobileSessionTerminalTab =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === args.tabId &&
            candidate.leafId === args.split!.splitFromLeafId
        )?.parentLayout ?? existingTab?.parentLayout)
      : existingTab?.parentLayout
    const parentLayout = buildMaterializedHeadlessParentLayout(
      args.leafId,
      pty.ptyId,
      baseLayout,
      args.split
    )
    // Why: a main-side PTY rescue or split publication must not erase the
    // host's explicit tab mode before the renderer graph catches up.
    const viewMode =
      args.viewMode ??
      existingTab?.viewMode ??
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === args.tabId &&
          candidate.viewMode !== undefined
      )?.viewMode
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${args.tabId}::${args.leafId}`,
      parentTabId: args.tabId,
      leafId: args.leafId,
      ptyId: pty.ptyId,
      title,
      ...(pty.launchAgent ? { launchAgent: pty.launchAgent } : {}),
      ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
      ...(viewMode ? { viewMode } : {}),
      parentLayout,
      isActive:
        args.activate || (args.selectIfNoActiveTab !== false && existing?.activeTabId == null)
    }
    const existingTabs = (existing?.tabs ?? []).filter(
      (candidate) =>
        !(
          candidate.type === 'terminal' &&
          candidate.parentTabId === args.tabId &&
          candidate.leafId === args.leafId
        )
    )
    const tabs = mergeMobileSessionSnapshotTabs(
      existingTabs.map((candidate) => ({
        ...candidate,
        // Why: the client picks one sibling's parentLayout to render the whole
        // tab; a split must update every sibling surface to the new tree, or a
        // stale single-leaf sibling makes the client fall back to a default
        // direction ("Split Right" renders as down).
        ...(args.split && candidate.type === 'terminal' && candidate.parentTabId === args.tabId
          ? { parentLayout }
          : {}),
        isActive: tab.isActive ? false : candidate.isActive
      })),
      [tab]
    )
    const activeTab =
      (tab.isActive ? tab : tabs.find((candidate) => candidate.id === existing?.activeTabId)) ??
      tabs.find((candidate) => candidate.isActive) ??
      (args.selectIfNoActiveTab !== false ? tabs[0] : null) ??
      null
    const terminalTabs = tabs.filter(
      (candidate): candidate is RuntimeMobileSessionTerminalTab => candidate.type === 'terminal'
    )
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      publicationEpoch:
        existing?.publicationEpoch ?? `headless:pty-backed:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      activeGroupId: existing?.activeGroupId ?? getHeadlessMobileSessionGroupId(worktreeId),
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: mergeMobileSessionTabGroups(
        worktreeId,
        existing?.tabGroups ?? [],
        terminalTabs,
        activeTab?.type === 'terminal' ? activeTab : null
      ),
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, next)
    if (args.notify !== false) {
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
  }

  private touchMobileSessionSnapshotsForPty(
    ptyId: string,
    options: { immediate?: boolean } = {}
  ): void {
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const hasPtyBackedTab = snapshot.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] === ptyId)
      )
      if (!hasPtyBackedTab) {
        continue
      }
      this.touchMobileSessionTabsForWorktree(worktreeId, options)
    }
  }

  private getMobileSessionWorktreeIdsForPty(ptyId: string): string[] {
    const worktreeIds: string[] = []
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const hasPtyBackedTab = snapshot.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] === ptyId)
      )
      if (hasPtyBackedTab) {
        worktreeIds.push(worktreeId)
      }
    }
    return worktreeIds
  }

  /** Bump the snapshot version and emit, coalesced unless `immediate`.
   *  Why the bump: clients gate mirrored snapshots on a strictly increasing
   *  `snapshotVersion`, so a re-emit at the same version is silently dropped. */
  touchMobileSessionTabsForWorktree(
    worktreeId: string,
    options: { immediate?: boolean } = {}
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1
    })
    if (options.immediate) {
      // Why: readiness/lifecycle changes are structural and must not wait
      // behind the title/status coalescing window.
      this.notifyMobileSessionTabsChanged(worktreeId)
      return
    }
    // Why: title/status flips several times a second under spinner-in-title
    // agents. Coalesce the emit instead of fanning out every version.
    this.mobileSessionTabsNotifyCoalescer.schedule(worktreeId)
  }

  /** Republish the workspace snapshot after a pane's hook status changed.
   *  Hook rows feed the headless `agentStatus` projection, which nothing else touches. */
  touchMobileSessionTabsForPane(paneKey: string, worktreeId?: string | null): void {
    const resolved = worktreeId ?? this.getTerminalWorktreeIdForPaneKey(paneKey)
    if (!resolved) {
      return
    }
    this.touchMobileSessionTabsForWorktree(resolved)
  }

  private mobileSessionSnapshotHasSurface(
    worktreeId: string,
    parentTabId: string,
    leafId: string
  ): boolean {
    return Boolean(
      this.mobileSessionTabsByWorktree
        .get(worktreeId)
        ?.tabs.some(
          (tab) =>
            tab.type === 'terminal' && tab.parentTabId === parentTabId && tab.leafId === leafId
        )
    )
  }

  private isMobileSessionSurfaceMembershipAllowed(
    worktreeId: string,
    parentTabId: string,
    leafId: string,
    candidatePtyId: string | null | undefined
  ): boolean {
    const session = this.store?.getWorkspaceSession?.()
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    if (
      !hasHostAuthoritativeTerminalMembership(session, worktreeId) &&
      (session !== undefined || !this.terminalTopologyRevisionByRepoId.has(repoId))
    ) {
      return true
    }
    if (this.mobileSessionSnapshotHasSurface(worktreeId, parentTabId, leafId)) {
      return true
    }
    if (!candidatePtyId) {
      return false
    }
    const pty = this.ptysById.get(candidatePtyId)
    const pane = parsePaneKey(pty?.paneKey ?? '')
    return Boolean(
      pty?.connected &&
      pty.worktreeId === worktreeId &&
      pty.tabId === parentTabId &&
      pane?.leafId === leafId
    )
  }

  private reconcileMobileSessionRetirementFences(
    leaves: readonly RuntimeSyncedLeaf[]
  ): RuntimeSyncedLeaf[] {
    return leaves.filter((leaf) =>
      this.isMobileSessionSurfaceMembershipAllowed(
        leaf.worktreeId,
        leaf.tabId,
        leaf.leafId,
        leaf.ptyId
      )
    )
  }

  private applyMobileSessionRetirementFences(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    let next = snapshot
    for (const tab of snapshot.tabs) {
      if (
        tab.type !== 'terminal' ||
        this.isMobileSessionSurfaceMembershipAllowed(
          snapshot.worktree,
          tab.parentTabId,
          tab.leafId,
          tab.ptyId
        )
      ) {
        continue
      }
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot: next,
        ptyId: tab.ptyId ?? '',
        exactSurfaces: [{ parentTabId: tab.parentTabId, leafId: tab.leafId }],
        exactOnly: true
      })
      if (retired) {
        next = retired.snapshot
      }
    }
    return next
  }

  /**
   * Retires each surface in the session partition of the host that owns its worktree.
   * Why: an SSH pane's durable surface lives in that connection's partition; retiring it
   * against the local partition strands the real ghost and bumps a foreign host's epoch.
   * Returns null when nothing may be published because persistence is unavailable or failed.
   */
  private persistTerminalSurfaceRetirements(
    retiredSurfaces: readonly RetiredTerminalSurface[]
  ): { accepted: RetiredTerminalSurface[]; unpersisted: RetiredTerminalSurface[] } | null {
    const surfacesByHostId = new Map<ExecutionHostId, RetiredTerminalSurface[]>()
    for (const surface of retiredSurfaces) {
      const hostId =
        this.tryGetWorkspaceSessionHostIdForWorktree(surface.worktreeId) ?? LOCAL_EXECUTION_HOST_ID
      const bucket = surfacesByHostId.get(hostId)
      if (bucket) {
        bucket.push(surface)
      } else {
        surfacesByHostId.set(hostId, [surface])
      }
    }
    const accepted: RetiredTerminalSurface[] = []
    const unpersisted: RetiredTerminalSurface[] = []
    const pendingWrites: { hostId: ExecutionHostId; session: WorkspaceSessionState }[] = []
    for (const [hostId, surfaces] of surfacesByHostId) {
      const session = this.store?.getWorkspaceSession?.(hostId)
      if (!session) {
        unpersisted.push(...surfaces)
        continue
      }
      // Why: publishing absence before its host membership fence is durable lets a crash or
      // stale renderer write resurrect the retired surface.
      if (!this.store?.setWorkspaceSession || !this.store.flushOrThrow) {
        return null
      }
      let nextSession = session
      const acceptedForHost: RetiredTerminalSurface[] = []
      for (const surface of surfaces) {
        const candidate = retireTerminalSurfaceFromPersistence(nextSession, surface)
        if (candidate !== nextSession) {
          acceptedForHost.push(surface)
          nextSession = candidate
        }
      }
      if (acceptedForHost.length === 0) {
        continue
      }
      accepted.push(...acceptedForHost)
      pendingWrites.push({ hostId, session: nextSession })
    }
    if (pendingWrites.length > 0) {
      try {
        for (const write of pendingWrites) {
          this.store?.setWorkspaceSession?.(write.session, write.hostId)
        }
        this.store?.flushOrThrow?.()
      } catch (error) {
        console.error('[runtime] failed to persist terminal retirement:', error)
        return null
      }
    }
    return { accepted, unpersisted }
  }

  private retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[]
  ): void {
    const retiredSurfaceByKey = new Map<string, RetiredTerminalSurface>()
    for (const surface of exactSurfaces) {
      retiredSurfaceByKey.set(`${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`, {
        ...surface,
        ptyId,
        incarnationId
      })
    }
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId,
        exactSurfaces: exactSurfaces.filter((surface) => surface.worktreeId === worktreeId)
      })
      if (!retired) {
        continue
      }
      for (const surface of retired.retired) {
        retiredSurfaceByKey.set(
          `${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`,
          { ...surface, incarnationId }
        )
      }
    }
    const retiredSurfaces = [...retiredSurfaceByKey.values()]
    if (retiredSurfaces.length === 0) {
      return
    }
    const persisted = this.persistTerminalSurfaceRetirements(retiredSurfaces)
    if (!persisted) {
      return
    }
    for (const surface of persisted.unpersisted) {
      const repoId = getRepoIdFromWorktreeId(surface.worktreeId)
      this.terminalTopologyRevisionByRepoId.set(
        repoId,
        (this.terminalTopologyRevisionByRepoId.get(repoId) ?? 0) + 1
      )
    }
    // Why: one repo epoch can cover multiple exits, but only surfaces individually accepted by persistence may disappear.
    const publishableRetiredSurfaces = [...persisted.accepted, ...persisted.unpersisted]
    if (publishableRetiredSurfaces.length === 0) {
      return
    }
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId,
        exactSurfaces: publishableRetiredSurfaces.filter(
          (surface) => surface.worktreeId === worktreeId
        ),
        // Why: discovery is broad by PTY id, but publication may remove only surfaces whose durable retirement was accepted.
        exactOnly: true
      })
      if (retired) {
        this.mobileSessionTabsByWorktree.set(worktreeId, retired.snapshot)
        this.notifyMobileSessionTabsChanged(worktreeId)
      }
    }
  }

  // Why: headless serve backs browser panes with offscreen WebContents that live
  // only in the BrowserManager, never in a renderer graph. Without surfacing them
  // as session tabs, a session.tabs snapshot (e.g. on terminal open) prunes the
  // paired browser tab and closing it fails with tab_not_found. Synthesize browser
  // session tabs from the live bridge so they are first-class alongside terminals.
  private buildHeadlessMobileSessionBrowserTabs(
    worktreeId: string
  ): RuntimeMobileSessionBrowserTab[] {
    const serverTabs =
      this.offscreenBrowserBackend && this.agentBrowserBridge?.tabList
        ? this.agentBrowserBridge.tabList(worktreeId).tabs
        : []
    const publishedServerTabs = serverTabs.map((tab) => {
      const persistedProps = this.getPersistedUnifiedSessionTabProps(worktreeId, tab.browserPageId)
      return {
        type: 'browser' as const,
        // Why: an offscreen page has no separate workspace identity, so the page id
        // is its own workspace id (matches the server's browserWorkspaceId fallback).
        id: tab.browserPageId,
        title: tab.title || tab.url || 'Browser',
        browserWorkspaceId: tab.browserPageId,
        browserPageId: tab.browserPageId,
        url: tab.url || 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        loadError: tab.loadError ?? undefined,
        certificateFailure: tab.certificateFailure ?? undefined,
        ...(persistedProps ? { color: persistedProps.color } : {}),
        ...(persistedProps ? { isPinned: persistedProps.isPinned === true } : {}),
        isActive: tab.active === true
      }
    })
    const publishedClientTabs = getRuntimeBrowserPageRegistry(this)
      .listPages(worktreeId)
      .map((page) => ({
        type: 'browser' as const,
        id: page.browserPageId,
        title: page.title || page.url || 'Browser',
        browserWorkspaceId: page.browserPageId,
        browserPageId: page.browserPageId,
        browserProfileId: page.browserProfileId,
        executionHostKey: page.executionHostKey,
        placement: page.placement,
        url: page.url,
        loading: page.loading,
        canGoBack: page.canGoBack,
        canGoForward: page.canGoForward,
        isActive: page.active
      }))
    return [...publishedServerTabs, ...publishedClientTabs]
  }

  private getPersistedUnifiedSessionTabProps(
    worktreeId: string,
    tabId: string
  ): Pick<Tab, 'color' | 'isPinned'> | null {
    const tab =
      this.getWorkspaceSessionForWorktree(worktreeId)?.unifiedTabs?.[worktreeId]?.find(
        (candidate) => candidate.id === tabId || candidate.entityId === tabId
      ) ?? null
    return tab ? { color: tab.color, isPinned: tab.isPinned } : null
  }

  private removePersistedHeadlessTerminalTab(
    worktreeId: string,
    parentTabId: string,
    options: { allowMissing?: boolean } = {}
  ): string[] {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      throw new Error('workspace_session_unavailable')
    }
    const result = closeTerminalTabInWorkspaceSession(session, worktreeId, parentTabId)
    if (result.pinned) {
      throw new Error('terminal_tab_pinned')
    }
    if (!result.closed) {
      if (options.allowMissing) {
        return []
      }
      throw new Error('tab_not_found')
    }
    this.setWorkspaceSessionForWorktree(
      worktreeId,
      advanceTerminalTopologyRevision(result.session, worktreeId)
    )
    return result.ptyIdsToKill
  }

  private persistHeadlessTerminalTabOrder(worktreeId: string, tabOrder: readonly string[]): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const orderIndexByTabId = new Map(tabOrder.map((tabId, index) => [tabId, index]))
    const tabs = session.tabsByWorktree[worktreeId] ?? []
    const reordered = [...tabs]
      .sort((a, b) => {
        const aIndex = orderIndexByTabId.get(a.id) ?? Number.MAX_SAFE_INTEGER
        const bIndex = orderIndexByTabId.get(b.id) ?? Number.MAX_SAFE_INTEGER
        return aIndex - bIndex || a.sortOrder - b.sortOrder || a.createdAt - b.createdAt
      })
      .map((tab, index) => ({
        ...tab,
        sortOrder: index
      }))
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktreeId]: reordered
      }
    })
  }

  private emitMobileSessionTabsSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    const result = this.toMobileSessionTabsResult(snapshot)
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId)
      )
    }
  }

  /**
   * Answers one client's session-tabs question: whether this runtime has taken back *that* client's
   * client-hosted pages yet, then that client's own tab selection.
   *
   * The hold is decided here and nowhere else, and it is set or cleared rather than only set, so a
   * frame built for one client can never carry another client's answer.
   */
  private projectMobileSessionTabsForClient(
    result: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.clientSessionTabSelections.project(
      this.withClientHostedPagesHold(result, clientNavigationId),
      clientNavigationId
    )
  }

  private withClientHostedPagesHold(
    result: RuntimeMobileSessionTabsResult,
    clientNavigationId: string | undefined
  ): RuntimeMobileSessionTabsResult {
    return this.clientHostedPageReconciliation.holdFor(result, clientNavigationId, Date.now())
  }

  private async refreshMobileSessionPtyRecords(
    targetWorktreeId: string | null = null
  ): Promise<Set<string> | null> {
    if (targetWorktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
      const pending = this.pendingMobileSessionPtyInventoryRefresh
      if (pending) {
        return pending
      }
      // Why: reconnect exit bursts share one authoritative daemon inventory
      // instead of multiplying a full cross-generation list RPC per stale tab.
      const refresh = this.performMobileSessionPtyRecordsRefresh(targetWorktreeId).finally(() => {
        if (this.pendingMobileSessionPtyInventoryRefresh === refresh) {
          this.pendingMobileSessionPtyInventoryRefresh = null
        }
      })
      this.pendingMobileSessionPtyInventoryRefresh = refresh
      return refresh
    }
    return await this.performMobileSessionPtyRecordsRefresh(targetWorktreeId)
  }

  private async performMobileSessionPtyRecordsRefresh(
    targetWorktreeId: string | null
  ): Promise<Set<string> | null> {
    if (!this.ptyController?.listProcesses && !this.ptyController?.hasPty) {
      return null
    }
    // Why: floating PTY identity is explicit, so polling must not resolve every Git/SSH worktree.
    const isFloatingWorkspace = targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID
    const resolvedWorktrees = isFloatingWorkspace ? [] : await this.listResolvedWorktrees()
    return await this.refreshPtyWorktreeRecordsFromController(
      resolvedWorktrees,
      isFloatingWorkspace ? targetWorktreeId : null
    )
  }

  async activateMobileSessionTab(
    worktreeSelector: string,
    tabId: string,
    leafId?: string,
    opts: {
      notifyClients?: boolean
      clientNavigationId?: string
      navigation?: RuntimeNavigationTarget
      intent?: TabActivationIntent
    } = {}
  ): Promise<RuntimeMobileSessionTabsResult> {
    const navigation = opts.navigation ?? (opts.notifyClients === false ? 'caller' : 'all')
    const targetsHost = navigationTargetsHost(navigation)
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    await this.refreshMobileSessionPtyRecords(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const directTab = snapshot?.tabs.find((candidate) => candidate.id === tabId)
    const tab = leafId
      ? ((directTab?.type === 'terminal' && directTab.leafId === leafId ? directTab : undefined) ??
        snapshot?.tabs.find(
          (candidate) =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === tabId &&
            candidate.leafId === leafId
        ))
      : (directTab ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
        ) ??
        snapshot?.tabs.find(
          (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
        ))
    if (!tab) {
      throw new Error('tab_not_found')
    }

    if (tab.type === 'terminal') {
      const publicTab = this.toMobileSessionTabsResult(snapshot!).tabs.find(
        (candidate) => candidate.type === 'terminal' && candidate.id === tab.id
      )
      // Why: serve-created tabs can be visible before any renderer has adopted
      // their tab id, so focusing the renderer would silently no-op.
      // Phone-local activation also needs this path for inactive restored tabs:
      // desktop focus is intentionally suppressed, but the PTY still must exist.
      const shouldMaterializePendingTerminal =
        publicTab?.type === 'terminal' &&
        publicTab.status !== 'ready' &&
        // Why: opening a tab is the documented wake gesture for a slept pane
        // (#11598), so only a background probe may be refused for one.
        (!isAutomaticTabActivation(opts.intent) ||
          !this.isDeliberatelyParkedPane(worktreeId, tab)) &&
        (!targetsHost ||
          !this.notifier?.focusTerminal ||
          this.shouldMaterializeHeadlessMobileSessionTab(snapshot!, tab))
      if (shouldMaterializePendingTerminal) {
        const sessionId = tab.ptyId ?? tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? undefined
        const targetGroupId = snapshot?.tabGroups?.find((group) =>
          group.tabOrder.includes(tab.parentTabId)
        )?.id
        // Why: a pending agent tab may exist without its startup command ever
        // having been delivered (the create's renderer stalled, #7587), so a
        // bare materialize would put a plain shell under the agent icon.
        // Re-resolve the launch like the create path; providers skip startup
        // commands when attaching to live sessions, so this cannot double-launch.
        let agentStartup: Awaited<
          ReturnType<OrcaRuntimeService['resolveMobileSessionTerminalCommand']>
        > = {}
        if (tab.launchAgent) {
          try {
            const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
            agentStartup = await this.resolveMobileSessionTerminalCommand(workspace, {
              agent: tab.launchAgent
            })
          } catch {
            // Why: a disabled or unresolvable agent must not make the tab
            // untappable; fall back to the plain-shell materialize.
          }
        }
        try {
          await this.createRuntimeOwnedMobileSessionTerminal(worktreeId, targetsHost, undefined, {
            identity: {
              tabId: tab.parentTabId,
              leafId: tab.leafId,
              sessionId
            },
            cwd: tab.startupCwd,
            command: agentStartup.command,
            env: agentStartup.env,
            startupCommandDelivery: agentStartup.startupCommandDelivery,
            launchConfig: agentStartup.launchConfig,
            launchAgent: tab.launchAgent,
            targetGroupId
          })
        } catch (err) {
          if (sessionId && parseAppSshPtyId(sessionId)) {
            // Why: an expired SSH reattach clears durable bindings in the store,
            // but this in-memory headless snapshot can still carry the old id.
            this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, { force: true })
          }
          throw err
        }
        return this.applyMobileSessionTabNavigation(
          this.getMobileSessionTabsForWorktree(worktreeId),
          tab.id,
          navigation,
          opts.clientNavigationId
        )
      }
      const callerSnapshot = this.getMobileSessionTabsForWorktree(
        worktreeId,
        opts.clientNavigationId
      )
      const activeSibling =
        tab.id === tabId || leafId
          ? null
          : (callerSnapshot.tabs.find(
              (candidate) =>
                candidate.type === 'terminal' &&
                candidate.parentTabId === tab.parentTabId &&
                candidate.isActive
            ) as RuntimeMobileSessionTerminalTab | undefined)
      const targetTab = activeSibling ?? tab
      if (targetsHost && !this.notifier?.focusTerminal) {
        if (
          !targetTab.isActive &&
          this.shouldPersistHeadlessMobileSessionActivation(snapshot!, targetTab)
        ) {
          this.activateHeadlessMobileSessionTerminalTab(worktreeId, snapshot!, targetTab)
        }
      } else if (targetsHost) {
        this.notifier?.focusTerminal?.(targetTab.parentTabId, worktreeId, targetTab.leafId)
      }
      return this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        targetTab.id,
        navigation,
        opts.clientNavigationId
      )
    } else if (tab.type === 'browser') {
      // Why: browser mobile tabs are renderer-owned unified tabs; focusing the
      // session tab keeps desktop tab order/group state authoritative.
      if (targetsHost) {
        this.notifier?.focusEditorTab?.(tab.id, worktreeId)
      }
    } else {
      if (targetsHost) {
        this.notifier?.focusEditorTab?.(tab.id, worktreeId)
      }
    }
    return this.applyMobileSessionTabNavigation(
      this.getMobileSessionTabsForWorktree(worktreeId),
      tab.id,
      navigation,
      opts.clientNavigationId
    )
  }

  private applyMobileSessionTabNavigation(
    snapshot: RuntimeMobileSessionTabsResult,
    activeTabId: string,
    navigation: RuntimeNavigationTarget,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    let callerSnapshot: RuntimeMobileSessionTabsResult | null = null
    if (navigationTargetsClients(navigation)) {
      // Why: follow is live intent; disconnected devices must not inherit stale navigation on reconnect.
      const ids = new Set(
        [...this.mobileSessionTabListeners]
          .map((subscription) => subscription.clientNavigationId)
          .filter((id): id is string => Boolean(id))
      )
      if (clientNavigationId) {
        ids.add(clientNavigationId)
      }
      for (const id of ids) {
        const projected = this.clientSessionTabSelections.activate(
          this.withClientHostedPagesHold(snapshot, id),
          id,
          activeTabId
        )
        this.emitMobileSessionTabsSnapshotToClient(projected, id, true)
        if (id === clientNavigationId) {
          callerSnapshot = projected
        }
      }
    } else if (clientNavigationId) {
      // Why: follow-host still starts as caller navigation; the host is an additional target, not a replacement owner.
      callerSnapshot = this.clientSessionTabSelections.activate(
        this.withClientHostedPagesHold(snapshot, clientNavigationId),
        clientNavigationId,
        activeTabId
      )
      this.emitMobileSessionTabsSnapshotToClient(callerSnapshot, clientNavigationId)
    }
    if (clientNavigationId) {
      return callerSnapshot ?? this.projectMobileSessionTabsForClient(snapshot, clientNavigationId)
    }
    if (navigation === 'caller') {
      const selection = activateClientSessionTabSelection(
        snapshot,
        deriveClientSessionTabSelection(snapshot),
        activeTabId
      )
      return projectClientSessionTabSelection(snapshot, selection).snapshot
    }
    return snapshot
  }

  /**
   * Whether persistence proves this pane's PTY was deliberately taken down and parked
   * (workspace sleep or completed-agent hibernation) rather than lost and awaiting reconnect.
   * Why: `pending-handle` alone cannot tell those apart — a parked pane publishes it
   * indefinitely — and respawning a parked pane re-launches its agent behind the user.
   * Only an automatic activation consults this; a user opening the tab is the wake gesture.
   */
  private isDeliberatelyParkedPane(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    const record =
      this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey?.[
        makePaneKey(tab.parentTabId, tab.leafId)
      ]
    // Why: 'live'/'quit' captures describe a pane that was still running, so a reconnect
    // must still mint its replacement PTY (#11542). Only a worktree-owned capture records
    // a deliberate takedown the user did not ask to undo.
    return (
      record?.origin === 'worktree-sleep' && runtimeWorktreeIdsEqual(record.worktreeId, worktreeId)
    )
  }

  private shouldMaterializeHeadlessMobileSessionTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    return (
      this.isHeadlessMobileSessionPublication(snapshot.publicationEpoch) ||
      this.hasServeOrSshOwnedBinding(tab)
    )
  }

  private shouldPersistHeadlessMobileSessionActivation(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    if (snapshot.publicationEpoch.includes(':headless-merge:')) {
      return false
    }
    if (this.authoritativeWindowId !== null && this.graphStatus === 'ready') {
      return false
    }
    return this.shouldMaterializeHeadlessMobileSessionTab(snapshot, tab)
  }

  private activateHeadlessMobileSessionTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    activeTab: RuntimeMobileSessionTerminalTab
  ): void {
    const tabs = snapshot.tabs.map((candidate) => ({
      ...candidate,
      isActive: candidate.id === activeTab.id
    }))
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: activeTab.id,
      activeTabType: 'terminal',
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        tabs,
        activeTab,
        snapshot.tabGroups
      ),
      tabs
    }
    this.persistHeadlessTerminalActiveLeaf(worktreeId, activeTab)
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  // Why: a headless split only updated the LIVE session snapshot, never the
  // persisted workspace session layout. So a later snapshot rebuild (e.g. on the
  // next terminal create) re-derived from the stale single-leaf persisted layout
  // and collapsed the split. Persist the new split leaf into the workspace
  // session's terminalLayoutsByTabId so the split survives rebuilds.
  private persistHeadlessTerminalSplit(args: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    splitFromLeafId: string
    direction: 'horizontal' | 'vertical'
  }): boolean {
    const session = this.getWorkspaceSessionForWorktree(args.worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return false
    }
    const existing = session.terminalLayoutsByTabId?.[args.tabId]
    const nextLayout = buildHeadlessTerminalSplitLayout(
      existing ? cloneTerminalLayoutSnapshot(existing) : undefined,
      args
    )
    this.setWorkspaceSessionForWorktree(args.worktreeId, {
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [args.tabId]: nextLayout
      }
    })
    return true
  }

  private persistHeadlessTerminalActiveLeaf(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const existingLayout = session.terminalLayoutsByTabId?.[tab.parentTabId]
    const nextLayouts = existingLayout
      ? {
          ...session.terminalLayoutsByTabId,
          [tab.parentTabId]: {
            ...cloneTerminalLayoutSnapshot(existingLayout),
            activeLeafId: tab.leafId
          }
        }
      : session.terminalLayoutsByTabId
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      activeTabId: tab.parentTabId,
      activeTabIdByWorktree: {
        ...session.activeTabIdByWorktree,
        [worktreeId]: tab.parentTabId
      },
      terminalLayoutsByTabId: nextLayouts
    })
  }

  async refuseUnattributedMobileSessionTabClose(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMobileSessionTabCloseResult> {
    const snapshot = await this.listMobileSessionTabs(worktreeSelector)
    const tabExists = snapshot.tabs.some(
      (candidate) =>
        candidate.id === tabId ||
        (candidate.type === 'terminal' && candidate.parentTabId === tabId) ||
        (candidate.type === 'browser' && candidate.browserWorkspaceId === tabId)
    )
    if (!tabExists) {
      throw new Error('tab_not_found')
    }
    // Why: a legacy client may already have hidden its mirror; a new snapshot
    // restores it without granting an unattributed request destructive authority.
    this.republishMobileSessionTabsSnapshot(snapshot.worktree)
    return {
      closed: true,
      refused: true,
      refusalReason: 'missing-intent',
      snapshotRepublished: true
    }
  }

  async closeMobileSessionTab(
    worktreeSelector: string,
    tabId: string,
    options: {
      reason?: RuntimeSessionTabCloseReason
      expectedPublicationEpoch?: string
      expectedTerminalHandle?: string
      clientNavigationId?: string
      localPtyTeardownOwnedExternally?: boolean
    } = {}
  ): Promise<MobileSessionTabCloseOutcome> {
    const graphEpoch = options.clientNavigationId ? this.captureReadyGraphEpoch() : null
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const observedPtyIds = await this.refreshMobileSessionPtyRecords()
    if (graphEpoch !== null) {
      this.assertStableReadyGraph(graphEpoch)
    }
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (options.reason !== undefined && options.reason !== 'user' && observedPtyIds === null) {
      // Why: keep-on-unknown must also restore the mirror the caller already pruned.
      this.republishMobileSessionTabsSnapshot(worktreeId)
      return refusedMobileSessionTabClose('unknown-liveness', {
        snapshotRepublished: Boolean(snapshot)
      })
    }
    if (
      options.expectedPublicationEpoch !== undefined &&
      snapshot?.publicationEpoch !== options.expectedPublicationEpoch
    ) {
      this.republishMobileSessionTabsSnapshot(worktreeId)
      return refusedMobileSessionTabClose('stale-publication', {
        snapshotRepublished: Boolean(snapshot)
      })
    }
    const tab =
      snapshot?.tabs.find((candidate) => candidate.id === tabId) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
      ) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
      )
    if (!snapshot || !tab) {
      throw new Error('tab_not_found')
    }
    if (options.expectedTerminalHandle !== undefined) {
      const terminalIncarnationMatches =
        tab.type === 'terminal' &&
        snapshot.tabs.some(
          (candidate) =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === tab.parentTabId &&
            this.getMobileSessionTerminalHandle(worktreeId, candidate) ===
              options.expectedTerminalHandle
        )
      if (!terminalIncarnationMatches) {
        this.republishMobileSessionTabsSnapshot(worktreeId)
        return refusedMobileSessionTabClose('stale-terminal', {
          snapshotRepublished: true
        })
      }
    }
    let closedSelectionTabIds = [tab.id]
    const finishCommittedClose = (): MobileSessionTabCloseOutcome =>
      committedMobileSessionTabClose(
        this.clientSessionTabSelections,
        worktreeId,
        closedSelectionTabIds
      )
    if (tab.type === 'terminal') {
      const parentLeafCount = snapshot.tabs.filter(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
      ).length
      const closingWholeParent = tab.id !== tabId || parentLeafCount <= 1
      if (closingWholeParent) {
        closedSelectionTabIds = snapshot.tabs.flatMap((candidate) =>
          candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
            ? [candidate.id, candidate.parentTabId]
            : []
        )
      }
      // Why: a non-'user' reason is a client-lifecycle echo ("terminal gone"),
      // not authorization to kill. Every destructive branch below can take the
      // whole parent down, so any live PTY under the parent means the echo is a
      // transport artifact: refuse the close and republish the snapshot so the
      // echoing client re-syncs and re-attaches. A reasonless close keeps
      // legacy behavior — old clients send user closes without the field.
      if (options.reason !== undefined && options.reason !== 'user') {
        const parentLeaves = snapshot.tabs.filter(
          (candidate): candidate is RuntimeMobileSessionTerminalTab =>
            candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
        )
        // Why: exited PTYs keep a disconnected record in ptysById for status
        // reads (and a still-synced leaf retains its record), so record
        // presence is not liveness — only `connected` counts, or a genuinely
        // dead tab never retires and the echo loops forever.
        const leafHasConnectedPty = (leaf: RuntimeMobileSessionTerminalTab): boolean => {
          const snapshotPtyIds = [
            leaf.ptyId,
            leaf.parentLayout?.ptyIdsByLeafId?.[leaf.leafId]
          ].filter((ptyId): ptyId is string => Boolean(ptyId))
          // Why: daemon discovery can prove the PTY live before its pane binding
          // reconnects; missing metadata is never authority to retire it.
          return (
            this.findPtyForMobileTerminalTab(worktreeId, leaf)?.connected === true ||
            snapshotPtyIds.some((ptyId) => observedPtyIds?.has(ptyId) === true)
          )
        }
        if (parentLeaves.some(leafHasConnectedPty)) {
          // Why: when the echo addresses a dead leaf under a live sibling we
          // still refuse (every reachable close path below destroys the whole
          // parent, live sibling included) but skip the republish — re-adding
          // the dead leaf on the echoing client would feed an endless
          // refuse→republish→re-echo cycle.
          const addressedDeadLeaf = tab.id === tabId && !leafHasConnectedPty(tab)
          if (!addressedDeadLeaf) {
            this.republishMobileSessionTabsSnapshot(worktreeId)
          }
          // Why: both markers are skew-safe; clients must restore a mirror only
          // when the host actually republished it, not for a dead leaf.
          return refusedMobileSessionTabClose('live-host-pty', {
            snapshotRepublished: !addressedDeadLeaf
          })
        }
        if (!closingWholeParent || this.tabs.has(tab.parentTabId)) {
          // Why: only the renderer may retire its own tab or split leaf; a
          // remote lifecycle echo must never cross that boundary into a kill.
          return refusedMobileSessionTabClose('retirement-owner')
        }
      }
      // Why: a runtime-owned headless tab is absent from renderer state, so the
      // closeTerminalTab relay below would ack success without killing its PTY,
      // and syncMobileSessionTabs would republish the "closed" tab. Only bypass
      // the relay when no renderer owns the parent: an adopted tab needs the
      // renderer's live pin guard and durable close transaction.
      if (closingWholeParent && !this.tabs.has(tab.parentTabId)) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab, {
          killPtys: options.reason === undefined || options.reason === 'user'
        })
        this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        this.store?.flushOrThrow?.()
        return finishCommittedClose()
      }
      if (closingWholeParent && this.notifier?.closeTerminalTab) {
        // Why: whole-tab close is a lifecycle transaction. The renderer reply
        // arrives only after canonical retirement and a forced session flush.
        const win = this.getAvailableAuthoritativeWindow()
        if (win?.webContents.isDestroyed?.()) {
          throw new Error('runtime_unavailable')
        }
        const releasePublicationThrottle =
          options.clientNavigationId && win
            ? this.rendererPublicationThrottle.acquire(win.webContents)
            : () => {}
        try {
          await (options.localPtyTeardownOwnedExternally
            ? this.notifier.closeTerminalTab(tab.parentTabId, {
                localPtyTeardownOwnedExternally: true
              })
            : this.notifier.closeTerminalTab(tab.parentTabId))
        } finally {
          releasePublicationThrottle()
        }
        const remainingSnapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
        const remainingTab = remainingSnapshot?.tabs.find(
          (candidate): candidate is RuntimeMobileSessionTerminalTab =>
            candidate.type === 'terminal' && candidate.parentTabId === tab.parentTabId
        )
        if (
          remainingSnapshot &&
          remainingTab &&
          this.isRuntimeOwnedHeadlessMobileTab(worktreeId, remainingTab)
        ) {
          // Why: after relay recovery the renderer can acknowledge a tab it no longer mirrors; the HUB must still retire its SSH-owned surface.
          this.closeHeadlessMobileTerminalTab(worktreeId, remainingSnapshot, remainingTab, {
            // Why: the renderer may already have durably removed the tab before acknowledging.
            allowMissingPersistedTab: true
          })
          this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
          this.store?.flushOrThrow?.()
        }
        this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
        return finishCommittedClose()
      }
      // Why: notifier implementations without the acknowledged relay may expose
      // only raw pane close. Runtime-owned parents still need de-persist + kill.
      if (closingWholeParent && this.isRuntimeOwnedHeadlessMobileTab(worktreeId, tab)) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab)
        this.notifyRendererOfHeadlessTerminalClose(tab.parentTabId)
        this.store?.flushOrThrow?.()
        return finishCommittedClose()
      }
      if (!this.notifier?.closeTerminal) {
        this.closeHeadlessMobileTerminalTab(worktreeId, snapshot, tab)
        this.store?.flushOrThrow?.()
        return finishCommittedClose()
      }
      if (tab.id === tabId) {
        const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
        if (pty) {
          if (this.ptyController?.kill(pty.ptyId) !== true) {
            throw new Error('terminal_close_failed')
          }
          return finishCommittedClose()
        }
        this.notifier.closeTerminal(tab.parentTabId)
        return delegatedMobileSessionTabClose()
      }
      // Why: paired web tab bars represent a split terminal with one local
      // parent tab id. Closing that parent should close the desktop tab, not
      // just whichever leaf happened to be first in the session snapshot.
      this.notifier.closeTerminal(tab.parentTabId)
      this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
      return delegatedMobileSessionTabClose()
    } else if (tab.type === 'browser') {
      // Why: a browser tab can be hosted by a client, by the offscreen backend,
      // or by the renderer; each surface owns a different retirement path.
      const clientPage = tab.browserPageId
        ? getRuntimeBrowserPageRegistry(this).getPage(tab.browserPageId)
        : undefined
      if (clientPage) {
        await (this as RuntimeCommandSurfaceHost<this>).browserTabClose({
          worktree: `id:${worktreeId}`,
          page: clientPage.browserPageId
        })
      } else if (this.isOffscreenMobileSessionBrowserTab(snapshot, tab)) {
        await this.offscreenBrowserBackend!.closeTab(tab.browserPageId!).catch(() => {})
        this.retireRuntimeOwnedBrowserSessionTab(worktreeId, tab.browserPageId!)
      } else {
        if (!this.notifier?.closeSessionTab) {
          throw new Error('runtime_unavailable')
        }
        await this.notifier.closeSessionTab(tab.id, worktreeId)
      }
    } else {
      if (!this.notifier?.closeSessionTab) {
        throw new Error('runtime_unavailable')
      }
      await this.notifier.closeSessionTab(tab.id, worktreeId)
    }
    return finishCommittedClose()
  }

  // Why: a refused echoed close means the echoing client already pruned its
  // local mirror. Bump the version and emit the unchanged snapshot so clients
  // that dedupe by snapshotVersion re-add and re-attach the still-live tab.
  private republishMobileSessionTabsSnapshot(worktreeId: string): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (snapshot) {
      this.mobileSessionTabsByWorktree.set(worktreeId, {
        ...snapshot,
        snapshotVersion: snapshot.snapshotVersion + 1
      })
    }
    this.notifyMobileSessionTabsChanged(worktreeId)
  }

  private getMobileSessionTerminalHandle(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): string | null {
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
    if (!pty) {
      return null
    }
    return this.handleByPtyId.get(pty.ptyId) ?? this.findHandleForPtyRecord(pty.ptyId)
  }

  private notifyRendererOfHeadlessTerminalClose(parentTabId: string): void {
    // Why: this relay is advisory after main owns teardown; renderer failure must
    // not prevent the authoritative session flush or turn the close into failure.
    try {
      this.notifier?.closeTerminal(parentTabId)
    } catch (error) {
      console.warn('[runtime] failed to notify renderer after headless terminal close', {
        parentTabId,
        error
      })
    }
  }

  private isOffscreenMobileSessionBrowserTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionBrowserTab
  ): boolean {
    if (!this.offscreenBrowserBackend || !tab.browserPageId) {
      return false
    }
    if (this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch)) {
      return true
    }
    const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(snapshot.worktree)
    return (
      snapshot.publicationEpoch.includes(':headless-merge:') &&
      accepted !== undefined &&
      !getMobileSessionSnapshotTabIdentityKeys(tab).some((id) =>
        accepted.rendererTabIdentityKeys.has(id)
      ) &&
      this.getLiveBrowserTabsByPageId(snapshot.worktree).has(tab.browserPageId)
    )
  }

  // Public so runtime-side page release (lease fencing) can prune a tab whose page is gone.
  retireRuntimeOwnedBrowserSessionTab(worktreeId: string, browserPageId: string): boolean {
    // Why: before the snapshot guard — worktree removal drops the snapshot first, and the host
    // rows for its client pages would otherwise be stranded on screen with nothing to retract them.
    this.clientHostedBrowserRows.publish(worktreeId)
    this.persistClientHostedBrowserPagesForWorktree(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return false
    }
    const retiredTab = snapshot.tabs.find(
      (candidate): candidate is RuntimeMobileSessionBrowserTab =>
        candidate.type === 'browser' && candidate.browserPageId === browserPageId
    )
    if (!retiredTab) {
      return false
    }
    const nextTabs = snapshot.tabs.filter((candidate) => candidate.id !== retiredTab.id)
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: (snapshot.tabGroups ?? []).map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((id) => id !== retiredTab.id),
        activeTabId: group.activeTabId === retiredTab.id ? null : group.activeTabId
      })),
      tabs: nextTabs
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return true
  }

  private markHeadlessBrowserSessionTabActive(
    worktreeId: string | undefined,
    browserPageId: string,
    options: BrowserSessionTabSelectionOptions
  ): void {
    if (!worktreeId) {
      return
    }
    const { targetGroupId, focusesHost } = options
    // Why: client-placed pages publish through the page registry and need no offscreen backing.
    if (
      !this.offscreenBrowserBackend &&
      !getRuntimeBrowserPageRegistry(this).getPage(browserPageId)
    ) {
      return
    }
    // Hydrate first so the freshly created browser tab is present in the snapshot.
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionBrowserTab =>
        candidate.type === 'browser' && candidate.browserPageId === browserPageId
    )
    if (!snapshot || !tab) {
      return
    }
    const {
      snapshot: nextSnapshot,
      groups: nextGroups,
      placedInTargetGroup
    } = applyBrowserSessionTabSelection({
      snapshot,
      tabId: tab.id,
      ...(targetGroupId !== undefined ? { targetGroupId } : {}),
      focusesHost,
      publicationEpoch: `headless:${Date.now().toString(36)}`
    })
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    // Why: browser group membership is otherwise live-only; persist it so a
    // later rebuild keeps the browser in its group instead of coalescing left.
    if (placedInTargetGroup && nextSnapshot.tabGroupLayout) {
      this.persistHeadlessTabGroups(worktreeId, nextGroups, nextSnapshot.tabGroupLayout)
    }
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    if (options.caller) {
      // Why: the originating device still lands on the tab it just created; only the shared
      // snapshot stayed put. Local creates keep the pre-navigation shape by having no caller.
      this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        tab.id,
        options.caller.navigation,
        options.caller.clientNavigationId
      )
    }
  }

  private closeHeadlessMobileTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowMissingPersistedTab?: boolean; killPtys?: boolean } = {}
  ): void {
    const closedParentTabId = tab.parentTabId
    this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, closedParentTabId)
    const projectedPtyIds = this.removePersistedHeadlessTerminalTab(worktreeId, closedParentTabId, {
      allowMissing: options.allowMissingPersistedTab
    })
    // Why: local provider ids can be reused after restart, so a dormant
    // persisted id is not kill authority. SSH relay ids remain durable exact
    // identities even before pane metadata reconnects.
    const ptyIdsToKill = new Set(projectedPtyIds.filter((ptyId) => parseAppSshPtyId(ptyId)))
    for (const candidate of snapshot.tabs) {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        continue
      }
      const livePty = this.findPtyForMobileTerminalTab(worktreeId, candidate)
      const ptyId = livePty?.ptyId ?? candidate.ptyId
      const hasOtherOwner = snapshot.tabs.some(
        (other) =>
          other.type === 'terminal' &&
          other.parentTabId !== closedParentTabId &&
          other.ptyId === ptyId
      )
      if (ptyId && !hasOtherOwner && (livePty || parseAppSshPtyId(ptyId))) {
        // Why: a live serve leaf can exist before its debounced binding reaches
        // persistence. Include it from the authoritative snapshot so split
        // close cannot leave a provider process behind.
        ptyIdsToKill.add(ptyId)
      }
    }
    if (options.killPtys !== false) {
      for (const ptyId of ptyIdsToKill) {
        this.ptyController?.kill(ptyId)
      }
    }
    const nextTabs = snapshot.tabs.filter((candidate) => {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        return true
      }
      return false
    })
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        nextTabs,
        active,
        snapshot.tabGroups
      ),
      tabs: nextTabs
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  async moveMobileSessionTab(
    worktreeSelector: string,
    move: RuntimeMobileSessionTabMove
  ): Promise<RuntimeMobileSessionTabMoveResult> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      throw new Error('tab_not_found')
    }
    if (!this.notifier?.moveSessionTab) {
      return this.moveHeadlessMobileSessionTab(worktreeId, snapshot, move)
    }
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const publicSnapshot = this.toMobileSessionTabsResult(snapshot)
    const targetGroup = publicSnapshot.tabGroups?.find((group) => group.id === move.targetGroupId)
    if (!targetGroup) {
      throw new Error('target_group_not_found')
    }

    // Why: web clients address terminal surfaces as tab::leaf, while desktop
    // tab grouping is owned by the outer terminal tab id.
    if (move.kind === 'reorder') {
      const tabOrder = this.normalizeMobileSessionTabOrder(snapshot, targetGroup, move.tabOrder)
      if (!tabOrder.includes(hostTabId)) {
        throw new Error('invalid_tab_order')
      }
      this.notifier.moveSessionTab(worktreeId, {
        ...move,
        tabId: hostTabId,
        tabOrder
      })
      return { moved: true }
    }
    this.notifier.moveSessionTab(worktreeId, {
      ...move,
      tabId: hostTabId
    })
    return { moved: true }
  }

  // Why: pane geometry inside a tab (split ratios, expanded pane, pane titles)
  // is host-authoritative for remote-server tabs but had no push path, so a
  // client divider-drag / expand / pane-rename reverted on the next snapshot.
  // Persist the structural fields onto the tab's layout, keeping host-owned
  // pty bindings and active leaf.
  async updateMobileSessionPaneLayout(
    worktreeSelector: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why: when a renderer is authoritative (desktop host reached via shared
    // control), it owns pane geometry and republishes it — a headless write here
    // would be overwritten and could fight the renderer. Persist only headlessly.
    if (this.getAvailableAuthoritativeWindow()) {
      return { updated: true }
    }
    // Why: resolve to the host tab id (older/raw-id clients) so the persisted
    // layout entry matches, matching setMobileSessionTabProps.
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    const resolvedArgs = { ...args, tabId: hostTabId }
    const acceptedLayout = this.persistHeadlessTerminalPaneLayout(worktreeId, resolvedArgs)
    if (acceptedLayout) {
      this.applyHeadlessTerminalPaneLayoutToSnapshot(worktreeId, {
        tabId: hostTabId,
        root: acceptedLayout.root,
        expandedLeafId: acceptedLayout.expandedLeafId,
        ...(acceptedLayout.titlesByLeafId ? { titlesByLeafId: acceptedLayout.titlesByLeafId } : {})
      })
    }
    return { updated: true }
  }

  // Why: tab color/pin are host-authoritative for remote-server tabs but had no
  // push path, so pinning or coloring a tab reverted on the next snapshot and
  // was never persisted. Persist to the workspace session + live snapshot.
  async setMobileSessionTabProps(
    worktreeSelector: string,
    args: {
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why: a renderer-authoritative host owns + republishes tab props, so a
    // headless write would be overwritten. Persist only when headless.
    if (this.getAvailableAuthoritativeWindow()) {
      return { updated: true }
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    this.persistHeadlessSessionTabProps(worktreeId, hostTabId, args)
    this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, hostTabId, args)
    return { updated: true }
  }

  private persistHeadlessSessionTabProps(
    worktreeId: string,
    tabId: string,
    props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const tabs = session.tabsByWorktree[worktreeId]
    const nextSession: WorkspaceSessionState = { ...session }
    let changed = false
    if (tabs?.some((tab) => tab.id === tabId)) {
      changed = true
      nextSession.tabsByWorktree = {
        ...session.tabsByWorktree,
        [worktreeId]: tabs.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                ...(props.color !== undefined ? { color: props.color } : {}),
                ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
                ...(props.viewMode !== undefined ? { viewMode: props.viewMode } : {})
              }
            : tab
        )
      }
    }

    const unifiedTabs = session.unifiedTabs?.[worktreeId]
    if (unifiedTabs?.some((tab) => tab.id === tabId || tab.entityId === tabId)) {
      changed = true
      nextSession.unifiedTabs = {
        ...session.unifiedTabs,
        [worktreeId]: unifiedTabs.map((tab) =>
          tab.id === tabId || tab.entityId === tabId
            ? {
                ...tab,
                ...(props.color !== undefined ? { color: props.color } : {}),
                ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {})
              }
            : tab
        )
      }
    }

    if (!changed) {
      return
    }
    this.setWorkspaceSessionForWorktree(worktreeId, nextSession)
  }

  private applyHeadlessSessionTabPropsToSnapshot(
    worktreeId: string,
    tabId: string,
    props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    let changed = false
    const tabs = snapshot.tabs.map((tab) => {
      if (this.getMobileSessionTopLevelTabId(tab) !== tabId) {
        return tab
      }
      changed = true
      return {
        ...tab,
        ...(props.color !== undefined ? { color: props.color } : {}),
        ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
        ...(props.viewMode !== undefined ? { viewMode: props.viewMode } : {})
      }
    })
    if (!changed) {
      return
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  private getMobileSessionTopLevelTabId(tab: RuntimeMobileSessionSnapshotTab): string {
    return tab.type === 'terminal' ? tab.parentTabId : tab.id
  }

  // Merge the client's pane structure into the persisted tab layout. PTY
  // bindings and active leaf stay host-owned; only ratios/expand/titles change.
  // terminalLayoutsByTabId is keyed by tab id (worktree-independent).
  private persistHeadlessTerminalPaneLayout(
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): TerminalLayoutSnapshot | undefined {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return undefined
    }
    const existing = session.terminalLayoutsByTabId?.[args.tabId]
    if (!existing) {
      return undefined
    }
    const candidate = {
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [args.tabId]: {
          ...cloneTerminalLayoutSnapshot(existing),
          root: args.root ?? existing.root,
          expandedLeafId: args.expandedLeafId,
          ...(args.titlesByLeafId ? { titlesByLeafId: args.titlesByLeafId } : {})
        }
      }
    }
    this.setWorkspaceSessionForWorktree(worktreeId, candidate)
    // Why: persistence may reject stale membership while accepting its metadata; publish only that rebased layout.
    return (
      this.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId[args.tabId] ??
      candidate.terminalLayoutsByTabId[args.tabId]
    )
  }

  private applyHeadlessTerminalPaneLayoutToSnapshot(
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    let changed = false
    const tabs = snapshot.tabs.map((tab) => {
      if (tab.type !== 'terminal' || tab.parentTabId !== args.tabId || !tab.parentLayout) {
        return tab
      }
      changed = true
      return {
        ...tab,
        parentLayout: {
          ...tab.parentLayout,
          root: args.root ?? tab.parentLayout.root,
          expandedLeafId: args.expandedLeafId,
          ...(args.titlesByLeafId ? { titlesByLeafId: args.titlesByLeafId } : {})
        }
      }
    })
    if (!changed) {
      return
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  private moveHeadlessMobileSessionTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    move: RuntimeMobileSessionTabMove
  ): RuntimeMobileSessionTabMoveResult {
    if (move.kind === 'split') {
      return this.splitHeadlessMobileSessionTabGroup(worktreeId, snapshot, move)
    }
    if (move.kind === 'move-to-group') {
      return this.moveHeadlessMobileSessionTabToGroup(worktreeId, snapshot, move)
    }
    if (move.kind !== 'reorder') {
      throw new Error('renderer_unavailable')
    }
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const publicSnapshot = this.toMobileSessionTabsResult(snapshot)
    const targetGroup = publicSnapshot.tabGroups?.find((group) => group.id === move.targetGroupId)
    if (!targetGroup) {
      throw new Error('target_group_not_found')
    }
    const tabOrder = this.normalizeMobileSessionTabOrder(snapshot, targetGroup, move.tabOrder)
    const orderIndexByParentTabId = new Map(tabOrder.map((tabId, index) => [tabId, index]))
    const nextTabs = [...snapshot.tabs].sort((a, b) => {
      const aParent = a.type === 'terminal' ? a.parentTabId : a.id
      const bParent = b.type === 'terminal' ? b.parentTabId : b.id
      const aIndex = orderIndexByParentTabId.get(aParent) ?? Number.MAX_SAFE_INTEGER
      const bIndex = orderIndexByParentTabId.get(bParent) ?? Number.MAX_SAFE_INTEGER
      return aIndex - bIndex
    })
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const reorderedTargetActiveTabId =
      active?.type === 'terminal' ? active.parentTabId : active ? active.id : (tabOrder[0] ?? null)
    // Why: reorder only changes ONE group's order. Preserve every other group so
    // a multi-group split isn't deleted by re-sorting tabs in one of its groups.
    const existingGroups = snapshot.tabGroups ?? []
    const nextGroups = existingGroups.some((group) => group.id === targetGroup.id)
      ? existingGroups.map((group) =>
          group.id === targetGroup.id
            ? { ...group, tabOrder, activeTabId: reorderedTargetActiveTabId }
            : group
        )
      : [{ ...targetGroup, tabOrder, activeTabId: reorderedTargetActiveTabId }]
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: nextGroups,
      tabs: nextTabs
    }
    this.persistHeadlessTerminalTabOrder(worktreeId, tabOrder)
    if (nextGroups.length > 1 && snapshot.tabGroupLayout) {
      this.persistHeadlessTabGroups(worktreeId, nextGroups, snapshot.tabGroupLayout)
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return { moved: true }
  }

  // Why: a drag-to-split-group used to be a client-only change the headless host
  // never modeled, so the next snapshot coalesced every tab back into one group.
  // Model + persist the multi-group layout so the split survives rebuilds.
  private splitHeadlessMobileSessionTabGroup(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    move: Extract<RuntimeMobileSessionTabMove, { kind: 'split' }>
  ): RuntimeMobileSessionTabMoveResult {
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const split = buildHeadlessTabGroupSplit({
      groups: snapshot.tabGroups ?? [],
      layout: snapshot.tabGroupLayout,
      tabId: hostTabId,
      targetGroupId: move.targetGroupId,
      splitDirection: move.splitDirection,
      newGroupId: randomUUID()
    })
    if (!split) {
      // Renderer treats an unsplittable drop (e.g. last tab onto its own group)
      // as a no-op; mirror that instead of churning the snapshot.
      return { moved: true }
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeGroupId: split.newGroupId,
      tabGroups: split.groups,
      tabGroupLayout: split.layout
    }
    this.persistHeadlessTabGroups(worktreeId, split.groups, split.layout)
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return { moved: true }
  }

  // Move a tab into an existing group on a headless serve (non-split drop).
  private moveHeadlessMobileSessionTabToGroup(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    move: Extract<RuntimeMobileSessionTabMove, { kind: 'move-to-group' }>
  ): RuntimeMobileSessionTabMoveResult {
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const moved = buildHeadlessTabGroupMove({
      groups: snapshot.tabGroups ?? [],
      layout: snapshot.tabGroupLayout,
      tabId: hostTabId,
      targetGroupId: move.targetGroupId,
      index: move.index
    })
    if (!moved) {
      // Same-group / missing-target drop is a renderer no-op; mirror that.
      return { moved: true }
    }
    const layout = moved.layout ?? { type: 'leaf' as const, groupId: move.targetGroupId }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeGroupId: move.targetGroupId,
      tabGroups: moved.groups,
      tabGroupLayout: layout
    }
    this.persistHeadlessTabGroups(worktreeId, moved.groups, layout)
    this.mobileSessionTabsByWorktree.set(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return { moved: true }
  }

  // Persist the headless tab-GROUP layout so snapshot rebuilds keep the split.
  private persistHeadlessTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    layout: TabGroupLayoutNode
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      tabGroups: {
        ...session.tabGroups,
        [worktreeId]: groups.map((group) => ({
          id: group.id,
          worktreeId,
          activeTabId: group.activeTabId,
          tabOrder: [...group.tabOrder],
          ...(group.recentTabIds ? { recentTabIds: [...group.recentTabIds] } : {})
        }))
      },
      tabGroupLayouts: {
        ...session.tabGroupLayouts,
        [worktreeId]: layout
      }
    })
  }

  // Persist a manual terminal rename so a headless rebuild keeps the title
  // instead of reverting to the generated/default one.
  private persistHeadlessTerminalTitle(
    worktreeId: string,
    tabId: string,
    title: string | null
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const tabs = session.tabsByWorktree[worktreeId]
    if (!tabs?.some((tab) => tab.id === tabId)) {
      return
    }
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktreeId]: tabs.map((tab) => (tab.id === tabId ? { ...tab, customTitle: title } : tab))
      }
    })
  }

  private normalizeMobileSessionTabOrder(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
    targetGroup: RuntimeMobileSessionTabGroup,
    tabOrder: readonly string[]
  ): string[] {
    const normalized: string[] = []
    const seen = new Set<string>()
    for (const tabId of tabOrder) {
      const hostTabId = this.resolveMobileSessionHostTabId(snapshot, tabId)
      if (!hostTabId) {
        throw new Error('invalid_tab_order')
      }
      if (seen.has(hostTabId)) {
        throw new Error('duplicate_tab_order')
      }
      seen.add(hostTabId)
      normalized.push(hostTabId)
    }

    const returnedIds = this.collectPublicMobileSessionTabIds(snapshot)
    const expected = targetGroup.tabOrder
      .map((tabId) => this.resolveMobileSessionHostTabId(snapshot, tabId) ?? tabId)
      // Why: clients reorder the sanitized session.tabs.list model; raw groups
      // can still contain stale browser ids hidden from paired web clients.
      .filter((tabId) => returnedIds.has(tabId))
    // Why: reorder is a pure permutation of one existing group. Missing or
    // extra ids would let a paired web client silently move/lose host tabs.
    if (normalized.length !== expected.length || expected.some((tabId) => !seen.has(tabId))) {
      throw new Error('invalid_tab_order')
    }
    return normalized
  }

  private collectPublicMobileSessionTabIds(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined
  ): Set<string> {
    const ids = new Set<string>()
    if (!snapshot) {
      return ids
    }
    const liveBrowserTabsByPageId = this.getLiveBrowserTabsByPageId(snapshot.worktree)
    for (const tab of snapshot.tabs) {
      if (tab.type === 'browser') {
        const liveTab = tab.browserPageId
          ? liveBrowserTabsByPageId.get(tab.browserPageId)
          : undefined
        if (!liveTab) {
          continue
        }
        ids.add(tab.id)
        ids.add(tab.browserWorkspaceId)
        continue
      }
      ids.add(tab.id)
      if (tab.type === 'terminal') {
        ids.add(tab.parentTabId)
      }
    }
    return ids
  }

  private resolveMobileSessionHostTabId(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
    tabId: string
  ): string | null {
    const tab =
      snapshot?.tabs.find((candidate) => candidate.id === tabId) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
      ) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
      )
    if (!tab) {
      return null
    }
    return tab.type === 'terminal' ? tab.parentTabId : tab.id
  }

  async readMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMarkdownReadTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    if (!this.notifier?.readMobileMarkdownTab) {
      throw new Error('renderer_unavailable')
    }
    return await this.notifier.readMobileMarkdownTab(worktreeId, tabId)
  }

  async saveMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    if (!this.notifier?.saveMobileMarkdownTab) {
      throw new Error('renderer_unavailable')
    }
    return await this.notifier.saveMobileMarkdownTab(worktreeId, tabId, baseVersion, content)
  }

  private readonly fileCommands = new RuntimeFileCommands({
    getRuntimeId: () => this.runtimeId,
    requireStore: () => this.requireStore(),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    resolveRuntimeFileTarget: (selector) => this.resolveRuntimeFileTarget(selector),
    resolveKnownWorkspaceFileTarget: (absolutePath, connectionId) =>
      this.resolveKnownWorkspaceFileTarget(absolutePath, connectionId),
    resolveTerminalCwd: (terminalHandle) => this.resolveTerminalCwd(terminalHandle),
    resolveTerminalContext: (terminalHandle) => this.resolveTerminalContext(terminalHandle),
    resolveTerminalFileUriHostname: (terminalHandle) =>
      this.resolveTerminalFileUriHostname(terminalHandle),
    hasRecentTerminalOutputPath: (terminalHandle, pathText, absolutePath) =>
      this.hasRecentTerminalOutputPath(terminalHandle, pathText, absolutePath),
    hasRecentNativeChatOutputPath: (worktreeId, context, pathText, absolutePath) =>
      nativeChatTranscriptIncludesPath({
        tabs: this.getMobileSessionTabsForWorktree(worktreeId).tabs,
        context,
        pathText,
        absolutePath
      }),
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId) => {
      if (!this.notifier?.openFile) {
        throw new Error('renderer_unavailable')
      }
      this.notifier.openFile(worktreeId, filePath, relativePath, runtimeEnvironmentId)
    },
    openDiff: (worktreeId, filePath, relativePath, staged, runtimeEnvironmentId) => {
      if (!this.notifier?.openDiff) {
        throw new Error('renderer_unavailable')
      }
      this.notifier.openDiff(worktreeId, filePath, relativePath, staged, runtimeEnvironmentId)
    }
  })

  private readonly fileWatcherRemoval = createRuntimeFileWatcherRemoval(this.fileCommands)
  closeFileWatchersForRemoval = this.fileWatcherRemoval.close
  restoreFileWatchersAfterFailedRemoval = this.fileWatcherRemoval.restore
  forgetFileWatchersAfterRemoval = this.fileWatcherRemoval.forget
  acquireFileWatcherRemoval = this.fileWatcherRemoval.acquire
  private readonly gitCommands = new RuntimeGitCommands({
    resolveRuntimeGitTarget: (selector) => this.resolveRuntimeGitTarget(selector),
    getRuntimeSettings: () => this.requireStore().getSettings() as GlobalSettings,
    getCommitMessageAgentEnvironment: () => this.accounts.getCommitMessageAgentEnvironment(),
    // Why: resolved worktrees are cached for a second, so link/unlink would lag
    // generation; meta is keyed by the same id the resolver returns.
    getWorktreeLinkedIssue: (worktreeId) => {
      const store = this.store
      // Why: an unreadable store is "unknown", not "unlinked" — undefined keeps
      // the resolver's cached linkedIssue instead of suppressing {linkedIssue}.
      if (!store?.getWorktreeMeta) {
        return undefined
      }
      return store.getWorktreeMeta(worktreeId)?.linkedIssue ?? null
    },
    getWorktreeLinkedIssueMeta: (worktreeId) => {
      const store = this.store
      if (!store?.getWorktreeMeta) {
        return undefined
      }
      const meta = store.getWorktreeMeta(worktreeId)
      return meta
        ? {
            linkedIssue: meta.linkedIssue,
            linkedGitLabIssue: meta.linkedGitLabIssue,
            linkedWorkItem: meta.linkedWorkItem
          }
        : null
    }
  })

  private async resolveRuntimeGitTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    repo?: Repo
    connectionId?: string
    localGitOptions?: { wslDistro?: string }
  }> {
    const store = this.requireStore()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = store.getRepo(worktree.repoId)
    const connectionId = repo?.connectionId ?? undefined
    const localGitOptions =
      repo && !connectionId ? getLocalProjectWorktreeGitOptions(store, repo) : {}
    return { worktree, repo, connectionId, localGitOptions }
  }

  private async resolveRuntimeFileTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    connectionId?: string
  }> {
    const folderScope = await this.resolveFolderWorkspaceLaunchScope(worktreeSelector)
    if (folderScope?.folderWorkspace) {
      return {
        worktree: this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace),
        connectionId: folderScope.connectionId ?? undefined
      }
    }

    const store = this.requireStore()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = store.getRepo(worktree.repoId)
    return { worktree, connectionId: repo?.connectionId ?? undefined }
  }

  private async resolveKnownWorkspaceFileTarget(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<{
    worktree: ResolvedWorktree
    connectionId?: string
    relativePath: string
  } | null> {
    const targets = new Map<
      string,
      {
        worktree: ResolvedWorktree
        connectionId?: string
        executionHostId: ExecutionHostId
      }
    >()
    const resolvedWorktrees = await this.listResolvedWorktrees()
    const visibilitySourceMatchersByRepoId =
      this.buildRuntimeVisibilitySourceMatchersByRepoId(resolvedWorktrees)
    for (const worktree of resolvedWorktrees) {
      if (
        !this.isRuntimeWorktreeVisible(
          worktree,
          visibilitySourceMatchersByRepoId.get(worktree.repoId)
        )
      ) {
        continue
      }
      const candidateConnectionId = this.store?.getRepo(worktree.repoId)?.connectionId ?? undefined
      const target = {
        worktree,
        executionHostId: getRuntimeFileTargetExecutionHostId({
          worktree,
          connectionId: candidateConnectionId
        }),
        ...(candidateConnectionId ? { connectionId: candidateConnectionId } : {})
      }
      targets.set(`${target.executionHostId}\0${worktree.id}`, target)
    }
    for (const folderWorkspace of this.store?.getFolderWorkspaces?.() ?? []) {
      try {
        const candidateConnectionId =
          this.resolveFolderWorkspaceConnectionId(folderWorkspace) ?? undefined
        const worktree = this.folderWorkspaceToResolvedWorktree(folderWorkspace)
        const target = {
          worktree,
          executionHostId: getRuntimeFileTargetExecutionHostId({
            worktree,
            connectionId: candidateConnectionId
          }),
          ...(candidateConnectionId ? { connectionId: candidateConnectionId } : {})
        }
        targets.set(`${target.executionHostId}\0${worktree.id}`, target)
      } catch {
        // An ambiguous folder workspace has no single filesystem authority.
      }
    }

    const owner = findRuntimeWorkspaceFileOwner(
      [...targets.values()].map((target) => ({
        workspaceId: target.worktree.id,
        rootPath: target.worktree.path,
        executionHostId: target.executionHostId
      })),
      absolutePath,
      executionHostId
    )
    if (!owner) {
      return null
    }
    const target = targets.get(`${owner.executionHostId}\0${owner.workspaceId}`)
    return target ? { ...target, relativePath: owner.relativePath } : null
  }

  onMobileSessionTabsChanged(
    listener: (snapshot: RuntimeMobileSessionTabsResult) => void,
    clientNavigationId?: string
  ): () => void {
    // Why: a notify coalesced before this subscriber existed is already folded
    // into the initial snapshot it was just sent. Draining it here — before the
    // listener joins — keeps that pending timer from landing as a redundant
    // `updated` frame carrying pre-subscribe state. Mirrors the unsubscribe flush.
    this.mobileSessionTabsNotifyCoalescer.flushAll()
    const subscription = { listener, clientNavigationId }
    this.mobileSessionTabListeners.add(subscription)
    return () => {
      // Why: flush pending coalesced notifies before dropping this listener so a
      // subscriber closing mid-window still receives the latest settled state.
      this.mobileSessionTabsNotifyCoalescer.flushAll()
      this.mobileSessionTabListeners.delete(subscription)
      if (this.mobileSessionTabListeners.size === 0) {
        this.mobileSessionTabsAgentStatusHeartbeat.cancelPending()
      }
    }
  }

  forgetClientNavigationState(clientNavigationId: string): void {
    this.clientSessionTabSelections.forgetClient(clientNavigationId)
  }

  // Why: terminal handles are normally created lazily when first referenced via
  // RPC, but agents need their own handle at spawn time (via ORCA_TERMINAL_HANDLE
  // env var) so they can self-identify in orchestration messages without an
  // extra RPC round-trip. Pre-allocating by ptyId lets issueHandle reuse it.
  preAllocateHandleForPty(ptyId: string): string {
    const existing = this.handleByPtyId.get(ptyId)
    if (existing) {
      return existing
    }
    const handle = this.createPreAllocatedTerminalHandle()
    this.handleByPtyId.set(ptyId, handle)
    return handle
  }

  createPreAllocatedTerminalHandle(): string {
    return `term_${randomUUID()}`
  }

  registerPreAllocatedHandleForPty(ptyId: string, handle: string): void {
    this.handleByPtyId.set(ptyId, handle)
    for (const leaf of this.getLeavesForPty(ptyId)) {
      this.adoptPreAllocatedHandle(leaf)
    }
  }

  private adoptControllerTerminalHandle(
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options: { exactRestoredSurface?: boolean } = {}
  ): void {
    const trimmed = handle?.trim()
    if (!trimmed || !trimmed.startsWith('term_')) {
      return
    }
    const pty = this.ptysById.get(ptyId)
    const changedIncarnation = Boolean(
      incarnationId && pty?.incarnationId && incarnationId !== pty.incarnationId
    )
    if (changedIncarnation) {
      const priorHandle = this.handleByPtyId.get(ptyId)
      this.invalidateAllHandlesForPty(ptyId)
      pty!.tabId = null
      pty!.paneKey = null
      // Reusing an exported handle would make stale client metadata name the replacement process.
      if (priorHandle === trimmed) {
        return
      }
    }
    if (this.isTerminalHandleAdoptionBlocked(ptyId, trimmed)) {
      if (
        !options.exactRestoredSurface ||
        !this.replaceSyntheticTerminalHandlesForRestoredPty(ptyId, trimmed) ||
        this.isTerminalHandleAdoptionBlocked(ptyId, trimmed)
      ) {
        return
      }
    }
    // Why: after an app/runtime restart, the live PTY child still has its
    // original ORCA_TERMINAL_HANDLE, but the runtime's in-memory map is gone.
    this.registerPreAllocatedHandleForPty(ptyId, trimmed)
  }

  private invalidateAllHandlesForPty(ptyId: string): void {
    this.handleByPtyId.delete(ptyId)
    const invalidated = new Set<string>()
    for (const [handle, record] of this.handles) {
      if (record.ptyId === ptyId) {
        invalidated.add(handle)
        this.handles.delete(handle)
        this.syntheticTerminalHandles.delete(handle)
        this.rejectWaitersForHandle(handle, 'terminal_handle_stale')
      }
    }
    for (const [leafKey, handle] of this.handleByLeafKey) {
      if (invalidated.has(handle)) {
        this.handleByLeafKey.delete(leafKey)
      }
    }
  }

  private replaceSyntheticTerminalHandlesForRestoredPty(
    ptyId: string,
    controllerHandle: string
  ): boolean {
    const boundHandles = new Set<string>()
    const directHandle = this.handleByPtyId.get(ptyId)
    if (directHandle) {
      boundHandles.add(directHandle)
    }
    for (const [handle, record] of this.handles) {
      if (record.ptyId === ptyId) {
        boundHandles.add(handle)
      } else if (handle === controllerHandle) {
        return false
      }
    }
    for (const [otherPtyId, handle] of this.handleByPtyId) {
      if (otherPtyId !== ptyId && handle === controllerHandle) {
        return false
      }
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (handle) {
        boundHandles.add(handle)
      }
    }
    if (
      boundHandles.size === 0 ||
      [...boundHandles].some(
        (handle) => handle === controllerHandle || !this.syntheticTerminalHandles.has(handle)
      )
    ) {
      return false
    }
    this.invalidateAllHandlesForPty(ptyId)
    return true
  }

  // Why: adoption is best-effort restart recovery and must be first-wins.
  // Re-keying a pty that already has a handle this session would strand
  // waiters registered under the old handle, and provider-reported values
  // are not trusted to be collision-free — a handle bound to a different
  // pty must never be stolen by a later report.
  private isTerminalHandleAdoptionBlocked(ptyId: string, handle: string): boolean {
    if (this.handleByPtyId.get(ptyId) ?? this.findHandleForPtyRecord(ptyId)) {
      return true
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const issued = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (issued && issued !== handle) {
        return true
      }
    }
    const existingRecord = this.handles.get(handle)
    if (existingRecord && existingRecord.ptyId !== ptyId) {
      return true
    }
    for (const [otherPtyId, otherHandle] of this.handleByPtyId) {
      if (otherHandle === handle && otherPtyId !== ptyId) {
        return true
      }
    }
    return false
  }

  onPtySpawned(
    ptyId: string,
    incarnationId?: PtyIncarnationId,
    options: { awaitsRegistration?: boolean } = {}
  ): void {
    if (options.awaitsRegistration !== false) {
      // Why: surface absence cannot distinguish an in-flight admission from a completed headless lifecycle.
      this.pendingPtyRegistrationIncarnations.set(ptyId, incarnationId ?? null)
    }
    this.terminalViewSubscribers.markSpawnPublished(ptyId)
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (pty) {
      if (incarnationId) {
        pty.incarnationId = incarnationId
      }
      pty.connected = true
      pty.disconnectedAt = null
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.connected = true
      leaf.writable = this.graphStatus === 'ready'
      this.adoptPreAllocatedHandle(leaf)
    }
  }

  registerPty(
    ptyId: string,
    worktreeId: string,
    connectionId: string | null = null,
    binding?: {
      tabId: string
      leafId: string
      incarnationId?: PtyIncarnationId
      agentLaunchAuthority?: { launchToken: string; launchAgent: TuiAgent }
    },
    isWsl?: boolean
  ): void {
    this.assertPtyDidNotExitBeforeRegistration(ptyId, binding?.incarnationId)
    this.terminalViewSubscribers.markSpawnPublished(ptyId)
    // Why: record the renderer pane identity at spawn time so a stalled graph
    // sync can't hide that a live PTY already backs a pending mobile create.
    const paneKey =
      binding && isValidTerminalTabId(binding.tabId) && isTerminalLeafId(binding.leafId)
        ? makePaneKey(binding.tabId, binding.leafId)
        : null
    const pty = this.recordPtyWorktree(ptyId, worktreeId, {
      connected: true,
      connectionId,
      ...(binding && this.pendingMobileTerminalCreatesByKey.has(`${worktreeId}::${binding.tabId}`)
        ? { runtimeSessionOwned: true }
        : {}),
      ...(isWsl !== undefined ? { isWsl } : {}),
      ...(binding && paneKey ? { tabId: binding.tabId, paneKey } : {}),
      ...(binding?.incarnationId ? { incarnationId: binding.incarnationId } : {})
    })
    const agentLaunchAuthority = binding?.agentLaunchAuthority
    if (
      agentLaunchAuthority &&
      paneKey &&
      binding.incarnationId &&
      pty.incarnationId === binding.incarnationId &&
      pty.paneKey === paneKey &&
      pty.launchToken === null &&
      agentLaunchAuthority.launchToken.length > 0 &&
      agentLaunchAuthority.launchToken.length <= 128 &&
      isTuiAgent(agentLaunchAuthority.launchAgent)
    ) {
      pty.launchToken = agentLaunchAuthority.launchToken
      pty.launchIncarnationId = binding.incarnationId
      pty.launchAgent = agentLaunchAuthority.launchAgent
    }
    const pendingIncarnation = this.pendingPtyRegistrationIncarnations.get(ptyId)
    if (
      pendingIncarnation === null ||
      pendingIncarnation === undefined ||
      binding?.incarnationId === undefined ||
      pendingIncarnation === binding.incarnationId
    ) {
      this.pendingPtyRegistrationIncarnations.delete(ptyId)
    }
    // Why: the renderer's own PTY spawn is the reliable signal that the pending
    // mobile create's tab is live; publish its surface main-side (#7587).
    if (binding && paneKey) {
      this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, binding.tabId)
    }
  }

  assertPtyRegistrationAllowed(ptyId: string, incarnationId?: PtyIncarnationId): void {
    // Why: the controller must reject an early exit before persisting bindings or handles.
    this.assertPtyDidNotExitBeforeRegistration(ptyId, incarnationId)
  }

  releaseRejectedPtyRegistrationFence(
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ): void {
    if (!this.earlyExitedPtyIncarnations.has(ptyId)) {
      return
    }
    const exitedIncarnation = this.earlyExitedPtyIncarnations.get(ptyId) ?? null
    if (
      exitedIncarnation === null ||
      candidateIncarnation === undefined ||
      exitedIncarnation === candidateIncarnation
    ) {
      // Why: the rejected spawn call was the fence's sole late publisher; retaining it leaks fresh PTY ids.
      this.earlyExitedPtyIncarnations.delete(ptyId)
      this.pendingPtyRegistrationIncarnations.delete(ptyId)
    }
  }

  beginPtyRegistration(ptyId: string, incarnationId?: PtyIncarnationId): void {
    this.pendingPtyRegistrationIncarnations.set(ptyId, incarnationId ?? null)
  }

  acceptPtyIncarnationForExit(ptyId: string, incarnationId: PtyIncarnationId): void {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      // Why: a reconnect attach reply can prove the exit generation after stale local proof was cleared.
      pty.incarnationId = incarnationId
    }
  }

  cancelPendingPtyRegistration(ptyId: string, incarnationId?: PtyIncarnationId): void {
    const pending = this.pendingPtyRegistrationIncarnations.get(ptyId)
    if (
      !this.pendingPtyRegistrationIncarnations.has(ptyId) ||
      (pending !== null && incarnationId !== undefined && pending !== incarnationId)
    ) {
      return
    }
    this.pendingPtyRegistrationIncarnations.delete(ptyId)
    const exited = this.earlyExitedPtyIncarnations.get(ptyId)
    if (
      exited === null ||
      exited === undefined ||
      incarnationId === undefined ||
      exited === incarnationId
    ) {
      this.earlyExitedPtyIncarnations.delete(ptyId)
    }
  }

  private assertPtyDidNotExitBeforeRegistration(
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ): void {
    if (this.earlyExitedPtyIncarnations.has(ptyId)) {
      const exitedIncarnation = this.earlyExitedPtyIncarnations.get(ptyId) ?? null
      const nextIncarnation = candidateIncarnation ?? null
      if (
        exitedIncarnation === null ||
        nextIncarnation === null ||
        exitedIncarnation === nextIncarnation
      ) {
        throw new Error('agent_session_exited_during_start')
      }
      this.earlyExitedPtyIncarnations.delete(ptyId)
    }
  }

  preparePtyExecutionContext(
    ptyId: string,
    wslDistro: string | null,
    options: { resetIncarnation?: boolean; preserveExisting?: boolean } = {}
  ): boolean {
    const pty = this.ptysById.get(ptyId)
    const hadExistingContext = this.wslDistroByPtyId.has(ptyId) || pty !== undefined
    if (options.preserveExisting && hadExistingContext) {
      // Why: attach-time settings are only a fallback; a live PTY's recorded
      // execution namespace remains authoritative until its provider replies.
      return false
    }

    if (options.resetIncarnation) {
      // Why: an explicit new lifecycle supersedes an unidentifiable exit from the reused PTY id.
      this.earlyExitedPtyIncarnations.delete(ptyId)
      this.disposeHeadlessTerminal(ptyId)
      this.osc7ScanTailByPtyId.delete(ptyId)
      this.terminalCwdByPtyId.delete(ptyId)
      this.terminalFileUriHostnameByPtyId.delete(ptyId)
      this.wslDistroByPtyId.delete(ptyId)
    }

    const previous = this.wslDistroByPtyId.get(ptyId) ?? null
    if (wslDistro) {
      this.wslDistroByPtyId.set(ptyId, wslDistro)
    } else {
      this.wslDistroByPtyId.delete(ptyId)
    }
    if (pty) {
      pty.wslDistro = wslDistro
    }
    if (!options.resetIncarnation && previous !== wslDistro && this.headlessTerminals.has(ptyId)) {
      // Why: bytes parsed with two distro namespaces would leave an internally
      // inconsistent CWD; rebuild from the provider's authoritative snapshot.
      this.terminalCwdByPtyId.delete(ptyId)
      this.replaceHeadlessTerminalAfterExecutionContextChange(ptyId)
    }
    return options.resetIncarnation === true || !hadExistingContext || previous !== wslDistro
  }

  /** Record the spawn launch command so the per-PTY Command Code detector can
   *  arm from it (renderer startupCommand parity). Best-effort: a chunk that
   *  beats this call falls back to the detector's banner arming. */
  noteTerminalSpawnCommand(ptyId: string, command: string | null | undefined): void {
    const trimmed = typeof command === 'string' ? command.trim() : ''
    if (trimmed.length > 0) {
      this.terminalSpawnCommandsByPtyId.set(ptyId, trimmed)
    }
  }

  resetPtyModelAfterMigrationFailure(ptyId: string): void {
    this.providerSnapshotPreferredPtys.add(ptyId)
    this.disposeHeadlessTerminal(ptyId)
  }

  /**
   * Handles incoming data from a PTY process, running agent detection,
   * updating terminal tail buffers, and triggering foreground agent refreshes.
   */
  acceptPtyDataBounded(
    ptyId: string,
    data: string,
    at: number,
    sequenceChars = data.length,
    transformed = false,
    sourceRanges?: readonly TerminalOutputSourceRange[]
  ): RuntimePtyDataAdmission {
    let completion: Promise<void> | null = null
    const sequence = this.onPtyData(
      ptyId,
      data,
      at,
      sequenceChars,
      transformed,
      (receipt) => {
        completion = receipt
      },
      sourceRanges
    )
    if (!completion) {
      throw new Error('PTY model admission receipt was not captured')
    }
    return Object.freeze({ sequence, completion })
  }

  onPtyData(
    ptyId: string,
    data: string,
    at: number,
    sequenceChars = data.length,
    transformed = false,
    captureModelReceipt?: (completion: Promise<void>) => void,
    sourceRanges?: readonly TerminalOutputSourceRange[]
  ): number {
    const outputSequence = (this.ptyOutputSequenceById.get(ptyId) ?? 0) + sequenceChars
    this.ptyOutputSequenceById.set(ptyId, outputSequence)
    this.providerModeTrackersByPtyId.get(ptyId)?.scan(data)
    for (const tracker of this.providerModeSnapshotScansByPtyId.get(ptyId) ?? []) {
      tracker.scan(data)
    }
    const osc7Metadata = this.recordOsc7MetadataForPty(ptyId, data)
    const cwd = osc7Metadata.cwd
    const cwdChanged = osc7Metadata.cwdChanged
    const agentStatusChunk = this.processAgentStatusOscForPty(ptyId, data)
    this.recordRecentPtyOutputForPathProvenance(ptyId, data)
    // Agent detection runs on raw data before leaf processing, since the
    // tail buffer logic normalizes away the OSC sequences we need.
    this.agentDetector?.onData(ptyId, data, at)
    // Why: watch terminal output for advertised dev-server URLs (e.g. Vite's
    // `Network: https://local.example.com:3001/`) so the workspace ports
    // panel can surface them in place of the kernel bind address.
    advertisedUrlWatcher.ingest(ptyId, data, at)
    // Why: reply ownership is captured per chunk, here at ingestion — the
    // same module state and tick as the hidden-gate drop sites — and rides
    // the writeChain link. A mark/setting/subscriber flip before the queued
    // emulator write runs must not change who answers (terminal-query-
    // authority.md invariant 1).
    const forwardQueryReplies = this.shouldAnswerQueriesForLiveChunk(ptyId)
    // Ordering invariant (DO NOT REORDER): maybeHydrateHeadlessFromRenderer
    // MUST run before trackHeadlessTerminalData so the eager-state pattern
    // (set headlessTerminals + writeChain head = seedPromise) is in place
    // before the live byte's chain link is queued. Without this ordering,
    // trackHeadlessTerminalData would lazy-create a fresh state at PTY dims
    // that the later seed-resolve would overwrite, dropping the live byte.
    // See docs/mobile-prefer-renderer-scrollback.md.
    this.maybeHydrateHeadlessFromRenderer(ptyId)
    // Our structure wins: OSC title/agent-status extraction runs through the
    // shared per-PTY title tracker below (getOrCreatePtyTitleTrackerEntry →
    // applyTrackedPtyTitle) in byte order, superseding main's inline
    // extractLastOscTitleForPty block (#7880/#7852 title/status semantics are
    // preserved via the tracker + detectAgentStatusFromTitle path).
    const modelCompletion = this.trackHeadlessTerminalData(
      ptyId,
      data,
      outputSequence,
      forwardQueryReplies
    )
    captureModelReceipt?.(modelCompletion)

    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    const ptyTailBefore = pty
      ? {
          lines: pty.tailBuffer,
          transcriptLines: pty.tailTranscriptBuffer,
          partialLine: pty.tailPartialLine,
          pendingAnsi: pty.tailPendingAnsi,
          redrawCursor: pty.tailRedrawCursor,
          truncated: pty.tailTruncated,
          linesTotal: pty.tailLinesTotal
        }
      : null
    let ptyTailAfter: ReturnType<typeof appendNormalizedToTailBuffer> | null = null
    if (pty) {
      pty.connected = true
      pty.disconnectedAt = null
      pty.lastOutputAt = at
      const normalized = normalizeTerminalChunk(data, pty.tailPendingAnsi)
      pty.tailPendingAnsi = normalized.pendingAnsi
      const nextTail = appendNormalizedToTailBuffer(
        pty.tailBuffer,
        pty.tailPartialLine,
        normalized.text,
        pty.tailRedrawCursor
      )
      ptyTailAfter = nextTail
      const nextTranscript = appendCompletedTerminalTranscript(
        pty.tailTranscriptBuffer,
        pty.tailTranscriptChars,
        nextTail.newlyCompletedLines,
        nextTail.newCompleteLines
      )
      pty.tailBuffer = nextTail.lines
      pty.tailTranscriptBuffer = nextTranscript.lines
      pty.tailTranscriptChars = nextTranscript.characters
      pty.tailPartialLine = nextTail.partialLine
      pty.tailRedrawCursor = nextTail.redrawCursor
      pty.tailTruncated = pty.tailTruncated || nextTail.truncated || nextTranscript.truncated
      pty.tailLinesTotal += nextTail.newCompleteLines
      pty.preview = buildPreview(pty.tailBuffer, pty.tailPartialLine)
      this.scheduleWaitBlockedCheck(ptyId, normalized.text, at)
    }

    for (const leaf of this.getLeavesForPty(ptyId)) {
      this.recordPtyWorktree(ptyId, leaf.worktreeId, {
        connected: true,
        lastOutputAt: pty?.lastOutputAt ?? at,
        preview: pty?.preview ?? leaf.preview,
        tabId: leaf.tabId,
        paneKey: this.makeRuntimePaneKey(leaf)
      })
      leaf.connected = true
      leaf.writable = this.graphStatus === 'ready'
      leaf.lastOutputAt = at
      if (
        pty &&
        ptyTailBefore &&
        ptyTailAfter &&
        tailStateMatches(
          leaf.tailBuffer,
          leaf.tailTranscriptBuffer,
          leaf.tailPartialLine,
          leaf.tailPendingAnsi,
          leaf.tailRedrawCursor,
          leaf.tailTruncated,
          leaf.tailLinesTotal,
          ptyTailBefore
        )
      ) {
        // Why: the leaf and PTY record usually mirror the same terminal. Reuse
        // the PTY tail update instead of splitting large output twice.
        leaf.tailBuffer = pty.tailBuffer
        leaf.tailTranscriptBuffer = pty.tailTranscriptBuffer
        leaf.tailTranscriptChars = pty.tailTranscriptChars
        leaf.tailPartialLine = pty.tailPartialLine
        leaf.tailPendingAnsi = pty.tailPendingAnsi
        leaf.tailRedrawCursor = pty.tailRedrawCursor
        leaf.tailTruncated = pty.tailTruncated
        leaf.tailLinesTotal = pty.tailLinesTotal
        leaf.preview = pty.preview
        leaf.waitBlockedAt = pty.waitBlockedAt
        // Why undefined on this branch: the PTY record's wait scan is throttled
        // (scheduleWaitBlockedCheck), so pty.tailWaitState is never populated;
        // copying it here intentionally invalidates the leaf cache and the
        // mismatch branch below recomputes an exact state on its next chunk.
        leaf.tailWaitState = pty.tailWaitState
      } else {
        const normalized = normalizeTerminalChunk(data, leaf.tailPendingAnsi)
        leaf.tailPendingAnsi = normalized.pendingAnsi
        const previousWaitState =
          leaf.tailWaitState?.fromTail === true
            ? leaf.tailWaitState
            : computeTerminalTailWaitState(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
        const nextTail = appendNormalizedToTailBuffer(
          leaf.tailBuffer,
          leaf.tailPartialLine,
          normalized.text,
          leaf.tailRedrawCursor
        )
        const nextTranscript = appendCompletedTerminalTranscript(
          leaf.tailTranscriptBuffer,
          leaf.tailTranscriptChars,
          nextTail.newlyCompletedLines,
          nextTail.newCompleteLines
        )
        const nextWaitState = computeTerminalTailWaitState(
          nextTail.lines,
          nextTail.partialLine,
          leaf.preview
        )
        if (tailGainedNewerBlockedReason(previousWaitState, nextWaitState, normalized.text)) {
          leaf.waitBlockedAt = at
        }
        leaf.tailWaitState = nextWaitState
        leaf.tailBuffer = nextTail.lines
        leaf.tailTranscriptBuffer = nextTranscript.lines
        leaf.tailTranscriptChars = nextTranscript.characters
        leaf.tailPartialLine = nextTail.partialLine
        leaf.tailRedrawCursor = nextTail.redrawCursor
        leaf.tailTruncated = leaf.tailTruncated || nextTail.truncated || nextTranscript.truncated
        leaf.tailLinesTotal += nextTail.newCompleteLines
        leaf.preview = buildPreview(leaf.tailBuffer, leaf.tailPartialLine)
      }
    }

    // Why: feed the chunk's OSC titles through the shared per-PTY tracker in
    // byte order — the same ordering the renderer transport uses — so
    // coalesced working→idle transitions reach tui-idle waiters and
    // pending-message delivery instead of being masked by the chunk's last
    // title (issue #1083). Uses the OSC 9999-stripped cleanData like the
    // renderer, so pure status chunks don't perturb the stale-title probe.
    const titleTrackerEntry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    const previousTitleScanTail = this.oscTitleScanTailByPtyId.get(ptyId)
    const titleInput = previousTitleScanTail
      ? `${previousTitleScanTail}${agentStatusChunk.cleanData}`
      : agentStatusChunk.cleanData
    const nextTitleScanTail = extractOscTitleScanTail(titleInput)
    if (nextTitleScanTail.length > 0) {
      this.oscTitleScanTailByPtyId.set(ptyId, nextTitleScanTail)
    } else {
      this.oscTitleScanTailByPtyId.delete(ptyId)
    }
    titleTrackerEntry.applyingChunk = true
    titleTrackerEntry.chunkTouchedSessionTabs = false
    let retainedAgentStatusChanged = false
    try {
      for (const payload of agentStatusChunk.payloads) {
        titleTrackerEntry.pendingFacts.push({ kind: 'agent-status', payload })
      }
      titleTrackerEntry.tracker.handleChunk(agentStatusChunk.cleanData, {
        titleScanData: titleInput
      })
      // Why: the Command Code scrape rides the same per-chunk batch (its facts
      // trail the tracker's). cleanData keeps OSC 9999 payloads out of the
      // detector's bounded recent-text window; the detector strips remaining
      // control sequences itself, exactly like the renderer byte path.
      titleTrackerEntry.commandCodeDetector?.observe(agentStatusChunk.cleanData)
    } finally {
      titleTrackerEntry.applyingChunk = false
      try {
        // Why: per-chunk cross-channel contract order is status → titles →
        // bell — the chunk's agentStatus:set events must reach the renderer
        // before its pty:sideEffect batch.
        retainedAgentStatusChanged = this.emitTerminalAgentStatusEvents(ptyId, agentStatusChunk)
      } finally {
        // Why: flushed in the finally so a throwing tracker callback cannot
        // strand this chunk's facts to be emitted under the next chunk's seq.
        this.flushPendingTerminalSideEffectFacts(ptyId, titleTrackerEntry)
      }
    }
    // Why: hook (OSC 9999) transitions often arrive without a title change, so
    // headless-serve snapshots would never republish and paired remote clients
    // kept the stale agent state until the next title change (#7970).
    if (titleTrackerEntry.chunkTouchedSessionTabs || retainedAgentStatusChanged) {
      this.touchMobileSessionSnapshotsForPty(ptyId)
    }

    this.terminalStreamConsumers.publish(ptyId, data, () => ({
      seq: outputSequence,
      rawLength: sequenceChars,
      ...(transformed ? { transformed: true } : {}),
      ...(cwdChanged && cwd !== null ? { cwd } : {}),
      ...(sourceRanges && sourceRanges.length > 0 ? { sourceRanges } : {})
    }))
    return outputSequence
  }

  private scheduleWaitBlockedCheck(ptyId: string, appendedText: string, at: number): void {
    let state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (!state) {
      state = { lastAt: 0, lastWaitState: null, appended: '', keywordCarry: '', timer: null }
      this.waitBlockedCheckStateByPtyId.set(ptyId, state)
    }
    const appendedLower = appendedText.toLowerCase()
    const keywordHit = WAIT_BLOCKED_KEYWORD_PATTERN.test(`${state.keywordCarry}${appendedLower}`)
    state.keywordCarry = appendedLower.slice(-WAIT_BLOCKED_KEYWORD_CARRY_CHARS)
    // Why the cap keeps the tail: the accumulated text only anchors boundary-
    // spanning prompt detection; anything past the tail cap has scrolled out
    // of the retained tail the check reads anyway.
    state.appended =
      state.appended.length + appendedText.length > MAX_TAIL_CHARS
        ? `${state.appended}${appendedText}`.slice(-MAX_TAIL_CHARS)
        : `${state.appended}${appendedText}`
    const elapsed = at - state.lastAt
    if (keywordHit || elapsed >= WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS || elapsed < 0) {
      this.runWaitBlockedCheck(ptyId, state, at)
      return
    }
    if (!state.timer) {
      // Why trailing edge: the final chunks of a burst must still be
      // evaluated or a prompt arriving right after a flood would go
      // unstamped until the next output.
      state.timer = setTimeout(() => {
        state.timer = null
        this.runWaitBlockedCheck(ptyId, state, Date.now())
      }, WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS - elapsed)
    }
  }

  private runWaitBlockedCheck(
    ptyId: string,
    state: {
      lastAt: number
      lastWaitState: TerminalTailWaitState | null
      appended: string
      keywordCarry: string
      timer: ReturnType<typeof setTimeout> | null
    },
    at: number
  ): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      state.appended = ''
      return
    }
    const nextWaitState = computeTerminalTailWaitState(
      pty.tailBuffer,
      pty.tailPartialLine,
      pty.preview
    )
    const previousWaitState = state.lastWaitState ?? {
      waitText: '',
      signal: null,
      fromTail: false
    }
    if (tailGainedNewerBlockedReason(previousWaitState, nextWaitState, state.appended)) {
      pty.waitBlockedAt = at
    }
    state.lastAt = at
    state.lastWaitState = nextWaitState
    state.appended = ''
  }

  // Why: the scanner's first run after a restore seed compares against a null
  // baseline, so a permission prompt visible only in seeded HISTORY would read
  // as newly gained and stamp waitBlockedAt "now" on the next benign chunk.
  // Store the seeded tail's wait state as the baseline WITHOUT stamping; only
  // a signal that appears in genuinely new output counts as gained.
  private primeWaitBlockedBaselineFromSeededTail(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return
    }
    let state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (!state) {
      state = { lastAt: 0, lastWaitState: null, appended: '', keywordCarry: '', timer: null }
      this.waitBlockedCheckStateByPtyId.set(ptyId, state)
    }
    if (state.lastWaitState === null) {
      state.lastWaitState = computeTerminalTailWaitState(
        pty.tailBuffer,
        pty.tailPartialLine,
        pty.preview
      )
    }
  }

  private clearWaitBlockedCheckState(ptyId: string): void {
    const state = this.waitBlockedCheckStateByPtyId.get(ptyId)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    this.waitBlockedCheckStateByPtyId.delete(ptyId)
  }

  private processAgentStatusOscForPty(ptyId: string, data: string): ProcessedAgentStatusChunk {
    let processor = this.agentStatusOscProcessorsByPtyId.get(ptyId)
    if (!processor) {
      processor = createAgentStatusOscProcessor()
      this.agentStatusOscProcessorsByPtyId.set(ptyId, processor)
    }
    return processor(data)
  }

  /** Emit the facts batched while applying one chunk/frame as a single
   *  pty:sideEffect batch, preserving byte order. */
  private flushPendingTerminalSideEffectFacts(
    ptyId: string,
    entry: RuntimePtyTitleTrackerEntry
  ): void {
    if (entry.pendingFacts.length === 0) {
      return
    }
    const facts = entry.pendingFacts
    entry.pendingFacts = []
    this.emitTerminalSideEffectBatch(ptyId, facts)
  }

  /** Feed a main-fabricated OSC title/BEL frame (agent hook spinners) through
   *  the per-PTY tracker — NOT onPtyData, so emulator state, tails,
   *  transcripts, and stats never see synthetic bytes. Parsed via the
   *  tracker's stateless synthetic path: the shared chunk bell detector must
   *  never observe fabricated bytes, or a tick interleaved with a split real
   *  OSC corrupts its escape state (phantom/swallowed bells). While the
   *  side-effect kill switch is off the legacy pty:data copy still drives
   *  renderer parsers; this ingest keeps main's facts and records
   *  authoritative. */
  ingestSyntheticTitleFrame(ptyId: string, data: string): void {
    const entry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    entry.applyingChunk = true
    entry.chunkTouchedSessionTabs = false
    try {
      entry.tracker.applySyntheticTitleFrame(data)
    } finally {
      entry.applyingChunk = false
      this.flushPendingTerminalSideEffectFacts(ptyId, entry)
    }
    if (entry.chunkTouchedSessionTabs) {
      this.touchMobileSessionSnapshotsForPty(ptyId)
    }
  }

  /** Scan-authority handoff for a backgrounded PTY (daemon keep-tail
   *  thinning): while delegated, the daemon relays bell/133/pr-link/2031
   *  facts itself and the delivered bytes may be gapped — feeding them to
   *  main's transient scanners would mint phantom or duplicate facts. Title
   *  processing stays main-side either way. */
  setPtyTransientFactDelegation(
    ptyId: string,
    delegated: boolean,
    scanSeedAnsi?: string,
    mode2031PendingSubscribe?: true
  ): void {
    const entry = this.getOrCreatePtyTitleTrackerEntry(ptyId)
    entry.tracker.setTransientFactScanningSuppressed(delegated)
    if (!delegated && scanSeedAnsi) {
      // Prime the freshly reset scanner carry with the emulator's dangling
      // incomplete escape at the handoff position — a sequence split across
      // the un-background toggle must not mint a phantom bell or lose its
      // fact. titleScanData:'' keeps titles out (they were never suppressed).
      entry.tracker.handleChunk(scanSeedAnsi, {
        titleScanData: '',
        mode2031PendingSubscribe
      })
    }
  }

  /** A transient fact the daemon detected while it held scan authority —
   *  emitted through the same fact channel as byte-scanned facts. Arrives
   *  between chunks, so recordTerminalSideEffectFact emits it immediately. */
  emitDaemonPtyTransientFact(ptyId: string, fact: PtyTransientFact): void {
    switch (fact.kind) {
      case 'bell':
        this.recordTerminalSideEffectFact(ptyId, { kind: 'bell' })
        return
      case 'command-finished':
        this.retirePtyAgentLaunchAuthority(ptyId)
        this.recordTerminalSideEffectFact(ptyId, {
          kind: 'command-finished',
          exitCode: fact.exitCode
        })
        return
      case 'pr-link':
        this.recordTerminalSideEffectFact(ptyId, { kind: 'pr-link', link: fact.link })
        return
      case '2031-subscribe':
        this.recordTerminalSideEffectFact(ptyId, { kind: '2031-subscribe' })
        return
      case '2031-unsubscribe':
        this.recordTerminalSideEffectFact(ptyId, { kind: '2031-unsubscribe' })
    }
  }

  /** The daemon keep-tail dropped this PTY's oldest undelivered output; the
   *  next delivered chunk is discontinuous. Reset every cross-chunk parse
   *  carry so a half-open escape from before the gap cannot corrupt what
   *  follows, and drop the mobile headless mirror — it rebuilds from the
   *  delivered tail / snapshot seeds instead of parsing a gapped stream. */
  notePtyDataGap(ptyId: string, droppedChars = 0): void {
    if (droppedChars > 0) {
      // Why: the daemon snapshot's seq counts bytes its monitoring stream
      // dropped. Advancing without parsing preserves that absolute domain so
      // post-snapshot live chunks can be reconciled instead of duplicated.
      const outputSequence = (this.ptyOutputSequenceById.get(ptyId) ?? 0) + droppedChars
      this.ptyOutputSequenceById.set(ptyId, outputSequence)
    }
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (pty) {
      pty.tailPendingAnsi = ''
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.tailPendingAnsi = ''
    }
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.agentStatusOscProcessorsByPtyId.delete(ptyId)
    this.disposeHeadlessTerminal(ptyId)
  }

  /** Record one derived side-effect fact: batched per chunk while applying
   *  bytes, emitted immediately for between-chunk facts (stale-title timer). */
  private recordTerminalSideEffectFact(ptyId: string, fact: TerminalSideEffectFact): void {
    if (!this.terminalSideEffectConsumerAvailable) {
      return
    }
    const entry = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (entry?.applyingChunk) {
      entry.pendingFacts.push(fact)
      return
    }
    this.emitTerminalSideEffectBatch(ptyId, [fact])
  }

  private emitTerminalSideEffectBatch(
    ptyId: string,
    facts: TerminalSideEffectFact[],
    options: { replay?: boolean } = {}
  ): void {
    if (!this.terminalSideEffectConsumerAvailable || facts.length === 0) {
      return
    }
    const batch: TerminalSideEffectBatch = {
      ptyId,
      seq: this.ptyOutputSequenceById.get(ptyId) ?? 0,
      facts,
      ...(options.replay ? { replay: true } : {}),
      ...this.resolveTerminalSideEffectAttribution(ptyId)
    }
    if (this.terminalSideEffectLocalConsumerAvailable) {
      try {
        this.onTerminalSideEffects?.(batch)
      } catch (err) {
        console.error('[runtime] terminal side-effect listener threw', { ptyId, err })
      }
    }
    if (this.countTerminalSideEffectConsumingClientEventListeners() > 0) {
      this.emitClientEvent({ type: 'terminalSideEffects', batch })
    }
  }

  /** Same attribution resolution as emitTerminalAgentStatusEvents: prefer the
   *  first mounted leaf, fall back to the spawn-time PTY record binding. */
  private resolveTerminalSideEffectAttribution(ptyId: string): {
    worktreeId?: string
    tabId?: string
    paneKey?: string
    connectionId?: string | null
  } {
    const pty = this.ptysById.get(ptyId)
    const connectionId = pty?.connectionId ?? null
    for (const leaf of this.getLeavesForPty(ptyId)) {
      return {
        worktreeId: leaf.worktreeId,
        tabId: leaf.tabId,
        paneKey: this.makeRuntimePaneKey(leaf),
        connectionId
      }
    }
    if (pty?.paneKey) {
      return {
        worktreeId: pty.worktreeId,
        ...(pty.tabId ? { tabId: pty.tabId } : {}),
        paneKey: pty.paneKey,
        connectionId
      }
    }
    return {}
  }

  /** Title-only replay batch for renderer (re)attach — the no-attention-replay
   *  rule: snapshots restore title state, never historical bells/completions. */
  getTerminalSideEffectSnapshot(ptyId: string): TerminalSideEffectBatch | null {
    const tracker = this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker
    const recordTitle = this.ptysById.get(ptyId)?.lastOscTitle
    const normalizedTitle = tracker?.getLastNormalizedTitle() ?? null
    // Why: a record-fallback snapshot must not replay the bare cursor-agent literal over a
    // tracker title Orca synthesized from hooks — but with no tracker title it is the pane's
    // only Cursor identity, so restored/mobile tabs keep it (#10258).
    const rawTitle =
      recordTitle && (normalizedTitle === null || !isCursorNativeAgentTitle(recordTitle))
        ? recordTitle
        : null
    if (normalizedTitle === null && !rawTitle) {
      return null
    }
    return {
      ptyId,
      seq: this.ptyOutputSequenceById.get(ptyId) ?? 0,
      replay: true,
      facts: [
        {
          kind: 'title',
          normalizedTitle: normalizedTitle ?? normalizeTerminalTitle(rawTitle!),
          rawTitle: rawTitle ?? normalizedTitle!
        }
      ],
      ...this.resolveTerminalSideEffectAttribution(ptyId)
    }
  }

  /** Raw last title from main's tracked PTY/leaf records — the title surface
   *  the tracker (live bytes + synthetic frames) keeps current. */
  private getTrackedRawTitleForPty(ptyId: string): string | null {
    const recordTitle = this.ptysById.get(ptyId)?.lastOscTitle
    if (recordTitle) {
      return recordTitle
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      if (leaf.lastOscTitle) {
        return leaf.lastOscTitle
      }
    }
    return null
  }

  private isLiveCursorNativeTitle(rawTitle: string, meta?: TerminalTitleFactMeta): boolean {
    return isCursorNativeAgentTitle(rawTitle) && meta?.staleWorkingTitleClear !== true
  }

  /** Display fallback for identities intentionally omitted from liveness records. */
  private getTrackedDisplayTitleForPty(ptyId: string): string | null {
    return (
      this.getTrackedRawTitleForPty(ptyId) ??
      this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.getLastNormalizedTitle() ??
      null
    )
  }

  private getUnpersistedTrackedTitleForPty(ptyId: string | null): string | null {
    if (!ptyId || this.getTrackedRawTitleForPty(ptyId) !== null) {
      return null
    }
    // Why: a manual title is authoritative until explicitly cleared with null.
    const pty = this.ptysById.get(ptyId)
    if (pty && pty.title !== null) {
      return null
    }
    return this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.getLastNormalizedTitle() ?? null
  }

  /** Why: synthetic agent title frames no longer ride pty:data, so neither
   *  renderer xterm nor the headless emulator observes them. Mobile-parity
   *  snapshot titles must prefer main's tracker over snapshot lastTitle, or
   *  hook-driven spinner/idle titles vanish from mobile tabs. */
  private preferTrackedLastTitle<T extends { lastTitle?: string }>(ptyId: string, snapshot: T): T {
    const tracked = this.getTrackedDisplayTitleForPty(ptyId)
    if (!tracked) {
      return snapshot
    }
    return { ...snapshot, lastTitle: tracked }
  }

  /** Decorative comparison key: only recognized agent titles fold leading spinner frames. */
  private makeDecorativeTitleGateKey(rawTitle: string, normalizedTitle: string): string {
    // Stable Pi/Gemini/Grok display normalization also defines their semantic gate.
    const normalizedSignature =
      rawTitle === normalizedTitle ? null : getDecorativeAgentTitleSignature(normalizedTitle)
    const signature = normalizedSignature ?? getDecorativeAgentTitleSignature(rawTitle)
    return signature === null ? `literal\u0000${normalizedTitle}` : `agent\u0000${signature}`
  }

  private getOrCreatePtyTitleTrackerEntry(ptyId: string): RuntimePtyTitleTrackerEntry {
    const existing = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (existing) {
      return existing
    }
    // Why: trackers are created lazily on the first observed chunk. After an
    // app relaunch the PTY/leaf records can already hold a persisted title; a
    // cold tracker would miss the parked working→idle completion and never
    // arm the stale-title timer for a persisted 'working' title.
    let initialTitle = this.ptysById.get(ptyId)?.lastOscTitle ?? null
    if (initialTitle === null) {
      for (const leaf of this.getLeavesForPty(ptyId)) {
        if (leaf.lastOscTitle) {
          initialTitle = leaf.lastOscTitle
          break
        }
      }
    }
    const tracker = createTerminalTitleTracker(
      {
        onTitle: (normalizedTitle, rawTitle, meta) => {
          this.recordTerminalSideEffectFact(ptyId, {
            kind: 'title',
            normalizedTitle,
            rawTitle,
            ...(meta?.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : {})
          })
          const changed = this.applyTrackedPtyTitle(ptyId, rawTitle, normalizedTitle, meta)
          const identityOnlyTitle = this.isLiveCursorNativeTitle(rawTitle, meta)
          const live = this.ptyTitleTrackersByPtyId.get(ptyId)
          const gateKey = this.makeDecorativeTitleGateKey(rawTitle, normalizedTitle)
          const decorativeOnly = live?.lastMobileTitleGateKey === gateKey
          if (live) {
            live.lastMobileTitleGateKey = gateKey
          }
          const tracksReplicatedStatus =
            live?.applyingChunk === true && this.mobileSessionTabListeners.size > 0
          const titleStatus = tracksReplicatedStatus ? detectAgentStatusFromTitle(rawTitle) : null
          if (
            tracksReplicatedStatus &&
            decorativeOnly &&
            !this.ptyForegroundAgent.hasDelayedSnapshot(ptyId) &&
            (titleStatus === 'working' || titleStatus === 'permission')
          ) {
            // Normalized Pi/Gemini/Grok frames still renew the replicated status lease.
            this.mobileSessionTabsAgentStatusHeartbeat.scheduleDecorativeHeartbeat(ptyId)
          }
          // Why: an identity-only cursor title records nothing, but the tracker
          // title is that pane's only Cursor identity and must still fan out (#10258).
          if (!changed && !identityOnlyTitle) {
            return
          }
          if (live?.applyingChunk) {
            // Why: synthetic spinner ticks change only the braille glyph
            // ~12.5x/sec; fanning out full mobile session snapshots per frame
            // is pure churn. Raw lastOscTitle updates above stay cheap.
            if (!decorativeOnly) {
              this.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
              live.chunkTouchedSessionTabs = true
            }
          } else {
            // Stale-working-title timer path — fires between chunks, so the
            // per-chunk batching in onPtyData cannot pick it up.
            this.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
            this.touchMobileSessionSnapshotsForPty(ptyId)
          }
        },
        // Why: agent transitions and bells become pty:sideEffect facts —
        // main is the single byte parser for local/SSH PTYs; the renderer
        // store handler decides what the facts mean (notification policy).
        onAgentBecameWorking: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-working' })
        },
        onAgentBecameIdle: (title, meta) => {
          this.recordTerminalSideEffectFact(ptyId, {
            kind: 'agent-idle',
            title,
            ...(meta?.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : {})
          })
        },
        onAgentExited: () => {
          this.confirmPtyAgentExit(ptyId)
        },
        onCommandFinished: (exitCode: number | null) => {
          this.retirePtyAgentLaunchAuthority(ptyId)
          this.recordTerminalSideEffectFact(ptyId, { kind: 'command-finished', exitCode })
        },
        onBell: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'bell' })
        },
        onPrLink: (link: TerminalGitHubPRLink) => {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'pr-link', link })
        },
        // Why: hidden-delivery-gated views never see 2031 bytes; facts keep their theme registry truthful.
        onMode2031Subscribe: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: '2031-subscribe' })
        },
        onMode2031Unsubscribe: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: '2031-unsubscribe' })
        }
      },
      initialTitle !== null ? { initialTitle } : {}
    )
    tracker.setTransientSideEffectScanningEnabled(this.terminalSideEffectConsumerAvailable)
    const entry: RuntimePtyTitleTrackerEntry = {
      tracker,
      applyingChunk: false,
      lastMobileTitleGateKey: null,
      chunkTouchedSessionTabs: false,
      pendingFacts: [],
      // Why: command-code facts exist only for the pty:sideEffect channel —
      // headless serve skips the per-chunk scrape entirely. The detector
      // self-arms on the Command Code banner; the spawn command (when main
      // saw one) mirrors the renderer detector's startupCommand fast-arm.
      commandCodeDetector: this.terminalSideEffectConsumerAvailable
        ? this.createTerminalSideEffectCommandCodeDetector(ptyId)
        : null
    }
    this.ptyTitleTrackersByPtyId.set(ptyId, entry)
    return entry
  }

  /** Apply one observed OSC title (raw form) to the PTY and leaf records.
   *  Returns true when the PTY record's title or status changed. */
  private applyTrackedPtyTitle(
    ptyId: string,
    rawTitle: string,
    normalizedTitle: string,
    meta?: TerminalTitleFactMeta
  ): boolean {
    // Why: status is detected from the RAW title (mirrors the renderer tracker),
    // so working/idle transitions are unaffected by normalization; the records
    // store the NORMALIZED title so rotating Grok/Pi/Gemini frames collapse to
    // one stable stored label (#7880) instead of churning `ps`/mobile tabs.
    //
    // Why the identity-only case: the bare cursor-agent literal identifies the pane without
    // asserting activity, so it records NO title/status evidence — only the tracker keeps it,
    // for display (#10258). Nulling the status here rather than trusting the detector keeps
    // that contract local, since every activity-gated effect below is keyed on status.
    const identityOnlyTitle = this.isLiveCursorNativeTitle(rawTitle, meta)
    const recordedTitle = identityOnlyTitle ? null : normalizedTitle
    const agentStatus = identityOnlyTitle ? null : detectAgentStatusFromTitle(rawTitle)
    let ptyRecordChanged = false
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      const prevStatus = pty.lastAgentStatus
      const prevTitle = pty.lastOscTitle
      const observedAt = this.nextTitleObservationSequence()
      const observedAtEpochMs = identityOnlyTitle ? null : Date.now()
      pty.lastOscTitle = recordedTitle
      pty.lastOscTitleAt = identityOnlyTitle ? null : observedAt
      pty.lastOscTitleEpochMs = observedAtEpochMs
      pty.lastAgentStatus = agentStatus
      pty.lastAgentStatusObservedLive = true
      if (prevStatus !== agentStatus) {
        pty.lastAgentStatusStartedAtEpochMs = observedAtEpochMs
      }
      if (
        identityOnlyTitle ||
        terminalTitleBlocksExplicitAgentStatus(recordedTitle) ||
        (prevStatus !== null && agentStatus !== null && prevStatus !== agentStatus)
      ) {
        pty.lastAgentStatusRichInvalidatedAtEpochMs = observedAtEpochMs ?? Date.now()
      }
      if (identityOnlyTitle) {
        pty.managementTitle = null
        pty.managementTitleAt = null
      } else {
        this.setPtyManagementTitleFromObservedTitle(pty, normalizedTitle, observedAt)
      }
      ptyRecordChanged = prevTitle !== recordedTitle || prevStatus !== agentStatus
      if (agentStatus === 'idle' && prevStatus !== 'idle') {
        this.resolvePtyTuiIdleWaiters(pty, ptyId)
      }
      const shouldDelayMobileSnapshot =
        ptyRecordChanged &&
        this.shouldDelayPtyBackedMobileSnapshotForForegroundAgent(pty, normalizedTitle)
      let foregroundRefresh: Promise<boolean> | undefined
      // Why: gate on an actual status transition — braille spinner frames
      // mutate the title every tick, so probing per-title-change would stream
      // a foreground query per frame during active work.
      if (prevStatus !== agentStatus) {
        foregroundRefresh = this.ptyForegroundAgent.refresh(ptyId, observedAt)
      } else if (shouldDelayMobileSnapshot) {
        // Why: same-status compatible title changes can arrive before the
        // foreground owner probe settles; publishing them would flicker.
        foregroundRefresh = this.getPendingForegroundAgentRefreshForTitle(ptyId, observedAt)
      }
      if (foregroundRefresh && shouldDelayMobileSnapshot) {
        // Why: report "unchanged" so the per-chunk batch skips the mobile
        // snapshot fan-out; the delayed publish fires when the probe settles.
        ptyRecordChanged = false
        this.delayPtyBackedMobileSnapshotForForegroundAgent(ptyId, observedAt, foregroundRefresh)
      }
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      // Why: keep the latest OSC title on the leaf so worktree.ps can
      // recompute status from the live title each call. Without this,
      // daemon-hosted terminals (no renderer pushing pane titles) had no
      // way to clear a stale 'working' status after the agent exited and
      // the shell took over the title — the stuck-spinner bug in #1437.
      const prevStatus = leaf.lastAgentStatus
      const prevObservedLive = leaf.lastAgentStatusObservedLive
      leaf.lastOscTitle = recordedTitle
      leaf.lastOscTitleAt = identityOnlyTitle ? null : this.nextTitleObservationSequence()
      // Why: when a new OSC title doesn't classify as an agent state (e.g.
      // bare shell title after the agent exits), clear lastAgentStatus so
      // it is no longer sticky. Tui-idle waiters that needed the previous
      // 'idle' transition were already resolved at the moment of the
      // transition below; only fresh waiters registered after the agent
      // exits would observe the cleared value, and they correctly fall
      // back to title-based detection / polling.
      leaf.lastAgentStatus = agentStatus
      leaf.lastAgentStatusObservedLive = true
      // Why: resolve tui-idle on any transition TO idle (not just working→idle).
      // Claude Code may skip "working" entirely on fast tasks, going null→idle,
      // and the coordinator's tui-idle waiter would hang forever waiting for a
      // working→idle transition that never comes. Permission→idle is excluded:
      // it means the agent was blocked on user approval and the user said no,
      // which isn't a task-completion signal.
      if (agentStatus === 'idle' && prevStatus !== 'idle') {
        this.resolveTuiIdleWaiters(leaf)
      }
      // Why the second condition: push delivery is gated on LIVE idle, so its
      // authorizing edge is liveness as well as status. A restore seed or a
      // status kept across a same-id respawn leaves a stale 'idle' behind, and
      // an agent whose first live title is already idle (claude --resume at its
      // prompt) then shows no transition — the row would strand, which is
      // exactly #12536. Waiter semantics stay transition-only above.
      if (agentStatus === 'idle' && (prevStatus !== 'idle' || !prevObservedLive)) {
        this.deliverPendingMessagesForLeaf(leaf)
      }
    }
    return ptyRecordChanged
  }

  /** Cancel the per-PTY title tracker (stale-title timer included) on PTY
   *  teardown so it cannot fire into pruned records. */
  private disposePtyTitleTracker(ptyId: string): void {
    this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.dispose()
    this.ptyTitleTrackersByPtyId.delete(ptyId)
    this.ptyForegroundAgent.clearDelayedSnapshot(ptyId)
    this.mobileSessionTabsAgentStatusHeartbeat.removePty(ptyId)
    this.clientEvents.clearPtyTitleGate(ptyId)
  }

  private resetTrackedTerminalStateForProviderGeneration(ptyId: string): void {
    // Why: a replacement daemon session can reuse the PTY id, but title/parser
    // state from the prior process must not bleed into its snapshots or chunks.
    this.disposePtyTitleTracker(ptyId)
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.agentStatusOscProcessorsByPtyId.delete(ptyId)
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      pty.lastOscTitle = null
      pty.lastOscTitleAt = null
      pty.lastOscTitleEpochMs = null
      pty.lastAgentStatus = null
      // Why: the prior process's live frames say nothing about the replacement,
      // so the seed a same-id restore applies must not inherit its authority.
      pty.lastAgentStatusObservedLive = false
      pty.lastAgentStatusStartedAtEpochMs = null
      pty.lastAgentStatusRichInvalidatedAtEpochMs = Date.now()
      pty.managementTitle = null
      pty.managementTitleAt = null
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.lastOscTitle = null
      leaf.lastOscTitleAt = null
      leaf.lastAgentStatus = null
      leaf.lastAgentStatusObservedLive = false
    }
    this.clearAgentRowSnapshotsForPty(ptyId)
  }

  private setTerminalSideEffectConsumerAvailable(available: boolean): void {
    this.terminalSideEffectLocalConsumerAvailable = available && this.onTerminalSideEffects !== null
    this.refreshTerminalSideEffectConsumerAvailability()
  }

  private refreshTerminalSideEffectConsumerAvailability(): void {
    const nextAvailable =
      this.terminalSideEffectLocalConsumerAvailable ||
      this.countTerminalSideEffectConsumingClientEventListeners() > 0
    if (nextAvailable === this.terminalSideEffectConsumerAvailable) {
      return
    }
    this.terminalSideEffectConsumerAvailable = nextAvailable
    for (const [ptyId, entry] of this.ptyTitleTrackersByPtyId) {
      entry.tracker.setTransientSideEffectScanningEnabled(nextAvailable)
      entry.commandCodeDetector = nextAvailable
        ? this.createTerminalSideEffectCommandCodeDetector(ptyId)
        : null
    }
  }

  private createTerminalSideEffectCommandCodeDetector(
    ptyId: string
  ): NonNullable<RuntimePtyTitleTrackerEntry['commandCodeDetector']> {
    return createCommandCodeOutputStatusDetector({
      startupCommand: this.terminalSpawnCommandsByPtyId.get(ptyId) ?? null,
      onWorking: (prompt) => {
        this.recordTerminalSideEffectFact(ptyId, { kind: 'command-code-working', prompt })
      },
      onDone: (prompt) => {
        this.recordTerminalSideEffectFact(ptyId, { kind: 'command-code-done', prompt })
      }
    })
  }

  private extractLastOsc7CwdForPty(
    ptyId: string,
    data: string
  ): { path: string; hostname: string } | null {
    const previousTail = this.osc7ScanTailByPtyId.get(ptyId)
    if (!previousTail && !data.includes('\x1b]7;')) {
      return null
    }
    const input = `${previousTail ?? ''}${data}`
    const scanTail = extractOscScanTail(input, 4096)
    if (scanTail.length > 0) {
      this.osc7ScanTailByPtyId.set(ptyId, scanTail)
    } else {
      this.osc7ScanTailByPtyId.delete(ptyId)
    }
    const uri = extractLastOsc7Uri(input)
    const pty = this.ptysById.get(ptyId)
    const pathFlavor = this.pathFlavorForPty(pty)
    return uri
      ? parseFileUriPathParts(uri, {
          pathFlavor,
          remotePosixAuthority: !!pty?.connectionId && pathFlavor !== 'win32',
          wslDistro: pty?.connectionId
            ? undefined
            : (this.wslDistroByPtyId.get(ptyId) ?? pty?.wslDistro ?? undefined)
        })
      : null
  }

  private recordOsc7MetadataForPty(
    ptyId: string,
    data: string
  ): { cwd: string | null; cwdChanged: boolean } {
    const osc7 = this.extractLastOsc7CwdForPty(ptyId, data)
    const cwd = osc7?.path ?? null
    const cwdChanged =
      cwd !== null && cwd.trim().length > 0 && this.terminalCwdByPtyId.get(ptyId) !== cwd
    if (cwdChanged) {
      this.terminalCwdByPtyId.set(ptyId, cwd)
    }
    if (osc7) {
      if (osc7.hostname) {
        this.terminalFileUriHostnameByPtyId.set(ptyId, osc7.hostname)
      } else {
        this.terminalFileUriHostnameByPtyId.delete(ptyId)
      }
    }
    return { cwd, cwdChanged }
  }

  private pathFlavorForPty(pty?: RuntimePtyWorktreeRecord | null): 'posix' | 'win32' {
    if (!pty?.connectionId) {
      return process.platform === 'win32' ? 'win32' : 'posix'
    }
    const worktreePath = splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath
    return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'posix'
  }

  /** Returns true when any retained agent-row snapshot changed in a
   *  client-visible way, so the caller can republish session snapshots. */
  private emitTerminalAgentStatusEvents(ptyId: string, chunk: ProcessedAgentStatusChunk): boolean {
    // Why: snapshot retention (for mobile worktree.ps) must run even when no
    // renderer listener is attached, so we don't early-return on a missing
    // onTerminalAgentStatus — only the per-target emit below is gated on it.
    if (chunk.payloads.length === 0) {
      return false
    }
    const targets = new Map<
      string,
      {
        source: 'mounted-leaf' | 'pty-record'
        paneKey: string
        tabId?: string
        worktreeId?: string
        connectionId?: string | null
      }
    >()
    const pty = this.ptysById.get(ptyId)
    const connectionId = pty?.connectionId ?? null
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const paneKey = this.makeRuntimePaneKey(leaf)
      targets.set(paneKey, {
        source: 'mounted-leaf',
        paneKey,
        tabId: leaf.tabId,
        worktreeId: leaf.worktreeId,
        connectionId
      })
    }
    if (targets.size === 0 && pty?.paneKey) {
      targets.set(pty.paneKey, {
        source: 'pty-record',
        paneKey: pty.paneKey,
        tabId: pty.tabId ?? undefined,
        worktreeId: pty.worktreeId,
        connectionId
      })
    }
    let retainedChanged = false
    for (const payload of chunk.payloads) {
      for (const target of targets.values()) {
        retainedChanged =
          this.retainAgentRowSnapshot(
            ptyId,
            target.paneKey,
            target.worktreeId,
            target.tabId,
            target.connectionId ?? null,
            payload
          ) || retainedChanged
        if (!this.onTerminalAgentStatus) {
          continue
        }
        try {
          this.onTerminalAgentStatus({
            ptyId,
            ...target,
            payload
          })
        } catch (err) {
          console.error('[runtime] terminal agent status listener threw', {
            ptyId,
            paneKey: target.paneKey,
            state: payload.state,
            agentType: payload.agentType,
            err
          })
        }
      }
    }
    return retainedChanged
  }

  private retainAgentRowSnapshot(
    ptyId: string,
    paneKey: string,
    worktreeId: string | undefined,
    tabId: string | undefined,
    connectionId: string | null,
    payload: ParsedAgentStatusPayload
  ): boolean {
    return this.agentRows.retain({
      ptyId,
      paneKey,
      worktreeId,
      tabId,
      connectionId,
      payload
    })
  }

  private clearAgentRowSnapshotsForPty(ptyId: string): void {
    this.agentRows.clearPty(ptyId)
  }

  getPtyOutputSequence(ptyId: string): number {
    return this.ptyOutputSequenceById.get(ptyId) ?? 0
  }

  private getPtyLifecycleGeneration(ptyId: string): number {
    const existing = this.ptyLifecycleGenerationById.get(ptyId)
    if (existing !== undefined) {
      return existing
    }
    const generation = this.nextPtyLifecycleGeneration++
    this.ptyLifecycleGenerationById.set(ptyId, generation)
    return generation
  }

  private advancePtyLifecycleGeneration(ptyId: string): void {
    this.ptyLifecycleGenerationById.set(ptyId, this.nextPtyLifecycleGeneration++)
    this.legacyWorkerRecovery.deleteRecoveredPty(ptyId)
    // Why: a respawn under the same session id needs its own subscriber-driven attach.
    this.terminalViewSubscribers.resetGeneration(ptyId)
    // Why: a provider response belongs to the process generation that issued
    // it; a respawn must neither reuse its frame nor join its in-flight call.
    this.providerBufferAcquisitionsByPtyId.delete(ptyId)
    this.providerVisibleStateByPtyId.delete(ptyId)
    this.providerVisibleRetryAtByPtyId.delete(ptyId)
  }

  synchronizePtyOutputSequenceFromProvider(
    ptyId: string,
    providerSequence: { value: number; generation: 'continued' | 'reset' },
    runtimeSequenceAtSpawnStart = 0
  ): number {
    if (
      !Number.isFinite(providerSequence.value) ||
      providerSequence.value < 0 ||
      !Number.isFinite(runtimeSequenceAtSpawnStart) ||
      runtimeSequenceAtSpawnStart < 0
    ) {
      return this.getPtyOutputSequence(ptyId)
    }
    const baseline = Math.floor(providerSequence.value)
    const currentSequence = this.getPtyOutputSequence(ptyId)
    const sequenceAtSpawnStart = Math.min(currentSequence, Math.floor(runtimeSequenceAtSpawnStart))
    const postSpawnSequence = currentSequence - sequenceAtSpawnStart
    const wasInitialized = this.providerSequenceInitializedPtys.has(ptyId)
    const replacesExistingRuntimeGeneration = wasInitialized || sequenceAtSpawnStart > 0
    const providerOffset =
      providerSequence.generation === 'reset'
        ? sequenceAtSpawnStart
        : (this.providerSequenceOffsetByPtyId.get(ptyId) ?? 0)
    const providerBaseline = providerOffset + baseline

    if (providerSequence.generation === 'reset') {
      this.advancePtyLifecycleGeneration(ptyId)
      // Why: daemon respawn/cold restore starts a new absolute domain. Old
      // emulator state cannot remain authoritative over the replacement.
      if (replacesExistingRuntimeGeneration) {
        this.disposeHeadlessTerminal(ptyId)
      }
      this.providerModeTrackersByPtyId.delete(ptyId)
      this.wslDistroByPtyId.delete(ptyId)
      this.terminalCwdByPtyId.delete(ptyId)
      this.terminalFileUriHostnameByPtyId.delete(ptyId)
      const pty = this.ptysById.get(ptyId)
      if (pty) {
        pty.wslDistro = null
      }
      if (replacesExistingRuntimeGeneration && postSpawnSequence === 0) {
        this.resetTrackedTerminalStateForProviderGeneration(ptyId)
      }
    }

    const synchronizedSequence =
      providerSequence.generation === 'reset'
        ? currentSequence
        : wasInitialized
          ? currentSequence
          : providerBaseline + postSpawnSequence
    this.ptyOutputSequenceById.set(ptyId, synchronizedSequence)
    this.providerSequenceInitializedPtys.add(ptyId)
    this.providerSequenceOffsetByPtyId.set(ptyId, providerOffset)

    const snapshotMayCoverMissingState =
      (providerSequence.generation === 'continued' && !wasInitialized) ||
      (postSpawnSequence > 0 &&
        providerSequence.generation === 'reset' &&
        replacesExistingRuntimeGeneration) ||
      (providerSequence.generation === 'continued' &&
        wasInitialized &&
        providerBaseline > currentSequence)
    if (snapshotMayCoverMissingState) {
      // Why: bytes can cross the control/stream sockets around attach. Until a
      // full renderer/provider snapshot is available, a partial model is unsafe.
      this.providerSnapshotPreferredPtys.add(ptyId)
    } else if (providerSequence.generation === 'reset') {
      this.providerSnapshotPreferredPtys.delete(ptyId)
    }

    const headless = this.headlessTerminals.get(ptyId)
    if (headless && !wasInitialized && providerSequence.generation === 'continued') {
      // Why: daemon bytes can reach main just before spawn resolves. Queue the
      // baseline behind those writes so their emulator sequence is rebased too.
      headless.writeChain = headless.writeChain.then(() => {
        headless.outputSequence = synchronizedSequence
      })
    }
    return synchronizedSequence
  }

  subscribeToTerminalData(
    ptyId: string,
    listener: (data: string, meta?: RuntimeTerminalDataMeta) => void
  ): () => void {
    return this.terminalStreamConsumers.subscribe(ptyId, listener)
  }

  setRemoteTerminalSourceRangeConsumerHooks(
    hooks: RemoteTerminalSourceRangeConsumerHooks | null
  ): void {
    this.terminalStreamConsumers.setSourceRangeHooks(hooks)
  }

  attachRemoteTerminalSourceRangeConsumer(
    identity: RemoteTerminalSourceRangeStreamIdentity
  ): boolean {
    return this.terminalStreamConsumers.attachSourceRangeConsumer(identity)
  }

  settleRemoteTerminalSourceRanges(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[]
  ): void {
    this.terminalStreamConsumers.settleSourceRanges(identity, ranges)
  }

  reserveRemoteTerminalSourceRangeReplacement(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    requiredSeq: number,
    reason: string
  ): RemoteTerminalSourceRangeReplacementReservation | null {
    return this.terminalStreamConsumers.reserveSourceRangeReplacement(identity, requiredSeq, reason)
  }

  commitRemoteTerminalSourceRangeReplacement(
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    publication: RemoteTerminalSourceRangeReplacementPublication
  ): boolean {
    return this.terminalStreamConsumers.commitSourceRangeReplacement(reservation, publication)
  }

  rollbackRemoteTerminalSourceRangeReplacement(
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    reason: string
  ): boolean {
    return this.terminalStreamConsumers.rollbackSourceRangeReplacement(reservation, reason)
  }

  cancelRemoteTerminalSourceRanges(
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[],
    reason: string
  ): void {
    this.terminalStreamConsumers.cancelSourceRanges(identity, ranges, reason)
  }

  /** Set by pty IPC: fires when a PTY gains/loses remote view subscribers so
   *  the daemon background mark (keep-tail stream thinning) can resync — a
   *  live mobile/web view consumes raw bytes and must never be thinned, even
   *  while the desktop pane is hidden. */
  onRemoteTerminalViewPresenceChanged: ((ptyId: string) => void) | null = null

  private notifyRemoteTerminalViewPresenceChanged(ptyId: string): void {
    try {
      this.onRemoteTerminalViewPresenceChanged?.(ptyId)
    } catch (err) {
      console.error('[runtime] remote view presence listener threw', { ptyId, err })
    }
  }

  /** Registered by terminal-RPC subscribe/multiplex streams: while a remote
   *  view subscriber is attached its xterm answers queries with view
   *  authority and the model responder must stay silent. Returns an
   *  idempotent release. */
  registerRemoteTerminalViewSubscriber(ptyId: string): () => void {
    return this.terminalViewSubscribers.registerRemote(ptyId)
  }

  /** A local daemon session main knows is live but has never ingested a byte
   *  from — i.e. no pane ever attached it, so the daemon is not emitting.
   *  Headless state exists only after the first ingested byte; a snapshot
   *  reconcile in flight implies a spawn-path attach already happened. */
  private isKnownUnattachedLocalDaemonPty(ptyId: string): boolean {
    return this.terminalViewSubscribers.isKnownUnattachedLocal(ptyId)
  }

  private reconcileSubscriberDrivenProviderAttach(ptyId: string): void {
    this.terminalViewSubscribers.reconcileProviderAttach(ptyId)
  }

  /** Mark a raw-output viewer without transferring terminal query authority. */
  registerRawTerminalViewSubscriber(ptyId: string): () => void {
    return this.terminalViewSubscribers.registerRaw(ptyId)
  }

  /** Raw stream presence prevents provider thinning without changing reply ownership. */
  hasRawTerminalViewSubscriber(ptyId: string): boolean {
    return this.terminalViewSubscribers.hasRaw(ptyId)
  }

  hasRemoteTerminalViewSubscriber(ptyId: string): boolean {
    return this.terminalViewSubscribers.hasRemote(ptyId)
  }

  isMobileTerminalQueryReplyAuthority(ptyId: string, clientId: string): boolean {
    // Why: a passive phone watching desktop-sized output must not race the
    // desktop xterm. Mobile becomes reply authority only with the mobile floor.
    if (this.getDriver(ptyId).kind !== 'mobile') {
      return false
    }
    const subscribers = this.mobileSubscribers.get(ptyId)
    if (!subscribers) {
      return false
    }
    // Why: soft-leave resubscribe preserves the original subscription time but
    // reinserts the record. Elect fitted responders from that stable age, not
    // mutable Map order or passive desktop-mode watchers.
    let earliest: { clientId: string; subscribedAt: number } | null = null
    for (const subscriber of subscribers.values()) {
      if (!subscriber.wasResizedToPhone) {
        continue
      }
      if (earliest === null || subscriber.subscribedAt < earliest.subscribedAt) {
        earliest = subscriber
      }
    }
    return earliest?.clientId === clientId
  }

  subscribeToFitOverrideChanges(
    ptyId: string,
    listener: (event: {
      mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
      cols: number
      rows: number
    }) => void
  ): () => void {
    return addListenerToMap(this.fitOverrideListeners, ptyId, listener)
  }

  subscribeToDriverChanges(ptyId: string, listener: (driver: DriverState) => void): () => void {
    return this.terminalDrivers.subscribe(ptyId, listener)
  }

  private notifyFitOverrideListeners(
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ): void {
    const listeners = this.fitOverrideListeners.get(ptyId)
    if (!listeners) {
      return
    }
    notifyRuntimeListeners(listeners, (listener) => listener({ mode, cols, rows }), 'fit-override')
  }

  serializeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<RuntimeTerminalBufferSnapshot | null> {
    return this.serializeTerminalBufferFromAvailableState(ptyId, opts)
  }

  async serializeAuthoritativeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<RuntimeTerminalBufferSnapshot | null> {
    const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts, {
      timeoutMs: AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
      retireOnTimeout: true
    })
    if (providerSnapshot) {
      return providerSnapshot
    }
    return this.serializeTerminalBufferFromAvailableState(ptyId, opts)
  }

  /** Raw keystroke pass-through for the pop-out dashboard's terminal preview.
   *  Honors the mobile-presence lock like the main window's pty:write path. */
  async writeTerminalPreviewInput(ptyId: string, data: string): Promise<boolean> {
    if (data.length === 0 || this.getDriver(ptyId).kind === 'mobile') {
      return false
    }
    try {
      await assertTerminalInputWithinLimitWithYield(data)
      await this.writeTerminalInputChunks(ptyId, data, {
        // Why: a phone can claim the floor while a paste yields between chunks.
        beforeWrite: () => {
          if (this.getDriver(ptyId).kind === 'mobile') {
            throw new Error('terminal_mobile_driver_active')
          }
        }
      })
      return true
    } catch {
      return false
    }
  }

  hasHeadlessTerminalState(ptyId: string): boolean {
    return this.headlessTerminals.has(ptyId)
  }

  serializeMainTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    terminalOwner?: 'shell'
  } | null> {
    return this.serializeHeadlessTerminalBuffer(ptyId, { ...opts, includeEmpty: true })
  }

  async serializeHiddenOutputRecoveryBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    pendingEscapeTailAnsi?: string
    terminalOwner?: 'shell'
  } | null> {
    const headlessSnapshot = await this.serializeHeadlessTerminalBuffer(ptyId, {
      ...opts,
      includeEmpty: true
    })
    if (headlessSnapshot) {
      return headlessSnapshot
    }
    // Why: hidden-output recovery is initiated by the desktop renderer. If the
    // runtime has not built headless state yet, the mounted xterm is still the
    // best available state and avoids a false "snapshot unavailable" result.
    const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
    return rendererSnapshot ?? this.serializeProviderTerminalBuffer(ptyId, opts)
  }

  async clearTerminalBuffer(handle: string): Promise<{ handle: string; cleared: boolean }> {
    const leaf = this.resolveLeafForHandle(handle)
    if (!leaf?.ptyId) {
      throw new Error('terminal_not_found')
    }
    // Why: clear is a terminal UI action (Cmd+K on desktop), not shell input.
    // Route through the controller so renderer-owned xterm buffers, daemon
    // sessions, and SSH relay sessions all drop scrollback before the next
    // mobile snapshot.
    await this.ptyController?.clearBuffer?.(leaf.ptyId)
    await this.clearHeadlessTerminalBuffer(leaf.ptyId)
    return { handle, cleared: true }
  }

  getTerminalSize(ptyId: string): { cols: number; rows: number } | null {
    return this.ptyController?.getSize?.(ptyId) ?? null
  }

  // Why: a width reflow on a normal-buffer PTY must re-stream the full
  // scrollback to mobile so it rewraps at the new cols, but alternate-screen
  // TUIs (vim, Claude Code) own their repaint and have no scrollback — for
  // those the mobile client just resizes xterm geometry and consumes the
  // TUI's own redraw, so the resize re-stream must be skipped. Provider state
  // covers restored PTYs whose main-side emulator is only a partial suffix.
  isTerminalAlternateScreen(ptyId: string): boolean {
    if (this.providerSnapshotPreferredPtys.has(ptyId)) {
      return this.providerModeTrackersByPtyId.get(ptyId)?.isAlternateScreen ?? false
    }
    return (
      this.headlessTerminals.get(ptyId)?.emulator.isAlternateScreen ??
      this.providerModeTrackersByPtyId.get(ptyId)?.isAlternateScreen ??
      false
    )
  }

  // Why: daemon-backed PTYs that the runtime adopted after an Orca relaunch
  // start with a fresh headless emulator that has zero scrollback, even though
  // the daemon's on-disk checkpoint and the desktop xterm both contain the
  // full prior history. Without this hydration, mobile subscribers see only
  // the bare current prompt because serializeHeadlessTerminalBuffer always
  // wins over the renderer-path fallback. Seeding the emulator with the
  // adapter's snapshot/cold-restore data makes mobile and desktop agree on
  // what scrollback is available.
  seedHeadlessTerminal(
    ptyId: string,
    data: string,
    size?: { cols: number; rows: number },
    metadata: HeadlessSeedMetadata = {}
  ): void {
    if (!data) {
      return
    }
    const existing = this.headlessTerminals.get(ptyId)
    if (existing) {
      // Why: emulator already has live data — re-seeding would duplicate
      // every byte. The seed is only valid when the emulator is fresh.
      if (metadata.preferProviderIfExisting) {
        this.providerSnapshotPreferredPtys.add(ptyId)
      }
      return
    }
    const dims = size ?? this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state = this.createPtyHeadlessTerminalState(ptyId, dims)
    state.outputSequence = this.getPtyOutputSequence(ptyId)
    this.headlessTerminals.set(ptyId, state)
    this.recordOsc7MetadataForPty(ptyId, data)
    this.recordRecentPtyOutputForPathProvenance(ptyId, data)
    state.writeChain = state.writeChain
      .then(async () => {
        // Why: seed writes never set forwardQueryReplies — the main-side
        // replay guard. A snapshot containing old queries must answer no one.
        await state.emulator.write(data)
        // Why AFTER the seed write: the snapshot payload cannot carry kitty
        // pushes (rehydrateSequences deliberately omits them), but ordering
        // behind it keeps the parse deterministic. Unflagged like the seed —
        // re-applying flags must answer no one.
        if (typeof metadata.kittyKeyboardFlags === 'number') {
          await state.emulator.applyKittyKeyboardFlags(metadata.kittyKeyboardFlags)
        }
        if (metadata.cwd !== undefined) {
          state.emulator.setCwd(metadata.cwd)
        }
        if (metadata.oscLinks !== undefined) {
          state.emulator.setRestoredOscLinks(metadata.oscLinks)
        }
        // Why derived from the emulator: the seed bytes bypass ownership.scan,
        // so the scanner must inherit the restored alternate-screen state or a
        // pane seeded mid-TUI never arms its recovery trigger.
        state.ownership.seedOwner(metadata.terminalOwner, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        this.providerSnapshotPreferredPtys.delete(ptyId)
      })
      .catch(() => {
        // Seeding is best-effort; live data will continue to populate the
        // emulator even if the snapshot replay fails.
      })
  }

  // Why: reattach/cold-restore/replay payloads arrive as spawn RPC results and
  // never pass through onPtyData, so after a relaunch the records backing
  // `terminal list`/`terminal read` stayed blank while the session was alive.
  // Seed semantics (applySeededAgentStatus precedent): write state only — no
  // waiters, no orchestration events, and no lastOutputAt, because restored
  // bytes are historical output, not fresh activity.
  seedTerminalRestoreTail(ptyId: string, restore: { text?: string; lastTitle?: string }): void {
    const seed = restore.text ? buildRestoredTerminalTailSeed(restore.text) : null
    if (seed) {
      const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
      // Why: live bytes outrank the seed — only never-written records take it,
      // so a same-run remount reattach cannot re-apply history it already has.
      if (pty && restoredTerminalTailSeedAllowed(pty)) {
        applyRestoredTerminalTailSeed(pty, seed)
        this.primeWaitBlockedBaselineFromSeededTail(ptyId)
      }
      for (const leaf of this.getLeavesForPty(ptyId)) {
        if (restoredTerminalTailSeedAllowed(leaf)) {
          applyRestoredTerminalTailSeed(leaf, seed)
        }
      }
    }
    if (restore.lastTitle) {
      // Why: mirror renderer hydration — a title main already tracked live outranks the payload's persisted one.
      this.applySeededAgentStatus(ptyId, this.getTrackedRawTitleForPty(ptyId) ?? restore.lastTitle)
    }
  }

  // Why: hydrate the runtime headless emulator from the desktop renderer's
  // xterm buffer on the first onPtyData byte after a PTY is taken over by a
  // pane. Eager-state pattern matches seedHeadlessTerminal: headlessTerminals
  // is populated synchronously so concurrent live writes from
  // trackHeadlessTerminalData chain after the seed via the same writeChain.
  // See docs/mobile-prefer-renderer-scrollback.md.
  private maybeHydrateHeadlessFromRenderer(ptyId: string): void {
    if (this.headlessHydrationState.has(ptyId)) {
      return
    }
    const providerSnapshotPreferred = this.providerSnapshotPreferredPtys.has(ptyId)
    if (this.headlessTerminals.has(ptyId) && !providerSnapshotPreferred) {
      // Daemon-snapshot seed already populated the emulator — skip hydration.
      this.headlessHydrationState.set(ptyId, 'done')
      return
    }
    const controller = this.ptyController
    if (!controller?.serializeBuffer || !controller.hasRendererSerializer) {
      return
    }
    if (!controller.hasRendererSerializer(ptyId)) {
      // Renderer hasn't registered yet (or never will). Live writes lazy-
      // create the state via trackHeadlessTerminalData on this same tick.
      return
    }

    if (providerSnapshotPreferred) {
      // Why: a stream byte can create a partial model before restored history
      // arrives. A mounted renderer snapshot can safely replace that model.
      this.disposeHeadlessTerminal(ptyId)
    }

    this.headlessHydrationState.set(ptyId, 'pending')
    const dims = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    // Why: hydration writes below never set forwardQueryReplies (main-side
    // replay guard) — renderer-buffer snapshots can embed stale queries.
    const state = this.createPtyHeadlessTerminalState(ptyId, dims)
    state.outputSequence = this.getPtyOutputSequence(ptyId)
    this.headlessTerminals.set(ptyId, state)

    // Why: append the seed work to writeChain so live writes queued by
    // trackHeadlessTerminalData (after this method returns synchronously)
    // execute AFTER the seed-write resolves. If we awaited inline before
    // setting headlessTerminals, the live byte would lazy-create a separate
    // state and the seed-resolve would overwrite it, dropping live bytes.
    state.writeChain = state.writeChain.then(async () => {
      try {
        const rendered = await controller.serializeBuffer!(ptyId, {
          scrollbackRows: MOBILE_SUBSCRIBE_SCROLLBACK_ROWS,
          altScreenForcesZeroRows: true
        })
        if (!rendered || rendered.data.length === 0) {
          return
        }
        this.recordOsc7MetadataForPty(ptyId, rendered.data)
        this.recordRecentPtyOutputForPathProvenance(ptyId, rendered.data)
        // Resize to renderer's dims so the seed reflows correctly into the
        // emulator's grid, then resize back to PTY dims (if known) so live
        // writes use the correct cell layout.
        if (rendered.cols !== dims.cols || rendered.rows !== dims.rows) {
          state.emulator.resize(rendered.cols, rendered.rows)
        }
        await state.emulator.write(rendered.data)
        const ptyDims = this.getTerminalSize(ptyId)
        if (ptyDims && (ptyDims.cols !== rendered.cols || ptyDims.rows !== rendered.rows)) {
          state.emulator.resize(ptyDims.cols, ptyDims.rows)
        }
        // Why: the renderer xterm no longer sees synthetic hook title frames
        // (they feed main's tracker only), so its serializer lastTitle can be
        // stale here. Prefer main's tracked title; the renderer's is only the
        // seed when main has observed none (fresh relaunch, cold tracker).
        state.ownership.seedOwner(undefined, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        const seedTitle = this.getTrackedRawTitleForPty(ptyId) ?? rendered.lastTitle
        if (seedTitle) {
          state.emulator.setLastTitle(seedTitle)
          this.applySeededAgentStatus(ptyId, seedTitle)
        }
        this.providerSnapshotPreferredPtys.delete(ptyId)
      } catch {
        // Hydration is best-effort. Live writes continue via the same
        // writeChain that this catch-arm leaves intact.
      } finally {
        this.headlessHydrationState.set(ptyId, 'done')
      }
    })
  }

  // Why: seed-derived agent status reflects historical state. Orchestration
  // waiters (resolveTuiIdleWaiters, deliverPendingMessages) must only react
  // to LIVE transitions, so this helper writes leaf.lastAgentStatus only,
  // leaves lastAgentStatusObservedLive untouched, and never resolves waiters.
  // detectAgentStatusFromTitle wrap mirrors the live path so seeded and live
  // values are the same union member, keeping downstream `=== 'idle'` checks
  // correct.
  private applySeededAgentStatus(ptyId: string, title: string): void {
    if (!title) {
      return
    }
    // Why: a relaunched main starts its per-PTY title tracker cold — without
    // this seed it misses the parked working→idle completion and never arms
    // the stale-title timer for a persisted 'working' title. Seeding no-ops
    // once a live title was observed, so live state always wins.
    this.getOrCreatePtyTitleTrackerEntry(ptyId).tracker.seedInitialTitle(title)
    const status = detectAgentStatusFromTitle(title)
    // Why: live observations store normalized titles, so seeds must match —
    // otherwise the first live frame after hydration compares unequal and
    // touches session tabs once for no visible change.
    const seededTitle = normalizeTerminalTitle(title)
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      const observedAt = this.nextTitleObservationSequence()
      pty.lastOscTitle = seededTitle
      pty.lastOscTitleAt = observedAt
      this.setPtyManagementTitleFromObservedTitle(pty, seededTitle, observedAt)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      // Why: seed lastOscTitle even when the seeded title doesn't classify
      // as an agent state, so worktree.ps recomputes status from the live
      // title rather than treating the leaf as agentless.
      leaf.lastOscTitle = seededTitle
      leaf.lastOscTitleAt = this.nextTitleObservationSequence()
      if (status !== null) {
        leaf.lastAgentStatus = status
      }
    }
  }

  /** Per-chunk reply-ownership capture (Phase 5). Evaluated synchronously at
   *  ingestion only — never re-read at reply time. */
  private shouldAnswerQueriesForLiveChunk(ptyId: string): boolean {
    return shouldModelAnswerHiddenPtyQueries({
      ptyId,
      settings: this.store?.getSettings(),
      hasRemoteViewSubscriber: this.hasRemoteTerminalViewSubscriber(ptyId)
    })
  }

  private trackHeadlessTerminalData(
    ptyId: string,
    data: string,
    outputSequence: number,
    forwardQueryReplies = false
  ): Promise<void> {
    const state = this.getOrCreateHeadlessTerminal(ptyId)
    const completion = state.writeChain.then(async () => {
      // Why: the ingestion-time ownership decision is closed over this
      // chain link; async scheduling cannot retroactively change it.
      // Why inside the chain: the ownership mirror must observe live bytes in
      // the same total order as seeds (seedOwner also runs on this chain).
      state.ownership.scan(data)
      await state.emulator.write(data, { forwardQueryReplies })
      state.outputSequence = outputSequence
    })
    // Legacy callers remain best-effort; bounded SSH admission observes the raw receipt.
    state.writeChain = completion.catch(() => {})
    return completion
  }

  /** Shared factory for the per-PTY runtime emulators (seed, hydration, and
   *  lazy live-byte creation): wires the Phase-5 query-reply sink and the
   *  ConPTY DA1 override. The daemon emulator never goes through here. */
  private createPtyHeadlessTerminalState(
    ptyId: string,
    dims: { cols: number; rows: number }
  ): RuntimeHeadlessTerminal {
    let state: RuntimeHeadlessTerminal | null = null
    const pathFlavor = this.pathFlavorForPty(this.ptysById.get(ptyId))
    const emulator = new HeadlessEmulator({
      cols: dims.cols,
      rows: dims.rows,
      pathFlavor,
      remotePosixFileUriAuthority:
        !!this.ptysById.get(ptyId)?.connectionId && pathFlavor !== 'win32',
      wslDistro: this.ptysById.get(ptyId)?.connectionId
        ? undefined
        : (this.wslDistroByPtyId.get(ptyId) ?? this.ptysById.get(ptyId)?.wslDistro ?? undefined),
      // Why: replies take the provider input path (same entry as pty:write —
      // daemon shell-ready gating and the SSH relay write apply unchanged),
      // NOT writePtyInput, so renderer interactive-output metering never
      // counts responder traffic as user-input echo.
      onQueryReply: (reply) => {
        // Why the identity check: queued writeChain links can parse after
        // disposeHeadlessTerminal, and daemon respawns reuse session ids — a
        // stale link's reply must never reach a successor PTY under this id.
        if (state !== null && this.headlessTerminals.get(ptyId) === state) {
          if (
            !shouldForwardHeadlessTerminalQueryReply(this.ptysById.get(ptyId)?.launchAgent, reply)
          ) {
            return
          }
          // Why this write is safe pre-shell-ready: daemon Session.write
          // QUEUES (never drops) input while the POSIX shell-ready gate is
          // pending and flushes at the ready marker or the 15s
          // SHELL_READY_TIMEOUT_MS bound (session.ts) — a spawn-time query
          // reply is delayed at most that bound, not lost.
          this.ptyController?.write(ptyId, reply)
        }
      }
    })
    if (isNativeWindowsConptyPty(ptyId)) {
      emulator.installConptyPrimaryDeviceAttributesOverride()
    }
    // Why the lazy getter: replies must use the freshest renderer push at
    // parse time, and stay silent (never default) before the first push.
    emulator.installViewAttributeResponder(() => getTerminalViewAttributes())
    const viewAttributes = getTerminalViewAttributes()
    if (viewAttributes) {
      emulator.applyPushedViewAttributes(viewAttributes)
    }
    const constructed: RuntimeHeadlessTerminal = {
      emulator,
      outputSequence: 0,
      writeChain: Promise.resolve(),
      ownership: new PtyShellOwnershipMirror(async () => {
        const controller = this.ptyController
        const lifecycleGeneration = this.getPtyLifecycleGeneration(ptyId)
        if (
          !controller?.confirmShellForeground ||
          this.headlessTerminals.get(ptyId) !== constructed
        ) {
          return false
        }
        const confirmed = await controller.confirmShellForeground(ptyId)
        return (
          confirmed &&
          this.headlessTerminals.get(ptyId) === constructed &&
          this.getPtyLifecycleGeneration(ptyId) === lifecycleGeneration
        )
      })
    }
    state = constructed
    return state
  }

  /** Phase-5 ConPTY DA1 retrofit (terminal-query-authority.md): invoked via
   *  markNativeWindowsConptyPty when the spawn mark lands after daemon stream
   *  data already created this PTY's emulator. Idempotent emulator-side. */
  private ensureNativeWindowsConptyDa1Override(ptyId: string): void {
    if (isNativeWindowsConptyPty(ptyId)) {
      this.headlessTerminals.get(ptyId)?.emulator.installConptyPrimaryDeviceAttributesOverride()
    }
  }

  private getOrCreateHeadlessTerminal(ptyId: string): RuntimeHeadlessTerminal {
    const existing = this.headlessTerminals.get(ptyId)
    if (existing) {
      return existing
    }
    const size = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state = this.createPtyHeadlessTerminalState(ptyId, size)
    this.headlessTerminals.set(ptyId, state)
    return state
  }

  private replaceHeadlessTerminalAfterExecutionContextChange(ptyId: string): void {
    this.disposeHeadlessTerminal(ptyId)
    this.providerSnapshotPreferredPtys.add(ptyId)
    const dims = this.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
    const state = this.createPtyHeadlessTerminalState(ptyId, dims)
    this.headlessTerminals.set(ptyId, state)
    state.writeChain = state.writeChain
      .then(async () => {
        const snapshot = await this.serializeProviderTerminalBuffer(ptyId)
        if (!snapshot) {
          return
        }
        const data = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
        // Why: a newer live OSC 7 can arrive while the snapshot is in flight;
        // only seed metadata while no post-correction CWD has won the race.
        if (!this.terminalCwdByPtyId.has(ptyId)) {
          this.recordOsc7MetadataForPty(ptyId, data)
        }
        await state.emulator.write(data)
        if (snapshot.cwd !== undefined) {
          state.emulator.setCwd(snapshot.cwd)
          if (!this.terminalCwdByPtyId.has(ptyId) && snapshot.cwd?.trim()) {
            this.terminalCwdByPtyId.set(ptyId, snapshot.cwd)
          }
        }
        if (snapshot.oscLinks !== undefined) {
          state.emulator.setRestoredOscLinks(snapshot.oscLinks)
        }
        state.ownership.seedOwner(snapshot.terminalOwner, {
          alternateScreen: state.emulator.isAlternateScreen
        })
        state.outputSequence = snapshot.seq
      })
      .catch(() => {
        // Best-effort: live bytes already chain behind this replacement state.
      })
      .finally(() => {
        this.providerSnapshotPreferredPtys.delete(ptyId)
      })
  }

  private resizeHeadlessTerminal(ptyId: string, cols: number, rows: number): void {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    // Why: terminal reflow is a parser operation. It must sit in the same
    // per-PTY stream as output bytes or restore snapshots can bake in wraps
    // from the wrong terminal width.
    state.writeChain = state.writeChain
      .then(() => {
        state.emulator.resize(cols, rows)
      })
      .catch(() => {
        // Best-effort mirror tracking; live PTY streaming must continue even
        // if xterm rejects a raced resize during teardown.
      })
  }

  // Public: desktop-initiated clears (ipc/pty.ts) must also drop this mobile
  // mirror or a resubscribing mobile client resurrects the cleared scrollback.
  async clearHeadlessTerminalBuffer(ptyId: string): Promise<void> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    // Why: headless writes are queued to preserve xterm parser order. Clear
    // must join that same chain or an earlier PTY chunk can finish after the
    // clear request and repopulate mobile scrollback.
    state.writeChain = state.writeChain.then(() => state.emulator.clearScrollback())
    await state.writeChain
  }

  private async serializeTerminalBufferFromAvailableState(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
  } | null> {
    if (this.providerSnapshotPreferredPtys.has(ptyId)) {
      // Why: pre-attach stream bytes only form a suffix of restored state. A
      // sequenced provider snapshot safely reconciles live bytes; renderer is
      // the fallback when an older provider cannot expose that boundary.
      const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts)
      if (providerSnapshot) {
        return providerSnapshot
      }
      const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
      if (rendererSnapshot) {
        return rendererSnapshot
      }
    }
    const headlessSnapshot = await this.serializeHeadlessTerminalBuffer(ptyId, opts)
    if (headlessSnapshot) {
      return headlessSnapshot
    }

    const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
    if (!rendererSnapshot) {
      return this.serializeProviderTerminalBuffer(ptyId, opts)
    }
    if (rendererSnapshot.data.length > 0) {
      return rendererSnapshot
    }
    // Why: parked desktop panes register serializers before their xterm has
    // hydrated. Treat that empty shell as provisional so retained provider
    // history can restore mobile without forcing the desktop pane to mount.
    const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts)
    return providerSnapshot &&
      (providerSnapshot.data.length > 0 || Boolean(providerSnapshot.scrollbackAnsi))
      ? providerSnapshot
      : rendererSnapshot
  }

  async serializeRendererTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    source?: 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    kittyKeyboardFlags?: number
  } | null> {
    if (this.ptyController?.hasRendererSerializer?.(ptyId) === false) {
      return null
    }
    let rendererSnapshot: {
      data: string
      cols: number
      rows: number
      seq?: number
      cwd?: string | null
      lastTitle?: string
      oscLinks?: TerminalOscLinkRange[]
      kittyKeyboardFlags?: number
    } | null = null
    try {
      // Why: recovery/read fallback wants visible alt-screen content (e.g. an
      // active TUI), so altScreenForcesZeroRows is FALSE here. Hydration is
      // the only path that suppresses alt-screen scrollback.
      rendererSnapshot = await (this.ptyController?.serializeBuffer?.(ptyId, {
        scrollbackRows: opts.scrollbackRows,
        altScreenForcesZeroRows: false
      }) ?? Promise.resolve(null))
    } catch {
      // Why: terminal snapshots should not depend on a mounted renderer pane.
      // If renderer serialization races reload/unmount, callers can still use
      // their existing null fallback paths.
    }
    return rendererSnapshot
      ? this.preferTrackedLastTitle(ptyId, {
          ...rendererSnapshot,
          cwd: rendererSnapshot.cwd ?? this.terminalCwdByPtyId.get(ptyId),
          source: 'renderer' as const
        })
      : null
  }

  private async serializeProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {},
    wait: { timeoutMs?: number; retireOnTimeout?: boolean } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const scrollbackRows = Math.max(0, Math.floor(opts.scrollbackRows ?? 0))
    let acquisition = this.providerBufferAcquisitionsByPtyId.get(ptyId)
    if (
      !acquisition ||
      acquisition.generation !== generation ||
      acquisition.scrollbackRows < scrollbackRows
    ) {
      const promise = this.captureProviderTerminalBuffer(ptyId, opts, generation)
      acquisition = { generation, scrollbackRows, promise, timedOut: false }
      this.providerBufferAcquisitionsByPtyId.set(ptyId, acquisition)
      void promise.finally(() => {
        if (this.providerBufferAcquisitionsByPtyId.get(ptyId) === acquisition) {
          this.providerBufferAcquisitionsByPtyId.delete(ptyId)
        }
      })
    }
    if (acquisition.timedOut) {
      return null
    }
    if (typeof wait.timeoutMs !== 'number') {
      return acquisition.promise
    }
    const result = await withTimeout<
      { settled: true; value: PtyProviderBufferSnapshot | null } | { settled: false }
    >(
      acquisition.promise.then((value) => ({ settled: true as const, value })),
      wait.timeoutMs,
      { settled: false as const }
    )
    if (!result.settled) {
      if (wait.retireOnTimeout) {
        acquisition.timedOut = true
      }
      return null
    }
    return result.value
  }

  private async captureProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number },
    generation: number
  ): Promise<PtyProviderBufferSnapshot | null> {
    const liveModeTracker = new TerminalKittyKeyboardModeTracker()
    let liveModeTrackers = this.providerModeSnapshotScansByPtyId.get(ptyId)
    if (!liveModeTrackers) {
      liveModeTrackers = new Set()
      this.providerModeSnapshotScansByPtyId.set(ptyId, liveModeTrackers)
    }
    liveModeTrackers.add(liveModeTracker)
    try {
      // Why: daemon PTYs survive an app relaunch before any renderer mounts.
      // Mobile still needs their retained history without navigating desktop.
      const snapshot = await this.ptyController?.serializeProviderBuffer?.(ptyId, opts)
      if (!snapshot || this.getPtyLifecycleGeneration(ptyId) !== generation) {
        return null
      }
      const snapshotModeTracker = new TerminalKittyKeyboardModeTracker()
      if (typeof snapshot.alternateScreen === 'boolean') {
        snapshotModeTracker.scan(snapshot.alternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
      } else {
        // Why: older providers omit mode metadata, but their ANSI snapshot
        // still carries the DECSET/DECRST needed to classify the active screen.
        snapshotModeTracker.scanReplay(snapshot.data)
      }
      const observedSnapshotMode = snapshotModeTracker.hasObservedAlternateScreenSwitch
      let effectiveAlternateScreen: boolean | undefined
      if (observedSnapshotMode || liveModeTracker.hasObservedAlternateScreenSwitch) {
        const modeTracker = new TerminalKittyKeyboardModeTracker()
        if (observedSnapshotMode) {
          modeTracker.scan(snapshotModeTracker.isAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
        }
        // Why: stream bytes received after the request began can be newer
        // than snapshot metadata, so an observed live transition wins.
        if (liveModeTracker.hasObservedAlternateScreenSwitch) {
          modeTracker.scan(liveModeTracker.isAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
        }
        this.providerModeTrackersByPtyId.set(ptyId, modeTracker)
        effectiveAlternateScreen = modeTracker.isAlternateScreen
      }
      const providerOffset = this.providerSequenceOffsetByPtyId.get(ptyId) ?? 0
      const reconciledSnapshot = this.preferTrackedLastTitle(ptyId, {
        ...snapshot,
        seq: providerOffset + snapshot.seq,
        ...(effectiveAlternateScreen !== undefined
          ? { alternateScreen: effectiveAlternateScreen }
          : {})
      })
      if (liveModeTracker.hasObservedAlternateScreenSwitch) {
        this.providerSnapshotsWithLiveModeTransition.add(reconciledSnapshot)
      }
      return reconciledSnapshot
    } catch {
      return null
    } finally {
      liveModeTrackers.delete(liveModeTracker)
      if (liveModeTrackers.size === 0) {
        this.providerModeSnapshotScansByPtyId.delete(ptyId)
      }
    }
  }

  private async withVisibleSnapshotFallback(
    ptyId: string,
    read: RuntimeTerminalRead,
    opts: { cursor?: number; limit?: number } = {}
  ): Promise<RuntimeTerminalRead> {
    if (typeof opts.cursor === 'number') {
      return read
    }
    const blankFallback = shouldFallbackToVisibleTerminalSnapshot(read, opts)
    const recoveredWorkerFallback =
      read.tail.length === 0 && this.legacyWorkerRecovery.hasRecoveredPty(ptyId)
    // Why: a live daemon session no pane ever attached has ingested zero bytes,
    // so only the provider holds its screen. Unprovable state stays empty.
    const neverAttachedProviderFallback =
      read.tail.length === 0 &&
      !recoveredWorkerFallback &&
      this.isKnownUnattachedLocalDaemonPty(ptyId)
    if (recoveredWorkerFallback || neverAttachedProviderFallback) {
      const providerLines = await this.readProviderTerminalTailLines(ptyId, opts.limit)
      if (providerLines.length > 0) {
        return buildVisibleSnapshotReadFallback(read, providerLines, opts.limit)
      }
    }
    const knownAlternateScreen = this.isTerminalAlternateScreen(ptyId)
    const providerModeUnknown =
      this.providerSnapshotPreferredPtys.has(ptyId) && !this.providerModeTrackersByPtyId.has(ptyId)
    if (
      !blankFallback &&
      !recoveredWorkerFallback &&
      !providerModeUnknown &&
      !knownAlternateScreen &&
      !this.headlessTerminals.has(ptyId)
    ) {
      return read
    }
    const visibleState = await this.readVisibleTerminalState(ptyId)
    if (
      !blankFallback &&
      !recoveredWorkerFallback &&
      !knownAlternateScreen &&
      !visibleState?.isAlternateScreen
    ) {
      return read
    }
    let lines = visibleState?.lines ?? []
    if (lines.length === 0) {
      lines = await this.readRendererVisibleSnapshotLines(ptyId)
    }
    if (lines.length === 0) {
      return read
    }
    return buildVisibleSnapshotReadFallback(read, lines, opts.limit)
  }

  private async readProviderTerminalTailLines(
    ptyId: string,
    limit: number | undefined
  ): Promise<string[]> {
    const lineLimit = terminalReadLimit(limit, DEFAULT_TERMINAL_READ_LIMIT)
    const snapshot = await this.serializeProviderTerminalBuffer(ptyId, {
      scrollbackRows: lineLimit
    })
    const data = snapshot ? `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}` : ''
    if (!snapshot || data.length === 0) {
      return []
    }
    const emulator = new HeadlessEmulator({
      cols: snapshot.cols,
      rows: snapshot.rows,
      scrollback: lineLimit
    })
    try {
      await emulator.write(data)
      return visibleNonBlankTerminalLines(emulator.getBufferTailLines(lineLimit))
    } finally {
      emulator.dispose()
    }
  }

  private async visibleSnapshotPreview(ptyId: string, preview: string): Promise<string> {
    const knownAlternateScreen = this.isTerminalAlternateScreen(ptyId)
    const providerModeUnknown =
      this.providerSnapshotPreferredPtys.has(ptyId) && !this.providerModeTrackersByPtyId.has(ptyId)
    if (!providerModeUnknown && !knownAlternateScreen && !this.headlessTerminals.has(ptyId)) {
      return preview
    }
    const visibleState = await this.readVisibleTerminalState(ptyId)
    if (!knownAlternateScreen && !visibleState?.isAlternateScreen) {
      return preview
    }
    let lines = visibleState?.lines ?? []
    if (lines.length === 0) {
      lines = await this.readRendererVisibleSnapshotLines(ptyId)
    }
    return lines.length > 0 ? buildPreview(lines, '') : preview
  }

  private async readVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const pending = this.providerVisibleStateReadsByPtyId.get(ptyId)
    if (pending?.generation === generation) {
      return pending.promise
    }
    let entry: { generation: number; promise: Promise<RuntimeVisibleTerminalState | null> }
    const promise = this.loadVisibleTerminalState(ptyId).finally(() => {
      if (this.providerVisibleStateReadsByPtyId.get(ptyId) === entry) {
        this.providerVisibleStateReadsByPtyId.delete(ptyId)
      }
    })
    entry = { generation, promise }
    this.providerVisibleStateReadsByPtyId.set(ptyId, entry)
    return promise
  }

  private async loadVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    if (!this.providerSnapshotPreferredPtys.has(ptyId)) {
      return this.readHeadlessVisibleTerminalState(ptyId)
    }

    const generation = this.getPtyLifecycleGeneration(ptyId)
    const outputSequence = this.getPtyOutputSequence(ptyId)
    const cached = this.providerVisibleStateByPtyId.get(ptyId)
    const trackedMode = this.providerModeTrackersByPtyId.get(ptyId)
    if (
      cached?.generation === generation &&
      outputSequence <= cached.sequence &&
      (!trackedMode || trackedMode.isAlternateScreen === cached.isAlternateScreen)
    ) {
      return cached
    }
    if (trackedMode && !trackedMode.isAlternateScreen) {
      const headlessState = await this.readHeadlessVisibleTerminalState(ptyId)
      return headlessState
        ? { ...headlessState, isAlternateScreen: false }
        : {
            lines: [],
            isAlternateScreen: false,
            sequence: outputSequence,
            generation
          }
    }
    if ((this.providerVisibleRetryAtByPtyId.get(ptyId) ?? 0) > Date.now()) {
      return null
    }

    const snapshot = await this.serializeProviderTerminalBuffer(
      ptyId,
      { scrollbackRows: 0 },
      { timeoutMs: VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS }
    )
    if (!snapshot || this.getPtyLifecycleGeneration(ptyId) !== generation) {
      this.providerVisibleRetryAtByPtyId.set(ptyId, Date.now() + VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS)
      return null
    }
    this.providerVisibleRetryAtByPtyId.delete(ptyId)
    if (this.providerSnapshotsWithLiveModeTransition.has(snapshot)) {
      // Why: the provider frame can predate a mode switch observed while its
      // RPC was pending; the ordered live emulator owns the post-switch grid.
      const liveState = await this.readHeadlessVisibleTerminalState(ptyId)
      if (liveState && liveState.isAlternateScreen === (snapshot.alternateScreen ?? false)) {
        return liveState
      }
    }
    const lines = await this.parseVisibleSnapshotLines(snapshot)
    if (this.getPtyLifecycleGeneration(ptyId) !== generation) {
      return null
    }
    const visibleState: RuntimeVisibleTerminalState = {
      lines,
      isAlternateScreen: snapshot.alternateScreen ?? false,
      sequence: snapshot.seq,
      generation
    }
    if (this.getPtyOutputSequence(ptyId) <= snapshot.seq) {
      this.providerVisibleStateByPtyId.set(ptyId, visibleState)
    }
    return visibleState
  }

  private async readHeadlessVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return null
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    await state.writeChain
    if (
      this.headlessTerminals.get(ptyId) !== state ||
      this.getPtyLifecycleGeneration(ptyId) !== generation
    ) {
      return null
    }
    return {
      lines: visibleNonBlankTerminalLines(state.emulator.getVisibleLines()),
      isAlternateScreen: state.emulator.isAlternateScreen,
      sequence: state.outputSequence,
      generation
    }
  }

  private async parseVisibleSnapshotLines(snapshot: {
    data: string
    cols: number
    rows: number
  }): Promise<string[]> {
    if (snapshot.data.length === 0) {
      return []
    }
    const emulator = new HeadlessEmulator({
      cols: snapshot.cols,
      rows: snapshot.rows,
      scrollback: 0
    })
    try {
      await emulator.write(`\x1b[2J\x1b[3J\x1b[H${snapshot.data}`)
      return visibleNonBlankTerminalLines(emulator.getVisibleLines())
    } finally {
      emulator.dispose()
    }
  }

  private async readRendererVisibleSnapshotLines(ptyId: string): Promise<string[]> {
    const controller = this.ptyController
    if (!controller?.serializeBuffer) {
      return []
    }
    if (controller.hasRendererSerializer && !controller.hasRendererSerializer(ptyId)) {
      return []
    }
    try {
      // Why: raw PTY tails can be whitespace-only while a full-screen TUI is
      // visibly nonblank in renderer xterm. Ask the renderer for the active
      // screen instead of reusing the headless transcript path.
      const snapshot = await withTimeout(
        controller.serializeBuffer(ptyId, {
          scrollbackRows: 0,
          altScreenForcesZeroRows: false
        }),
        VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
        null
      )
      if (!snapshot || snapshot.data.length === 0) {
        return []
      }
      return this.parseVisibleSnapshotLines(snapshot)
    } catch {
      return []
    }
  }

  private async serializeHeadlessTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number; includeEmpty?: boolean } = {}
  ): Promise<{
    data: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
    // Why: dangling mid-escape tail the restorer must write LAST, after any
    // reset, so the next live chunk completes it instead of rendering it
    // literally (Bug E / #7329).
    pendingEscapeTailAnsi?: string
  } | null> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return null
    }
    await state.writeChain
    await state.ownership.settle()
    // Why: normal history is separated from an active alternate frame, so the
    // caller's scrollback policy can be honored without painting it into alt.
    const scrollbackRows = opts.scrollbackRows ?? 0
    const snapshot = state.emulator.getSnapshot({ scrollbackRows })
    const terminalOwner = state.ownership.owner
    const data = snapshot.rehydrateSequences + snapshot.snapshotAnsi
    return data.length > 0 || opts.includeEmpty === true
      ? this.preferTrackedLastTitle(ptyId, {
          data,
          frameRestoreAnsi: snapshot.frameRestoreAnsi,
          cols: snapshot.cols,
          rows: snapshot.rows,
          cwd: snapshot.cwd ?? this.terminalCwdByPtyId.get(ptyId),
          lastTitle: snapshot.lastTitle,
          seq: state.outputSequence,
          source: 'headless' as const,
          oscLinks: snapshot.oscLinks,
          scrollbackAnsi: snapshot.scrollbackAnsi,
          // Why beside outputSequence and never re-read later: the flags must
          // describe the same stream position as the image, or replay would
          // apply push/pop transitions twice or out of order.
          ...(parseTerminalKittyKeyboardFlags(snapshot.modes?.kittyKeyboardFlags) !== undefined
            ? { kittyKeyboardFlags: snapshot.modes.kittyKeyboardFlags }
            : {}),
          ...(snapshot.pendingEscapeTailAnsi
            ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
            : {}),
          ...(terminalOwner ? { terminalOwner } : {}),
          // Why: lets the renderer skip the destructive scrollback clear when
          // restoring an alt-screen snapshot — clearing wipes xterm's own
          // history that the TUI relies on for scroll-up after a tab return.
          alternateScreen: snapshot.modes?.alternateScreen ?? state.emulator.isAlternateScreen,
          // Why NOT folded into data: the renderer writes its post-replay
          // reset after data, and any ESC after a dangling partial aborts it.
          // The restorer writes this last (Bug E fix).
          pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi
        })
      : null
  }

  private disposeHeadlessTerminal(ptyId: string): void {
    this.headlessHydrationState.delete(ptyId)
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    this.headlessTerminals.delete(ptyId)
    // Why: queued chain links still parse below before the emulator disposes;
    // sever the reply sink now so they cannot write to a respawned PTY that
    // reused this id (belt to the sink's state-identity check).
    state.emulator.disableQueryReplyForwarding()
    state.ownership.dispose()
    state.writeChain.finally(() => state.emulator.dispose()).catch(() => state.emulator.dispose())
  }

  resolveLeafForHandle(handle: string): { ptyId: string | null } | null {
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    if (record.tabId.startsWith('pty:')) {
      return { ptyId: record.ptyId }
    }
    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf) {
      return null
    }
    return { ptyId: leaf.ptyId }
  }

  // Why: remote clients hold handles across transport reconnects. A handle
  // minted for a concrete PTY must never silently adopt a different PTY that
  // later occupies the same pane — that misroutes keystrokes (#7718). Handles
  // still awaiting their first PTY (ptyId null) may adopt it, which preserves
  // the mobile pre-spawn subscribe flow.
  resolveLiveLeafForHandle(handle: string): { ptyId: string | null } | null {
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    if (record.tabId.startsWith('pty:')) {
      return { ptyId: record.ptyId }
    }
    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf) {
      return null
    }
    if (
      record.ptyId !== null &&
      (leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration)
    ) {
      throw new Error('terminal_handle_stale')
    }
    return { ptyId: leaf.ptyId }
  }

  getOrchestrationCompatibilityHostId(): 'local' {
    return 'local'
  }

  registerOrchestrationCompatibilitySshAttachment(
    targetId: string,
    connectionIncarnation: string
  ): OrchestrationCompatibilitySshAttachmentAuthority {
    const authority = Object.freeze({
      kind: 'ssh' as const,
      targetId,
      connectionIncarnation,
      attachmentId: randomUUID()
    })
    this.orchestrationCompatibilitySshAttachments.set(authority.attachmentId, authority)
    return authority
  }

  releaseOrchestrationCompatibilitySshAttachment(attachmentId: string): void {
    this.orchestrationCompatibilitySshAttachments.delete(attachmentId)
  }

  verifyOrchestrationCompatibilityCaller(
    evidence: OrchestrationCompatibilityEvidence | null | undefined,
    options?: { currentRuntimeLaunchSufficient?: boolean }
  ): OrchestrationCompatibilityCallerAuthority | null {
    const terminalHandle =
      typeof evidence?.terminalHandle === 'string' ? evidence.terminalHandle.trim() : ''
    const claimedPaneKey = typeof evidence?.paneKey === 'string' ? evidence.paneKey.trim() : ''
    const launchToken = typeof evidence?.launchToken === 'string' ? evidence.launchToken.trim() : ''
    const host = evidence?.host
    if (!terminalHandle || !claimedPaneKey || !launchToken) {
      return null
    }
    const terminal = this.getOrchestrationDispatchAuthority(terminalHandle)
    if (
      !terminal?.processIncarnation ||
      !terminal.paneKey ||
      !this.orchestrationCompatibilityHostMatches(terminal.hostScope, host)
    ) {
      return null
    }
    const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
    let terminalProvenance: 'current_runtime' | 'restored'
    if (terminal.launchTokenHash) {
      if (launchTokenHash !== terminal.launchTokenHash) {
        return null
      }
      terminalProvenance = 'current_runtime'
    } else {
      const receipt = this.restoredOrchestrationAuthorityByPtyId.get(terminal.ptyId)
      if (
        !receipt ||
        receipt.ptyId !== terminal.ptyId ||
        receipt.worktreeId !== terminal.worktreeId ||
        receipt.terminalHandle !== terminal.terminalHandle ||
        receipt.paneKey !== terminal.paneKey ||
        receipt.processIncarnation !== terminal.processIncarnation ||
        !this.orchestrationCompatibilityHostScopesEqual(receipt.hostScope, terminal.hostScope)
      ) {
        return null
      }
      terminalProvenance = 'restored'
    }
    if (
      options?.currentRuntimeLaunchSufficient &&
      terminalProvenance === 'current_runtime' &&
      claimedPaneKey === terminal.paneKey
    ) {
      // Why: the checks above bind a fresh launch to its live PTY, host, and
      // launch secret. Only an exact live-pane match may skip hook attestation.
      return this.freezeOrchestrationCompatibilityCallerAuthority(
        terminal,
        terminal.processIncarnation,
        claimedPaneKey,
        terminalHandle,
        launchTokenHash
      )
    }
    const attestation = this.attestAgentHookCompatibilityAuthorityFn?.({
      paneKey: claimedPaneKey,
      launchTokenHash,
      connectionId: terminal.hostScope.kind === 'ssh' ? terminal.hostScope.targetId : null,
      terminalProvenance
    })
    if (!attestation || attestation.paneKey !== terminal.paneKey) {
      return null
    }
    return this.freezeOrchestrationCompatibilityCallerAuthority(
      terminal,
      terminal.processIncarnation,
      attestation.paneKey,
      terminalHandle,
      launchTokenHash
    )
  }

  private freezeOrchestrationCompatibilityCallerAuthority(
    terminal: OrchestrationCompatibilityTerminalAuthority,
    processIncarnation: string,
    paneKey: string,
    terminalHandle: string,
    launchTokenHash: string
  ): OrchestrationCompatibilityCallerAuthority {
    return Object.freeze({
      hostScope: Object.freeze({ ...terminal.hostScope }),
      paneKey,
      terminalHandle,
      processIncarnation,
      launchTokenHash
    })
  }

  private orchestrationCompatibilityHostMatches(
    hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope'],
    host: OrchestrationCompatibilityHostStamp | undefined
  ): boolean {
    if (hostScope.kind === 'local') {
      return host === undefined
    }
    if (hostScope.kind === 'wsl') {
      return (
        host?.kind === 'wsl' && host.hostId === hostScope.hostId && host.distro === hostScope.distro
      )
    }
    if (host?.kind !== 'ssh' || host.targetId !== hostScope.targetId) {
      return false
    }
    const authority = this.orchestrationCompatibilitySshAttachments.get(host.attachmentId)
    return (
      authority?.targetId === host.targetId &&
      authority.connectionIncarnation === host.connectionIncarnation
    )
  }

  private orchestrationCompatibilityHostScopesEqual(
    left: OrchestrationCompatibilityTerminalAuthority['hostScope'],
    right: OrchestrationCompatibilityTerminalAuthority['hostScope']
  ): boolean {
    if (left.kind !== right.kind) {
      return false
    }
    if (left.kind === 'local' && right.kind === 'local') {
      return left.hostId === right.hostId
    }
    if (left.kind === 'wsl' && right.kind === 'wsl') {
      return left.hostId === right.hostId && left.distro === right.distro
    }
    return left.kind === 'ssh' && right.kind === 'ssh' && left.targetId === right.targetId
  }

  private getOrchestrationCompatibilityHostScope(
    pty: RuntimePtyWorktreeRecord
  ): OrchestrationCompatibilityTerminalAuthority['hostScope'] | null {
    if (pty.connectionId) {
      return { kind: 'ssh', targetId: pty.connectionId }
    }
    if (pty.isWsl || pty.wslDistro) {
      return pty.wslDistro ? { kind: 'wsl', hostId: 'local', distro: pty.wslDistro } : null
    }
    return { kind: 'local', hostId: 'local' }
  }

  private rememberRestoredOrchestrationAuthority(
    pty: RuntimePtyWorktreeRecord,
    terminalHandle: string,
    incarnationId: string
  ): void {
    const paneKey = pty.paneKey
    const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
    if (!paneKey || !parsePaneKey(paneKey) || !hostScope) {
      this.restoredOrchestrationAuthorityByPtyId.delete(pty.ptyId)
      return
    }
    this.restoredOrchestrationAuthorityByPtyId.set(
      pty.ptyId,
      Object.freeze({
        ptyId: pty.ptyId,
        worktreeId: pty.worktreeId,
        terminalHandle,
        paneKey,
        processIncarnation: `${pty.ptyId}:${incarnationId}`,
        hostScope: Object.freeze({ ...hostScope })
      })
    )
  }

  getOrchestrationDispatchAuthority(
    terminalHandle: string
  ): OrchestrationCompatibilityTerminalAuthority | null {
    let ptyId: string | null
    try {
      ptyId =
        this.getLivePtyForHandle(terminalHandle)?.pty.ptyId ??
        this.resolveLiveLeafForHandle(terminalHandle)?.ptyId ??
        null
    } catch {
      return null
    }
    if (!ptyId) {
      return null
    }
    const pty = this.ptysById.get(ptyId)
    if (!pty?.connected) {
      return null
    }
    const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
    if (!hostScope) {
      return null
    }
    return {
      runtimeId: this.runtimeId,
      terminalHandle,
      ptyId,
      worktreeId: pty.worktreeId,
      processIncarnation: this.getTerminalProcessIncarnation(terminalHandle),
      paneKey: pty.paneKey,
      launchTokenHash: pty.launchToken
        ? createHash('sha256').update(pty.launchToken).digest('hex')
        : null,
      hostScope
    }
  }

  private retirePtyAgentLaunchAuthority(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return
    }
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    if (!pty.launchToken && !receipt) {
      return
    }
    this.restoredOrchestrationAuthorityByPtyId.delete(ptyId)
    pty.launchToken = null
    pty.launchIncarnationId = null
    const paneKeys = new Set<string>()
    if (pty.paneKey && parsePaneKey(pty.paneKey)) {
      paneKeys.add(pty.paneKey)
    }
    if (receipt?.paneKey && parsePaneKey(receipt.paneKey)) {
      paneKeys.add(receipt.paneKey)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      if (isValidTerminalTabId(leaf.tabId) && isTerminalLeafId(leaf.leafId)) {
        paneKeys.add(makePaneKey(leaf.tabId, leaf.leafId))
      }
    }
    for (const paneKey of paneKeys) {
      this.retireAgentHookCompatibilityAuthorityFn?.(paneKey)
    }
  }

  async resolveTerminalCwd(handle: string): Promise<string | null> {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    if (!ptyId) {
      return null
    }
    const tracked = this.terminalCwdByPtyId.get(ptyId)
    if (tracked) {
      return tracked
    }
    try {
      const cwd = await this.ptyController?.getCwd?.(ptyId)
      return cwd && cwd.trim().length > 0 ? cwd : null
    } catch {
      return null
    }
  }

  resolveTerminalFileUriHostname(handle: string): string | null {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    return ptyId ? (this.terminalFileUriHostnameByPtyId.get(ptyId) ?? null) : null
  }

  private recordRecentPtyOutputForPathProvenance(ptyId: string, data: string): void {
    let recentOutputBuffer = this.recentPtyOutputById.get(ptyId)
    if (!recentOutputBuffer) {
      // Boundaries are only owed to the one-time activation backfill; once
      // tracking is live, new buffers keep the read-collapsing hot path.
      recentOutputBuffer = new RecentPtyOutputBuffer({
        preserveChunkBoundaries: !this.recentPtyPathCandidateTrackingActive
      })
      this.recentPtyOutputById.set(ptyId, recentOutputBuffer)
    }
    recentOutputBuffer.append(data)
    if (
      this.recentPtyPathCandidateTrackingActive ||
      // Why: an over-window chunk is stored pre-sliced, so activation backfill
      // could never replay its original text. Extract while intact; oversized
      // chunks are rare, so the desktop-only gate still skips the hot path.
      data.length > RECENT_PTY_OUTPUT_LIMIT
    ) {
      this.recentPtyPathCandidatesById.set(
        ptyId,
        appendRecentPtyPathCandidates(this.recentPtyPathCandidatesById.get(ptyId), data)
      )
    }
  }

  activateRecentPtyPathCandidateTracking(): void {
    if (this.recentPtyPathCandidateTrackingActive) {
      return
    }
    this.recentPtyPathCandidateTrackingActive = true
    // Why: synchronous backfill from the retained raw windows so a file tap
    // right after first mobile connect resolves exactly as before the gate.
    // Replay each retained chunk in its original full form: joining or
    // trimming chunks would change the candidate set (e.g. a window cut can
    // shorten an over-4KiB line under the extractor's line guard, minting
    // candidates the eager extractor rejected).
    // Accepted best-effort loss: output that scrolled past the raw window
    // before the first-ever connect no longer yields candidates.
    for (const [ptyId, buffer] of this.recentPtyOutputById) {
      let candidates = this.recentPtyPathCandidatesById.get(ptyId)
      const { chunks, headChunkIsPartial } = buffer.retainedChunks()
      for (let index = 0; index < chunks.length; index += 1) {
        if (index === 0 && headChunkIsPartial) {
          // A pre-sliced over-window chunk was already extracted eagerly at
          // append time (while its original text was intact); replaying its
          // truncated remainder would mint or drop candidates spuriously.
          continue
        }
        candidates = appendRecentPtyPathCandidates(candidates, chunks[index]!)
      }
      if (candidates) {
        this.recentPtyPathCandidatesById.set(ptyId, candidates)
      }
      // Chunk boundaries were owed only to this one-time backfill; return
      // the buffer to the compact read-collapsing steady state.
      buffer.compact()
    }
  }

  resolveTerminalContext(
    handle: string
  ): { worktreeId: string; connectionId: string | null } | null {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    const pty = ptyId ? this.ptysById.get(ptyId) : null
    return pty ? { worktreeId: pty.worktreeId, connectionId: pty.connectionId } : null
  }

  // Why: remote clients cannot resolve this runtime's WSL project preference,
  // so host-affecting RPCs (skill discovery) resolve it from the owning store.
  resolveProjectRuntimeForWorktree(
    worktreeId: string | null | undefined
  ): ProjectExecutionRuntimeResolution | undefined {
    return this.store && worktreeId
      ? resolveLocalProjectRuntimeForWorktreeId(this.requireStore(), worktreeId)
      : undefined
  }

  getTerminalOrchestrationCliCommand(handle: string): 'orca' | 'orca-ide' {
    let pty: RuntimePtyWorktreeRecord | null = null
    try {
      const ptyId = this.resolveLeafForHandle(handle)?.ptyId
      pty = ptyId ? (this.ptysById.get(ptyId) ?? null) : null
    } catch {
      return 'orca'
    }
    if (!pty) {
      return 'orca'
    }
    return resolveTerminalOrchestrationCliCommand({
      connectionId: pty.connectionId,
      isWsl: pty.isWsl,
      worktreeId: pty.worktreeId,
      projectRuntime: this.store
        ? resolveLocalProjectRuntimeForWorktreeId(this.requireStore(), pty.worktreeId)
        : undefined
    })
  }

  hasRecentTerminalOutputPath(handle: string, pathText: string, absolutePath: string): boolean {
    // Why: safety net for any query path that never saw a mobile onReady —
    // lazily backfill so the answer matches pre-gate behavior.
    if (!this.recentPtyPathCandidateTrackingActive) {
      this.activateRecentPtyPathCandidateTracking()
    }
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    const recentOutput = ptyId ? this.recentPtyOutputById.get(ptyId)?.read() : null
    if (recentOutput && recentTerminalOutputIncludesPath(recentOutput, pathText, absolutePath)) {
      return true
    }
    const candidates = ptyId ? this.recentPtyPathCandidatesById.get(ptyId) : null
    return candidates
      ? recentTerminalPathCandidatesIncludePath(candidates, pathText, absolutePath)
      : false
  }

  // ─── Mobile Fit Override Management ─────────────────────────

  // Why: legacy mobile RPC entrypoint. After the state-machine rewrite this
  // is a thin shim that computes a `PtyLayoutTarget` and routes through
  // `enqueueLayout`. Keeps the same observable return shape so older mobile
  // builds continue to work. See docs/mobile-terminal-layout-state-machine.md.
  async resizeForClient(
    ptyId: string,
    mode: 'mobile-fit' | 'restore',
    clientId: string,
    cols?: number,
    rows?: number
  ): Promise<{
    cols: number
    rows: number
    previousCols: number | null
    previousRows: number | null
    mode: 'mobile-fit' | 'desktop-fit'
  }> {
    if (mode === 'mobile-fit') {
      if (cols == null || rows == null || !Number.isFinite(cols) || !Number.isFinite(rows)) {
        throw new Error('invalid_dimensions')
      }
      const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(cols, rows)

      const currentSize = this.getTerminalSize(ptyId)
      const existing = this.terminalFitOverrides.get(ptyId)
      // Capture baseline cols/rows for the return value (existing override's
      // baseline wins over current size to preserve original desktop dims
      // across multiple re-fits).
      const previousCols = existing?.previousCols ?? currentSize?.cols ?? null
      const previousRows = existing?.previousRows ?? currentSize?.rows ?? null

      // Why: legacy resizeForClient callers bypass handleMobileSubscribe, so
      // mobileSubscribers stays empty and resolveDesktopRestoreTarget's step-1
      // (per-subscriber baseline) never matches. Stash the pre-fit PTY size
      // into lastRendererSizes so restore lands on step 2 (renderer geometry)
      // instead of step 3 (current phone-fit dims = no-op restore).
      if (currentSize && !existing) {
        this.lastRendererSizes.set(ptyId, {
          cols: currentSize.cols,
          rows: currentSize.rows
        })
      }

      this.freshSubscribeGuard.add(ptyId)
      let result: ApplyLayoutResult
      try {
        result = await this.enqueueLayout(ptyId, {
          kind: 'phone',
          cols: clampedCols,
          rows: clampedRows,
          ownerClientId: clientId
        })
      } finally {
        this.freshSubscribeGuard.delete(ptyId)
      }
      if (!result.ok) {
        throw new Error('resize_failed')
      }

      // Why: mobile-fit via resizeForClient is a deliberate mobile action;
      // the actor takes the floor (updates lastActedAt; mode-flip case is
      // already handled by enqueueLayout above).
      await this.mobileTookFloor(ptyId, clientId)

      return {
        cols: clampedCols,
        rows: clampedRows,
        previousCols,
        previousRows,
        mode: 'mobile-fit'
      }
    }

    // restore mode
    const override = this.terminalFitOverrides.get(ptyId)
    if (!override) {
      throw new Error('no_active_override')
    }
    // Only the owning client can restore — prevents one phone from undoing
    // another phone's active fit.
    if (override.clientId !== clientId) {
      throw new Error('not_override_owner')
    }

    const restore = this.resolveDesktopRestoreTarget(ptyId)
    const result = await this.enqueueLayout(ptyId, {
      kind: 'desktop',
      cols: restore.cols,
      rows: restore.rows
    })
    if (!result.ok) {
      throw new Error('resize_failed')
    }

    // Why: legacy mobile clients on the resizeForClient path also need a
    // fit-override-listener notification (the renderer-side terminalFitOverrideChanged
    // is already emitted by applyLayout's mode-flip path).
    this.notifyFitOverrideListeners(ptyId, 'desktop-fit', restore.cols, restore.rows)

    return {
      cols: restore.cols,
      rows: restore.rows,
      previousCols: null,
      previousRows: null,
      mode: 'desktop-fit'
    }
  }

  getTerminalFitOverride(ptyId: string) {
    return this.terminalFitOverrides.get(ptyId) ?? null
  }

  getAllTerminalFitOverrides(): Map<
    string,
    { mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }
  > {
    const result = new Map<
      string,
      { mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }
    >()
    for (const [ptyId, override] of this.terminalFitOverrides) {
      result.set(ptyId, { mode: override.mode, cols: override.cols, rows: override.rows })
    }
    for (const ptyId of this.remoteDesktopFloor.ownerPtyIds()) {
      if (result.has(ptyId)) {
        continue
      }
      const size = this.getTerminalSize(ptyId)
      if (size) {
        result.set(ptyId, { mode: 'remote-desktop-fit', ...size })
      }
    }
    return result
  }

  getAllTerminalDrivers(): Map<string, DriverState> {
    return this.terminalDrivers.getAll()
  }

  getBrowserRemoteViewerPages(): string[] {
    return this.edgeCommands.getBrowserRemoteViewerPages()
  }

  onClientDisconnected(clientId: string): void {
    ;(this as RuntimeCommandSurfaceHost<this>).revokeTerminalFileGrantsForClient(clientId)
    this.mobileDictation.cancelForClient(clientId)

    // (1) Cancel pending restore-debounce timers owned by this client.
    for (const [ptyId, entry] of this.pendingRestoreTimers) {
      if (entry.clientId === clientId) {
        clearTimeout(entry.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }
    }

    // (2) Promote any soft-leave grace owned by this client into immediate
    // finalization. Grace existed to absorb a quick re-subscribe; a real
    // disconnect kills any chance of re-subscribe.
    //
    // Note: this is mode-decoupled (matches docs/mobile-terminal-layout-state-machine.md
    // sub-case 2). Today's pre-rewrite code only restored when
    // `mode === 'auto' && wasResizedToPhone`; the new design restores
    // whenever the layout is currently `phone`. This is an intentional
    // behavior fix — `mode === 'phone'` with no subscribers is a degenerate
    // state nothing in product depends on.
    for (const [ptyId, soft] of this.pendingSoftLeavers) {
      if (soft.clientId !== clientId) {
        continue
      }
      clearTimeout(soft.timer)
      this.pendingSoftLeavers.delete(ptyId)

      // Cancel any in-flight 300ms restore timer too — we'll handle it inline.
      const pending = this.pendingRestoreTimers.get(ptyId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }

      const cur = this.layouts.get(ptyId)
      // Why: Indefinite hold (mobileAutoRestoreFitMs == null) keeps the PTY
      // at phone dims after the phone disconnects; the desktop banner's
      // Restore button is the explicit return path. See
      // docs/mobile-fit-hold.md.
      if (this.remoteDesktopFloor.hasViewers(ptyId)) {
        this.setDriver(ptyId, { kind: 'idle' })
        void this.applyRemoteDesktopLayout(ptyId)
        continue
      } else if (cur?.kind === 'phone' && this.getAutoRestoreFitMs() != null) {
        if (this.remoteDesktopFloor.hasHostReclaimTarget(ptyId)) {
          this.setDriver(ptyId, { kind: 'idle' })
          void this.applyRemoteDesktopLayout(ptyId)
          continue
        }
        // Use the soft-leaver's snapshot baseline as a hint, falling
        // through to resolveDesktopRestoreTarget for missing values.
        const fallback = this.resolveDesktopRestoreTarget(ptyId)
        const cols = soft.record.previousCols ?? fallback.cols
        const rows = soft.record.previousRows ?? fallback.rows
        void this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      }
      this.setDriver(ptyId, { kind: 'idle' })
    }

    // (3) Immediate restore for PTYs where this client was the last
    // mobile subscriber. With multi-mobile, peer subscribers keep the
    // floor; only when the inner map empties do we transition to desktop.
    const ptysWithSurvivingPeers: string[] = []
    const ptysToRestore: { ptyId: string; baseline: { cols: number; rows: number } | null }[] = []
    for (const [ptyId, inner] of this.mobileSubscribers) {
      const subscriber = inner.get(clientId)
      if (!subscriber) {
        continue
      }
      // Snapshot baseline before deleting — needed once mobileSubscribers
      // entry is gone for the resolveDesktopRestoreTarget chain.
      const baseline =
        subscriber.previousCols != null && subscriber.previousRows != null
          ? { cols: subscriber.previousCols, rows: subscriber.previousRows }
          : null
      inner.delete(clientId)
      this.notifyRemoteTerminalViewPresenceChanged(ptyId)
      if (inner.size > 0) {
        ptysWithSurvivingPeers.push(ptyId)
      } else {
        this.mobileSubscribers.delete(ptyId)
        ptysToRestore.push({ ptyId, baseline })
      }
    }
    for (const { ptyId, baseline } of ptysToRestore) {
      const cur = this.layouts.get(ptyId)
      // Why: Indefinite hold gate — see soft-leaver branch above.
      if (this.remoteDesktopFloor.hasViewers(ptyId)) {
        this.setDriver(ptyId, { kind: 'idle' })
        void this.applyRemoteDesktopLayout(ptyId)
        continue
      } else if (cur?.kind === 'phone' && this.getAutoRestoreFitMs() != null) {
        if (this.remoteDesktopFloor.hasHostReclaimTarget(ptyId)) {
          this.setDriver(ptyId, { kind: 'idle' })
          void this.applyRemoteDesktopLayout(ptyId)
          continue
        }
        const fallback = this.resolveDesktopRestoreTarget(ptyId)
        const cols = baseline?.cols ?? fallback.cols
        const rows = baseline?.rows ?? fallback.rows
        void this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      }
      this.setDriver(ptyId, { kind: 'idle' })
    }

    // (4) Driver re-election where peers survived. If the disconnecting
    // client was the active driver, the most-recent surviving actor takes
    // the floor.
    for (const ptyId of ptysWithSurvivingPeers) {
      const driver = this.getDriver(ptyId)
      if (driver.kind !== 'mobile' || driver.clientId !== clientId) {
        continue
      }
      const inner = this.mobileSubscribers.get(ptyId)
      const next = inner ? this.pickMostRecentActor(inner) : null
      if (!next) {
        continue
      }
      this.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })

      const mode = this.getMobileDisplayMode(ptyId)
      if (mode === 'desktop') {
        continue
      }
      const nextSub = inner!.get(next.clientId)
      const nextViewport = nextSub?.viewport
      if (!nextViewport) {
        continue
      }
      void this.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: nextViewport.cols,
        rows: nextViewport.rows,
        ownerClientId: next.clientId
      })
    }

    // (5) Legacy-callers fallback. Older mobile builds use resizeForClient
    // directly and never populate mobileSubscribers. For those PTYs the
    // override carries the owning clientId; restore the layout when the
    // owner disconnects. resolveDesktopRestoreTarget reads lastRendererSizes
    // (which the legacy mobile-fit branch stashes the pre-fit size into).
    for (const [ptyId, override] of this.terminalFitOverrides) {
      if (override.clientId !== clientId) {
        continue
      }
      if (this.mobileSubscribers.has(ptyId)) {
        continue
      }
      const cur = this.layouts.get(ptyId)
      if (cur?.kind !== 'phone') {
        continue
      }
      // Why: Indefinite hold gate — see soft-leaver branch above. Legacy
      // mobile clients (resizeForClient path) honor the same setting.
      if (this.getAutoRestoreFitMs() == null) {
        continue
      }
      const fallback = this.resolveDesktopRestoreTarget(ptyId)
      const cols = override.previousCols ?? fallback.cols
      const rows = override.previousRows ?? fallback.rows
      void this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
    }
  }

  onPtyExit(ptyId: string, exitCode: number, exitIncarnationId?: PtyIncarnationId): void {
    const pty = this.ptysById.get(ptyId)
    if (exitIncarnationId && pty?.incarnationId && exitIncarnationId !== pty.incarnationId) {
      return
    }
    const preservesAbnormalSshSurface =
      this.isSshOwnedPtyId(ptyId) && pty?.connectionId != null && exitCode < 0
    if (preservesAbnormalSshSurface) {
      this.restoredOrchestrationAuthorityByPtyId.delete(ptyId)
    } else {
      this.retirePtyAgentLaunchAuthority(ptyId)
    }
    const incarnationId =
      exitIncarnationId ??
      pty?.incarnationId ??
      `runtime:${this.runtimeId}:${this.getPtyLifecycleGeneration(ptyId)}`
    this.advancePtyLifecycleGeneration(ptyId)
    const exactSurfaceByKey = new Map<
      string,
      Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>
    >()
    for (const leaf of this.getLeavesForPty(ptyId)) {
      exactSurfaceByKey.set(`${leaf.worktreeId}\0${leaf.tabId}\0${leaf.leafId}`, {
        worktreeId: leaf.worktreeId,
        parentTabId: leaf.tabId,
        leafId: leaf.leafId
      })
    }
    const parsedPaneKey = parsePaneKey(pty?.paneKey ?? '')
    if (pty?.tabId && parsedPaneKey) {
      exactSurfaceByKey.set(`${pty.worktreeId}\0${pty.tabId}\0${parsedPaneKey.leafId}`, {
        worktreeId: pty.worktreeId,
        parentTabId: pty.tabId,
        leafId: parsedPaneKey.leafId
      })
    }
    const exactSurfaces = [...exactSurfaceByKey.values()]
    const pendingIncarnation = this.pendingPtyRegistrationIncarnations.get(ptyId)
    const exitMatchesPendingRegistration =
      this.pendingPtyRegistrationIncarnations.has(ptyId) &&
      (pendingIncarnation === null ||
        exitIncarnationId === null ||
        exitIncarnationId === undefined ||
        pendingIncarnation === exitIncarnationId)
    if (exitMatchesPendingRegistration) {
      // Why: reused surfaces can look registered while their replacement incarnation still awaits admission.
      this.earlyExitedPtyIncarnations.set(
        ptyId,
        exitIncarnationId ?? pendingIncarnation ?? pty?.incarnationId ?? null
      )
    }
    const intentionalStopIncarnation = this.intentionalHandlelessPtyStops.get(ptyId)
    const preservesIntentionalHandlelessSurface =
      this.intentionalHandlelessPtyStops.has(ptyId) &&
      (intentionalStopIncarnation === null || intentionalStopIncarnation === incarnationId)
    advertisedUrlWatcher.unbindPty(ptyId)
    // Clean up new mobile state for this PTY
    this.mobileSubscribers.delete(ptyId)
    this.terminalViewSubscribers.clear(ptyId)
    this.mobileDisplayModes.delete(ptyId)
    this.resizeListeners.delete(ptyId)
    this.lastRendererSizes.delete(ptyId)
    this.recentPtyOutputById.delete(ptyId)
    this.setupCompletionTokenByPtyId.delete(ptyId)
    this.clearWaitBlockedCheckState(ptyId)
    this.recentPtyPathCandidatesById.delete(ptyId)
    this.ptyOutputSequenceById.delete(ptyId)
    this.providerSequenceInitializedPtys.delete(ptyId)
    this.providerSequenceOffsetByPtyId.delete(ptyId)
    this.providerSnapshotPreferredPtys.delete(ptyId)
    this.providerModeTrackersByPtyId.delete(ptyId)
    this.providerModeSnapshotScansByPtyId.delete(ptyId)
    this.providerBufferAcquisitionsByPtyId.delete(ptyId)
    this.providerVisibleStateByPtyId.delete(ptyId)
    this.providerVisibleRetryAtByPtyId.delete(ptyId)
    this.agentStatusOscProcessorsByPtyId.delete(ptyId)
    this.terminalSpawnCommandsByPtyId.delete(ptyId)
    this.disposePtyTitleTracker(ptyId)
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.terminalCwdByPtyId.delete(ptyId)
    this.terminalFileUriHostnameByPtyId.delete(ptyId)
    this.wslDistroByPtyId.delete(ptyId)
    this.clearAgentRowSnapshotsForPty(ptyId)
    // Why: a Claude agent-team leader whose PTY exits naturally (agent finished,
    // process died, renderer reload) must release its team + nested panes map.
    // Previously only explicit closeTerminal evicted it, so natural exits leaked
    // one team per never-reused teamId for the runtime's lifetime.
    const exitedTeamLeaderHandle = this.handleByPtyId.get(ptyId)
    if (exitedTeamLeaderHandle) {
      this.claudeAgentTeams.removeTeamForLeaderHandle(exitedTeamLeaderHandle)
    }
    // Layout state machine: clear `layouts` and `layoutQueues`. Any
    // already-queued applyLayout work for this ptyId will run, but every
    // applyLayout re-checks `layouts.has(ptyId)` (or fresh-subscribe) and
    // short-circuits with `pty-exited`.
    this.layouts.delete(ptyId)
    this.layoutQueues.delete(ptyId)
    this.freshSubscribeGuard.delete(ptyId)
    this.cancelPendingDriverMutations(ptyId)
    // Why: a cold restore can respawn under the same session id within the
    // delayed-Enter window; the armed Enter would inject \r into the
    // replacement and stamp rows it never received.
    this.retirePendingMessageDeliveryForPty(ptyId)

    if (this.terminalFitOverrides.has(ptyId)) {
      this.terminalFitOverrides.delete(ptyId)
      this.notifier?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
      this.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
    }
    // Why: clear driver state and notify the renderer so any lock banner on
    // this dead pane unmounts. Without this, the pane shows a stuck banner
    // until tab teardown, and `getDriver(deadPtyId)` would keep returning a
    // stale `mobile{X}` to any caller that hasn't yet seen the exit IPC.
    this.terminalDrivers.clear(ptyId)
    this.remoteDesktopFloor.clearPty(ptyId)
    this.disposeHeadlessTerminal(ptyId)
    this.agentDetector?.onExit(ptyId)
    if (pty) {
      pty.connected = false
      pty.runtimeSessionOwned = false
      this.setPairedRendererSessionOwnership(pty.ptyId, false)
      pty.disconnectedAt = Date.now()
      pty.lastExitCode = exitCode
      // Why: the exited process's live frames say nothing about a replacement.
      // A same-id respawn makes the leaf writable again before any new title,
      // so leaving this true would let push delivery type into the new process
      // on the dead one's idle. lastAgentStatus itself stays for `ps` display.
      pty.lastAgentStatusObservedLive = false
      this.resolvePtyExitWaiters(pty, ptyId)
      this.pruneDisconnectedPtyTranscript(pty)
    }
    if (preservesIntentionalHandlelessSurface || preservesAbnormalSshSurface) {
      // Why: relay loss is recoverable; keep the HUB-owned pane addressable through the bounded reconnect grace.
      this.touchMobileSessionSnapshotsForPty(ptyId, { immediate: true })
    } else {
      // Why: permanent process exit is absence, not a starting/sleeping tab.
      // Retire before publishing so paired clients never persist a ghost.
      this.retireMobileSessionSurfacesForPty(ptyId, incarnationId, exactSurfaces)
    }

    for (const leaf of this.getLeavesForPty(ptyId)) {
      this.detachedPreAllocatedLeaves.delete(ptyId)
      leaf.connected = false
      leaf.writable = false
      leaf.lastExitCode = exitCode
      leaf.lastAgentStatusObservedLive = false
      this.resolveExitWaiters(leaf)
      if (!preservesAbnormalSshSurface) {
        this.failActiveDispatchOnExit(leaf, exitCode)
      }
    }
    this.pruneDisconnectedPtyRecords()
  }

  // ─── Driver state (mobile-presence lock) ──────────────────────────
  //
  // See docs/mobile-presence-lock.md.

  getDriver(ptyId: string): DriverState {
    return this.terminalDrivers.get(ptyId)
  }

  private setDriver(ptyId: string, next: DriverState): void {
    this.terminalDrivers.set(ptyId, next)
  }

  // Why: the host's own fit cascade (window resize, split drag, tab reveal,
  // "+"-new-tab re-render) must not resize a PTY whose width a remote client
  // owns — that is the remote "porridge" bug. True while a phone (mobile driver)
  // OR an active remote desktop viewer owns the PTY. Input is deliberately NOT gated
  // here (see the `writePtyInput` mobile-only checks): shared-control desktop
  // viewers may still type alongside the host.
  // Note: this is intentionally NOT a driver kind. An active remote viewer needs
  // only resize suppression, not the mobile driver machinery (input lock,
  // phone-fit, driver-change banners), so it lives in its own registry and does
  // not perturb the presence-lock state machine. It also coexists with mobile:
  // while a phone drives, the registry still suppresses host resize, and when
  // the phone leaves the surviving viewer keeps the PTY suppressed.
  isPtyResizeDrivenRemotely(ptyId: string): boolean {
    if (this.getDriver(ptyId).kind === 'mobile') {
      return true
    }
    return this.isRemoteDesktopResizeDriven(ptyId)
  }

  isRemoteDesktopResizeDriven(ptyId: string): boolean {
    return this.remoteDesktopFloor.isResizeDriven(ptyId)
  }

  isRemoteDesktopViewerOwner(ptyId: string, subscriptionKey: string): boolean {
    return this.remoteDesktopFloor.isViewerOwner(ptyId, subscriptionKey)
  }

  getRemoteDesktopFitHold(
    ptyId: string,
    subscriptionKey: string
  ): { mode: 'remote-desktop-fit' | 'desktop-fit'; cols: number; rows: number } {
    return this.remoteDesktopFloor.getFitHold(ptyId, subscriptionKey)
  }

  recordRemoteDesktopHostReclaimTarget(ptyId: string, cols: number, rows: number): void {
    this.remoteDesktopFloor.recordHostReclaimTarget(ptyId, cols, rows)
  }

  async applyRemoteDesktopLayout(ptyId: string): Promise<boolean> {
    return this.remoteDesktopFloor.applyLayout(ptyId)
  }

  // Why: attachment only records geometry. Passive hydration/reconnect must not
  // steal the shared PTY from the desktop where the user is actively working.
  async updateRemoteDesktopViewer(
    ptyId: string,
    subscriptionKey: string,
    clientId: string,
    cols: number,
    rows: number,
    claim = true
  ): Promise<boolean> {
    return this.remoteDesktopFloor.updateViewer(ptyId, subscriptionKey, clientId, cols, rows, claim)
  }

  claimRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    return this.remoteDesktopFloor.claimViewer(ptyId, subscriptionKey)
  }

  claimRemoteDesktopHost(ptyId: string, cols: number, rows: number): Promise<boolean> {
    return this.remoteDesktopFloor.claimHost(ptyId, cols, rows)
  }

  unregisterRemoteDesktopViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    return this.unregisterRemoteDesktopViewers(ptyId, [subscriptionKey])
  }

  unregisterRemoteDesktopViewers(
    ptyId: string,
    subscriptionKeys: Iterable<string>
  ): Promise<boolean> {
    return this.remoteDesktopFloor.unregisterViewers(ptyId, subscriptionKeys)
  }

  // Why: the one-shot `terminal.updateViewport` RPC has no disconnect hook, so
  // it must never *create* a width floor (that floor would leak — nothing
  // releases it, pinning the host at a stale width after the viewer is gone).
  // It only refreshes the floor(s) this client already owns via its stream
  // subscription, keyed by clientId. Mirrors the mobile `updateMobileViewport`
  // no-op-without-subscription invariant. Returns false when the client owns no
  // floor (passive/stream-less viewer) — a stream-less viewer must not lock host
  // resize.
  refreshRemoteDesktopViewer(
    ptyId: string,
    clientId: string,
    cols: number,
    rows: number,
    claim = false
  ): Promise<boolean> {
    return this.remoteDesktopFloor.refreshViewer(ptyId, clientId, cols, rows, claim)
  }

  async updateDesktopViewport(
    ptyId: string,
    viewport: { cols: number; rows: number }
  ): Promise<boolean> {
    const { cols, rows } = clampTerminalViewport(viewport.cols, viewport.rows)
    if (this.terminalFitOverrides.has(ptyId) || this.getDriver(ptyId).kind === 'mobile') {
      this.recordRendererGeometry(ptyId, cols, rows)
      return true
    }
    if (this.isResizeSuppressed()) {
      return false
    }
    this.freshSubscribeGuard.add(ptyId)
    try {
      const result = await this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      if (result.ok) {
        this.refreshRendererGeometry(ptyId, cols, rows)
      }
      return result.ok
    } finally {
      this.freshSubscribeGuard.delete(ptyId)
    }
  }

  markMobileActor(ptyId: string, clientId: string): void {
    const inner = this.mobileSubscribers.get(ptyId)
    const sub = inner?.get(clientId)
    if (sub) {
      sub.lastActedAt = Date.now()
    }
    this.setDriver(ptyId, { kind: 'mobile', clientId })
  }

  beginMobileInputFloor(
    ptyId: string,
    clientId: string
  ): { commit: () => Promise<void>; rollback: () => void } | null {
    return this.terminalDrivers.beginMobileInputFloor(ptyId, clientId)
  }

  // Why: invoked from mobile RPC method handlers (terminal.send / setDisplayMode /
  // resizeForClient / fresh subscribe with auto). Records the actor as the
  // most recent mobile driver and re-applies phone-fit if we were previously
  // in `desktop` mode (mobile reclaims a take-back). Mobile-to-mobile hand-offs
  // are no-ops for resize.
  async mobileTookFloor(
    ptyId: string,
    clientId: string,
    previousFloor?: DriverState,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    const inner = this.mobileSubscribers.get(ptyId)
    const sub = inner?.get(clientId)
    const softLeaver = this.pendingSoftLeavers.get(ptyId)
    // Why: native chat pauses terminal output, so its later sends have no
    // subscriber lifecycle that could release a newly-created desktop lock.
    if (!sub && softLeaver?.clientId !== clientId) {
      return
    }
    if (sub) {
      sub.lastActedAt = Date.now()
    }
    const prev = previousFloor ?? this.getDriver(ptyId)
    const currentMode = this.mobileDisplayModes.get(ptyId)
    // Why: a deliberate mobile action implies mobile is resuming control.
    // If the display mode is currently 'desktop' (set by an earlier
    // take-back), flip it back to 'auto' (= map absence) and re-apply so
    // phone-fit takes hold again. See docs/mobile-presence-lock.md.
    if (prev.kind === 'desktop' || currentMode === 'desktop') {
      if (currentMode === 'desktop') {
        this.mobileDisplayModes.delete(ptyId)
      }
      await this.applyMobileDisplayMode(ptyId)
    }
    // Why: display changes are async; a later PTY write must keep the floor
    // when an older phone-fit operation eventually completes.
    if (!isCurrent()) {
      return
    }
    this.setDriver(ptyId, { kind: 'mobile', clientId })
  }

  // Why: in-place viewport update on the existing mobile subscription —
  // used when the mobile keyboard opens/closes and shrinks/grows the
  // visible terminal area. We refresh the subscriber's viewport, re-fit
  // the PTY to the new dims, and emit a 'resized' event so the mobile
  // xterm reinits inline at the new dims without re-subscribing. This
  // avoids the unsubscribe → resubscribe cycle which would (a) flash the
  // desktop lock banner during the brief idle gap and (b) cause the new
  // subscribe to capture the already-phone-fitted PTY size as its
  // restore baseline (stuck-dim bug on later disconnect).
  // No-op when the client isn't actually subscribed to this PTY.
  async updateMobileViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): Promise<{ updated: boolean; applied: boolean }> {
    const inner = this.mobileSubscribers.get(ptyId)
    const sub = inner?.get(clientId)
    if (!sub) {
      return { updated: false, applied: false }
    }
    sub.viewport = viewport
    sub.lastActedAt = Date.now()

    const mode = this.getMobileDisplayMode(ptyId)
    if (mode === 'desktop') {
      // Watching at desktop dims — viewport is informational only.
      return { updated: true, applied: false }
    }
    // Drive PTY dims by the most-recent-actor (just updated to this client).
    const winner = this.pickMostRecentActor(inner!)
    if (!winner) {
      return { updated: false, applied: false }
    }
    const winnerSub = inner!.get(winner.clientId)
    const driveViewport = winnerSub?.viewport ?? viewport
    const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
      driveViewport.cols,
      driveViewport.rows
    )

    sub.wasResizedToPhone = true
    // The driver is already mobile{this client} when we got here; refresh
    // to update lastActedAt-based ordering on later actor selection.
    this.setDriver(ptyId, { kind: 'mobile', clientId })

    const needsFreshSubscribeGuard = !this.layouts.has(ptyId)
    if (needsFreshSubscribeGuard) {
      this.freshSubscribeGuard.add(ptyId)
    }
    let result: ApplyLayoutResult
    try {
      result = await this.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: clampedCols,
        rows: clampedRows,
        ownerClientId: winner.clientId
      })
    } finally {
      if (needsFreshSubscribeGuard) {
        this.freshSubscribeGuard.delete(ptyId)
      }
    }
    return { updated: true, applied: result.ok }
  }

  // Why: invoked from `runtime:restoreTerminalFit` IPC (the desktop "Take
  // back" / "Restore" button). Forces the PTY back to desktop dims and flips
  // the driver to `desktop`, suppressing further mobile-driven dim changes
  // until a mobile actor takes the floor again. Three cases, each ending in
  // releaseDesktopTakeBack:
  //   1. Active mobile subscriber: route through applyMobileDisplayMode so the
  //      existing 'resized' event reaches the phone.
  //   2. Held override, no subscriber (post-indefinite-hold): resolve the
  //      restore target and enqueueLayout directly.
  //   3. Stale mobile driver, no subscriber and no override: nothing to resize,
  //      just drop the lock. See docs/mobile-fit-hold.md.
  //
  // Why: explicit desktop take-back is a user command to reclaim input control
  // NOW. Unlike the auto-restore timer and phone-initiated setDisplayMode paths
  // (which keep the lock when a resize can't converge, #7588), this gesture
  // ALWAYS drops the presence lock and banner. "Take back all terminals"
  // reclaims several PTYs at once; a background pane whose desktop resize can't
  // converge must not strand its banner on the other terminals. The resize is
  // best-effort — the desktop renderer refits the PTY on its next settled
  // frame. Returns `true` whenever there was a lock to reclaim, `false` only
  // when there was nothing to reclaim.
  async reclaimTerminalForDesktop(ptyId: string): Promise<boolean> {
    this.cancelPendingDriverMutations(ptyId)
    if (this.isMobileSubscriberActive(ptyId)) {
      this.setMobileDisplayMode(ptyId, 'desktop')
      await this.applyMobileDisplayMode(ptyId)
      this.releaseDesktopTakeBack(ptyId)
      // Why: a desktop-initiated reclaim is "I'm taking over right now", not a
      // sticky preference. The next mobile subscribe (e.g. user switches back to
      // the terminal tab on the phone) must default to phone-fit again, not stay
      // in passive desktop-watch mode.
      this.setMobileDisplayMode(ptyId, 'auto')
      if (this.remoteDesktopFloor.hasLayoutState(ptyId)) {
        return this.applyRemoteDesktopLayout(ptyId)
      }
      return true
    }
    const heldOverride = this.terminalFitOverrides.get(ptyId)
    if (heldOverride && this.remoteDesktopFloor.hasLayoutState(ptyId)) {
      const pending = this.pendingRestoreTimers.get(ptyId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }
      const softLeaver = this.pendingSoftLeavers.get(ptyId)
      if (softLeaver) {
        clearTimeout(softLeaver.timer)
        this.pendingSoftLeavers.delete(ptyId)
      }
      const priorDriver = this.getDriver(ptyId)
      this.setDriver(ptyId, { kind: 'idle' })
      const converged = await this.applyRemoteDesktopLayout(ptyId)
      if (!converged) {
        this.setDriver(ptyId, priorDriver)
        return false
      }
      this.setDriver(ptyId, { kind: 'desktop' })
      this.setMobileDisplayMode(ptyId, 'auto')
      return true
    }
    if (heldOverride) {
      // Why: with no subscribers, resolveDesktopRestoreTarget can fall through
      // to current PTY size — which is at phone dims (wrong). Prefer a fresh
      // desktop renderer measurement when one exists; otherwise use the
      // override's pre-fit baseline before falling back to current size.
      const fallback = this.resolveDesktopRestoreTarget(ptyId)
      const renderer = this.lastRendererSizes.get(ptyId)
      const cols = renderer?.cols ?? heldOverride.previousCols ?? fallback.cols
      const rows = renderer?.rows ?? heldOverride.previousRows ?? fallback.rows
      await this.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
      this.releaseDesktopTakeBack(ptyId)
      this.setMobileDisplayMode(ptyId, 'auto')
      return true
    }
    // Why: a stale lock — driver still reads mobile with no active subscriber
    // and no held override (e.g. reclaimed inside the soft-leave grace, or a
    // subscriber that dropped without a clean unsubscribe). Release it so the
    // banner can't linger; there is nothing to resize.
    if (this.getDriver(ptyId).kind === 'mobile') {
      this.releaseDesktopTakeBack(ptyId)
      return true
    }
    return false
  }

  // Why: teardown and desktop reclaim supersede delayed mobile mutations,
  // revoking soft-leave grace admission for input floors.
  private cancelPendingDriverMutations(ptyId: string): void {
    const pendingRestore = this.pendingRestoreTimers.get(ptyId)
    if (pendingRestore) {
      clearTimeout(pendingRestore.timer)
      this.pendingRestoreTimers.delete(ptyId)
    }
    const pendingSoft = this.pendingSoftLeavers.get(ptyId)
    if (pendingSoft) {
      clearTimeout(pendingSoft.timer)
      this.pendingSoftLeavers.delete(ptyId)
    }
  }

  // Why: the shared "banner must be gone now" step for an explicit desktop
  // take-back. Releases the presence lock (driver → desktop) and, if the
  // best-effort resize left a fit-override held (resize didn't converge),
  // clears it optimistically with a paired desktop-fit 0×0 — the same signal
  // onPtyExit emits — so neither the presence-lock banner nor the held-fit
  // banner can survive the reclaim. The desktop renderer refits the PTY to real
  // dims on its next settled frame.
  private releaseDesktopTakeBack(ptyId: string): void {
    this.setDriver(ptyId, { kind: 'desktop' })
    if (this.terminalFitOverrides.has(ptyId)) {
      this.terminalFitOverrides.delete(ptyId)
      this.notifier?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
      this.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
    }
  }

  // Why: read-side clamp for mobileAutoRestoreFitMs. `null` means
  // indefinite hold (no auto-restore timer). A finite value is clamped
  // to [MIN, MAX] to defend against bad config — the smallest useful
  // value is a few seconds, the largest is one hour. See
  // docs/mobile-fit-hold.md.
  private getAutoRestoreFitMs(): number | null {
    const raw = this.store?.getSettings().mobileAutoRestoreFitMs ?? null
    if (raw == null) {
      return null
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return null
    }
    return Math.min(Math.max(raw, MOBILE_AUTO_RESTORE_FIT_MIN_MS), MOBILE_AUTO_RESTORE_FIT_MAX_MS)
  }

  // Why: invoked when the user changes mobileAutoRestoreFitMs to `null`
  // (Indefinite). Clears every pending restore timer so the just-expressed
  // preference "do not auto-restore" is honored for ALL currently-pending
  // PTYs, not just one. See docs/mobile-fit-hold.md.
  cancelAllPendingFitRestoreTimers(): void {
    for (const [, entry] of this.pendingRestoreTimers) {
      clearTimeout(entry.timer)
    }
    this.pendingRestoreTimers.clear()
  }

  // Why: read the persisted user preference (clamped) for surfacing to UI
  // callers (mobile RPC, desktop preferences). Returns null when the
  // setting is unset or `null` ("Indefinite").
  getMobileAutoRestoreFitMs(): number | null {
    return this.getAutoRestoreFitMs()
  }

  // Why: persisted-preference setter routed through the same `Store` the
  // desktop preferences UI writes to. Transitions to `null` (Indefinite)
  // clear every pending restore timer to honor the preference change for
  // already-held PTYs. Transitions to a finite value do NOT retroactively
  // schedule timers for PTYs that are currently held — those PTYs were
  // already-not-restored under the old preference, and silently scheduling
  // a restore on a settings change would be surprising. The new value
  // takes effect on the next unsubscribe. See docs/mobile-fit-hold.md.
  setMobileAutoRestoreFitMs(ms: number | null): number | null {
    if (!this.store?.updateSettings) {
      return this.getAutoRestoreFitMs()
    }
    let normalized: number | null
    if (ms == null) {
      normalized = null
    } else if (typeof ms !== 'number' || !Number.isFinite(ms)) {
      normalized = null
    } else {
      normalized = Math.min(
        Math.max(ms, MOBILE_AUTO_RESTORE_FIT_MIN_MS),
        MOBILE_AUTO_RESTORE_FIT_MAX_MS
      )
    }
    this.store.updateSettings({ mobileAutoRestoreFitMs: normalized }, { notifyListeners: true })
    if (normalized == null) {
      this.cancelAllPendingFitRestoreTimers()
    }
    return normalized
  }

  // Why: with multiple subscribers, the active phone-fit dims follow the
  // most recent mobile actor (argmax(lastActedAt)). See
  // docs/mobile-presence-lock.md "Active phone-fit dim selection".
  private pickMostRecentActor(
    inner: Map<string, { clientId: string; lastActedAt: number }>
  ): { clientId: string; lastActedAt: number } | null {
    let best: { clientId: string; lastActedAt: number } | null = null
    for (const sub of inner.values()) {
      if (best === null || sub.lastActedAt > best.lastActedAt) {
        best = sub
      }
    }
    return best
  }

  // Why: restore-target selection on last-subscriber-leaves picks the
  // earliest-by-subscribe-time subscriber AMONG those with non-null
  // previousCols/Rows. Desktop-mode joins carry null and are skipped — they
  // never captured pre-fit dims by design.
  private pickEarliestRestoreTarget(
    inner: Map<
      string,
      { subscribedAt: number; previousCols: number | null; previousRows: number | null }
    >
  ): { previousCols: number; previousRows: number } | null {
    let best: { subscribedAt: number; previousCols: number; previousRows: number } | null = null
    for (const sub of inner.values()) {
      if (sub.previousCols == null || sub.previousRows == null) {
        continue
      }
      if (best === null || sub.subscribedAt < best.subscribedAt) {
        best = {
          subscribedAt: sub.subscribedAt,
          previousCols: sub.previousCols,
          previousRows: sub.previousRows
        }
      }
    }
    return best ? { previousCols: best.previousCols, previousRows: best.previousRows } : null
  }

  // ─── Layout state machine ─────────────────────────────────────────
  //
  // See docs/mobile-terminal-layout-state-machine.md.
  //
  // applyLayout is the SOLE writer of:
  //   - this.layouts
  //   - this.terminalFitOverrides (except the sanctioned dead-pty cleanups in
  //     onPtyExit and reclaimTerminalForDesktop's orphan branch, which delete)
  //   - this.ptyController.resize (i.e. the actual PTY dims)
  //
  // Every trigger that wants to change PTY dims or flip mode goes through
  // enqueueLayout, which serializes calls behind a per-PTY async queue
  // (the await on ptyController.resize would otherwise let seq bumps reach
  // the wire out of order).

  getLayout(ptyId: string): PtyLayoutState | null {
    return this.layouts.get(ptyId) ?? null
  }

  // Why: `enqueueLayout`'s "no layouts entry" short-circuit must not fire
  // on the very first transition for a PTY (where the entry doesn't exist
  // yet *because* we're about to create it). handleMobileSubscribe adds
  // the ptyId to `freshSubscribeGuard` before calling enqueueLayout and
  // removes it in a finally block.
  private isFreshSubscribe(ptyId: string): boolean {
    return this.freshSubscribeGuard.has(ptyId)
  }

  // Why: four-step fallback chain for desktop-restore targets. Always
  // returns a value; the terminal {80,24} branch is reached only under
  // bug. Wrapping the chain as a single helper prevents callsite drift.
  private resolveDesktopRestoreTarget(ptyId: string): { cols: number; rows: number } {
    // 1. Earliest-by-subscribedAt subscriber with non-null baseline.
    const inner = this.mobileSubscribers.get(ptyId)
    if (inner) {
      const earliest = this.pickEarliestRestoreTarget(inner)
      if (earliest) {
        return { cols: earliest.previousCols, rows: earliest.previousRows }
      }
    }
    // 2. Most-recent desktop renderer geometry report.
    const renderer = this.lastRendererSizes.get(ptyId)
    if (renderer) {
      return { cols: renderer.cols, rows: renderer.rows }
    }
    // 3. Current PTY size.
    const size = this.getTerminalSize(ptyId)
    if (size) {
      return { cols: size.cols, rows: size.rows }
    }
    // 4. Hard default.
    return { cols: 80, rows: 24 }
  }

  // Why: a new viewport-only update from the same owner supersedes a
  // queued same-shape tail. Mode flips, owner changes, and take-back
  // append (losing a take-floor to a viewport tick would be a fairness
  // hole — see "enqueueLayout coalescing" in the design doc).
  private coalescesWith(prev: PtyLayoutTarget, next: PtyLayoutTarget): boolean {
    if (prev.kind !== next.kind) {
      return false
    }
    if (prev.kind === 'phone' && next.kind === 'phone') {
      return prev.ownerClientId === next.ownerClientId
    }
    if (prev.kind === 'remote-desktop' && next.kind === 'remote-desktop') {
      // Why: each owner's claim promise gates its following input. Sharing a
      // waiter across owners could release A's input only after B's grid lands.
      return prev.ownerSubscriptionKey === next.ownerSubscriptionKey
    }
    return true
  }

  private enqueueLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult> {
    // Why: PTY-exit short-circuit. Fresh-subscribe gate lets the very first
    // transition through even though `layouts` has no entry yet.
    if (!this.layouts.has(ptyId) && !this.isFreshSubscribe(ptyId)) {
      return Promise.resolve({ ok: false, reason: 'pty-exited' })
    }

    let entry = this.layoutQueues.get(ptyId)
    if (!entry) {
      entry = { running: null, pending: [] }
      this.layoutQueues.set(ptyId, entry)
    }
    const queue = entry

    return new Promise<ApplyLayoutResult>((resolve) => {
      if (!queue.running) {
        queue.running = this.runLayoutSlot(ptyId, target, [resolve])
        return
      }
      const tail = queue.pending.at(-1)
      if (tail && this.coalescesWith(tail.target, target)) {
        tail.target = target
        tail.waiters.push(resolve)
        return
      }
      queue.pending.push({ target, waiters: [resolve] })
    })
  }

  private async runLayoutSlot(
    ptyId: string,
    target: PtyLayoutTarget,
    waiters: ((r: ApplyLayoutResult) => void)[]
  ): Promise<ApplyLayoutResult> {
    let result: ApplyLayoutResult
    try {
      result = await this.applyLayout(ptyId, target)
    } catch (err) {
      // Why: defensive — applyLayout itself catches resize errors, but a
      // throw from one of the synchronous map writes (e.g. notifier hook)
      // must not jam the queue forever.
      console.error('[layout] applyLayout threw', { ptyId, err })
      result = { ok: false, reason: 'resize-failed' }
    }
    for (const w of waiters) {
      w(result)
    }

    const queue = this.layoutQueues.get(ptyId)
    if (!queue) {
      return result
    }
    const next = queue.pending.shift()
    if (next) {
      queue.running = this.runLayoutSlot(ptyId, next.target, next.waiters)
    } else {
      queue.running = null
      // Why: drop the entry once empty so the map doesn't grow without bound
      // across short-lived PTYs.
      this.layoutQueues.delete(ptyId)
    }
    return result
  }

  private async applyLayout(ptyId: string, target: PtyLayoutTarget): Promise<ApplyLayoutResult> {
    // Why: re-check pty-exit at the head of the slot — the queue may have
    // accepted this target before onPtyExit ran.
    if (!this.layouts.has(ptyId) && !this.isFreshSubscribe(ptyId)) {
      return { ok: false, reason: 'pty-exited' }
    }

    const prev = this.layouts.get(ptyId) ?? null
    const seq = (prev?.seq ?? 0) + 1
    const next: PtyLayoutState = { ...target, seq, appliedAt: Date.now() }

    const currentSize = this.getTerminalSize(ptyId)
    const dimsChanged = currentSize?.cols !== target.cols || currentSize?.rows !== target.rows
    const modeChanged = (prev?.kind ?? 'desktop') !== target.kind

    // Snapshot for rollback.
    const prevFitOverride = this.terminalFitOverrides.get(ptyId) ?? null

    // Tentative writes — the resize is the point of no return.
    this.layouts.set(ptyId, next)
    if (target.kind === 'phone') {
      // Why: pull baseline cols+rows atomically from the same subscriber so
      // they can't desync.
      const baseline = (() => {
        const inner = this.mobileSubscribers.get(ptyId)
        if (!inner) {
          return null
        }
        return this.pickEarliestRestoreTarget(inner)
      })()
      this.terminalFitOverrides.set(ptyId, {
        mode: 'mobile-fit',
        cols: target.cols,
        rows: target.rows,
        previousCols: baseline?.previousCols ?? null,
        previousRows: baseline?.previousRows ?? null,
        updatedAt: next.appliedAt,
        clientId: target.ownerClientId
      })
    } else {
      this.terminalFitOverrides.delete(ptyId)
    }

    if (dimsChanged) {
      let ok = false
      try {
        const r = this.ptyController?.resize?.(ptyId, target.cols, target.rows)
        ok = r ?? true
      } catch (err) {
        console.error('[layout] ptyController.resize threw', { ptyId, err })
        ok = false
      }
      if (!ok) {
        // Roll back to pre-call snapshot. seq is NOT bumped on the wire
        // because we never emit below.
        if (prev) {
          this.layouts.set(ptyId, prev)
        } else {
          this.layouts.delete(ptyId)
        }
        if (prevFitOverride) {
          this.terminalFitOverrides.set(ptyId, prevFitOverride)
        } else {
          this.terminalFitOverrides.delete(ptyId)
        }
        return { ok: false, reason: 'resize-failed' }
      }
      this.resizeHeadlessTerminal(ptyId, target.cols, target.rows)
    }

    // Why: remote desktop ownership is a fit hold for the host and passive
    // peer viewers. Emit every remote layout so owner changes at equal geometry
    // still park/release the correct clients without relying on resize deltas.
    // Defense-in-depth (#7588): also emit when the override's presence
    // changed even without a kind flip. applyLayout is the sole writer and
    // keeps override presence in lockstep with layout kind, so overrideChanged
    // ≡ modeChanged in every reachable state today; the extra clause fires
    // only if that invariant is ever violated, repairing the renderer instead
    // of stranding the held modal.
    const overrideChanged = (prevFitOverride != null) !== (target.kind === 'phone')
    if (target.kind === 'remote-desktop' || modeChanged || overrideChanged) {
      // Why: phone→desktop arms the renderer-cascade suppress window
      // before the collateral safeFit IPCs arrive. See "Renderer cascade
      // suppression".
      if (target.kind === 'desktop') {
        this.lastRendererSizes.delete(ptyId)
        this.suppressResizesForMs(500)
      }
      this.notifier?.terminalFitOverrideChanged(
        ptyId,
        target.kind === 'phone'
          ? 'mobile-fit'
          : target.kind === 'remote-desktop'
            ? 'remote-desktop-fit'
            : 'desktop-fit',
        target.cols,
        target.rows
      )
      this.notifyFitOverrideListeners(
        ptyId,
        target.kind === 'phone'
          ? 'mobile-fit'
          : target.kind === 'remote-desktop'
            ? 'remote-desktop-fit'
            : 'desktop-fit',
        target.cols,
        target.rows
      )
    }

    // Mobile-facing event always fires (phone clients need to re-fit on
    // every dim change, not just mode flips).
    this.notifyTerminalResize(ptyId, {
      cols: target.cols,
      rows: target.rows,
      displayMode: target.kind === 'phone' ? 'phone' : 'desktop',
      reason: 'apply-layout',
      seq
    })

    return { ok: true, state: next }
  }

  // ─── Server-Authoritative Mobile Display Mode ─────────────────────

  setMobileDisplayMode(ptyId: string, mode: 'auto' | 'desktop'): void {
    if (mode === 'auto') {
      this.mobileDisplayModes.delete(ptyId)
    } else {
      this.mobileDisplayModes.set(ptyId, mode)
    }
  }

  getMobileDisplayMode(ptyId: string): 'auto' | 'desktop' {
    return this.mobileDisplayModes.get(ptyId) ?? 'auto'
  }

  isMobileSubscriberActive(ptyId: string): boolean {
    const inner = this.mobileSubscribers.get(ptyId)
    return inner !== undefined && inner.size > 0
  }

  // Why: late-bind viewport on an existing subscriber record. Subscribers
  // that registered before the mobile side measured (e.g. terminal first
  // mounted while the WebView was still loading) have null viewport, and
  // applyMobileDisplayMode's auto branch needs a viewport to phone-fit.
  // The setDisplayMode RPC carries the latest viewport so we can patch it
  // here just before applyMobileDisplayMode runs.
  updateMobileSubscriberViewport(
    ptyId: string,
    clientId: string,
    viewport: { cols: number; rows: number }
  ): void {
    const inner = this.mobileSubscribers.get(ptyId)
    const record = inner?.get(clientId)
    if (!record) {
      return
    }
    record.viewport = viewport
  }

  // Why: server-side auto-fit on mobile subscribe. The runtime is the single
  // source of truth — the mobile client just passes its viewport and the runtime
  // decides whether to resize. This eliminates the measure→RPC→resubscribe
  // pipeline that caused race conditions.
  //
  // Multi-mobile keying: each subscriber lives in `mobileSubscribers[ptyId]`'s
  // inner map under its own clientId. Phone B subscribing does not overwrite
  // phone A's record — both stay until each unsubscribes.
  //
  // Subscribe-in-desktop-mode rule: a subscribe with displayMode='desktop' is
  // a passive watch; it does NOT take the floor. The driver remains
  // `idle`/`desktop`. The lock banner is reserved for actual mobile
  // interaction (input/resize/setDisplayMode/auto-or-phone subscribe).
  async handleMobileSubscribe(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    try {
      return await this.handleMobileSubscribeInternal(ptyId, clientId, viewport)
    } finally {
      // Every subscribe path mutates mobileSubscribers — resync the daemon
      // background mark once, whatever branch returned.
      this.notifyRemoteTerminalViewPresenceChanged(ptyId)
    }
  }

  private async handleMobileSubscribeInternal(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    const mode = this.getMobileDisplayMode(ptyId)

    // Cancel pending restore timer for this ptyId — any new subscriber
    // supersedes any old client's pending restore.
    const pendingRestore = this.pendingRestoreTimers.get(ptyId)
    if (pendingRestore) {
      clearTimeout(pendingRestore.timer)
      this.pendingRestoreTimers.delete(ptyId)
    }

    // Resubscribe-grace honor: same client returning within soft-leave
    // window restores prior record (preserving baseline so we don't capture
    // phone-fitted dims as the new baseline).
    const softLeaver = this.pendingSoftLeavers.get(ptyId)
    if (softLeaver && softLeaver.clientId === clientId) {
      clearTimeout(softLeaver.timer)
      this.pendingSoftLeavers.delete(ptyId)
      let inner = this.mobileSubscribers.get(ptyId)
      if (!inner) {
        inner = new Map()
        this.mobileSubscribers.set(ptyId, inner)
      }
      inner.set(clientId, {
        ...softLeaver.record,
        viewport: viewport ?? null,
        lastActedAt: Date.now()
      })
      if (!viewport) {
        return false
      }
      this.setDriver(ptyId, { kind: 'mobile', clientId })
      if (mode !== 'desktop') {
        const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
          viewport.cols,
          viewport.rows
        )
        this.freshSubscribeGuard.add(ptyId)
        try {
          await this.enqueueLayout(ptyId, {
            kind: 'phone',
            cols: clampedCols,
            rows: clampedRows,
            ownerClientId: clientId
          })
        } finally {
          this.freshSubscribeGuard.delete(ptyId)
        }
      }
      return true
    }

    let inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      inner = new Map()
      this.mobileSubscribers.set(ptyId, inner)
    }

    // Capture restore baseline BEFORE applyLayout writes the override.
    // Multi-mobile: peer joiner against an already-fitted PTY captures null
    // — the existing baseline-holder's snapshot remains canonical. See
    // docs/mobile-presence-lock.md.
    //
    // Resubscribe-after-indefinite-hold: the held override carries the only
    // authoritative pre-fit dims across the no-subscriber gap. Inherit it
    // first; otherwise rendererSize/currentSize would be the held phone dims
    // and applyLayout would clobber the override's previousCols with phone
    // dims, making any subsequent Restore a no-op.
    const heldOverride = this.terminalFitOverrides.get(ptyId)
    const existing = inner.get(clientId)
    const someoneAlreadyFitted = [...inner.values()].some((s) => s.wasResizedToPhone)
    const currentSize = this.getTerminalSize(ptyId)
    const rendererSize = this.lastRendererSizes.get(ptyId)
    const previousCols =
      existing?.previousCols ??
      heldOverride?.previousCols ??
      (someoneAlreadyFitted ? null : (rendererSize?.cols ?? currentSize?.cols ?? null))
    const previousRows =
      existing?.previousRows ??
      heldOverride?.previousRows ??
      (someoneAlreadyFitted ? null : (rendererSize?.rows ?? currentSize?.rows ?? null))
    const now = Date.now()
    const subscribedAt = existing?.subscribedAt ?? now

    if (!viewport) {
      // Why: mobile can subscribe before its WebView has measured. Keep the
      // subscriber + desktop baseline so updateViewport/setDisplayMode can
      // late-bind the viewport without recapturing phone dims.
      inner.set(clientId, {
        clientId,
        viewport: null,
        wasResizedToPhone: false,
        previousCols,
        previousRows,
        subscribedAt,
        lastActedAt: now
      })
      return false
    }

    const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
      viewport.cols,
      viewport.rows
    )

    if (mode === 'desktop') {
      // Passive watch — null baseline (we'll capture later if user toggles
      // to auto/phone, since safeFit will have converged by then). Do not
      // flip driver.
      inner.set(clientId, {
        clientId,
        viewport,
        wasResizedToPhone: false,
        previousCols: null,
        previousRows: null,
        subscribedAt,
        lastActedAt: now
      })
      return false
    }

    inner.set(clientId, {
      clientId,
      viewport,
      wasResizedToPhone: true,
      previousCols,
      previousRows,
      subscribedAt,
      lastActedAt: now
    })

    // Subscribe-fresh with auto/phone counts as "take the floor".
    this.setDriver(ptyId, { kind: 'mobile', clientId })

    // Route the actual resize through the state machine. The fresh-subscribe
    // gate lets enqueueLayout's "no layouts entry" short-circuit pass on
    // the very first transition for this PTY.
    this.freshSubscribeGuard.add(ptyId)
    try {
      await this.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: clampedCols,
        rows: clampedRows,
        ownerClientId: clientId
      })
    } finally {
      this.freshSubscribeGuard.delete(ptyId)
    }

    return true
  }

  // Why: delayed restore prevents resize thrashing during rapid tab switches.
  // The 300ms debounce means only the final tab triggers a PTY restore;
  // intermediate terminals keep their current dims harmlessly.
  //
  // Multi-mobile: only the last subscriber leaving for this ptyId triggers
  // restore + driver=idle. Peer mobile clients still on the inner map keep
  // the lock banner mounted; if the disconnecting client was the active
  // driver, we re-elect the most-recent surviving subscriber.
  handleMobileUnsubscribe(ptyId: string, clientId: string): void {
    const inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      return
    }
    const subscriber = inner.get(clientId)
    if (!subscriber) {
      return
    }
    const wasResizedToPhone = subscriber.wasResizedToPhone

    inner.delete(clientId)
    this.notifyRemoteTerminalViewPresenceChanged(ptyId)

    if (inner.size > 0) {
      // Why: if the leaving client was the only one with a non-null restore
      // baseline (typical when peer joiners subscribed against an
      // already-phone-fitted PTY and got null prevCols), donate the baseline
      // to the earliest surviving subscriber so a future last-leaver can
      // still restore correctly. See docs/mobile-presence-lock.md.
      if (
        subscriber.previousCols != null &&
        subscriber.previousRows != null &&
        !this.pickEarliestRestoreTarget(inner)
      ) {
        let earliestSurvivor: { clientId: string; subscribedAt: number } | null = null
        for (const sub of inner.values()) {
          if (earliestSurvivor === null || sub.subscribedAt < earliestSurvivor.subscribedAt) {
            earliestSurvivor = { clientId: sub.clientId, subscribedAt: sub.subscribedAt }
          }
        }
        if (earliestSurvivor) {
          const heir = inner.get(earliestSurvivor.clientId)
          if (heir) {
            heir.previousCols = subscriber.previousCols
            heir.previousRows = subscriber.previousRows
          }
        }
      }
      // Peers still on the line. If the disconnecting client was the active
      // mobile driver, re-elect the most-recent surviving subscriber so the
      // banner remains correct and active phone-fit dims follow them.
      const driver = this.getDriver(ptyId)
      if (driver.kind === 'mobile' && driver.clientId === clientId) {
        const next = this.pickMostRecentActor(inner)
        if (next) {
          this.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })
          // Fire-and-forget — handleMobileUnsubscribe stays sync; applyLayout
          // failures self-recover on the next gesture.
          void this.applyMobileDisplayMode(ptyId)
        }
      }
      return
    }

    // Last subscriber leaving — clean up.
    this.mobileSubscribers.delete(ptyId)
    const mode = this.getMobileDisplayMode(ptyId)

    // Resubscribe-grace: hold driver=mobile{clientId} for ~250ms so a quick
    // re-subscribe (older clients without updateViewport) doesn't flash the
    // desktop banner. See docs/mobile-presence-lock.md.
    const SOFT_LEAVE_GRACE_MS = 250
    const existingSoft = this.pendingSoftLeavers.get(ptyId)
    if (existingSoft) {
      clearTimeout(existingSoft.timer)
      this.pendingSoftLeavers.delete(ptyId)
    }
    const softTimer = setTimeout(() => {
      this.pendingSoftLeavers.delete(ptyId)
      if (!this.mobileSubscribers.has(ptyId)) {
        this.setDriver(ptyId, { kind: 'idle' })
        if (this.remoteDesktopFloor.hasViewers(ptyId)) {
          void this.applyRemoteDesktopLayout(ptyId)
        }
      }
    }, SOFT_LEAVE_GRACE_MS)
    if (typeof softTimer.unref === 'function') {
      softTimer.unref()
    }
    this.pendingSoftLeavers.set(ptyId, {
      clientId,
      timer: softTimer,
      record: {
        clientId: subscriber.clientId,
        viewport: subscriber.viewport,
        wasResizedToPhone: subscriber.wasResizedToPhone,
        previousCols: subscriber.previousCols,
        previousRows: subscriber.previousRows,
        subscribedAt: subscriber.subscribedAt,
        lastActedAt: subscriber.lastActedAt
      }
    })

    if (mode === 'auto' && wasResizedToPhone) {
      const existingTimer = this.pendingRestoreTimers.get(ptyId)
      if (existingTimer) {
        clearTimeout(existingTimer.timer)
        this.pendingRestoreTimers.delete(ptyId)
      }
      // Why: scheduling is conditional on the user's mobileAutoRestoreFitMs
      // preference. `null` (default, "Indefinite") leaves the PTY at phone
      // dims until the user clicks Restore on the desktop banner — the
      // central UX promise of docs/mobile-fit-hold.md. A finite value runs
      // the restore that long after the last unsubscribe.
      const autoRestoreMs = this.getAutoRestoreFitMs()
      if (autoRestoreMs == null) {
        // Indefinite hold: the fit override persists, the SOFT_LEAVE_GRACE
        // driver-state grace above still releases the input lock, and the
        // banner's Restore button is the explicit return path.
      } else {
        // Snapshot the disconnecting subscriber's baseline NOW, before the
        // timer fires. By the time the timer runs, the subscriber map has
        // been deleted; resolveDesktopRestoreTarget would fall through to
        // lastRendererSizes → current PTY size (which is at phone dims,
        // wrong). The disconnecting subscriber's baseline is the correct
        // restore target.
        const fallback = this.lastRendererSizes.get(ptyId)
        const restoreCols =
          subscriber.previousCols ?? fallback?.cols ?? this.getTerminalSize(ptyId)?.cols ?? 80
        const restoreRows =
          subscriber.previousRows ?? fallback?.rows ?? this.getTerminalSize(ptyId)?.rows ?? 24
        const timer = setTimeout(() => {
          this.pendingRestoreTimers.delete(ptyId)
          if (this.isMobileSubscriberActive(ptyId)) {
            return
          }
          if (this.remoteDesktopFloor.hasLayoutState(ptyId)) {
            void this.applyRemoteDesktopLayout(ptyId)
            return
          }
          void this.enqueueLayout(ptyId, {
            kind: 'desktop',
            cols: restoreCols,
            rows: restoreRows
          })
        }, autoRestoreMs)
        // Why: a delayed mobile restore should not keep Electron main alive
        // after the last window/runtime transport has otherwise shut down.
        if (typeof timer.unref === 'function') {
          timer.unref()
        }

        this.pendingRestoreTimers.set(ptyId, { timer, clientId })
      }
    }
    // 'desktop' mode: was never resized, nothing to restore.
  }

  // Why: called when mode changes via terminal.setDisplayMode. Applies the
  // mode change immediately if there's an active subscriber, and emits a
  // 'resized' event so the mobile client can reinitialize xterm inline.
  //
  // Multi-mobile: the most recent mobile actor's viewport drives the active
  // phone-fit dims. The earliest-by-subscribe-time subscriber's
  // previousCols/Rows drive the desktop-restore target.
  //
  // Returns the post-condition "no fit-override remains held" (#7588): `true`
  // when it cleared a held override OR nothing was held to begin with, `false`
  // only when a restore was attempted and the resize failed (override rolled
  // back, still held). reclaimTerminalForDesktop gates its driver/mode
  // transitions on this; other callers ignore it.
  async applyMobileDisplayMode(ptyId: string): Promise<boolean> {
    const mode = this.getMobileDisplayMode(ptyId)
    const inner = this.mobileSubscribers.get(ptyId)
    const subscriber = inner ? this.pickMostRecentActor(inner) : null
    const subscriberRecord = subscriber && inner ? inner.get(subscriber.clientId) : null

    if (mode === 'desktop') {
      // Reset wasResizedToPhone on every fitted subscriber so a future
      // toggle back to auto re-issues the resize. applyLayout owns the
      // actual PTY resize + override delete + renderer notify. Track which
      // subscribers we cleared so a failed resize can re-arm them.
      const clearedFitSubscribers = inner
        ? [...inner.values()].filter((sub) => sub.wasResizedToPhone)
        : []
      for (const sub of clearedFitSubscribers) {
        sub.wasResizedToPhone = false
      }
      const anyWasResized = clearedFitSubscribers.length > 0
      // Why (#7588): also restore when a fit-override is still held but no
      // subscriber carries wasResizedToPhone — e.g. a null-viewport resubscribe
      // after an indefinite hold resets the flag yet leaves the override,
      // stranding the desktop "phone size" modal. Reuse resolveDesktopRestoreTarget
      // (the same resolver the anyWasResized branch uses) so the two adjacent
      // restore paths can never resolve to different dims for the same state.
      if (anyWasResized || this.terminalFitOverrides.has(ptyId)) {
        const restore = this.resolveDesktopRestoreTarget(ptyId)
        const result = await this.enqueueLayout(ptyId, {
          kind: 'desktop',
          cols: restore.cols,
          rows: restore.rows
        })
        // Why (#7588): a failed resize rolls the override back (still held), so
        // re-arm the flags we cleared. Otherwise a later unsubscribe under a
        // finite mobileAutoRestoreFitMs would see wasResizedToPhone=false, skip
        // scheduling its auto-restore timer, and strand the held phone-fit.
        if (!result.ok) {
          for (const sub of clearedFitSubscribers) {
            sub.wasResizedToPhone = true
          }
        }
      } else {
        // Nothing was fitted or held — emit a mode-change resize event so
        // the mobile client still learns the toggle landed.
        const size = this.getTerminalSize(ptyId)
        this.notifyTerminalResize(ptyId, {
          cols: size?.cols ?? 0,
          rows: size?.rows ?? 0,
          displayMode: 'desktop',
          reason: 'mode-change',
          seq: this.layouts.get(ptyId)?.seq
        })
      }
    } else {
      // mode === 'auto' — the only non-desktop mode after the 'phone'
      // (sticky-fit) collapse. Phone-fit if the active subscriber has a
      // viewport and we haven't already applied it.
      if (subscriberRecord && !subscriberRecord.wasResizedToPhone) {
        const viewport = subscriberRecord.viewport
        if (viewport) {
          await this.handleMobileSubscribe(ptyId, subscriberRecord.clientId, viewport)
          // After a phone-fit an override IS held, so this reports false. The
          // auto branch is never reached from reclaim (it sets 'desktop'
          // first); computed here only to keep the post-condition uniform.
          return !this.terminalFitOverrides.has(ptyId)
        }
      }
      // Why: always emit the mode change even when no resize occurred — the
      // mobile client needs to learn the toggle landed even if dims didn't
      // actually change. Carry the current seq (or undefined if no layout
      // entry yet) so the mobile-side stale-event filter behaves correctly.
      const size = this.getTerminalSize(ptyId)
      this.notifyTerminalResize(ptyId, {
        cols: size?.cols ?? 0,
        rows: size?.rows ?? 0,
        displayMode: 'auto',
        reason: 'mode-change',
        seq: this.layouts.get(ptyId)?.seq
      })
    }
    return !this.terminalFitOverrides.has(ptyId)
  }

  // Why: called after a desktop renderer path has successfully resized the
  // PTY (local IPC or remote desktop viewport). The runtime mirror must take
  // the same accepted geometry so hidden-output restore parses at PTY width.
  onExternalPtyResize(ptyId: string, cols: number, rows: number): void {
    // The pty:resize IPC handler is supposed to gate via `isResizeSuppressed`
    // before calling here, but defend against callers that don't.
    if (this.isResizeSuppressed()) {
      return
    }
    // Why: while a mobile-fit override is in place, the desktop renderer's
    // safeFit echoes pty:resize(override.cols, override.rows). Treating that
    // echo as legitimate geometry would overwrite each subscriber's
    // previousCols/Rows baseline with phone dims, so the next take-back
    // enqueues a no-op {kind:'desktop', cols:49, rows:40} and leaves xterm
    // stuck. Only filter reports that EXACTLY match the override — a fresh
    // measurement from a now-visible pane (e.g. user activated a previously
    // hidden tab on desktop, container went 0×0 → 1782×1195) reports
    // different dims and is the right baseline to remember.
    const activeOverride = this.terminalFitOverrides.get(ptyId)
    if (activeOverride && activeOverride.cols === cols && activeOverride.rows === rows) {
      return
    }
    // Why: a successful host resize supersedes any target retained after a
    // failed viewer reclaim; a later viewer cycle must capture this new truth.
    this.remoteDesktopFloor.clearStaleHostReclaimTarget(ptyId)
    this.resizeHeadlessTerminal(ptyId, cols, rows)
    this.refreshRendererGeometry(ptyId, cols, rows)
  }

  // Why: pty:reportGeometry IPC sibling. The renderer calls this when a
  // desktop pane container goes from 0×0 to a real size while a mobile-fit
  // override is active (e.g. user activates a previously-hidden tab on
  // desktop after the phone has already taken the floor). We need the
  // restore-target baseline to track real desktop dims even during the
  // fit period — otherwise resolveDesktopRestoreTarget falls back to the
  // PTY's spawn default (typically 80×24) and Take Back leaves the
  // terminal partially restored. This is a measurement-only channel: it
  // refreshes lastRendererSizes and non-null subscriber baselines, never
  // resizes the PTY, and bypasses both isResizeSuppressed and the
  // override-echo gate by design — the renderer only fires it when it
  // has just measured fresh real geometry. See docs/mobile-fit-hold.md.
  recordRendererGeometry(ptyId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) {
      return
    }
    // Why: a viewer may leave while phone-fit still owns the PTY. Keep its
    // deferred host reclaim cache aligned with later trusted pane measurements.
    this.remoteDesktopFloor.updateHostReclaimTarget(ptyId, cols, rows)
    this.refreshRendererGeometry(ptyId, cols, rows)
  }

  // Why: test seam — exposes lastRendererSizes for assertions about
  // pty:reportGeometry / onExternalPtyResize side effects without making
  // the underlying Map writable from the outside.
  getLastRendererSize(ptyId: string): { cols: number; rows: number } | null {
    return this.lastRendererSizes.get(ptyId) ?? null
  }

  private refreshRendererGeometry(ptyId: string, cols: number, rows: number): void {
    this.lastRendererSizes.set(ptyId, { cols, rows })
    const inner = this.mobileSubscribers.get(ptyId)
    if (!inner) {
      return
    }
    // Refresh the renderer-current size as the next-restore target on every
    // subscriber that already has a non-null baseline. Subscribers with null
    // baselines (joined while a peer had already phone-fitted) stay null.
    for (const sub of inner.values()) {
      if (sub.previousCols != null && sub.previousRows != null) {
        sub.previousCols = cols
        sub.previousRows = rows
      }
    }
  }

  // Why: the pty:resize IPC handler calls this to check if the global
  // suppress window is active. During this window, all desktop renderer
  // pty:resize events are ignored to prevent collateral safeFit corruption.
  isResizeSuppressed(): boolean {
    return Date.now() < this.resizeSuppressedUntil
  }

  private suppressResizesForMs(ms: number): void {
    this.resizeSuppressedUntil = Date.now() + ms
  }

  subscribeToTerminalResize(
    ptyId: string,
    listener: (event: {
      cols: number
      rows: number
      displayMode: string
      reason: string
      seq?: number
    }) => void
  ): () => void {
    return addListenerToMap(this.resizeListeners, ptyId, listener)
  }

  private notifyTerminalResize(
    ptyId: string,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ): void {
    const listeners = this.resizeListeners.get(ptyId)
    if (!listeners) {
      return
    }
    notifyRuntimeListeners(listeners, (listener) => listener(event), 'pty-resize')
  }

  // Why: Section 7.2 — the runtime detects agent exit directly and updates
  // dispatch contexts immediately, rather than waiting for the coordinator's
  // next poll cycle. This catches agent crashes and unexpected exits within
  // milliseconds. The task is set back to 'pending' so it can be re-dispatched.
  private failActiveDispatchOnExit(leaf: RuntimeLeafRecord, exitCode: number): void {
    if (!this._orchestrationDb) {
      return
    }

    const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    if (!handle) {
      return
    }

    const dispatch = this._orchestrationDb.getActiveDispatchForTerminal(handle)
    if (!dispatch) {
      return
    }

    const errorContext = `Agent exited with code ${exitCode}`
    this._orchestrationDb.failDispatch(dispatch.id, errorContext)

    // Why: create an escalation message so the coordinator is notified about
    // the unexpected exit on its next check cycle, even if the circuit breaker
    // hasn't tripped yet.
    const run = this._orchestrationDb.getActiveCoordinatorRun()
    if (run) {
      this._orchestrationDb.insertMessage({
        from: handle,
        to: run.coordinator_handle,
        subject: `Agent exited unexpectedly (code ${exitCode})`,
        type: 'escalation',
        priority: 'high',
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          exitCode,
          handle
        })
      })
    }
  }

  async listTerminals(
    worktreeSelector?: string,
    limit = DEFAULT_TERMINAL_LIST_LIMIT,
    opts: {
      handles?: readonly string[]
      requireFreshPtyLiveness?: boolean
      includeVisualLayouts?: boolean
    } = {}
  ): Promise<RuntimeTerminalListResult> {
    return this.terminalList.list(worktreeSelector, limit, opts)
  }

  async inspectTerminalProcessIncarnationLiveness(
    processIncarnation: string,
    serializedHostScope: string | null
  ): Promise<'live' | 'dead' | 'unknown'> {
    const hostScope = parseWorkerTerminalHostScope(serializedHostScope)
    if (!hostScope || !this.ptyController?.listProcesses) {
      return 'unknown'
    }
    const listed = await withTimeoutResult(
      this.ptyController.listProcesses(hostScope.kind === 'ssh' ? hostScope.targetId : null),
      PTY_CONTROLLER_LIST_TIMEOUT_MS
    )
    if (!listed.ok) {
      return 'unknown'
    }
    return classifyWorkerTerminalProcessIncarnation(processIncarnation, listed.value)
  }

  private getTerminalTopologyRevision(worktreeId: string): number {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    return (
      this.getWorkspaceSessionForWorktree(worktreeId)?.terminalTopologyRevisionByRepoId?.[repoId] ??
      this.terminalTopologyRevisionByRepoId.get(repoId) ??
      0
    )
  }

  async adoptTerminalOrphans(
    request: RuntimeTerminalOrphanAdoptionRequest
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    if (request.claims.length === 0) {
      throw new Error('terminal_orphan_claims_required')
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
    const resolvedWorkspace = workspace.folderWorkspace
      ? this.folderWorkspaceToResolvedWorktree(workspace.folderWorkspace)
      : await this.resolveWorktreeSelector(`id:${workspace.id}`)
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      [resolvedWorkspace],
      workspace.id,
      undefined,
      workspace.connectionId ?? null
    )
    if (!inventory) {
      throw new Error('terminal_liveness_unavailable')
    }
    return this.adoptTerminalOrphansFromInventory(request, workspace, inventory)
  }

  private async adoptTerminalOrphansFromInventory(
    request: RuntimeTerminalOrphanAdoptionRequest,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: PtyControllerInventory
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    const store = this.store
    const session = this.getWorkspaceSessionForWorktree(workspace.id)
    if (
      !store?.setWorkspaceSession ||
      (!store.flushPendingOrThrowAsync && !store.flushOrThrow) ||
      !session
    ) {
      throw new Error('workspace_session_unavailable')
    }
    const sessionWorktreeId = resolveTerminalSessionWorktreeId(session, workspace.id)
    if (!sessionWorktreeId) {
      throw new Error('terminal_orphan_competing_owner')
    }
    const worktreeConnectionId = workspace.connectionId
    let worktreeWslDistro: string | null = null
    if (!worktreeConnectionId && workspace.repo) {
      try {
        worktreeWslDistro =
          getLocalProjectWorktreeGitOptions(this.requireStore(), workspace.repo).wslDistro ?? null
      } catch {
        throw new Error('terminal_orphan_owner_mismatch')
      }
    }
    return adoptRuntimeTerminalOrphansFromInventory({
      request,
      workspace,
      inventory,
      session,
      sessionWorktreeId,
      repoId: getRepoIdFromWorktreeId(workspace.id),
      worktreeWslDistro,
      currentRevision: this.getTerminalTopologyRevision(workspace.id),
      ports: {
        getPty: (handle) => this.getLivePtyForHandle(handle)?.pty ?? null,
        getLeaves: (ptyId) => this.getLeavesForPty(ptyId),
        getLeaf: (tabId, leafId) => this.leaves.get(this.getLeafKey(tabId, leafId)),
        getMobileSnapshots: () => this.mobileSessionTabsByWorktree.values(),
        getSession: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
        setSession: (worktreeId, next) => this.setWorkspaceSessionForWorktree(worktreeId, next),
        flushSession: () => this.flushWorkspaceSessionOrThrowAsync(),
        hydrateSession: (worktreeId) =>
          this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
            force: true,
            allowAttachedWindow: true,
            onlyRuntimeOwnedTerminals: true
          }),
        notifySessionChanged: (worktreeId) => this.notifyMobileSessionTabsChanged(worktreeId),
        getSnapshot: (worktreeId) => this.getTerminalOrphanAdoptionSnapshot(worktreeId)
      }
    })
  }

  private getTerminalOrphanAdoptionSnapshot(worktreeId: string): RuntimeMobileSessionTabsResult {
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    return this.getMobileSessionTabsForWorktree(worktreeId)
  }

  // Why: when --terminal is omitted, the CLI auto-resolves to the active
  // terminal in the current worktree — matching browser's implicit active tab.
  async resolveActiveTerminal(worktreeSelector?: string): Promise<string> {
    if (this.graphStatus !== 'ready') {
      const targetWorktreeId = worktreeSelector
        ? (await this.resolveWorktreeSelector(worktreeSelector)).id
        : null
      const snapshots = targetWorktreeId
        ? [this.getMobileSessionTabsForWorktree(targetWorktreeId)]
        : await this.listAllMobileSessionTabs()
      for (const snapshot of snapshots) {
        const activeTerminal = snapshot.tabs.find(
          (tab) =>
            tab.type === 'terminal' &&
            tab.isActive &&
            tab.status === 'ready' &&
            typeof tab.terminal === 'string'
        )
        if (activeTerminal?.type === 'terminal' && activeTerminal.terminal) {
          return activeTerminal.terminal
        }
      }
      const listed = await this.listTerminals(worktreeSelector, undefined, {
        includeVisualLayouts: false
      })
      const first = listed.terminals[0]?.handle
      if (first) {
        return first
      }
      throw new Error('no_active_terminal')
    }
    this.assertGraphReady()

    const targetWorktreeId = worktreeSelector
      ? (await this.resolveWorktreeSelector(worktreeSelector)).id
      : null

    // Prefer the tab's activeLeafId — this is the pane the user last focused
    for (const tab of this.tabs.values()) {
      if (targetWorktreeId && tab.worktreeId !== targetWorktreeId) {
        continue
      }
      if (!tab.activeLeafId) {
        continue
      }
      const leafKey = this.getLeafKey(tab.tabId, tab.activeLeafId)
      const leaf = this.leaves.get(leafKey)
      if (leaf) {
        return this.issueHandle(leaf)
      }
    }

    // Fallback: any leaf in the target worktree
    for (const leaf of this.leaves.values()) {
      if (targetWorktreeId && leaf.worktreeId !== targetWorktreeId) {
        continue
      }
      return this.issueHandle(leaf)
    }

    throw new Error('no_active_terminal')
  }

  // Why: orchestration records the pane key as the remint-stable assignee
  // identity at dispatch time; null (best-effort) rather than throwing so
  // dispatch still works for handles without a resolvable pane.
  getTerminalPaneKey(handle: string): string | null {
    return this.getPaneKeyForTerminalHandle(handle)
  }

  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null {
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed ? this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId)) : null
    return leaf?.worktreeId ?? this.getPtyRecordForPaneKey(paneKey)?.worktreeId ?? null
  }

  /** Read-only context of the worktree the user is focused on, for plugin
   *  panels (workspace.readContext). Prefers the persisted session focus and
   *  falls back to the last-focused pane's worktree; null when neither
   *  resolves so panels degrade instead of erroring. */
  async resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null> {
    let worktreeId = this.store?.getWorkspaceSession?.()?.activeWorktreeId ?? null
    if (!worktreeId && this.graphStatus === 'ready') {
      for (const tab of this.tabs.values()) {
        if (tab.activeLeafId && tab.worktreeId) {
          worktreeId = tab.worktreeId
          break
        }
      }
    }
    if (!worktreeId) {
      return null
    }
    try {
      const resolved = await this.resolveWorktreeSelector(`id:${worktreeId}`)
      return {
        worktreeId: resolved.id,
        path: resolved.git.path,
        branch: resolved.git.branch,
        displayName: resolved.displayName
      }
    } catch {
      return null
    }
  }

  getTerminalProcessIncarnation(handle: string): string | null {
    const live = this.getLivePtyForHandle(handle)
    const record = live?.record ?? this.handles.get(handle)
    if (!record?.ptyId) {
      return null
    }
    const incarnationId = live?.pty.incarnationId ?? this.ptysById.get(record.ptyId)?.incarnationId
    if (incarnationId) {
      return `${record.ptyId}:${incarnationId}`
    }
    // Why: legacy providers may omit process incarnation; retain the prior restart-degraded fence.
    return `${this.runtimeId}:${record.ptyId}:${record.ptyGeneration}`
  }

  getExactWorkerProviderSession(
    handle: string,
    observedAfter: number
  ): ExactWorkerProviderSession | null {
    const paneKey = this.getTerminalPaneKey(handle)
    const processIncarnation = this.getTerminalProcessIncarnation(handle)
    if (!paneKey || !processIncarnation) {
      return null
    }
    let connectionId: string | null | undefined
    let launchToken: string | null | undefined
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      const pty = this.ptysById.get(ptyId)
      connectionId = pty?.connectionId ?? null
      launchToken = pty?.launchToken ?? null
    } catch {
      // Exact worker validation rejects this in production; test/legacy providers may not expose PTY metadata.
      connectionId = undefined
      launchToken = undefined
    }
    return selectExactWorkerProviderSession({
      paneKey,
      processIncarnation,
      connectionId,
      launchToken,
      observedAfter,
      statuses: this.getAgentStatusSnapshotFn?.() ?? []
    })
  }

  validateOrchestrationAgentLauncher(agent: TuiAgent): void {
    const settings = this.store?.getSettings()
    if (!settings) {
      throw new Error('runtime_unavailable')
    }
    if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Agent launcher ${agent} is disabled or unavailable.`
      )
    }
  }

  resolveTerminalPane(paneKey: string, expectedWorktreeId?: string): RuntimeTerminalResolvePane {
    // Why: the renderer context menu only knows the stable pane key; main owns
    // the runtime terminal handle that agents and CLI commands can address.
    const handle = this.getTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      throw new Error('terminal_not_found')
    }
    const record = this.handles.get(handle)
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed ? this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId)) : null
    const pty = this.getPtyRecordForPaneKey(paneKey)
    const candidateWorktreeIds = [leaf?.worktreeId, pty?.worktreeId].filter(
      (worktreeId): worktreeId is string => Boolean(worktreeId)
    )
    const worktreeId = candidateWorktreeIds[0] ?? null
    if (
      (candidateWorktreeIds.length > 1 && new Set(candidateWorktreeIds).size > 1) ||
      (expectedWorktreeId && candidateWorktreeIds.some((id) => id !== expectedWorktreeId)) ||
      (expectedWorktreeId && candidateWorktreeIds.length === 0)
    ) {
      // Why: pane coordinates restored by a paired client must not cross workspace ownership.
      throw new Error('terminal_not_found')
    }
    return {
      handle,
      tabId: parsed?.tabId ?? record?.tabId ?? '',
      leafId: parsed?.leafId ?? record?.leafId ?? '',
      ptyId: record?.ptyId ?? null,
      connected: pty?.connected === true,
      ...(worktreeId ? { worktreeId } : {}),
      ...this.getPtyExecutionHostMetadata(record?.ptyId ?? pty?.ptyId ?? null)
    }
  }

  async recoverTerminalPane(
    paneKey: string,
    expectedWorktreeId: string,
    expectedHandle?: string
  ): Promise<RuntimeTerminalResolvePane> {
    const parsed = parsePaneKey(paneKey)
    const pty = this.getPtyRecordForPaneKey(paneKey)
    if (
      !parsed ||
      !pty ||
      !expectedHandle ||
      pty.worktreeId !== expectedWorktreeId ||
      this.getPaneKeyForTerminalHandle(expectedHandle) !== paneKey
    ) {
      throw new Error('terminal_not_found')
    }
    const recoveryKey = `${expectedWorktreeId}\0${paneKey}`
    const pending = this.terminalPaneRecoveryByIdentity.get(recoveryKey)
    if (pending) {
      return pending
    }
    if (pty?.connected) {
      const current = this.resolveTerminalPane(paneKey, expectedWorktreeId)
      if (expectedHandle === undefined || current.handle !== expectedHandle) {
        return current
      }
      throw new Error('terminal_not_recoverable')
    }
    if (
      !this.getRecentExpiredSshLease(expectedWorktreeId, parsed.tabId, parsed.leafId, pty.ptyId)
    ) {
      // Why: an explicit close leaves a terminated lease; only relay expiry authorizes shell recreation.
      throw new Error('terminal_not_recoverable')
    }
    // Why: disconnected PTYs can reissue handles during graph cleanup; only a connected replacement satisfies the pane CAS.
    const recovery = this.createTerminal(`id:${expectedWorktreeId}`, {
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      focus: false,
      // Why: the HUB renderer may publish its exited layout while recovery is in flight; persist the replacement before that stale graph can orphan it.
      persistHostSessionBinding: true
    }).then((terminal) => ({
      handle: terminal.handle,
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      ptyId: terminal.ptyId ?? null,
      worktreeId: expectedWorktreeId
    }))
    this.terminalPaneRecoveryByIdentity.set(recoveryKey, recovery)
    const clearRecovery = (): void => {
      if (this.terminalPaneRecoveryByIdentity.get(recoveryKey) === recovery) {
        this.terminalPaneRecoveryByIdentity.delete(recoveryKey)
      }
    }
    void recovery.then(clearRecovery, clearRecovery)
    return recovery
  }

  async showTerminal(handle: string): Promise<RuntimeTerminalShow> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const worktreesById = await this.getResolvedWorktreeMap()
      const summary = this.buildPtyTerminalSummary(pty.pty, worktreesById)
      const preview = await this.visibleSnapshotPreview(pty.pty.ptyId, summary.preview)
      this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
      return {
        ...summary,
        preview,
        tabId: pty.pty.tabId ?? pty.record.tabId,
        leafId: parsePaneKey(pty.pty.paneKey ?? '')?.leafId ?? pty.record.leafId,
        paneRuntimeId: -1,
        ptyId: pty.pty.ptyId,
        rendererGraphEpoch: this.rendererGraphEpoch
      }
    }
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktreesById = await this.getResolvedWorktreeMap()
    this.assertStableReadyGraph(graphEpoch)
    const { leaf } = this.getLiveLeafForHandle(handle)
    const summary = this.buildTerminalSummary(leaf, worktreesById)
    const preview = leaf.ptyId
      ? await this.visibleSnapshotPreview(leaf.ptyId, summary.preview)
      : summary.preview
    this.assertStableReadyGraph(graphEpoch)
    if (leaf.ptyId) {
      this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId)
    }
    return {
      ...summary,
      preview,
      paneRuntimeId: leaf.paneRuntimeId,
      ptyId: leaf.ptyId,
      rendererGraphEpoch: this.rendererGraphEpoch
    }
  }

  async readTerminal(
    handle: string,
    opts: { cursor?: number; limit?: number } = {}
  ): Promise<RuntimeTerminalRead> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const read = this.readPtyTerminal(handle, pty.pty, opts)
      const visibleRead = await this.withVisibleSnapshotFallback(pty.pty.ptyId, read, opts)
      this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
      return visibleRead
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    const read = readTerminalTail({
      handle,
      status: getTerminalState(leaf),
      previewLines: leaf.tailBuffer,
      completedLines: leaf.tailTranscriptBuffer,
      partialLine: leaf.tailPartialLine,
      completedLineCount: leaf.tailLinesTotal,
      bufferTruncated: leaf.tailTruncated,
      cursor: opts.cursor,
      limit: opts.limit
    })
    if (!leaf.ptyId) {
      return read
    }
    const visibleRead = await this.withVisibleSnapshotFallback(leaf.ptyId, read, opts)
    this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId)
    return visibleRead
  }

  // Why a cache: leaf-branch sends may arrive per keystroke; one proven-absent
  // verdict per ptyId serves the burst instead of a probe round-trip each call.
  private readonly provenAbsentLeafPtyVerdicts = new Map<string, number>()
  private readonly leafPtyAbsenceProbes = new Map<string, Promise<boolean>>()
  // Why: probe dedupe shares one promise across callers, but each caller's
  // continuation would re-deliver the same unread rows; arm one per pty.
  private readonly probeDeferredDeliveryPtyIds = new Set<string>()

  private controllerKnowsPtyIsLive(ptyId: string): boolean {
    try {
      return this.ptyController?.hasPty?.(ptyId) === true
    } catch {
      // Why: liveness lookup failures are doubt; doubt never gates a write.
      return false
    }
  }

  /** True only on controller-proven absence; live, unknown, and probe errors all answer false. */
  private isLeafPtyProvenAbsent(ptyId: string): Promise<boolean> {
    // Why hasPty and not ptysById: graph sync mirrors a connected record for
    // every leaf ptyId — including a prior process's — so runtime records can't
    // distinguish live from stale. The controller's exact-id hasPty is the
    // provider's own synchronous inventory: a known id is alive, skip probing
    // and supersede any cached verdict (the id came back).
    if (this.controllerKnowsPtyIsLive(ptyId)) {
      this.provenAbsentLeafPtyVerdicts.delete(ptyId)
      return Promise.resolve(false)
    }
    const verdictAt = this.provenAbsentLeafPtyVerdicts.get(ptyId)
    if (verdictAt !== undefined) {
      if (Date.now() - verdictAt < PROVEN_ABSENT_LEAF_PTY_TTL_MS) {
        return Promise.resolve(true)
      }
      this.provenAbsentLeafPtyVerdicts.delete(ptyId)
    }
    const probeLiveness = this.ptyController?.probePtyLiveness?.bind(this.ptyController)
    if (!probeLiveness) {
      return Promise.resolve(false)
    }
    const inFlight = this.leafPtyAbsenceProbes.get(ptyId)
    if (inFlight) {
      return inFlight
    }
    const probe = (async () => {
      try {
        if ((await probeLiveness(ptyId)) !== false) {
          return false
        }
        this.provenAbsentLeafPtyVerdicts.set(ptyId, Date.now())
        return true
      } catch {
        // Why: a failed probe is unknown, and unknown never rejects a write.
        return false
      } finally {
        this.leafPtyAbsenceProbes.delete(ptyId)
      }
    })()
    this.leafPtyAbsenceProbes.set(ptyId, probe)
    return probe
  }

  async sendTerminal(
    handle: string,
    action: {
      text?: string
      enter?: boolean
      interrupt?: boolean
    },
    options: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      reserveWrite?: (ptyId: string) => void
      afterWrite?: (ptyId: string) => void | Promise<void>
      suffixFailureError?: string
      // Why: the pre-Enter wait now scales with the payload, so an abandoned request must be
      // able to stop it instead of writing Enter minutes after the caller gave up.
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeTerminalSend> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      const payload = buildTerminalSendPayload(action)
      if (payload === null) {
        throw new Error('invalid_terminal_send')
      }
      await assertTerminalInputWithinLimitWithYield(action.text)
      await this.writeTerminalAction(pty.pty.ptyId, action, payload, options)
      return {
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(payload, 'utf8')
      }
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    const payload = buildTerminalSendPayload(action)
    if (payload === null) {
      throw new Error('invalid_terminal_send')
    }
    await assertTerminalInputWithinLimitWithYield(action.text)
    // Why: leaf.writable mirrors the renderer graph, which can still answer for
    // a prior process's ptyId — and provider writes to unknown ids are accepted
    // no-ops. Only controller-proven absence rejects; unknown proceeds (a
    // restored daemon session takes writes before its pane remounts).
    if (await this.isLeafPtyProvenAbsent(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }

    await this.writeTerminalAction(leaf.ptyId, action, payload, options)

    return {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(payload, 'utf8')
    }
  }

  async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      suffixFailureError?: string
    } = {}
  ): Promise<RuntimeTerminalSend> {
    const payload = buildAgentPromptPasteBytes(prompt)
    const bytesWritten = Buffer.byteLength(`${payload}${AGENT_PROMPT_SUBMIT}`, 'utf8')
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      await assertTerminalInputWithinLimitWithYield(payload)
      await this.writeTerminalAgentPrompt(pty.pty.ptyId, payload, options)
      return { handle, accepted: true, bytesWritten }
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    await assertTerminalInputWithinLimitWithYield(payload)
    // Why: same absence gate as sendTerminal — a stale graph mirror must not
    // accept a prompt into a void; unknown liveness still proceeds.
    if (await this.isLeafPtyProvenAbsent(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }
    await this.writeTerminalAgentPrompt(leaf.ptyId, payload, options)
    return { handle, accepted: true, bytesWritten }
  }

  getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    return this.terminalAgentStatus.getStatus(handle)
  }

  private getTerminalAgentStatusPtyId(handle: string): string {
    return this.terminalAgentStatus.getPtyId(handle)
  }

  private getTerminalAgentStatusSnapshot(
    handle: string,
    expectedPtyId: string
  ): RuntimeTerminalAgentStatusSnapshot {
    return this.terminalAgentStatus.getSnapshot(handle, expectedPtyId)
  }

  private shouldDelayPtyBackedMobileSnapshotForForegroundAgent(
    pty: RuntimePtyWorktreeRecord,
    title: string
  ): boolean {
    return (
      !pty.launchAgent && pty.foregroundAgent === null && hasCompatibleAgentTitleIdentity(title)
    )
  }

  private readPtyForegroundProcessFromController(
    ptyId: string,
    afterTitleObservation = 0
  ): Promise<PtyForegroundProcessRead> | null {
    return this.ptyForegroundAgent.read(ptyId, afterTitleObservation)
  }

  private confirmPtyAgentExit(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    const titleObservedAt = pty?.lastOscTitleAt ?? null
    const foregroundRead = this.readPtyForegroundProcessFromController(ptyId, titleObservedAt ?? 0)
    if (!pty?.connected || !foregroundRead) {
      this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
      return
    }
    void foregroundRead.then((result) => {
      const current = this.ptysById.get(ptyId)
      if (current !== pty || !current.connected) {
        return
      }
      if (current.lastOscTitleAt !== titleObservedAt && current.lastAgentStatus !== null) {
        return
      }
      if (
        result.controller === this.ptyController &&
        result.available &&
        recognizeAgentProcess(result.process) !== null
      ) {
        const restoredStatus = this.ptyTitleTrackersByPtyId
          .get(ptyId)
          ?.tracker.restoreLastAgentExit()
        if (restoredStatus !== null && restoredStatus !== undefined) {
          current.lastAgentStatus = restoredStatus
          for (const leaf of this.getLeavesForPty(ptyId)) {
            if (leaf.lastAgentStatus !== null) {
              continue
            }
            // Why: the foreground agent disproved the neutral title's exit signal; keep runtime delivery state aligned with the restored tracker.
            leaf.lastAgentStatus = restoredStatus
            if (restoredStatus === 'idle') {
              this.deliverPendingMessagesForLeaf(leaf)
            }
          }
        }
        return
      }
      this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
    })
  }

  /**
   * Schedules an asynchronous query to check which agent process is currently
   * running in the foreground of a PTY.
   */
  private refreshPtyForegroundAgent(ptyId: string): void {
    void this.ptyForegroundAgent.refresh(ptyId)
  }

  private getPendingForegroundAgentRefreshForTitle(
    ptyId: string,
    titleObservedAt: number
  ): Promise<boolean> | undefined {
    return this.ptyForegroundAgent.getPending(ptyId, titleObservedAt)
  }

  private delayPtyBackedMobileSnapshotForForegroundAgent(
    ptyId: string,
    titleObservedAt: number,
    foregroundRefresh: Promise<boolean>
  ): void {
    this.ptyForegroundAgent.delaySnapshot(ptyId, titleObservedAt, foregroundRefresh)
  }

  private getFreshExplicitAgentStatusForHandle(handle: string): {
    status: NonNullable<RuntimeTerminalAgentStatus['status']>
    updatedAt: number
    /** When this state was entered. Pinned across same-state pings, so it identifies the turn. */
    stateStartedAt: number
  } | null {
    return this.agentRows.getFreshExplicit({
      handle,
      paneKey: this.getPaneKeyForTerminalHandle(handle),
      hookRows: this.getAgentStatusSnapshotFn?.() ?? []
    })
  }

  private writeTerminalAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<void> {
    return this.terminalWriter.writeAction(ptyId, action, payload, options)
  }

  private writeTerminalInputChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<void> {
    return this.terminalWriter.writeChunks(ptyId, text, options)
  }

  /** Platform of the host whose pty transport ingests our writes -- deliberately NOT the OS
   *  the command runs under. A WSL pane is spawned as `wsl.exe` through the Windows ConPTY
   *  (see local-pty-provider), so it pays the ConPTY ingest cost even though its shell is
   *  Linux; an SSH pane is spawned by node-pty on the remote host, so the client's
   *  process.platform says nothing about it. */
  private getPtyWriteHostPlatform(ptyId: string): NodeJS.Platform {
    const pty = this.ptysById.get(ptyId)
    const connectionId = pty?.connectionId
    if (!connectionId) {
      return process.platform
    }
    const remotePlatform = getRegisteredSshState(connectionId)?.remotePlatform
    if (remotePlatform) {
      return remotePlatform
    }
    // Why: remotePlatform only arrives with the relay handshake; until then the worktree path
    // flavor is the same signal getAgentLaunchPlatformForRepo already trusts for a remote repo.
    const worktreePath = pty ? splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath : null
    return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'linux'
  }

  private async writeTerminalAgentPrompt(
    ptyId: string,
    pastePayload: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<void> {
    const renderGate = this.createClaudeAgentPromptRenderGate(ptyId)
    let wrotePasteBytes = false
    let completedPaste = false
    try {
      const chunks = iterateTerminalInputChunks(pastePayload)
      let chunk = chunks.next()
      while (!chunk.done) {
        const nextChunk = chunks.next()
        await options.beforeWrite?.(ptyId)
        if (nextChunk.done) {
          renderGate?.arm()
        }
        if (!this.ptyController?.write(ptyId, chunk.value)) {
          throw new Error('terminal_not_writable')
        }
        wrotePasteBytes = true
        chunk = nextChunk
        if (!chunk.done) {
          await yieldBetweenTerminalInputChunks()
        }
      }
      completedPaste = true
    } catch (error) {
      if (wrotePasteBytes && !completedPaste) {
        this.ptyController?.write(ptyId, AGENT_PROMPT_BRACKETED_PASTE_END)
      }
      renderGate?.dispose()
      throw error
    }

    if (renderGate) {
      await renderGate.wait()
      renderGate.dispose()
    } else {
      await new Promise((resolve) => setTimeout(resolve, AGENT_PROMPT_SUBMIT_DELAY_MS))
    }
    try {
      await options.beforeWrite?.(ptyId)
    } catch (error) {
      if (options.suffixFailureError) {
        throw new Error(options.suffixFailureError)
      }
      throw error
    }
    if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT)) {
      throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
    }
  }

  private createClaudeAgentPromptRenderGate(ptyId: string): {
    arm: () => void
    wait: () => Promise<void>
    dispose: () => void
  } | null {
    const pty = this.ptysById.get(ptyId)
    if ((pty?.launchAgent ?? pty?.foregroundAgent) !== 'claude') {
      return null
    }
    let armed = false
    let observedMarker = false
    let settled = false
    let ingested = pasteIngestMs <= 0
    // Why absolute: the ingest clock starts once, here, but the cap is armed twice (at arm()
    // and again on the marker). Re-adding the whole window would charge ingest twice.
    const ingestDeadlineAt = Date.now() + pasteIngestMs
    let markerCarry = ''
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let ingestTimer: NodeJS.Timeout | null = null
    let resolveRender!: () => void
    const rendered = new Promise<void>((resolve) => {
      resolveRender = resolve
    })

    const clearGateTimers = (): void => {
      if (quietTimer) {
        clearTimeout(quietTimer)
        quietTimer = null
      }
      if (hardTimer) {
        clearTimeout(hardTimer)
        hardTimer = null
      }
      if (ingestTimer) {
        clearTimeout(ingestTimer)
        ingestTimer = null
      }
    }
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearGateTimers()
      resolveRender()
    }
    const armQuietTimer = (): void => {
      // Why: the quiet window measures the agent going still after a *complete* paste.
      // Silence during ingest is not settlement, so it cannot start the clock.
      if (!ingested) {
        return
      }
      if (quietTimer) {
        clearTimeout(quietTimer)
      }
      quietTimer = setTimeout(finish, CLAUDE_AGENT_PROMPT_RENDER_QUIET_MS)
    }
    const unsubscribe = this.subscribeToTerminalData(ptyId, (data) => {
      if (!armed || settled) {
        return
      }
      if (!observedMarker) {
        const combined = markerCarry + data
        markerCarry = combined.slice(-(CLAUDE_AGENT_PROMPT_RENDER_MARKER.length - 1))
        if (!combined.includes(CLAUDE_AGENT_PROMPT_RENDER_MARKER)) {
          return
        }
        observedMarker = true
      }
      armQuietTimer()
    })
    return {
      arm: () => {
        armed = true
        markerCarry = ''
      },
      wait: async () => {
        if (settled) {
          return
        }
        hardTimer = setTimeout(finish, CLAUDE_AGENT_PROMPT_RENDER_TIMEOUT_MS)
        await rendered
      },
      dispose: () => {
        unsubscribe()
        clearGateTimers()
      }
    }
  }

  waitForTerminal(
    handle: string,
    options?: {
      condition?: RuntimeTerminalWaitCondition
      timeoutMs?: number
      signal?: AbortSignal
    }
  ): Promise<RuntimeTerminalWait> {
    return this.terminalWait.wait(handle, options)
  }

  async waitForSetupTerminalCompletion(handle: string): Promise<{ exitCode: number | null }> {
    const ptyId = this.getLivePtyForHandle(handle)?.pty.ptyId
    if (!ptyId) {
      throw new Error('terminal_handle_stale')
    }
    const completionToken = this.setupCompletionTokenByPtyId.get(ptyId)
    const exitAbort = new AbortController()
    return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let settled = false
      let unsubscribe: (() => void) | null = null
      const cleanup = (): void => {
        unsubscribe?.()
        exitAbort.abort()
      }
      const finish = (exitCode: number | null): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        this.setupCompletionTokenByPtyId.delete(ptyId)
        resolve({ exitCode })
      }
      const fail = (error: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
      const scanner = completionToken ? createSetupCompletionScanner(completionToken, finish) : null

      if (scanner) {
        unsubscribe = this.subscribeToTerminalData(ptyId, scanner.scan)
      }
      // Why: setup can finish before the observer is registered on fast local worktrees.
      const replay = this.recentPtyOutputById.get(ptyId)?.read()
      if (scanner && replay) {
        scanner.scan(replay)
      }
      if (!settled) {
        void this.waitForTerminal(handle, {
          condition: 'exit',
          signal: exitAbort.signal
        })
          .then((wait) => {
            if (wait.satisfied && wait.condition === 'exit' && wait.status === 'exited') {
              finish(wait.exitCode)
            }
          })
          .catch(fail)
      }
    })
  }

  async getWorktreePs(limit = DEFAULT_WORKTREE_PS_LIMIT): Promise<{
    worktrees: RuntimeWorktreePsSummary[]
    totalCount: number
    truncated: boolean
  }> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolvedWorktreeSnapshot = await this.listResolvedWorktreeSnapshot()
    const visibilitySourceMatchersByRepoId = this.buildRuntimeVisibilitySourceMatchersByRepoId(
      resolvedWorktreeSnapshot.worktrees
    )
    const resolvedWorktrees = resolvedWorktreeSnapshot.worktrees.filter((worktree) =>
      this.isRuntimeWorktreeVisible(worktree, visibilitySourceMatchersByRepoId.get(worktree.repoId))
    )
    // Why: worktree.ps backs the mobile sidebar, so it must use the same
    // host-owned imported-worktree visibility gate as worktree.list/desktop.
    const freshPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    const repoById = new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
    const platformByRepoId = resolvedWorktreeSnapshot.platformByRepoId
    const summaries = buildRuntimeWorktreePsSummaries({
      store: this.store,
      resolvedWorktrees,
      platformByRepoId
    })

    const runtimeWorktreeSummaryPathIndex = buildRuntimeWorktreeSummaryPathIndex(
      summaries,
      resolvedWorktrees,
      platformByRepoId
    )
    const missingRuntimeWorktreeIds = new Set<string>()
    const session = this.store?.getWorkspaceSession?.()
    applyRuntimeWorktreePsTerminalActivity({
      summaries,
      pathIndex: runtimeWorktreeSummaryPathIndex,
      missingIds: missingRuntimeWorktreeIds,
      freshPtyLiveness,
      leaves: this.leaves.values(),
      ptysById: this.ptysById,
      tabs: this.tabs,
      session,
      getSummary: (summaryMap, pathIndex, missingIds, worktreeId) =>
        this.getSummaryForRuntimeWorktreeId(summaryMap, pathIndex, missingIds, worktreeId)
    })
    const { mirroredWorktreeIdByTabId, connectedPtyEvidence } =
      applyRuntimeWorktreePsSessionActivity({
        store: this.store,
        summaries,
        repoById,
        pathIndex: runtimeWorktreeSummaryPathIndex,
        missingIds: missingRuntimeWorktreeIds,
        ptysById: this.ptysById,
        tabs: this.tabs,
        getSummary: (summaryMap, pathIndex, missingIds, worktreeId) =>
          this.getSummaryForRuntimeWorktreeId(summaryMap, pathIndex, missingIds, worktreeId)
      })
    attachRuntimeWorktreeAgentRows({
      summaries,
      pathIndex: runtimeWorktreeSummaryPathIndex,
      missingWorktreeIds: missingRuntimeWorktreeIds,
      mirroredWorktreeIdByTabId,
      connectedPtyEvidence,
      retainedSnapshots: this.agentRows.values(),
      hookSnapshots: this.getAgentStatusSnapshotFn?.() ?? [],
      orchestrationByPaneKey: this.agentOrchestrationProjection.buildByPaneKey(),
      getSummary: (summaryMap, pathIndex, missingIds, worktreeId) =>
        this.getSummaryForRuntimeWorktreeId(summaryMap, pathIndex, missingIds, worktreeId)
    })

    const sorted = [...summaries.values()].sort(compareWorktreePs)
    return {
      worktrees: sorted.slice(0, limit),
      totalCount: sorted.length,
      truncated: sorted.length > limit
    }
  }

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }

  enrichMissingRepoGitRemoteIdentities(): void {
    if (!this.store) {
      return
    }
    enrichMissingRepoGitRemoteIdentities(this.store, {
      onChanged: () => {
        this.invalidateResolvedWorktreeCache()
        this.notifyReposChanged()
      }
    })
  }

  async inspectTerminalProcess(
    terminalSelector: string
  ): Promise<{ foregroundProcess: string | null; hasChildProcesses: boolean; unavailable?: true }> {
    const leaf = this.resolveLiveLeafForHandle(terminalSelector)
    if (!leaf?.ptyId || !this.ptyController) {
      throw new Error('terminal_gone')
    }
    if (this.ptyController.inspectProcess) {
      return this.ptyController.inspectProcess(leaf.ptyId)
    }
    const foregroundProcess = await this.ptyController.getForegroundProcess(leaf.ptyId)
    const hasChildProcesses = (await this.ptyController.hasChildProcesses?.(leaf.ptyId)) ?? false
    return { foregroundProcess, hasChildProcesses }
  }

  async searchRepoRefs(
    repoSelector: string,
    query: string,
    limit = DEFAULT_REPO_SEARCH_REFS_LIMIT
  ): Promise<RuntimeRepoSearchRefs> {
    return this.repositoryRefQueries.search(repoSelector, query, limit)
  }

  private async resolveHostedReviewTarget(args: {
    repoSelector: string
    worktreeSelector?: string
  }): Promise<{ repo: Repo; repoPath: string }> {
    const repo = await this.resolveRepoSelector(args.repoSelector)
    if (!args.worktreeSelector) {
      return { repo, repoPath: repo.path }
    }

    const worktree = await this.resolveWorktreeSelector(args.worktreeSelector)
    if (worktree.repoId !== repo.id) {
      throw new Error('Access denied: worktree does not belong to repository')
    }
    return { repo, repoPath: worktree.path }
  }

  private getHostedReviewExecutionOptions(
    repo: Repo
  ): { localGitExecOptions: { wslDistro?: string } } | undefined {
    const localGitOptions = this.getLocalGitExecutionOptionArgs(repo)[0] ?? {}
    return Object.keys(localGitOptions).length > 0
      ? { localGitExecOptions: localGitOptions }
      : undefined
  }

  private getLocalGitExecutionOptionArgs(repo: Repo): [] | [{ wslDistro?: string }] {
    const localGitOptions = getLocalProjectWorktreeGitOptions(this.requireStore(), repo)
    return Object.keys(localGitOptions).length > 0 ? [localGitOptions] : []
  }

  private getAgentLaunchPlatformForRepo(repo: Repo): NodeJS.Platform {
    const projectRuntime = repo.connectionId
      ? undefined
      : resolveLocalProjectRuntimeForRepo(this.requireStore(), repo)
    return getAgentLaunchPlatformForRepo(repo, projectRuntime)
  }

  private getAgentLaunchPlatformForWorkspace(scope: TerminalWorkspaceLaunchScope): NodeJS.Platform {
    if (scope.repo) {
      return this.getAgentLaunchPlatformForRepo(scope.repo)
    }
    if (scope.connectionId) {
      return isWindowsAbsolutePathLike(scope.path) ? 'win32' : 'linux'
    }
    return isWslUncPath(scope.path) ? 'linux' : process.platform
  }

  private readonly hostedReviews = new RuntimeHostedReviewCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    resolveTarget: (args) => this.resolveHostedReviewTarget(args),
    getExecutionOptions: (repo) => this.getHostedReviewExecutionOptions(repo),
    recordCreated: (repoId, number, url) => {
      if (!this.stats || this.stats.hasCountedPR(url)) {
        return
      }
      this.stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId,
        meta: { prNumber: number, prUrl: url }
      })
    }
  })
  private readonly gitHubRepositoryQueries = new RuntimeGitHubRepositoryQueryCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })
  private readonly gitLabQueryCommands = new RuntimeGitLabQueryCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo),
    recordProjectRecent: (projectRef) => {
      if (!this.store?.updateSettings) {
        return
      }
      const store = this.store
      recordGitLabProjectRecent(
        {
          getSettings: () => store.getSettings(),
          updateSettings: (updates) => store.updateSettings?.(updates)
        },
        projectRef.host,
        projectRef.path
      )
    }
  })
  private readonly gitLabMutationCommands = new RuntimeGitLabMutationCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  private readonly gitHubReviewQueries = new RuntimeGitHubReviewQueryCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })
  private readonly gitHubReviewMutations = new RuntimeGitHubReviewMutationCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })
  private readonly gitHubIssueComments = new RuntimeGitHubIssueCommentCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    getLocalGitArgs: (repo) => this.getLocalGitExecutionOptionArgs(repo)
  })

  private readonly gitHubProjectCommands = new RuntimeGitHubProjectCommands()
  private readonly repositoryHooks = new RuntimeRepositoryHooksCommands({
    resolveRepo: (selector) => this.resolveRepoSelector(selector)
  })
  private readonly repositoryIssueCommand = new RuntimeRepositoryIssueCommand({
    resolveRepo: (selector) => this.resolveRepoSelector(selector)
  })
  listManagedWorktrees(
    repoSelector?: string,
    limit = DEFAULT_WORKTREE_LIST_LIMIT
  ): Promise<RuntimeWorktreeListResult> {
    return this.managedWorktreeQueries.list(repoSelector, limit)
  }

  async listDetectedManagedWorktrees(
    repoSelector: string,
    connectionId?: string | null
  ): Promise<DetectedWorktreeListResult> {
    return this.listDetectedWorktreesForResolvedRepo(
      await this.resolveRepoSelectorForConnection(repoSelector, connectionId)
    )
  }

  private listDetectedWorktreesForResolvedRepo(repo: Repo): Promise<DetectedWorktreeListResult> {
    return this.managedWorktreeQueries.listDetected(repo)
  }

  async teardownMissingManagedWorktreeTerminals(
    repoSelector: string,
    knownWorktreeIds: readonly string[],
    connectionId?: string | null
  ): Promise<{ stoppedWorktreeIds: string[] }> {
    const repo = await this.resolveRepoSelectorForConnection(repoSelector, connectionId)
    // Why: killing PTYs must be proven against the host right now — a cached scan
    // (30s TTL) can still list a directory git already dropped, and the renderer
    // purges its state either way, so a stale miss strands those processes for good.
    this.invalidateWorktreeScanCacheForRepo(repo.id)
    // Why: rescanning by `id:` would re-resolve the already-resolved repo, and a
    // duplicate id across hosts makes that second lookup throw selector_ambiguous
    // even though the caller's selector was unique — losing the sweep entirely.
    const detected = await this.listDetectedWorktreesForResolvedRepo(repo)
    if (!detected.authoritative) {
      return { stoppedWorktreeIds: [] }
    }
    return stopMissingWorktreeTerminals(
      repo,
      knownWorktreeIds,
      detected.worktrees.map((worktree) => worktree.id),
      {
        runtime: this as RuntimeCommandSurfaceHost<this>,
        getLocalProvider: () => this.getLocalProvider(),
        getSshProvider: (connectionId) => this.getSshProviderFn?.(connectionId),
        onPtyStopped: this.onPtyStopped ?? undefined
      }
    )
  }

  private resolveRepoSelectorForConnection(
    repoSelector: string,
    connectionId?: string | null
  ): Promise<Repo> {
    return this.managedWorktreeQueries.resolveRepoForConnection(repoSelector, connectionId)
  }

  private isRuntimeWorktreeVisible(
    worktree: Worktree,
    worktreeVisibilitySourceMatcher?: WorktreeVisibilitySourceMatcher
  ): boolean {
    return this.managedWorktreeQueries.isVisible(worktree, worktreeVisibilitySourceMatcher)
  }

  private buildRuntimeVisibilitySourceMatchersByRepoId(
    worktrees: readonly Worktree[]
  ): Map<string, WorktreeVisibilitySourceMatcher> {
    return this.managedWorktreeQueries.buildVisibilityMatchers(worktrees)
  }

  async showManagedWorktree(worktreeSelector: string) {
    return await this.resolveWorktreeSelector(worktreeSelector)
  }

  async showManagedTerminalWorkspace(worktreeSelector: string) {
    const target = await this.resolveTerminalWorkspaceLaunchTarget(worktreeSelector)
    if (!target.managedWorktree) {
      throw new Error('selector_not_found')
    }
    return target.managedWorktree
  }

  async scanWorkspacePorts(repoId?: string): Promise<WorkspacePortScanResult> {
    return scanWorkspacePortProbes(await this.getWorkspacePortProbes(repoId))
  }

  async killWorkspacePort(args: WorkspacePortKillRequest): Promise<WorkspacePortKillResult> {
    return killWorkspacePort(await this.getWorkspacePortProbes(args.repoId), args)
  }

  // Why: remote clients may invoke this over RPC, so the runtime derives
  // allowed worktree paths from its own store instead of trusting client paths.
  private async getWorkspacePortProbes(repoId?: string): Promise<WorkspacePortProbe[]> {
    const reposById = new Map(
      this.requireStore()
        .getRepos()
        .map((repo) => [repo.id, repo])
    )
    return filterWorkspacePortProbes(
      (await this.listResolvedWorktrees()).map((worktree) => ({
        id: worktree.id,
        repoId: worktree.repoId,
        displayName: worktree.displayName,
        path: worktree.git.path,
        connectionId: reposById.get(worktree.repoId)?.connectionId ?? null
      })),
      repoId
    )
  }

  async sleepManagedWorktree(worktreeSelector: string): Promise<{ worktreeId: string }> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    // Why: sleep is renderer-initiated on desktop (it tears down tab state
    // before killing PTYs). The notifier tells the renderer to run its own
    // sleep flow so all cleanup happens in the correct order.
    this.notifier?.sleepWorktree(worktree.id)
    return { worktreeId: worktree.id }
  }

  async activateManagedWorktree(
    worktreeSelector: string,
    opts: {
      notifyClients?: boolean
      clientKind?: 'mobile' | 'runtime'
      navigation?: RuntimeNavigationTarget
    } = {}
  ): Promise<{
    repoId: string
    worktreeId: string
    activated: boolean
    /** Mobile-scoped slept-agent wake outcome. `unsupported-headless` means no
     *  renderer holds the sleeping records (headless `orca serve`), so nothing
     *  woke — clients must not present the worktree's agents as resumed. */
    sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable'
  }> {
    this.assertGraphReady()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    const navigation = opts.navigation ?? (opts.notifyClients === false ? 'caller' : 'all')
    const targetsHost = navigationTargetsHost(navigation)
    const targetsClients = navigationTargetsClients(navigation)

    if (!targetsHost && this.store?.getWorktreeMeta(worktree.id)?.isUnread) {
      // Why: mobile/web session activation intentionally bypasses renderer
      // selection, so the runtime must acknowledge the unread state itself.
      this.store.setWorktreeMeta(worktree.id, { isUnread: false })
      this.notifyWorktreesChanged(repo.id)
    }

    let sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable' =
      'not-applicable'
    if (targetsHost || targetsClients) {
      // Why: inactive worktree terminal panes are renderer-owned and may not have
      // live PTYs until the desktop activates the worktree and mounts them.
      if (targetsHost) {
        this.notifyHostActivateWorktree(repo.id, worktree.id)
      }
      if (targetsClients) {
        this.notifyClientsActivateWorktree(repo.id, worktree.id)
      }
    }
    if (!targetsHost) {
      // Why: mobile/web selection needs fresh session surfaces without forcing
      // every attached desktop renderer to navigate to the phone's workspace.
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktree.id, {
        allowAttachedWindow: true
      })
      await this.refreshMobileSessionPtyRecords()
      this.notifyMobileSessionTabsChanged(worktree.id)
      // Why: a phone open must also wake the worktree's slept agents (experimental
      // agent sleep). Only the host renderer holds the sleeping records + wake
      // authority, so fire-and-forget ask it — mobile-scoped so web/desktop are
      // unaffected. Headless serve has no renderer to wake anything, so report
      // that explicitly instead of letting mobile assume the agents resumed.
      if (opts.clientKind === 'mobile') {
        if (this.getAvailableAuthoritativeWindow()) {
          this.notifier?.resumeSleepingAgents?.(worktree.id)
          sleepingAgentWake = 'requested'
        } else if (
          // Why: sleeping records are partitioned by execution host; reading
          // only the local partition would miss slept agents on SSH-host
          // worktrees and skip the headless warning for them.
          Object.values(
            this.store?.getWorkspaceSession?.(getRepoExecutionHostId(repo))
              .sleepingAgentSessionsByPaneKey ?? {}
          ).some((record) => record.worktreeId === worktree.id)
        ) {
          // Why: headless is only degraded when this worktree actually has a
          // persisted resume record. Ordinary mobile activation must not show
          // an unsupported warning merely because no desktop window is open.
          sleepingAgentWake = 'unsupported-headless'
        }
      }
    }
    return { repoId: repo.id, worktreeId: worktree.id, activated: true, sleepingAgentWake }
  }

  private async buildStartupForDraft(
    repo: Repo,
    draft: string,
    requestedAgent?: TuiAgent
  ): Promise<{
    agent: TuiAgent
    startup: WorktreeStartupLaunch
    draftPaste?: WorktreeStartupDraftPaste
  } | null> {
    if (!this.store) {
      return null
    }
    return buildWorktreeStartupForDraft({
      repo,
      draft,
      ...(requestedAgent ? { requestedAgent } : {}),
      settings: this.store.getSettings(),
      getLaunchPlatform: () => this.getAgentLaunchPlatformForRepo(repo)
    })
  }

  private buildStartupForAgent(
    repo: Repo,
    agent: TuiAgent,
    prompt: string | undefined,
    launchPreferences?: AgentLaunchPreferences
  ): { agent: TuiAgent; startup: WorktreeStartupLaunch; followup?: WorktreeStartupFollowup } {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return buildWorktreeStartupForAgent({
      repo,
      agent,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(launchPreferences ? { launchPreferences } : {}),
      settings: this.store.getSettings(),
      getLaunchPlatform: () => this.getAgentLaunchPlatformForRepo(repo),
      toSessionOptions: (preferences) => this.toAgentSessionOptions(preferences)
    })
  }

  private markLocalWorkspaceTrustedForAgent(agent: TuiAgent, workspacePath: string): void {
    markLocalWorktreeTrusted(agent, workspacePath)
  }

  private async markRemoteWorkspaceTrustedForAgent(
    agent: TuiAgent,
    connectionId: string,
    workspacePath: string
  ): Promise<void> {
    await markRemoteWorktreeTrusted(agent, connectionId, workspacePath)
  }

  private recordCreatedWorktreeLineage(
    worktree: Pick<Worktree, 'id' | 'instanceId'>,
    lineageResolution: WorktreeLineageResolution
  ): {
    lineage: WorktreeLineage | null
    workspaceLineage: WorkspaceLineage | null
    warnings: WorktreeLineageWarning[]
  } {
    return recordCreatedWorktreeLineageState(this.store, worktree, lineageResolution)
  }

  private pasteStartupDraftWhenReady(handle: string, draft: WorktreeStartupDraftPaste): void {
    pasteWorktreeStartupDraftWhenReady(this.getWorktreeStartupReadinessHost(), handle, draft)
  }

  private sendStartupFollowupWhenReady(handle: string, followup: WorktreeStartupFollowup): void {
    sendWorktreeStartupFollowupWhenReady(this.getWorktreeStartupReadinessHost(), handle, followup)
  }

  private async provisionManagedWorktreeTerminals(args: {
    worktreeSelector: string
    worktreeId: string
    worktreePath: string
    setup?: CreateWorktreeResult['setup']
    defaultTabs?: CreateWorktreeResult['defaultTabs']
    primaryTerminalHandle?: string | null
    hasStartupTerminal: boolean
    setupCommandPlatform: 'windows' | 'posix'
    observeSetupCompletion?: boolean
    // Why: when the agent startup is sequenced to wait for setup
    // (waitForAgentStartup), the startup PTY runs a wrapper that already embeds
    // the setup command. Pass that wrapped command through so the Setup tab runs
    // the same script the agent is waiting on instead of a bare runner.
    wrappedSetupCommand?: string
    // Why: a workspace provisioned in the background must not pull the sidebar
    // to itself; the user never asked to look at these tabs.
    surfaceOwner?: false
  }): Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null }> {
    return provisionWorktreeTerminals(this.getWorktreeTerminalProvisioningHost(), args)
  }

  private getWorktreeTerminalProvisioningHost(): WorktreeTerminalProvisioningHost {
    return {
      canSpawn: () => Boolean(this.ptyController?.spawn),
      createTerminal: (selector, options) =>
        this.createTerminal(selector, options as TerminalCreateOptions),
      splitTerminal: (handle, options) =>
        this.splitTerminal(handle, options as WorktreeProvisionTerminalOptions),
      setTabColor: async (worktreeId, tabId, color) => {
        await this.setMobileSessionTabProps(`id:${worktreeId}`, { tabId, color })
      },
      getSettings: () => this.requireStore().getSettings(),
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId,
      recordSetupCompletionToken: (ptyId, token) =>
        this.setupCompletionTokenByPtyId.set(ptyId, token)
    }
  }

  private getWorktreeStartupReadinessHost(): WorktreeStartupReadinessHost {
    return {
      getPtyId: (handle) => this.getLivePtyForHandle(handle)?.pty.ptyId ?? null,
      getForegroundProcess: (ptyId) => this.ptyController!.getForegroundProcess(ptyId),
      hasChildProcesses: (ptyId) =>
        this.ptyController!.hasChildProcesses?.(ptyId) ?? Promise.resolve(false),
      subscribeToData: (ptyId, listener) => this.subscribeToTerminalData(ptyId, listener),
      readRecentOutput: (ptyId) => this.recentPtyOutputById.get(ptyId)?.read(),
      write: (ptyId, data) => this.ptyController?.write(ptyId, data)
    }
  }

  async prefetchManagedWorktreeCreateBase(args: {
    repoSelector: string
    baseBranch?: string
  }): Promise<void> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    await prefetchWorktreeCreateBase({
      repo,
      baseBranch: args.baseBranch,
      runtime: this
    })
  }

  async createManagedWorktree(
    args: RuntimeManagedWorktreeCreateArgs
  ): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }

    const repo = await this.resolveRepoSelector(args.repoSelector)
    const createSettings = this.store.getSettings()
    const requestedAgent = args.startupAgent ?? args.createdWithAgent
    const requestedAgentEnabled =
      requestedAgent !== undefined
        ? isTuiAgentEnabled(requestedAgent, createSettings.disabledTuiAgents)
        : false
    if ((args.startup || args.startupAgent) && requestedAgent && !requestedAgentEnabled) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    if (
      args.startup &&
      args.startupDraftPaste &&
      !isTuiAgentEnabled(args.startupDraftPaste.agent, createSettings.disabledTuiAgents)
    ) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    const agentStartup =
      !args.startup && args.startupAgent
        ? this.buildStartupForAgent(
            repo,
            args.startupAgent,
            args.startupPrompt,
            args.startupLaunchPreferences
          )
        : null
    const draftStartup =
      !args.startup && !agentStartup && args.startupDraft
        ? await this.buildStartupForDraft(repo, args.startupDraft, requestedAgent)
        : null
    const effectiveStartup = args.startup ?? agentStartup?.startup ?? draftStartup?.startup
    const effectiveStartupFollowup = agentStartup?.followup
    const effectiveCreatedWithAgent = args.startup
      ? args.createdWithAgent
      : (agentStartup?.agent ??
        draftStartup?.agent ??
        (requestedAgentEnabled ? requestedAgent : undefined))
    const effectiveDraftPaste = args.startupDraftPaste ?? draftStartup?.draftPaste
    if (isFolderRepo(repo)) {
      return createRuntimeFolderWorktree({
        request: args,
        repo,
        startup: effectiveStartup,
        startupFollowup: effectiveStartupFollowup,
        createdWithAgent: effectiveCreatedWithAgent,
        draftPaste: effectiveDraftPaste,
        deps: {
          store: this.store,
          ptySpawnAvailable: Boolean(this.ptyController?.spawn),
          createTerminal: (selector, options) => this.createTerminal(selector, options),
          markTrusted: (agent, path) => this.markLocalWorkspaceTrustedForAgent(agent, path),
          pasteDraft: (handle, draft) => this.pasteStartupDraftWhenReady(handle, draft),
          sendFollowup: (handle, followup) => this.sendStartupFollowupWhenReady(handle, followup),
          invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
          notifyWorktreesChanged: (repoId) => this.notifyWorktreesChanged(repoId),
          emitCreated: (event) => this.emitWorktreeLifecycle(event),
          activate: (repoId, worktreeId, setup, startup) =>
            this.notifyActivateWorktree(repoId, worktreeId, setup, startup)
        }
      })
    }
    const lineageInput =
      args.lineage || args.comment ? { ...args.lineage, comment: args.comment } : undefined
    const lineageResolution = await this.resolveLineageForWorktreeCreate(lineageInput)
    if (repo.connectionId) {
      const result = await this.createManagedRemoteWorktree(repo, {
        ...args,
        activate: args.activate,
        ...(effectiveStartup ? { startup: effectiveStartup } : {}),
        ...(effectiveStartupFollowup ? { startupFollowup: effectiveStartupFollowup } : {}),
        ...(effectiveCreatedWithAgent ? { createdWithAgent: effectiveCreatedWithAgent } : {}),
        ...(effectiveDraftPaste ? { startupDraftPaste: effectiveDraftPaste } : {})
      })
      const recordedLineage = this.recordCreatedWorktreeLineage(result.worktree, lineageResolution)
      this.emitWorktreeLifecycle({
        kind: 'created',
        worktreeId: result.worktree.id,
        path: result.worktree.path,
        branch: result.worktree.branch
      })
      return {
        ...result,
        worktree: {
          ...result.worktree,
          parentWorktreeId: recordedLineage.lineage?.parentWorktreeId ?? null,
          childWorktreeIds: result.worktree.childWorktreeIds ?? [],
          lineage: recordedLineage.lineage,
          workspaceLineage: recordedLineage.workspaceLineage
        },
        ...(lineageInput
          ? {
              lineage: recordedLineage.lineage,
              workspaceLineage: recordedLineage.workspaceLineage,
              warnings: recordedLineage.warnings
            }
          : {})
      }
    }
    const { worktree, worktreePath, includeCopyWarning, created, addResult } =
      await createRuntimeLocalManagedWorktree({
        request: args,
        repo,
        store: this.requireStore(),
        createdWithAgent: effectiveCreatedWithAgent,
        hostedReviewExecutionContext: this.getHostedReviewExecutionOptions(repo),
        resolveRemoteTrackingBase: (path, base, ...options) =>
          this.resolveRemoteTrackingBase(path, base, ...options),
        hasRemoteTrackingRef: (path, base, ...options) =>
          this.hasRemoteTrackingRef(path, base, ...options),
        refreshRemoteTrackingBase: (path, base, ...options) =>
          this.getOrStartRemoteTrackingBaseRefresh(path, base, ...options),
        fetchRemote: (path, remote, ...options) =>
          this.fetchRemoteWithCache(path, remote, ...options)
      })
    const settings = createSettings
    const {
      lineage,
      workspaceLineage,
      warnings: lineageWarnings
    } = this.recordCreatedWorktreeLineage(worktree, lineageResolution)

    let {
      setup,
      defaultTabs,
      warning,
      effectiveDecision,
      hookFound,
      shouldRunSetup,
      didStartInProcessSetupHook
    } = await prepareRuntimeLocalWorktreeSetup({
      request: args,
      repo,
      worktreePath,
      settings,
      runtimeTarget: this.getLocalGitExecutionOptionArgs(repo)[0],
      shouldUseSetupRunner:
        this.authoritativeWindowId !== null ||
        Boolean(effectiveStartup) ||
        Boolean(this.ptyController?.spawn),
      warning: includeCopyWarning
    })

    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repo.id)
    // Why: the filesystem-auth layer maintains a separate cache of registered
    // worktree roots used by git IPC handlers (branchCompare, diff, status, etc.)
    // to authorize paths. Without invalidating it here, CLI-created worktrees
    // are not recognized and all git operations fail with "Access denied:
    // unknown repository or worktree path".
    invalidateAuthorizedRootsCache()

    this.notifyWorktreesChanged(repo.id)
    const {
      warning: terminalWarning,
      returnedSetup,
      didSpawnSetup,
      didSpawnStartup,
      setupTerminalHandle,
      startupTerminalHandle,
      startupTerminalTabId,
      startupTerminalPaneKey,
      startupTerminalPtyId
    } = await startRuntimeLocalWorktreeTerminals({
      request: args,
      repo,
      worktree,
      setup,
      defaultTabs,
      startup: effectiveStartup,
      startupFollowup: effectiveStartupFollowup,
      createdWithAgent: effectiveCreatedWithAgent,
      draftPaste: effectiveDraftPaste,
      warning,
      ports: {
        canSpawn: Boolean(this.ptyController?.spawn),
        markTrusted: (agent, path) => this.markLocalWorkspaceTrustedForAgent(agent, path),
        createTerminal: (selector, options) => this.createTerminal(selector, options),
        pasteDraft: (handle, draft) => this.pasteStartupDraftWhenReady(handle, draft),
        sendFollowup: (handle, followup) => this.sendStartupFollowupWhenReady(handle, followup),
        provision: (options) => this.provisionManagedWorktreeTerminals(options),
        activate: (repoId, worktreeId, activationSetup, startup, activationDefaultTabs) =>
          this.notifyActivateWorktree(
            repoId,
            worktreeId,
            activationSetup,
            startup,
            activationDefaultTabs
          )
      }
    })
    warning = terminalWarning
    this.emitWorktreeLifecycle({
      kind: 'created',
      worktreeId: worktree.id,
      path: worktree.path,
      branch: worktree.branch
    })
    return {
      worktree: {
        ...worktree,
        parentWorktreeId: lineage?.parentWorktreeId ?? null,
        childWorktreeIds: [],
        lineage,
        workspaceLineage,
        git: created
      },
      ...(lineageInput ? { lineage, workspaceLineage, warnings: lineageWarnings } : {}),
      ...(returnedSetup ? { setup: returnedSetup } : {}),
      ...(args.awaitTerminalProvisioning
        ? {
            setupReceipt: {
              requested: effectiveDecision,
              hookFound,
              startupPolicy: setup?.waitForAgentStartup
                ? ('wait-for-setup' as const)
                : ('start-immediately' as const),
              state: !hookFound
                ? ('not_configured' as const)
                : effectiveDecision === 'skip' || !shouldRunSetup
                  ? ('skipped' as const)
                  : // Why: the in-process hook is already executing, so reporting
                    // spawn_failed would strand callers that retry on it.
                    didSpawnSetup || didStartInProcessSetupHook
                    ? ('running' as const)
                    : ('spawn_failed' as const),
              ...(setupTerminalHandle ? { terminalHandle: setupTerminalHandle } : {})
            }
          }
        : {}),
      ...(defaultTabs ? { defaultTabs } : {}),
      ...(warning ? { warning } : {}),
      ...(addResult.localBaseRefRefresh
        ? { localBaseRefRefresh: addResult.localBaseRefRefresh }
        : {}),
      ...(addResult.localBaseRefUpdateSuggestion
        ? { localBaseRefUpdateSuggestion: addResult.localBaseRefUpdateSuggestion }
        : {}),
      ...(didSpawnStartup && startupTerminalHandle
        ? {
            startupTerminal: {
              spawned: true,
              handle: startupTerminalHandle,
              ...(startupTerminalTabId ? { tabId: startupTerminalTabId } : {}),
              ...(startupTerminalPaneKey ? { paneKey: startupTerminalPaneKey } : {}),
              ...(startupTerminalPtyId ? { ptyId: startupTerminalPtyId } : {}),
              surface: 'background' as const
            }
          }
        : {})
    }
  }

  private createManagedRemoteWorktree(
    repo: Repo,
    args: RuntimeRemoteWorktreeCreateArgs
  ): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return createRuntimeRemoteManagedWorktree(repo, args, {
      store: this.store,
      canSpawn: () => Boolean(this.ptyController?.spawn),
      markTrusted: (agent, connectionId, path) =>
        this.markRemoteWorkspaceTrustedForAgent(agent, connectionId, path),
      createTerminal: (selector, options) => this.createTerminal(selector, options),
      pasteDraft: (handle, draft) => this.pasteStartupDraftWhenReady(handle, draft),
      sendFollowup: (handle, followup) => this.sendStartupFollowupWhenReady(handle, followup),
      provision: (options) => this.provisionManagedWorktreeTerminals(options),
      activate: (repoId, worktreeId, setup, startup, defaultTabs) =>
        this.notifyActivateWorktree(repoId, worktreeId, setup, startup, defaultTabs),
      invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
      invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
      notifyWorktreesChanged: (repoId) => this.notifyWorktreesChanged(repoId)
    })
  }

  async getCanonicalFetchKey(
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<string> {
    return await this.remoteFetches.getCanonicalFetchKey(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteFetch(
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteFetchResult> {
    return await this.remoteFetches.getOrStartRemoteFetch(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteTrackingBaseRefresh(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteFetchResult> {
    return await this.remoteFetches.getOrStartRemoteTrackingBaseRefresh(repoPath, base, gitOptions)
  }

  async fetchRemoteWithCache(
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<void> {
    await this.remoteFetches.fetchRemoteWithCache(repoPath, remote, gitOptions)
  }

  async resolveRemoteTrackingBase(
    repoPath: string,
    baseBranch: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteTrackingBase | null> {
    return await this.remoteFetches.resolveRemoteTrackingBase(repoPath, baseBranch, gitOptions)
  }

  async hasRemoteTrackingRef(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<boolean> {
    return await this.remoteFetches.hasRemoteTrackingRef(repoPath, base, gitOptions)
  }

  recordOptimisticReconcileToken(worktreeId: string): string {
    return this.worktreeBaseReconciliation.recordToken(worktreeId)
  }

  clearOptimisticReconcileToken(worktreeId: string): void {
    this.worktreeBaseReconciliation.clearToken(worktreeId)
  }

  emitWorktreeBaseStatus(event: WorktreeBaseStatusEvent): void {
    this.worktreeBaseReconciliation.emitStatus(event)
  }

  async reconcileWorktreeBaseStatus(args: {
    repoId: string
    repoPath: string
    worktreeId: string
    base: RemoteTrackingBase
    branchName: string
    createdBaseSha: string
    token: string
    fetchPromise: Promise<RemoteFetchResult>
  }): Promise<void> {
    await this.worktreeBaseReconciliation.reconcile(args)
  }

  /**
   * Probe how far the worktree's HEAD is behind its tracking remote. Returns
   * null when the probe cannot establish a signal (no default base ref, or
   * git failure). Dispatch treats null as "unknown — proceed" (§3.1); only
   * knowing-and-stale refuses.
   */
  async probeWorktreeDrift(worktreeSelector: string): Promise<{
    base: string
    behind: number
    recentSubjects: string[]
  } | null> {
    return probeRuntimeWorktreeDrift({
      selector: worktreeSelector,
      store: this.store ? this.requireStore() : null,
      resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
      resolveRemoteTrackingBase: (repoPath, base, options) =>
        this.resolveRemoteTrackingBase(repoPath, base, options),
      fetchRemote: (repoPath, remote, options) =>
        this.fetchRemoteWithCache(repoPath, remote, options)
    })
  }

  async updateManagedWorktreeMeta(
    worktreeSelector: string,
    updates: Omit<Partial<WorktreeMeta>, 'pushTarget'> & {
      pushTarget?: GitPushTarget | null
      lineage?: {
        parentWorktree?: string
        noParent?: boolean
      }
    }
  ) {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return updateRuntimeManagedWorktreeMetadata({
      selector: worktreeSelector,
      updates,
      store: this.store,
      ports: {
        resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
        validateParent: (worktree, parent) => this.worktreeLineage.validateParent(worktree, parent),
        invalidateResolved: () => this.invalidateResolvedWorktreeCache(),
        invalidateScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
        notifyChanged: (repoId) => this.notifyWorktreesChanged(repoId),
        showWorktree: (selector) => this.showManagedWorktree(selector)
      }
    })
  }

  persistManagedWorktreeSortOrder(orderedIds: string[]): { updated: number } {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return persistRuntimeManagedWorktreeSortOrder({
      orderedIds,
      store: this.store,
      invalidateResolved: () => this.invalidateResolvedWorktreeCache(),
      notifyChanged: (repoId) => this.notifyWorktreesChanged(repoId)
    })
  }

  async resolveManagedPrBase(args: {
    repoSelector: string
    prNumber: number
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  }): Promise<GitHubPrStartPoint | { error: string }> {
    return resolveRuntimeGitHubWorktreeBase(args, {
      store: this.store ? this.requireStore() : null,
      resolveRepo: (selector) => this.resolveRepoSelector(selector)
    })
  }

  async resolveManagedMrBase(args: {
    repoSelector: string
    mrIid: number
    sourceBranch?: string
    targetBranch?: string
    isCrossRepository?: boolean
  }): Promise<
    { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget } | { error: string }
  > {
    return resolveRuntimeGitLabWorktreeBase(args, {
      store: this.store ? this.requireStore() : null,
      resolveRepo: (selector) => this.resolveRepoSelector(selector)
    })
  }

  private async resolveWorktreeRemovalTarget(
    worktreeSelector: string,
    requiredHostId?: ExecutionHostId
  ): Promise<RuntimeWorktreeRemovalTarget> {
    return resolveRuntimeWorktreeRemovalTarget({
      selector: worktreeSelector,
      store: this.store,
      resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
      resolveExplicitWorktreeIdScoped: (worktreeId, hostId) =>
        this.resolveExplicitWorktreeIdScoped(worktreeId, hostId),
      ...(requiredHostId ? { requiredHostId } : {})
    })
  }

  private removeWorktreeMetadataAndHistory(
    store: RuntimeStore,
    worktreeId: string,
    hostId?: ExecutionHostId
  ): void {
    // Why: worktree IDs are path-derived and can be recreated, so removal must
    // purge history and process-local caches before the ID points at new state.
    const persistedHostId = store.getWorktreeMeta(worktreeId)?.hostId
    const repoId = splitWorktreeId(worktreeId)?.repoId
    const preservesSameIdOwner = Boolean(
      hostId &&
      ((persistedHostId && persistedHostId !== hostId) ||
        (repoId && hasWorktreeRemovalRepoOwnerOnOtherHost(store, repoId, hostId)))
    )
    if (hostId) {
      store.removeWorktreeMeta(worktreeId, hostId)
    } else {
      store.removeWorktreeMeta(worktreeId)
    }
    if (!preservesSameIdOwner) {
      this.mobileSessionTabsByWorktree.delete(worktreeId)
      this.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId)
      this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
      advertisedUrlWatcher.forgetWorktree(worktreeId)
      deleteWorktreeHistoryDir(worktreeId)
      this.closeHeadlessBrowserPagesForWorktree(worktreeId)
      closeClientHostedBrowserPagesForWorktree(this, worktreeId)
    }
  }

  // Why: headless offscreen browser pages are main-process BrowserWindows that
  // outlive a worktree unless explicitly closed — removing a worktree without
  // closing its open panes leaks the windows for the life of the serve process.
  private closeHeadlessBrowserPagesForWorktree(worktreeId: string): void {
    if (!this.offscreenBrowserBackend || !this.agentBrowserBridge?.tabList) {
      return
    }
    for (const tab of this.agentBrowserBridge.tabList(worktreeId).tabs) {
      void this.offscreenBrowserBackend.closeTab(tab.browserPageId).catch(() => {})
    }
  }

  async forceDeletePreservedBranch(
    worktreeSelector: string,
    branchName: string,
    expectedHead: string,
    hostId?: string
  ): Promise<ForceDeleteWorktreeBranchResult> {
    return this.preservedBranchCleanup.forceDelete(
      worktreeSelector,
      branchName,
      expectedHead,
      hostId
    )
  }

  async removeManagedWorktree(
    worktreeSelector: string,
    force = false,
    runHooks = false,
    // Why (#11960): only an explicit Force Delete waives PTY-stop proof; `force`
    // alone is already set by the ordinary delete confirmation.
    allowUnverifiedPtyStop = false,
    hostId?: string
  ): Promise<RemoveWorktreeResult & { warning?: string }> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const store = this.store
    const cleanupHostId = parseExecutionHostId(hostId)?.id
    const removalTarget = await this.resolveWorktreeRemovalTarget(worktreeSelector, cleanupHostId)
    const optionsKey = getRuntimeWorktreeRemovalOptionsKey(force, runHooks, allowUnverifiedPtyStop)
    const inFlightRemoval = this.removeManagedWorktreeInFlight.get(removalTarget.id, optionsKey)
    if (inFlightRemoval) {
      return inFlightRemoval
    }

    // Why: runtime callers can race the same workspace through CLI/mobile
    // retries. Share one destructive Git/filesystem operation per worktree ID.
    const removal = (async (): Promise<RemoveWorktreeResult & { warning?: string }> => {
      // Why: CLI, mobile and headless serve delete through here rather than the IPC handler; without
      // this span their freezes are as invisible as desktop deletes were before `worktree.remove`.
      return withWorktreeSpan({ stage: 'remove', path: removalTarget.path }, async () => {
        const repoOwner = resolveWorktreeRemovalRepoOwner(
          store,
          removalTarget.repoId,
          cleanupHostId
        )
        if (repoOwner.kind === 'ambiguous') {
          throw new Error(
            `Workspace identity is ambiguous across hosts: ${removalTarget.id}. Retry with an explicit host.`
          )
        }
        const repo = repoOwner.kind === 'resolved' ? repoOwner.repo : undefined
        const removalHostId = repo ? (cleanupHostId ?? getRepoExecutionHostId(repo)) : cleanupHostId
        if (!repo) {
          const orphanHost = parseExecutionHostId(store.getWorktreeMeta(removalTarget.id)?.hostId)
          const sshPtyProvider =
            orphanHost?.kind === 'ssh' ? this.getSshProviderFn?.(orphanHost.targetId) : undefined
          const ptyProvider = sshPtyProvider ?? this.getLocalProvider()
          const externalOrphanHost = orphanHost?.kind === 'ssh' || orphanHost?.kind === 'runtime'
          if (ptyProvider) {
            // External host inventories must never sweep a same-id local workspace.
            await killAllProcessesForWorktree(removalTarget.id, {
              runtime: this as RuntimeCommandSurfaceHost<this>,
              resolvedWorktreeId: removalTarget.id,
              ...(orphanHost?.kind === 'ssh' ? { resolvedConnectionId: orphanHost.targetId } : {}),
              ...(orphanHost?.kind === 'runtime'
                ? { resolvedRuntimeEnvironmentId: orphanHost.environmentId }
                : {}),
              localProvider: ptyProvider,
              onPtyStopped: this.onPtyStopped ?? undefined,
              ...(externalOrphanHost
                ? {
                    includeProviderInventory: orphanHost?.kind === 'ssh' && Boolean(sshPtyProvider),
                    includeLocalRegistry: false
                  }
                : {})
            }).catch((error) => {
              console.warn(
                `[worktree-teardown] orphan cleanup failed for ${removalTarget.id}:`,
                error
              )
            })
          }
          // Why: nothing is deleted on disk here, so watchers must be restored — a folder
          // workspace or explorer pane rooted at the same path stays live.
          const orphanFullPath = splitWorktreeId(removalTarget.id)?.worktreePath
          const orphanWatcherPath =
            splitWorktreeIdForFilesystem(removalTarget.id)?.worktreePath === orphanFullPath
              ? orphanFullPath
              : undefined
          if (orphanWatcherPath) {
            await this.acquireFileWatcherRemoval(
              orphanWatcherPath,
              orphanHost?.kind === 'ssh' ? orphanHost.targetId : undefined
            )
              .then((gate) => gate.finish(false))
              .catch(() => {})
          }
          this.clearOptimisticReconcileToken(removalTarget.id)
          this.removeWorktreeMetadataAndHistory(
            store,
            removalTarget.id,
            cleanupHostId ?? orphanHost?.id
          )
          this.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
          this.invalidateResolvedWorktreeCache()
          this.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
          invalidateAuthorizedRootsCache()
          this.notifyWorktreesChanged(removalTarget.repoId)
          // Why: non-desktop callers must be able to tell "forgotten" from "deleted"; nothing left the disk.
          return {
            warning: `Project ${removalTarget.repoId} is no longer tracked, so ${removalTarget.path} was forgotten without deleting the directory or its Git worktree registration.`
          }
        }
        if (isFolderRepo(repo)) {
          if (removalTarget.id === getRuntimeFolderWorkspaceRootId(repo)) {
            throw new Error(
              'Cannot delete the project root workspace. Remove the folder project instead.'
            )
          }
          // This service runs inside the selected runtime, so runtime-stamped repos use its
          // local PTY namespace; only a direct SSH connection is external from here.
          const folderConnectionId = repo.connectionId?.trim() || null
          const folderSshPtyProvider = folderConnectionId
            ? this.getSshProviderFn?.(folderConnectionId)
            : undefined
          const folderPtyProvider = folderSshPtyProvider ?? this.getLocalProvider()
          if (folderPtyProvider) {
            // Why: folder workspace deletion has no Git removal phase where PTYs
            // would otherwise be swept; tear them down before hiding the workspace.
            await killAllProcessesForWorktree(removalTarget.id, {
              runtime: this as RuntimeCommandSurfaceHost<this>,
              resolvedWorktreeId: removalTarget.id,
              ...(folderConnectionId ? { resolvedConnectionId: folderConnectionId } : {}),
              localProvider: folderPtyProvider,
              onPtyStopped: this.onPtyStopped ?? undefined,
              ...(folderConnectionId
                ? {
                    includeProviderInventory: Boolean(folderSshPtyProvider),
                    includeLocalRegistry: false
                  }
                : {})
            }).catch((err) => {
              console.warn(`[worktree-teardown] failed for ${removalTarget.id}:`, err)
            })
          }
          this.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
          this.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
          this.invalidateResolvedWorktreeCache()
          this.notifyWorktreesChanged(repo.id)
          return {}
        }
        const provider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
        const fsProvider = repo.connectionId ? getSshFilesystemProvider(repo.connectionId) : null
        const localWorktreeGitOptions = repo.connectionId
          ? {}
          : getLocalProjectWorktreeGitOptions(this.requireStore(), repo)
        const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
        const registeredWorktrees = repo.connectionId
          ? await provider!.listWorktrees(repo.path)
          : hasLocalWorktreeGitOptions
            ? await listWorktreesStrict(repo.path, localWorktreeGitOptions)
            : await listWorktreesStrict(repo.path)
        const removedMeta = resolveWorktreeRemovalMetadata(
          store,
          removalTarget.repoId,
          removalTarget.id,
          cleanupHostId ?? getRepoExecutionHostId(repo)
        )
        const removedPushTarget = removedMeta?.pushTarget ?? removalTarget.pushTarget
        const registeredWorktree = findRegisteredDeletableWorktree(
          repo.path,
          removalTarget.path,
          registeredWorktrees
        )
        if (!registeredWorktree) {
          return removeRuntimeUnregisteredWorktree({
            repo,
            target: removalTarget,
            registeredWorktrees,
            removedMeta,
            removedPushTarget,
            force,
            allowUnverifiedPtyStop,
            provider,
            fsProvider: fsProvider ?? null,
            localOptions: localWorktreeGitOptions,
            store,
            acquireWatcherRemoval: this.acquireFileWatcherRemoval,
            stopPtys: (worktreeId, connectionId, allow) =>
              this.stopPtysForDestructiveWorktreeRemoval(worktreeId, {
                ...(connectionId ? { connectionId } : {}),
                allowUnverifiedStop: allow
              }),
            finishRemoval: () => {
              this.clearOptimisticReconcileToken(removalTarget.id)
              this.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
              this.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
              this.invalidateResolvedWorktreeCache()
              this.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
              invalidateAuthorizedRootsCache()
              this.notifyWorktreesChanged(repo.id)
            }
          })
        }
        const canonicalWorktreePath = registeredWorktree.path
        const deleteBranch = removedMeta?.preserveBranchOnDelete !== true

        // Why: a Git lock must block before archive hooks or linked-path cleanup
        // mutate the workspace; dirty-file force is a separate permission.
        try {
          assertWorktreeUnlockedForRemoval(registeredWorktree)
        } catch (error) {
          throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
        }

        // Why: a prior forced Windows recovery can delete the directory but leave
        // Git's stale registration; recover and verify it before clearing metadata.
        if (
          !repo.connectionId &&
          force === true &&
          process.platform === 'win32' &&
          (isWindowsAbsolutePathLike(canonicalWorktreePath) ||
            !!localWorktreeGitOptions.wslDistro) &&
          removedMeta &&
          (await isRuntimeWorktreePathMissing(repo, canonicalWorktreePath, localWorktreeGitOptions))
        ) {
          const removalResult = await removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval({
            canonicalWorktreePath,
            repoPath: repo.path,
            localWorktreeGitOptions,
            registeredWorktree,
            deleteBranch
          })
          await cleanupUnusedWorktreePushTargetRemote(
            repo.path,
            removalTarget.id,
            removedPushTarget,
            store,
            localWorktreeGitOptions
          )
          this.preservedBranchCleanup.remember(
            removalTarget.id,
            cleanupHostId,
            removalResult,
            registeredWorktree.head,
            removedPushTarget
          )
          this.clearOptimisticReconcileToken(removalTarget.id)
          this.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
          this.invalidateResolvedWorktreeCache()
          this.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
          invalidateAuthorizedRootsCache()
          this.notifyWorktreesChanged(repo.id)
          return removalResult ?? {}
        }
        if (repo.connectionId) {
          return removeRuntimeRegisteredRemoteWorktree({
            repo,
            target: removalTarget,
            registeredWorktree,
            removedPushTarget,
            store,
            provider: provider!,
            force,
            allowUnverifiedPtyStop,
            deleteBranch,
            acquireWatcherRemoval: this.acquireFileWatcherRemoval,
            stopPtys: () =>
              this.stopPtysForDestructiveWorktreeRemoval(removalTarget.id, {
                connectionId: repo.connectionId!,
                allowUnverifiedStop: allowUnverifiedPtyStop
              }),
            preserveBranchHead: (result, fallbackHead) =>
              this.preservedBranchCleanup.preserveHead(result, fallbackHead),
            finishRemoval: (result) => {
              this.preservedBranchCleanup.remember(
                removalTarget.id,
                cleanupHostId,
                result,
                registeredWorktree.head,
                removedPushTarget
              )
              this.clearOptimisticReconcileToken(removalTarget.id)
              this.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
              this.invalidateResolvedWorktreeCache()
              this.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
              invalidateAuthorizedRootsCache()
              this.notifyWorktreesChanged(repo.id)
            }
          })
        }

        return removeRuntimeRegisteredLocalWorktree({
          repo,
          target: removalTarget,
          registeredWorktree,
          removedPushTarget,
          store,
          localOptions: localWorktreeGitOptions,
          hasLocalOptions: hasLocalWorktreeGitOptions,
          force,
          runHooks,
          allowUnverifiedPtyStop,
          deleteBranch,
          acquireWatcherRemoval: this.acquireFileWatcherRemoval,
          stopPtys: () =>
            this.stopPtysForDestructiveWorktreeRemoval(removalTarget.id, {
              allowUnverifiedStop: allowUnverifiedPtyStop
            }),
          closeWatchers: (path) => this.closeFileWatchersForRemoval(path),
          preserveBranchHead: (result, fallbackHead) =>
            this.preservedBranchCleanup.preserveHead(result, fallbackHead),
          finishRemoval: (result, rememberBranch) => {
            if (rememberBranch) {
              this.preservedBranchCleanup.remember(
                removalTarget.id,
                cleanupHostId,
                result,
                registeredWorktree.head,
                removedPushTarget
              )
            } else {
              this.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
            }
            this.clearOptimisticReconcileToken(removalTarget.id)
            this.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
            this.invalidateResolvedWorktreeCache()
            this.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
            invalidateAuthorizedRootsCache()
            this.notifyWorktreesChanged(repo.id)
          }
        })
      })
    })()
    this.removeManagedWorktreeInFlight.track(removalTarget.id, optionsKey, removal)
    try {
      const result = await removal
      this.emitWorktreeLifecycle({
        kind: 'removed',
        worktreeId: removalTarget.id,
        path: removalTarget.path
      })
      return result
    } finally {
      this.removeManagedWorktreeInFlight.release(removalTarget.id, removal)
    }
  }

  async renameTerminal(handle: string, title: string | null): Promise<RuntimeTerminalRename> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      pty.pty.title = title
      // Why: a manual rename must outrank later agent OSC title updates (which
      // win by timestamp), so stamp it as the freshest title.
      pty.pty.titleUpdatedAt = Date.now()
      this.touchMobileSessionSnapshotsForPty(pty.pty.ptyId)
      // Why: without a renderer the rename only lived on the live pty and was
      // lost on restart. Persist customTitle so a headless rebuild keeps it.
      if (!this.notifier?.renameTerminal && pty.pty.tabId) {
        this.persistHeadlessTerminalTitle(pty.pty.worktreeId, pty.pty.tabId, title)
      }
      for (const leaf of this.leaves.values()) {
        if (leaf.ptyId === pty.pty.ptyId) {
          this.notifier?.renameTerminal(leaf.tabId, title)
          return { handle, tabId: leaf.tabId, title }
        }
      }
      return { handle, tabId: pty.pty.tabId ?? pty.record.tabId, title }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    this.notifier?.renameTerminal(leaf.tabId, title)
    return { handle, tabId: leaf.tabId, title }
  }

  private async resolveAgentTerminalCreateOptions(
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    // Why: raw shell commands like `codex exec` must remain user-authored shell.
    // Only unmanaged, repo-backed, bare agent launches get Settings defaults.
    const callerSuppliedLaunch =
      opts.env ||
      opts.launchConfig ||
      opts.launchAgent ||
      opts.startupCommandDelivery ||
      opts.claudeAgentTeamsSourceCommand
    const store = this.store
    if (opts.startupAgent) {
      // Why: falling through unresolved would spawn a bare shell that can only time
      // out waiting for an agent. A caller-supplied launch contradicts the agent:
      // `command` would be overwritten, `resumeProviderSession` would pair resume
      // identity with a fresh launch.
      if (callerSuppliedLaunch || opts.command || opts.resumeProviderSession) {
        throw new Error(
          `startupAgent ${opts.startupAgent} cannot combine with a caller-supplied launch.`
        )
      }
      if (!store) {
        throw new Error('runtime_unavailable')
      }
    } else if (callerSuppliedLaunch || !store || !opts.command || !workspace.repo) {
      return opts
    }

    const settings = store.getSettings()
    const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
    const isRemote = workspace.repo ? repoIsRemote(workspace.repo) : Boolean(workspace.connectionId)
    const queuedShell = resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    if (opts.startupAgent && !isTuiAgentEnabled(opts.startupAgent, settings.disabledTuiAgents)) {
      throw new Error(`Agent ${opts.startupAgent} is disabled. Choose an enabled agent.`)
    }
    const agent =
      opts.startupAgent ??
      resolveBareAgentLaunchCommand({
        command: opts.command,
        settings,
        platform,
        isRemote
      })
    if (!agent) {
      return opts
    }

    const sessionOptions = this.toAgentSessionOptions(opts.launchPreferences)
    const startupPlan = buildAgentStartupPlan({
      agent,
      prompt: '',
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
      sessionOptions,
      sessionOptionsOverrideAgentArgs: Boolean(sessionOptions),
      platform,
      shell: queuedShell,
      isRemote,
      allowEmptyPromptLaunch: true
    })
    if (!startupPlan) {
      // Why: an explicit agent that yields no plan would otherwise spawn a bare
      // shell that never reaches agent readiness.
      if (opts.startupAgent) {
        throw new Error(`Could not build launch command for ${opts.startupAgent}.`)
      }
      return opts
    }

    await this.markWorkspaceTrustedForAgent(agent, workspace.connectionId, workspace.path)

    return {
      ...opts,
      command: startupPlan.launchCommand,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      launchConfig: startupPlan.launchConfig,
      launchAgent: agent,
      startupCommandDelivery: startupPlan.startupCommandDelivery
    }
  }

  private getAgentSessionExecutionNamespace(
    workspace: TerminalWorkspaceLaunchScope,
    agent: TuiAgent
  ): { machine: string; principal: string; container: string; providerRoot: string } | null {
    if (workspace.connectionId) {
      // Why: SSH target ids are not execution-namespace proof. Preserve the
      // legacy launch until an attested route can safely participate in claims.
      return null
    }
    const wsl = parseWslUncPath(workspace.path)
    const principal =
      typeof process.getuid === 'function'
        ? `uid:${process.getuid()}`
        : `user:${process.env.USERNAME ?? ''}`
    return {
      machine: wsl ? 'wsl-host' : `native:${process.platform}`,
      principal,
      container: wsl ? `wsl:${wsl.distro.toLocaleLowerCase('en-US')}` : 'native',
      // Why: merging account roots is conservative (it may conflict) and can
      // never permit two TUIs to own one provider session.
      providerRoot: `profile-default:${agent}`
    }
  }

  private async executionOwnerSupportsAgentSessionOperation(
    workspace: TerminalWorkspaceLaunchScope,
    operation: 'resume' | 'create',
    signal?: AbortSignal
  ): Promise<boolean> {
    const provider = workspace.connectionId
      ? this.getSshProviderFn?.(workspace.connectionId)
      : this.getLocalProvider()
    if (!provider) {
      // An unavailable route is not proof of an old owner; preserve the structured failure.
      return true
    }
    const probe =
      operation === 'resume'
        ? provider.supportsAgentSessionClaims
        : provider.supportsAgentSessionCreateOperations
    if (!probe) {
      // Local in-process PTYs need no wire negotiation; unknown SSH providers are legacy.
      return workspace.connectionId === null
    }
    try {
      return (await probe.call(provider, { signal })) === true
    } catch {
      // Why: this read-only check has not launched anything, so the old route remains safe.
      return false
    }
  }

  private toAgentSessionOptions(
    preferences: AgentLaunchPreferences | undefined
  ): Record<string, string> | undefined {
    if (!preferences) {
      return undefined
    }
    const options = {
      ...(preferences.model ? { model: preferences.model } : {}),
      ...(preferences.effort ? { effort: preferences.effort } : {}),
      ...(preferences.mode ? { mode: preferences.mode } : {})
    }
    return Object.keys(options).length > 0 ? options : undefined
  }

  async ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest,
    _caller: RuntimeAgentSessionRpcCaller = {}
  ): Promise<RuntimeEnsureAgentSessionResult> {
    if (request.kind === 'automatic') {
      // Legacy renderer sleep records are migration evidence, not host authority.
      throw new Error('agent_session_resume_not_authorized')
    }
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
    const namespace = this.getAgentSessionExecutionNamespace(workspace, request.agent)
    if (
      !namespace ||
      !(await this.executionOwnerSupportsAgentSessionOperation(workspace, 'resume', _caller.signal))
    ) {
      // Why: the renderer still holds the exact old request and may retry it before any side effect.
      throw new Error('agent_session_legacy_required')
    }
    // Why: nested SSH paths belong to the execution owner, so compatibility selection must happen before local filesystem canonicalization.
    const identity = canonicalizeAgentSessionIdentity(request.agent, request.providerSession)
    const claim = this.agentSessionClaimSigner.createClaim({
      namespace,
      identity,
      canonicalWorktreeId: workspace.id
    })
    const settings = this.store.getSettings()
    if (!isTuiAgentEnabled(request.agent, settings.disabledTuiAgents)) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before resuming.')
    }
    const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
    const isRemote = workspace.repo ? repoIsRemote(workspace.repo) : Boolean(workspace.connectionId)
    const shell = resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    const startup = buildAgentResumeStartupPlan({
      agent: request.agent,
      providerSession: identity.providerSession,
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs:
        request.agentArgs !== undefined
          ? request.agentArgs
          : resolveTuiAgentLaunchArgs(request.agent, settings.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(request.agent, settings.agentDefaultEnv),
      ompResumeFilePath: request.ompResumeFilePath,
      sessionOptions: this.toAgentSessionOptions(request.launchPreferences),
      platform,
      shell,
      isRemote
    })
    if (!startup) {
      throw new Error('agent_session_identity_required')
    }
    await this.markWorkspaceTrustedForAgent(request.agent, workspace.connectionId, workspace.path)
    if (_caller.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const terminal = await this.createTerminal(`id:${workspace.id}`, {
      command: startup.launchCommand,
      env: startup.env,
      launchConfig: startup.launchConfig,
      launchAgent: request.agent,
      presentation: request.presentation ?? 'background',
      tabId: request.placement?.tabId,
      leafId: request.placement?.leafId,
      persistHostSessionBinding: true,
      agentSessionClaim: claim,
      signal: _caller.signal
    })
    return {
      terminal,
      disposition: terminal.agentSessionDisposition ?? 'created'
    }
  }

  async createAgentSession(
    request: RuntimeCreateAgentSessionRequest,
    caller: RuntimeAgentSessionRpcCaller = {}
  ): Promise<RuntimeCreateAgentSessionResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const now = Date.now()
    const operationTimestamp = parseAgentSessionOperationTimestamp(request.clientOperationId)
    if (
      operationTimestamp === null ||
      operationTimestamp > now + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
    ) {
      throw new Error('agent_session_operation_invalid')
    }
    const callerKey = caller.clientId?.trim() || `trusted-local:${caller.clientKind ?? 'runtime'}`
    const operationKey = `${callerKey}\0${request.clientOperationId}`
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          request.worktree,
          request.agent,
          request.prompt ?? null,
          request.promptDelivery ?? null,
          request.agentArgs ?? null,
          request.agentArgs === undefined ? 'host-default' : 'client-override',
          request.launchPreferences?.model ?? null,
          request.launchPreferences?.effort ?? null,
          request.launchPreferences?.mode ?? null,
          request.startupCwd ?? null,
          request.presentation ?? null,
          request.placement?.tabId ?? null,
          request.placement?.leafId ?? null,
          request.viewMode ?? null
        ])
      )
      .digest('base64url')
    const existing = this.agentSessionCreateOperations.get(operationKey)
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new Error('agent_session_operation_conflict')
      }
      const replayed = await existing.promise
      return { ...replayed, disposition: 'replayed' }
    }
    if (now - operationTimestamp > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) {
      // Why: once a tombstone could have expired, an unseen replay must never
      // be reinterpreted as permission to start another fresh agent.
      throw new Error('agent_session_operation_expired')
    }
    let callerOperationCount = 0
    const callerPrefix = `${callerKey}\0`
    for (const key of this.agentSessionCreateOperations.keys()) {
      if (key.startsWith(callerPrefix)) {
        callerOperationCount += 1
      }
    }
    if (
      callerOperationCount >= AGENT_SESSION_OPERATION_PER_CLIENT_LIMIT ||
      this.agentSessionCreateOperations.size >= AGENT_SESSION_OPERATION_GLOBAL_LIMIT
    ) {
      // Why: tombstones cannot be evicted early without making an old replay
      // capable of spawning again; reject new IDs until retained entries age out.
      throw new Error('agent_session_operation_capacity')
    }
    let retainReplayFence = false
    const operation = (async (): Promise<RuntimeCreateAgentSessionResult> => {
      // Why: reserve the client operation before any async preflight so concurrent retries cannot
      // both observe an empty ledger and reach the execution owner independently.
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
      if (
        !(await this.executionOwnerSupportsAgentSessionOperation(
          workspace,
          'create',
          caller.signal
        ))
      ) {
        // Why: the exact legacy launch remains client-owned until this pre-spawn check succeeds.
        throw new Error('agent_session_legacy_required')
      }
      const startupCwd = this.resolveWorkspaceTerminalStartupCwd(workspace, request.startupCwd)
      // Why: aliases and object property order are client syntax, not authority;
      // fingerprint the host-resolved fields in one fixed order.
      const resolvedFingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            workspace.id,
            request.agent,
            request.prompt ?? null,
            request.promptDelivery ?? null,
            request.agentArgs ?? null,
            request.agentArgs === undefined ? 'host-default' : 'client-override',
            request.launchPreferences?.model ?? null,
            request.launchPreferences?.effort ?? null,
            request.launchPreferences?.mode ?? null,
            startupCwd ?? null,
            request.presentation ?? null,
            request.placement?.tabId ?? null,
            request.placement?.leafId ?? null,
            request.viewMode ?? null
          ])
        )
        .digest('base64url')
      const settings = this.store!.getSettings()
      if (!isTuiAgentEnabled(request.agent, settings.disabledTuiAgents)) {
        throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
      }
      const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
      const isRemote = workspace.repo
        ? repoIsRemote(workspace.repo)
        : Boolean(workspace.connectionId)
      const shell = resolveLocalWindowsAgentStartupShell({
        platform,
        isRemote,
        terminalWindowsShell: settings.terminalWindowsShell
      })
      const startupArgs = {
        agent: request.agent,
        cmdOverrides: settings.agentCmdOverrides ?? {},
        agentArgs:
          request.agentArgs !== undefined
            ? request.agentArgs
            : resolveTuiAgentLaunchArgs(request.agent, settings.agentDefaultArgs),
        agentEnv: resolveTuiAgentLaunchEnv(request.agent, settings.agentDefaultEnv),
        sessionOptions: this.toAgentSessionOptions(request.launchPreferences),
        platform,
        shell,
        isRemote
      }
      const startup =
        request.promptDelivery === 'draft'
          ? buildAgentDraftLaunchPlan({ ...startupArgs, draft: request.prompt ?? '' })
          : buildAgentStartupPlan({
              ...startupArgs,
              prompt: request.prompt ?? '',
              allowEmptyPromptLaunch: true
            })
      if (!startup) {
        throw new Error('agent_session_identity_required')
      }
      await this.markWorkspaceTrustedForAgent(request.agent, workspace.connectionId, workspace.path)
      if (caller.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      let terminal: RuntimeTerminalCreate
      const executionOperationId = createHash('sha256')
        .update(this.runtimeId)
        .update('\0')
        .update(operationKey)
        .update('\0')
        .update(resolvedFingerprint)
        .digest('base64url')
      const operationTabId =
        request.placement?.tabId ?? deterministicAgentSessionUuid(`${executionOperationId}:tab`)
      const operationLeafId =
        request.placement?.leafId ?? deterministicAgentSessionUuid(`${executionOperationId}:leaf`)
      const operationHandle = `term_${deterministicAgentSessionUuid(`${executionOperationId}:handle`)}`
      try {
        terminal = await this.createTerminal(`id:${workspace.id}`, {
          command: startup.launchCommand,
          env: startup.env,
          launchConfig: startup.launchConfig,
          launchAgent: request.agent,
          startupCommandDelivery: startup.startupCommandDelivery,
          cwd: startupCwd,
          presentation: request.presentation ?? 'background',
          tabId: operationTabId,
          leafId: operationLeafId,
          preAllocatedHandle: operationHandle,
          viewMode: request.viewMode,
          persistHostSessionBinding: true,
          agentSessionCreateOperationId: executionOperationId,
          signal: caller.signal,
          onPtySpawnCommitted: () => {
            retainReplayFence = true
          }
        })
      } catch (error) {
        if (isAgentSessionOperationOutcomeUnknown(error)) {
          retainReplayFence = true
        }
        throw error
      }
      return { terminal, disposition: 'created' }
    })()
    this.agentSessionCreateOperations.set(operationKey, {
      fingerprint: requestFingerprint,
      promise: operation
    })
    const expireOperation = (): void => {
      const expiresAt = Math.max(now, operationTimestamp) + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
      const timer = setTimeout(
        () => {
          if (this.agentSessionCreateOperations.get(operationKey)?.promise === operation) {
            this.agentSessionCreateOperations.delete(operationKey)
          }
        },
        Math.max(1, expiresAt - Date.now())
      )
      timer.unref?.()
    }
    try {
      const result = await operation
      expireOperation()
      return result
    } catch (error) {
      if (retainReplayFence) {
        // Why: the first PTY may still be alive; replay the same failure until
        // expiry instead of interpreting a lost outcome as a fresh spawn grant.
        expireOperation()
      } else if (this.agentSessionCreateOperations.get(operationKey)?.promise === operation) {
        this.agentSessionCreateOperations.delete(operationKey)
      }
      throw error
    }
  }

  async createTerminal(
    worktreeSelector?: string,
    opts: TerminalCreateOptions = {}
  ): Promise<RuntimeTerminalCreate> {
    if (opts.startupAgent && worktreeSelector === undefined) {
      // Why: the launch is resolved against a workspace, so with no selector
      // startupAgent is silently dropped and the terminal is a bare shell.
      throw new Error(`startupAgent ${opts.startupAgent} requires a workspace selector.`)
    }
    const presentation = resolveTerminalPresentation(opts)
    const requiresRendererFocus = opts.presentation === 'focused' || opts.focus === true
    const availableAuthoritativeWindow = this.getAvailableAuthoritativeWindow()
    // Why: pre-diff createTerminal fell back to the renderer's active worktree
    // when no selector was provided. The new background-spawn branch hard-
    // requires a resolvable selector, so route the no-selector case through
    // the renderer IPC path to preserve that behavior.
    const rendererWindow = opts.rendererBacked === true ? availableAuthoritativeWindow : null
    const shouldCreateInBackground =
      worktreeSelector !== undefined &&
      (Boolean(opts.agentSessionClaim) ||
        (!requiresRendererFocus && opts.rendererBacked !== true) ||
        // Why: `orca serve` exposes the local runtime without a renderer
        // window. Renderer-backed and focus-requested creates are preferred on
        // the renderer, but with no window a background spawn is the only
        // usable path — otherwise getAuthoritativeWindow() below throws and the
        // caller gets no terminal at all (#10333). Focus is not lost: the
        // spawned pane is still published and revealed with `activate`.
        availableAuthoritativeWindow === null)

    if (shouldCreateInBackground) {
      if (!this.ptyController?.spawn) {
        throw new Error('runtime_unavailable')
      }
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
      const launchOpts = await this.resolveAgentTerminalCreateOptions(workspace, opts)
      let ptySpawnCommitReported = false
      const reportPtySpawnCommitted = (): void => {
        if (ptySpawnCommitReported) {
          return
        }
        ptySpawnCommitReported = true
        launchOpts.onPtySpawnCommitted?.()
      }
      const cwd =
        this.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd) ?? workspace.path
      let preAllocatedHandle =
        launchOpts.preAllocatedHandle ?? this.createPreAllocatedTerminalHandle()
      // Why: mint tabId in main before spawn so paneKey is known at PTY env
      // build time. Hook-based agent status (Claude/Codex/Cursor/Gemini) keys
      // off `${tabId}:${leafId}` — without these vars set on the PTY, the
      // hook payload arrives with an empty paneKey and the renderer cannot
      // attribute the event. Use a stable UUID leaf because hooks reject the
      // legacy numeric pane keys after the pane-id migration.
      const hintedTabId = launchOpts.tabId?.trim()
      const canAdoptPaneIdentity =
        hintedTabId !== undefined &&
        isValidHostTerminalTabId(hintedTabId) &&
        launchOpts.leafId !== undefined &&
        isTerminalLeafId(launchOpts.leafId)
      let tabId = canAdoptPaneIdentity ? (hintedTabId as string) : randomUUID()
      let leafId = canAdoptPaneIdentity ? (launchOpts.leafId as string) : randomUUID()
      let paneKey = makePaneKey(tabId, leafId)
      const claimedStablePaneCreate = this.ptyController.claimStablePaneCreate?.({
        worktreeId: workspace.id,
        connectionId: workspace.connectionId,
        tabId,
        leafId
      })
      let stablePaneCreateReleased = false
      const releaseStablePaneCreate = (): void => {
        if (stablePaneCreateReleased) {
          return
        }
        stablePaneCreateReleased = true
        claimedStablePaneCreate?.()
      }
      try {
        if (launchOpts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        const adoptedBeforeLaunch = await this.ptyController.adoptStablePane?.({
          cols: 120,
          rows: 40,
          cwd,
          connectionId: workspace.connectionId,
          worktreeId: workspace.id,
          preAllocatedHandle,
          tabId,
          leafId
        })
        const launchToken = launchOpts.launchConfig
          ? (launchOpts.launchToken ?? randomUUID())
          : undefined
        const baseEnv = {
          ...launchOpts.env,
          ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
        }
        const claudeAgentTeamsSourceCommand =
          launchOpts.claudeAgentTeamsSourceCommand?.trim() ||
          launchOpts.command?.trim() ||
          undefined
        const claudeAgentTeamsMode = this.store?.getSettings?.().claudeAgentTeamsMode
        const effectiveClaudeAgentTeamsMode = inferCapturedClaudeAgentTeamsMode(
          launchOpts.launchConfig,
          claudeAgentTeamsSourceCommand,
          claudeAgentTeamsMode
        )
        let agentTeamsPlan: Awaited<ReturnType<typeof buildClaudeAgentTeamsLaunchPlan>> | undefined
        try {
          agentTeamsPlan = adoptedBeforeLaunch
            ? undefined
            : await buildClaudeAgentTeamsLaunchPlan({
                command: claudeAgentTeamsSourceCommand,
                mode: effectiveClaudeAgentTeamsMode,
                baseEnv: {
                  ...process.env,
                  ...baseEnv
                },
                createTeamEnv: (shimDir, shimBin) =>
                  this.claudeAgentTeams.createLaunchEnv({
                    leaderHandle: preAllocatedHandle,
                    baseEnv: {
                      ...process.env,
                      ...baseEnv
                    },
                    shimDir,
                    shimBin
                  }).env
              })
        } catch (error) {
          releaseStablePaneCreate?.()
          throw error
        }
        const sequencedStartupCommand =
          agentTeamsPlan &&
          claudeAgentTeamsSourceCommand &&
          launchOpts.command &&
          claudeAgentTeamsSourceCommand !== launchOpts.command
            ? agentTeamsPlan.command
            : undefined
        const effectiveLaunchConfig =
          launchOpts.launchConfig && agentTeamsPlan
            ? {
                ...launchOpts.launchConfig,
                agentCommand: launchOpts.launchConfig.agentCommand
                  ? effectiveClaudeAgentTeamsMode === 'in-process' || process.platform === 'win32'
                    ? addClaudeTeammateModeInProcess(launchOpts.launchConfig.agentCommand)
                    : addClaudeTeammateModeAuto(launchOpts.launchConfig.agentCommand)
                  : agentTeamsPlan.command,
                agentEnv: {
                  ...launchOpts.launchConfig.agentEnv,
                  ...agentTeamsPlan.env
                }
              }
            : launchOpts.launchConfig
        // Why: setup/agent sequencing wraps the PTY launch in a wait shell before
        // Claude Agent Teams runs. Preserve the direct Claude command separately
        // so the wrapper can exec the teammate-mode variant after setup completes.
        const env = this.buildTerminalWorkspaceEnv(
          workspace,
          {
            ...baseEnv,
            ...(sequencedStartupCommand
              ? { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: sequencedStartupCommand }
              : {})
          },
          paneKey,
          tabId,
          agentTeamsPlan?.env
        )
        const terminalColorQueryReplies =
          launchOpts.terminalColorQueryReplies ?? getTerminalViewColorQueryReplyColors()
        if (launchOpts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        const persistHostSessionBinding =
          launchOpts.persistHostSessionBinding ||
          launchOpts.surfaceOwner === false ||
          this.getAvailableAuthoritativeWindow() === null
        let result: Awaited<ReturnType<NonNullable<RuntimePtyController['spawn']>>>
        try {
          result = await this.ptyController.spawn({
            cols: 120,
            rows: 40,
            cwd,
            command: sequencedStartupCommand
              ? launchOpts.command
              : (agentTeamsPlan?.command ?? launchOpts.command),
            launchAgent: launchOpts.launchAgent,
            commandDelivery: 'provider',
            startupCommandDelivery: launchOpts.startupCommandDelivery,
            env,
            envToDelete: mergeTerminalEnvDeletionKeys(
              launchOpts.envToDelete,
              agentTeamsPlan?.envToDelete
            ),
            resumeProviderSession: launchOpts.resumeProviderSession,
            telemetry: launchOpts.telemetry,
            connectionId: workspace.connectionId,
            worktreeId: workspace.id,
            preAllocatedHandle,
            tabId,
            leafId,
            ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
            ...(launchOpts.agentSessionClaim
              ? {
                  agentSessionEnsure: {
                    claim: launchOpts.agentSessionClaim,
                    surface: {
                      worktreeId: workspace.id,
                      tabId,
                      leafId,
                      terminalHandle: preAllocatedHandle
                    }
                  }
                }
              : {}),
            ...(launchOpts.agentSessionCreateOperationId
              ? { agentSessionCreateOperationId: launchOpts.agentSessionCreateOperationId }
              : {}),
            ...(launchOpts.signal ? { signal: launchOpts.signal } : {}),
            ...(launchOpts.onPtySpawnCommitted
              ? { onPtySpawnCommitted: reportPtySpawnCommitted }
              : {}),
            ...(adoptedBeforeLaunch ? { adoptedStablePane: adoptedBeforeLaunch } : {}),
            ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
            ...(!adoptedBeforeLaunch && launchOpts.isNewSession ? { isNewSession: true } : {}),
            // Why: a headless-created pane has no renderer session writer. Persist
            // its tab/leaf binding at spawn so a later promoted window reattaches
            // the live daemon or SSH PTY instead of replacing it with a fresh one.
            // Re-check freshly: the entry-time snapshot can go stale across the
            // awaits above if the authoritative window is destroyed mid-spawn.
            ...(persistHostSessionBinding ? { persistHostSessionBinding: true } : {})
          })
        } finally {
          releaseStablePaneCreate?.()
        }
        if (!result.stablePaneOwner) {
          reportPtySpawnCommitted()
        }
        const adoptedStablePane = Boolean(result.stablePaneOwner)
        if (result.agentSessionEnsure) {
          const canonicalSurface = result.agentSessionEnsure.owner.surface
          preAllocatedHandle = canonicalSurface.terminalHandle
          tabId = canonicalSurface.tabId
          leafId = canonicalSurface.leafId
          paneKey = makePaneKey(tabId, leafId)
        } else if (result.stablePaneOwner) {
          preAllocatedHandle = result.stablePaneOwner.handle
          tabId = result.stablePaneOwner.tabId
          leafId = result.stablePaneOwner.leafId
          paneKey = makePaneKey(tabId, leafId)
        }
        try {
          this.assertPtyDidNotExitBeforeRegistration(result.id, result.incarnationId)
        } catch (error) {
          if (error instanceof Error && error.message === 'agent_session_exited_during_start') {
            this.releaseRejectedPtyRegistrationFence(result.id, result.incarnationId)
          }
          throw error
        }
        this.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
        if (result.wslDistro) {
          this.preparePtyExecutionContext(result.id, result.wslDistro)
        }
        this.registerPty(result.id, workspace.id, workspace.connectionId, {
          tabId,
          leafId,
          ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
        })
        const pty = this.getOrCreatePtyWorktreeRecord(result.id)
        if (pty) {
          if (persistHostSessionBinding) {
            pty.runtimeSessionOwned = true
          }
          if (!adoptedStablePane) {
            if (launchOpts.title) {
              const observedAt = this.nextTitleObservationSequence()
              pty.title = launchOpts.title
              pty.titleUpdatedAt = observedAt
              this.setPtyManagementTitleFromObservedTitle(pty, launchOpts.title, observedAt)
            } else {
              pty.title = null
              pty.titleUpdatedAt = null
            }
            pty.launchConfig = effectiveLaunchConfig
              ? copySleepingAgentLaunchConfig(effectiveLaunchConfig)
              : null
            pty.launchToken = launchToken ?? null
            pty.launchIncarnationId = launchToken ? pty.incarnationId : null
            pty.launchAgent = launchOpts.launchAgent ?? null
          }
          pty.tabId = tabId
          pty.paneKey = paneKey
        }
        const handle = pty ? this.issuePtyHandle(pty) : preAllocatedHandle
        if (pty && !adoptedStablePane && launchOpts.deferMobileSessionPublish !== true) {
          this.publishPtyBackedMobileSessionTerminal(workspace.id, pty, {
            tabId,
            leafId,
            title: launchOpts.title ?? null,
            activate: presentation === 'focused',
            // Why: explicit background presentation may carry legacy activate
            // metadata from an already-owned renderer pane; don't select it on mobile.
            selectIfNoActiveTab: presentation !== 'background',
            ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
            ...(cwd !== workspace.path ? { startupCwd: cwd } : {})
          })
        }
        let surface: RuntimeTerminalCreate['surface'] = 'background'
        let warning: string | undefined
        if (presentation !== 'background' && this.notifier?.revealTerminalSession) {
          try {
            // Why: after the PTY is spawned, renderer tab adoption is best-effort;
            // failing here must not strand a live process without returning a handle.
            // Pass the pre-minted tabId so the renderer adopts under the same id
            // already baked into the PTY env — keeps paneKey hook attribution intact.
            await this.notifier.revealTerminalSession(workspace.id, {
              ptyId: result.id,
              title: launchOpts.title ?? null,
              ...(cwd !== workspace.path ? { cwd } : {}),
              ...(effectiveLaunchConfig ? { launchConfig: effectiveLaunchConfig } : {}),
              ...(launchToken ? { launchToken } : {}),
              ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
              ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
              activate: presentation === 'focused',
              ...(presentation ? { presentation } : {}),
              ...ownerSurfacing(opts.surfaceOwner !== false),
              tabId,
              leafId
            })
            surface = 'visible'
          } catch (err) {
            console.warn(`[terminal-create] failed to create inactive tab for ${result.id}:`, err)
            warning = createTerminalRevealWarning(handle, err)
          }
        } else if (presentation !== 'background') {
          warning = createTerminalRevealWarning(handle)
        }
        return {
          handle,
          tabId,
          paneKey,
          ptyId: result.id,
          worktreeId: workspace.id,
          title: pty?.title ?? launchOpts.title ?? null,
          ...this.getPtyExecutionHostMetadata(result.id),
          surface,
          ...(result.agentSessionEnsure
            ? { agentSessionDisposition: result.agentSessionEnsure.disposition }
            : {}),
          ...(adoptedStablePane ? { isReattach: true as const } : {}),
          ...(warning ? { warning } : {})
        }
      } finally {
        releaseStablePaneCreate()
      }
    }

    this.assertGraphReady()
    const win = rendererWindow ?? this.getAuthoritativeWindow()
    // Why: mirrors browserTabCreate — when no worktree is specified, pass
    // undefined so the renderer uses its current active worktree.
    const workspace = worktreeSelector
      ? await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
      : null
    const launchOpts = workspace
      ? await this.resolveAgentTerminalCreateOptions(workspace, opts)
      : opts
    const worktreeId = workspace?.id
    const cwd = workspace
      ? this.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd)
      : launchOpts.cwd
    const requestId = randomUUID()

    // Why: terminal creation is a renderer-side Zustand store operation (like
    // browser tab creation). The main process sends a request, the renderer
    // creates the tab and replies with the tabId so we can resolve the handle.
    const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('terminal:tabCreateReply', handler)
        reject(new Error('Terminal creation timed out'))
      }, 10_000)

      const handler = (
        event: Electron.IpcMainEvent,
        r: { requestId: string; tabId?: string; title?: string; error?: string }
      ): void => {
        if (event.sender !== win.webContents || r.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('terminal:tabCreateReply', handler)
        if (r.error) {
          reject(new Error(r.error))
        } else {
          resolve({ tabId: r.tabId!, title: r.title ?? launchOpts.title ?? '' })
        }
      }
      ipcMain.on('terminal:tabCreateReply', handler)
      win.webContents.send('terminal:requestTabCreate', {
        requestId,
        worktreeId,
        command: launchOpts.command,
        cwd,
        ...(launchOpts.env ? { env: launchOpts.env } : {}),
        ...(launchOpts.launchConfig ? { launchConfig: launchOpts.launchConfig } : {}),
        ...(launchOpts.resumeProviderSession
          ? { resumeProviderSession: launchOpts.resumeProviderSession }
          : {}),
        ...(launchOpts.launchToken ? { launchToken: launchOpts.launchToken } : {}),
        ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
        ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
        startupCommandDelivery: launchOpts.startupCommandDelivery,
        title: launchOpts.title,
        activate: presentation === 'focused',
        ...(presentation ? { presentation } : {}),
        ...ownerSurfacing(opts.surfaceOwner !== false)
      })
    })

    // Why: the renderer created the tab immediately, but the graph sync that
    // populates this.leaves may not have arrived yet. Wait for the leaf to
    // appear so we can return a valid handle the caller can use right away.
    const handle = await this.waitForTerminalHandle(reply.tabId)
    return {
      handle,
      tabId: reply.tabId,
      worktreeId: worktreeId ?? '',
      title: reply.title,
      ...this.getPtyExecutionHostMetadata(this.handles.get(handle)?.ptyId ?? null),
      surface: 'visible'
    }
  }

  async dedupeTerminalCreate(
    clientIdentity: string,
    worktreeSelector: string | undefined,
    clientMutationId: string | undefined,
    reconcileExisting: boolean,
    run: (
      canonicalWorktreeSelector: string | undefined,
      preAllocatedHandle: string | undefined
    ) => Promise<RuntimeTerminalCreate>
  ): Promise<RuntimeTerminalCreate> {
    if (!clientMutationId || !worktreeSelector) {
      if (reconcileExisting) {
        throw new Error('runtime_unavailable')
      }
      return await run(worktreeSelector, undefined)
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    const canonicalWorktreeSelector = `id:${workspace.id}`
    const preAllocatedHandle = deriveRemoteRuntimeTerminalCreateHandle(
      clientIdentity,
      workspace.id,
      clientMutationId
    )
    return this.terminalCreateIdempotency.run(
      clientIdentity,
      workspace.id,
      clientMutationId,
      async () => {
        if (reconcileExisting) {
          const adopted = await this.reconcileRemoteTerminalCreate(workspace.id, preAllocatedHandle)
          if (adopted) {
            return adopted
          }
        }
        return await run(canonicalWorktreeSelector, preAllocatedHandle)
      }
    )
  }

  private async reconcileRemoteTerminalCreate(
    worktreeId: string,
    terminalHandle: string
  ): Promise<RuntimeTerminalCreate | null> {
    if (!this.ptyController?.listProcesses) {
      throw new Error('runtime_unavailable')
    }
    const listed = await withTimeoutResult(
      this.ptyController.listProcesses(),
      PTY_CONTROLLER_LIST_TIMEOUT_MS
    )
    if (!listed.ok) {
      // Why: unknown inventory cannot prove the first create failed, so spawning could duplicate a live shell.
      throw new Error('runtime_unavailable')
    }
    const matches = listed.value.filter((session) => session.terminalHandle === terminalHandle)
    if (matches.length > 1) {
      throw new Error('terminal_create_identity_conflict')
    }
    if (matches.length === 0) {
      const sameWorktreeHasUnknownIdentity = listed.value.some(
        (session) =>
          (session.worktreeId ?? inferWorktreeIdFromPtyId(session.id)) === worktreeId &&
          !session.terminalHandle
      )
      if (sameWorktreeHasUnknownIdentity) {
        // Why: older retained providers may list the first shell without its handle; absence is not authoritative in that shape.
        throw new Error('runtime_unavailable')
      }
      return null
    }
    const session = matches[0]
    const authoritativeWorktreeId = session.worktreeId ?? inferWorktreeIdFromPtyId(session.id)
    if (authoritativeWorktreeId !== worktreeId) {
      // Why: a reused address or forged provider record must never adopt a PTY from another workspace.
      throw new Error('terminal_create_identity_conflict')
    }
    this.adoptControllerTerminalHandle(session.id, terminalHandle)
    const pty = this.recordPtyWorktree(session.id, worktreeId, {
      connected: true,
      title: session.title
    })
    const adoptedHandle = this.issuePtyHandle(pty)
    if (adoptedHandle !== terminalHandle) {
      throw new Error('terminal_create_identity_conflict')
    }
    return {
      handle: adoptedHandle,
      ptyId: session.id,
      worktreeId,
      title: session.title || null,
      surface: 'background'
    }
  }

  private getPtyExecutionHostMetadata(
    ptyId: string | null
  ): Pick<RuntimeTerminalCreate, 'executionHostId' | 'hostPlatform'> {
    if (!ptyId) {
      return {}
    }
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return {}
    }
    if (pty.connectionId) {
      const remotePlatform = getRegisteredSshState(pty.connectionId)?.remotePlatform
      return {
        executionHostId: toSshExecutionHostId(pty.connectionId),
        ...(remotePlatform ? { hostPlatform: remotePlatform } : {})
      }
    }
    return {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      hostPlatform: pty.isWsl || pty.wslDistro ? 'linux' : process.platform
    }
  }

  async launchAgentTerminal(
    worktreeSelector: string,
    opts: { agent: TuiAgent; prompt: string; title?: string }
  ): Promise<RuntimeTerminalCreate> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('Repository for the selected workspace is no longer available.')
    }
    const startup = this.buildStartupForAgent(repo, opts.agent, opts.prompt)
    await this.markWorkspaceTrustedForAgent(opts.agent, repo.connectionId, worktree.path)
    return await this.createTerminal(`id:${worktree.id}`, {
      command: startup.startup.command,
      env: startup.startup.env,
      ...(startup.startup.launchConfig ? { launchConfig: startup.startup.launchConfig } : {}),
      launchAgent: startup.agent,
      startupCommandDelivery: startup.startup.startupCommandDelivery,
      telemetry: startup.startup.telemetry,
      title: opts.title
    })
  }

  // Why: dedupes a worktree.create whose response was lost when a mobile
  // connection migration (relay/direct hand-off on shoddy cellular) rejected the
  // in-flight request. A retry with the same clientMutationId returns the
  // in-flight or just-finished create instead of a duplicate worktree; failures
  // drop immediately so a genuine retry starts fresh, and successes linger
  // briefly so a retry whose response was lost in the cutover still reconciles.
  dedupeWorktreeCreate<T>(
    repoSelector: string,
    clientMutationId: string | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    if (!clientMutationId) {
      return run()
    }
    const key = `${repoSelector}\0${clientMutationId}`
    const inflight = this.worktreeCreateByMutationId.get(key)
    if (inflight) {
      return inflight as Promise<T>
    }
    const created = run()
    this.worktreeCreateByMutationId.set(key, created)
    const drop = (): void => {
      if (this.worktreeCreateByMutationId.get(key) === created) {
        this.worktreeCreateByMutationId.delete(key)
      }
    }
    void created.then(() => {
      setTimeout(drop, WORKTREE_CREATE_RESULT_TTL_MS).unref?.()
    }, drop)
    return created
  }

  async createMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      targetGroupId?: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      select?: boolean
      clientNavigationId?: string
      navigation?: RuntimeNavigationTarget
      clientMutationId?: string
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const navigation = opts.navigation ?? 'all'
    const select = opts.select ?? opts.activate !== false
    const runOpts = {
      ...opts,
      activate: select && navigationTargetsHost(navigation)
    }
    const mutationId = opts.clientMutationId
    let result: RuntimeMobileSessionCreateTerminalResult
    if (!mutationId) {
      result = await this.runCreateMobileSessionTerminal(worktreeSelector, runOpts)
    } else {
      // Why: idempotency is caller-owned; two paired devices may reuse the same mutation id without sharing a result.
      const mutationKey = `${opts.clientNavigationId ?? 'local'}\0${worktreeSelector}\0${mutationId}`
      // Why: a retried create (double-tap, reconnect replay) with the same
      // idempotency key must return the in-flight operation instead of spawning a
      // duplicate terminal. Successes are kept briefly so a retry whose response
      // was lost in transit reuses the created terminal; failures are dropped
      // immediately so a retry can start a fresh create.
      const inflight = this.mobileTerminalCreateByMutationId.get(mutationKey)
      const run = inflight ?? this.runCreateMobileSessionTerminal(worktreeSelector, runOpts)
      if (!inflight) {
        this.mobileTerminalCreateByMutationId.set(mutationKey, run)
        const drop = (): void => {
          if (this.mobileTerminalCreateByMutationId.get(mutationKey) === run) {
            this.mobileTerminalCreateByMutationId.delete(mutationKey)
          }
        }
        void run.then(() => {
          setTimeout(drop, MOBILE_TERMINAL_CREATE_RESULT_TTL_MS).unref?.()
        }, drop)
      }
      result = await run
    }
    if (select) {
      const worktreeId =
        this.getValidatedExplicitWorktreeIdSelector(worktreeSelector) ??
        (await this.resolveWorktreeSelector(worktreeSelector)).id
      this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        result.tab.id,
        navigation,
        opts.clientNavigationId
      )
    }
    return result
  }

  private async runCreateMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      targetGroupId?: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      clientNavigationId?: string
      clientMutationId?: string
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const pairedCreate = Boolean(opts.clientNavigationId)
    const graphEpoch = this.captureReadyGraphEpoch()
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    const worktreeId = workspace.id
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    let afterDesktopTabId: string | undefined
    if (opts.afterTabId) {
      const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
      const anchor = snapshot?.tabs.find((tab) => tab.id === opts.afterTabId)
      if (!anchor) {
        throw new Error('after_tab_not_found')
      }
      afterDesktopTabId = anchor.type === 'terminal' ? anchor.parentTabId : anchor.id
    }
    const startupCommand = await this.resolveMobileSessionTerminalCommand(workspace, opts)
    this.assertStableReadyGraph(graphEpoch)
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const win = this.getAvailableAuthoritativeWindow()
    if (!win) {
      return await this.createRuntimeOwnedMobileSessionTerminal(
        worktreeId,
        opts.activate !== false,
        opts.afterTabId,
        {
          command: startupCommand.command,
          cwd,
          env: startupCommand.env,
          envToDelete: startupCommand.envToDelete,
          startupCommandDelivery: startupCommand.startupCommandDelivery,
          launchAgent: startupCommand.launchAgent,
          viewMode: opts.viewMode,
          targetGroupId: opts.targetGroupId,
          launchConfig: startupCommand.launchConfig,
          signal: opts.signal
        }
      )
    }
    if (win.webContents.isDestroyed?.()) {
      throw new Error('runtime_unavailable')
    }
    const releasePublicationThrottle = pairedCreate
      ? this.rendererPublicationThrottle.acquire(win.webContents)
      : () => {}
    try {
      const requestId = randomUUID()
      const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          opts.signal?.removeEventListener('abort', onAbort)
          reject(new Error('Terminal creation timed out'))
        }, 10_000)
        // Why: a dead client connection cancels the wait; the renderer tab (and
        // its shell) stays alive for the host and mirrors on reconnect (#7718).
        const onAbort = (): void => {
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          reject(new Error('client_disconnected'))
        }

        const handler = (
          event: Electron.IpcMainEvent,
          r: { requestId: string; tabId?: string; title?: string; error?: string }
        ): void => {
          if (event.sender !== win.webContents || r.requestId !== requestId) {
            return
          }
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          opts.signal?.removeEventListener('abort', onAbort)
          if (r.error) {
            reject(new Error(r.error))
          } else {
            resolve({ tabId: r.tabId!, title: r.title ?? '' })
          }
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        ipcMain.on('terminal:tabCreateReply', handler)
        win.webContents.send('terminal:requestTabCreate', {
          requestId,
          worktreeId,
          afterTabId: afterDesktopTabId,
          targetGroupId: opts.targetGroupId,
          command: startupCommand.command,
          cwd,
          ...(startupCommand.env ? { env: startupCommand.env } : {}),
          ...(startupCommand.envToDelete ? { envToDelete: startupCommand.envToDelete } : {}),
          ...(startupCommand.launchConfig ? { launchConfig: startupCommand.launchConfig } : {}),
          ...(startupCommand.launchAgent ? { launchAgent: startupCommand.launchAgent } : {}),
          ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
          startupCommandDelivery: startupCommand.startupCommandDelivery,
          source: 'runtime-session',
          activate: opts.activate
        })
      })

      if (opts.activate !== false) {
        this.notifier?.focusTerminal(reply.tabId, worktreeId, null)
      }
      // Why: register the wait before the renderer's PTY spawn arrives so that
      // spawn (registerPty) can publish the pty-backed surface main-side even if
      // graph-sync is stalled (#7587). Removed in the finally below.
      const pendingCreateKey = `${worktreeId}::${reply.tabId}`
      // Why: a rescue publishes into the active group (opts.targetGroupId is not
      // threaded); the renderer's reconciling publication then moves the tab to the
      // requested group, so any wrong-group placement is cosmetic and stall-window-only.
      this.pendingMobileTerminalCreatesByKey.set(pendingCreateKey, {
        activate: opts.activate !== false,
        paired: pairedCreate,
        selectIfNoActiveTab: true,
        ...(startupCommand.command ? { startupCommand: startupCommand.command } : {}),
        ...(opts.viewMode ? { viewMode: opts.viewMode } : {})
      })
      try {
        // Why: the PTY spawn and the tabCreate reply race on independent IPC
        // channels; if the spawn already registered, publish immediately so the
        // wait resolves without depending on a graph sync.
        this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, reply.tabId)
        const surface = await this.waitForMobileTerminalSurface(worktreeId, reply.tabId, {
          timeoutMs: MOBILE_TERMINAL_SURFACE_TIMEOUT_MS,
          signal: opts.signal
        })
        if (this.isReadyMobileTerminalSurface(surface)) {
          this.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
          return surface
        }
        const readySurface = await this.waitForMobileTerminalSurface(worktreeId, reply.tabId, {
          timeoutMs: MOBILE_TERMINAL_READY_FALLBACK_MS,
          requireReady: true,
          signal: opts.signal
        }).catch(() => null)
        if (readySurface) {
          this.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
          return readySurface
        }
        if (opts.signal?.aborted) {
          // Why: nobody awaits this create anymore; don't materialize or roll back — the renderer's own publication settles the tab.
          throw new Error('client_disconnected')
        }
        const pendingSurface = this.findMobileTerminalSurface(worktreeId, reply.tabId)
        if (!pendingSurface) {
          throw new Error('Timed out waiting for terminal surface after creation')
        }
        // Why: a hidden renderer can publish the tab shell before the PTY spawns; reuse the same identity so later focus adopts instead of creating another tab.
        return await this.createRuntimeOwnedMobileSessionTerminal(
          worktreeId,
          opts.activate !== false,
          opts.afterTabId,
          {
            command: startupCommand.command,
            cwd,
            env: startupCommand.env,
            envToDelete: startupCommand.envToDelete,
            startupCommandDelivery: startupCommand.startupCommandDelivery,
            identity: { tabId: pendingSurface.tab.parentTabId, leafId: pendingSurface.tab.leafId },
            launchAgent: startupCommand.launchAgent,
            viewMode: opts.viewMode,
            targetGroupId: opts.targetGroupId,
            launchConfig: startupCommand.launchConfig,
            signal: opts.signal
          }
        )
      } catch (error) {
        // Why: publication latency (hidden renderer) can trip the surface timeout; rescue only when a live PTY backs the tab, else a ghost tab skips rollback (#7587).
        if (this.findLiveRegisteredPtyForRendererTab(worktreeId, reply.tabId)) {
          const rescued = this.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, reply.tabId)
          if (rescued) {
            this.deliverPendingStartupCommandToBareRendererPty(worktreeId, reply.tabId)
            return rescued
          }
        }
        // Why: don't roll back on a client disconnect or a live shell already backing the tab — that would kill a visible terminal ("tab dies after ~10s", #7718).
        if (
          isClientDisconnectedError(error) ||
          this.hasLiveShellForRendererTab(worktreeId, reply.tabId)
        ) {
          throw error
        }
        // Why: renderer made the tab but no live PTY backs it (real spawn/handle failure); roll it back so it can't linger as a ghost in mobile snapshots.
        this.notifier?.closeTerminal(reply.tabId)
        throw error
      } finally {
        this.pendingMobileTerminalCreatesByKey.delete(pendingCreateKey)
      }
    } finally {
      releasePublicationThrottle()
    }
  }

  private async resolveMobileSessionTerminalCommand(
    workspace: TerminalWorkspaceLaunchScope,
    opts: {
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
    }
  ): Promise<{
    command?: string
    env?: Record<string, string>
    envToDelete?: string[]
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
  }> {
    if (opts.command || !opts.agent) {
      return {
        command: opts.command,
        env: opts.env,
        envToDelete: opts.envToDelete,
        launchConfig: opts.launchConfig,
        launchAgent: opts.launchAgent,
        startupCommandDelivery: opts.startupCommandDelivery
      }
    }
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const settings = this.store.getSettings()
    if (!isTuiAgentEnabled(opts.agent, settings.disabledTuiAgents)) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    // Why: mobile may be iOS while the shell host is Windows/macOS/Linux or SSH Linux; quote for the host shell.
    const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
    // Why: SSH runs the CLI through the relay shim (plain `orca`), so the Linux-only `orca-ide` rename must not apply.
    const isRemote = workspace.repo ? repoIsRemote(workspace.repo) : repoIsRemote(workspace)
    const queuedShell = resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    const startupPlan = buildAgentStartupPlan({
      agent: opts.agent,
      prompt: opts.agentPrompt ?? '',
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(opts.agent, settings.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(opts.agent, settings.agentDefaultEnv),
      platform,
      shell: queuedShell,
      isRemote,
      allowEmptyPromptLaunch: true
    })
    if (!startupPlan) {
      throw new Error(`Could not build launch command for ${opts.agent}.`)
    }
    if (opts.agentPrompt && startupPlan.followupPrompt) {
      throw new Error(`Agent ${opts.agent} does not support startup prompt quick commands.`)
    }
    await this.markWorkspaceTrustedForAgent(opts.agent, workspace.connectionId, workspace.path)
    return {
      command: startupPlan.launchCommand,
      env: startupPlan.env,
      // Why: a real-home Codex resume strips inherited CODEX_HOME via
      // envToDelete; dropping it here would resume against the wrong home.
      envToDelete: opts.envToDelete,
      launchConfig: startupPlan.launchConfig,
      launchAgent: opts.agent,
      startupCommandDelivery: startupPlan.startupCommandDelivery
    }
  }

  private async createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts: {
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      identity?: { tabId: string; leafId: string; sessionId?: string }
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      targetGroupId?: string
      launchConfig?: SleepingAgentLaunchConfig
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    // Why: SshPtyProvider treats sessionId as a relay reattach; only synthesize local serve ids so SSH fresh terminals still call pty.spawn.
    const stableSessionId =
      opts.identity?.sessionId ?? (workspace.connectionId ? undefined : `serve-${randomUUID()}`)
    const isNewSession = stableSessionId !== undefined && opts.identity?.sessionId === undefined
    const terminal = await this.createTerminal(`id:${worktreeId}`, {
      focus: false,
      command: opts.command,
      cwd,
      env: opts.env,
      envToDelete: opts.envToDelete,
      ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
      startupCommandDelivery: opts.startupCommandDelivery,
      ...(opts.identity
        ? {
            tabId: opts.identity.tabId,
            leafId: opts.identity.leafId,
            ...(stableSessionId ? { sessionId: stableSessionId } : {})
          }
        : stableSessionId
          ? { sessionId: stableSessionId }
          : {}),
      ...(isNewSession ? { isNewSession: true } : {}),
      persistHostSessionBinding: true,
      // Why: this method publishes the authoritative snapshot below; skip the intermediate publish to avoid a wrong-group flash.
      deferMobileSessionPublish: true,
      signal: opts.signal
    })
    const livePty = this.getLivePtyForHandle(terminal.handle)
    if (!livePty) {
      throw new Error('terminal_handle_stale')
    }
    const parentTabId = livePty.pty.tabId ?? `pty:${livePty.pty.ptyId}`
    const leafId = parsePaneKey(livePty.pty.paneKey ?? '')?.leafId ?? randomUUID()
    if (opts.viewMode) {
      // Why: the runtime-owned binding must survive a serve restart with the same initial mode, not a later client's local default.
      this.persistHeadlessSessionTabProps(worktreeId, parentTabId, { viewMode: opts.viewMode })
    }
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    const existingSurface =
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === parentTabId &&
          candidate.leafId === leafId
      ) ?? null
    const parentLayout = buildMaterializedHeadlessParentLayout(
      leafId,
      livePty.pty.ptyId,
      existingSurface?.parentLayout
    )
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      ptyId: livePty.pty.ptyId,
      title: terminal.title ?? livePty.pty.title ?? 'Terminal',
      ...(cwd ? { startupCwd: cwd } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
      parentLayout,
      isActive: activate
    }
    const tabs = (existing?.tabs ?? [])
      .filter((candidate) => candidate.id !== tab.id)
      .map((candidate) => ({
        ...candidate,
        ...(candidate.type === 'terminal' && candidate.parentTabId === parentTabId
          ? { parentLayout }
          : {}),
        isActive: activate ? false : candidate.isActive
      }))
    const insertAfter = afterTabId ? tabs.findIndex((candidate) => candidate.id === afterTabId) : -1
    if (insertAfter >= 0) {
      tabs.splice(insertAfter + 1, 0, tab)
    } else {
      tabs.push(tab)
    }
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      // Why: activating the new tab also focuses its group, so a "+" targeting a specific split group makes that group active too.
      activeGroupId:
        activate && opts.targetGroupId
          ? opts.targetGroupId
          : (existing?.activeGroupId ?? getHeadlessMobileSessionGroupId(worktreeId)),
      activeTabId: activate ? tab.id : (existing?.activeTabId ?? null),
      activeTabType: activate ? 'terminal' : (existing?.activeTabType ?? null),
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        tabs,
        activate ? tab : null,
        existing?.tabGroups,
        opts.targetGroupId ? { tabId: parentTabId, groupId: opts.targetGroupId } : undefined
      ),
      // Why: keep group split geometry on new-tab creation, else opening a terminal while split loses the arrangement.
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, next)
    const result = this.toMobileSessionTabsResult(next)
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId)
      )
    }
    const created = result.tabs.find((candidate) => candidate.id === tab.id)
    if (!created || created.type !== 'terminal') {
      throw new Error('terminal_handle_stale')
    }
    return {
      tab: created,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }

  private waitForMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { timeoutMs?: number; requireReady?: boolean; signal?: AbortSignal } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const timeoutMs = options.timeoutMs ?? MOBILE_TERMINAL_SURFACE_TIMEOUT_MS
    const existing = this.findMobileTerminalSurface(worktreeId, parentTabId, options)
    if (existing) {
      return Promise.resolve(existing)
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error('client_disconnected'))
    }

    return new Promise<RuntimeMobileSessionCreateTerminalResult>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for terminal surface after creation'))
      }, timeoutMs)
      // Why: a dead client connection cancels the wait immediately instead of running down the timeout into rollback (#7718).
      const onAbort = (): void => {
        cleanup()
        reject(new Error('client_disconnected'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const check = (): void => {
        const next = this.findMobileTerminalSurface(worktreeId, parentTabId, options)
        if (!next) {
          return
        }
        cleanup()
        resolve(next)
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }

  private findMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { requireReady?: boolean } = {}
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return null
    }
    const result = this.toMobileSessionTabsResult(snapshot)
    const tab = result.tabs.find(
      (candidate) => candidate.type === 'terminal' && candidate.parentTabId === parentTabId
    )
    if (!tab || tab.type !== 'terminal') {
      return null
    }
    const surface = {
      tab,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
    if (options.requireReady === true && !this.isReadyMobileTerminalSurface(surface)) {
      return null
    }
    return surface
  }

  private findMobileTerminalSurfaceForPty(
    worktreeId: string,
    ptyId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate) =>
        candidate.type === 'terminal' &&
        (candidate.ptyId === ptyId ||
          candidate.parentLayout?.ptyIdsByLeafId?.[candidate.leafId] === ptyId)
    )
    return tab?.type === 'terminal'
      ? this.findMobileTerminalSurface(worktreeId, tab.parentTabId)
      : null
  }

  // Why: publish an in-flight mobile create main-side from the live PTY so it can't stall on graph sync and destroy the session (#7587).
  private ensurePtyBackedMobileSurfaceForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const pending = this.pendingMobileTerminalCreatesByKey.get(`${worktreeId}::${tabId}`)
    if (!pending) {
      return null
    }
    const existing = this.findMobileTerminalSurface(worktreeId, tabId)
    const pty = this.findLiveRegisteredPtyForRendererTab(worktreeId, tabId)
    if (pty) {
      pty.runtimeSessionOwned = true
      if (pending.paired) {
        this.setPairedRendererSessionOwnership(pty.ptyId, true)
      }
    }
    if (
      existing &&
      this.isReadyMobileTerminalSurface(existing) &&
      (pending.viewMode === undefined || existing.tab.viewMode === pending.viewMode)
    ) {
      // Why: the renderer's ready publication already landed with the intended mode; only a pending shell needs the main-side rescue.
      return existing
    }
    const leafId = pty ? parsePaneKey(pty.paneKey ?? '')?.leafId : undefined
    if (!pty || !leafId) {
      return existing
    }
    this.publishPtyBackedMobileSessionTerminal(worktreeId, pty, {
      tabId,
      leafId,
      title: null,
      activate: pending.activate,
      selectIfNoActiveTab: pending.selectIfNoActiveTab,
      ...(pending.viewMode ? { viewMode: pending.viewMode } : {})
    })
    // Why: check closures normally drain only inside syncWindowGraph; a main-side publish must drain them too or the pending wait misses the insertion.
    for (const cb of [...this.graphSyncCallbacks]) {
      cb()
    }
    return this.findMobileTerminalSurface(worktreeId, tabId)
  }

  private restoreLivePairedRendererSessionOwnedMobileTerminals(
    worktreeId: string | null,
    options: { missingSnapshotOnly?: boolean; notify?: boolean } = {}
  ): void {
    for (const ptyId of this.pairedRendererSessionOwnedPtyIds) {
      const pty = this.ptysById.get(ptyId)
      if (
        !pty?.connected ||
        !pty.tabId ||
        (worktreeId !== null && !runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId))
      ) {
        continue
      }
      const targetWorktreeId = worktreeId ?? pty.worktreeId
      const pane = parsePaneKey(pty.paneKey ?? '')
      if (!pane || pane.tabId !== pty.tabId) {
        continue
      }
      const existing = this.mobileSessionTabsByWorktree.get(targetWorktreeId)
      if (existing && options.missingSnapshotOnly) {
        continue
      }
      if (
        existing?.tabs.some(
          (tab) =>
            tab.type === 'terminal' &&
            (tab.ptyId === pty.ptyId ||
              (tab.parentTabId === pty.tabId && tab.leafId === pane.leafId))
        )
      ) {
        continue
      }
      if (!existing) {
        this.mobileSessionTabsByWorktree.set(targetWorktreeId, {
          worktree: targetWorktreeId,
          publicationEpoch: `renderer-rescue:${Date.now().toString(36)}`,
          snapshotVersion: 0,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabGroups: [],
          tabs: []
        })
      }
      this.publishPtyBackedMobileSessionTerminal(targetWorktreeId, pty, {
        tabId: pty.tabId,
        leafId: pane.leafId,
        title: null,
        activate: false,
        selectIfNoActiveTab: false,
        notify: options.notify
      })
    }
  }

  private setPairedRendererSessionOwnership(ptyId: string, owned: boolean): void {
    if (owned) {
      this.pairedRendererSessionOwnedPtyIds.add(ptyId)
    } else {
      this.pairedRendererSessionOwnedPtyIds.delete(ptyId)
    }
  }

  private findLiveRegisteredPtyForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimePtyWorktreeRecord | null {
    for (const pty of this.ptysById.values()) {
      if (
        pty.worktreeId === worktreeId &&
        pty.tabId === tabId &&
        pty.connected &&
        parsePaneKey(pty.paneKey ?? '')?.leafId
      ) {
        return pty
      }
    }
    return null
  }

  // Why: looser rollback guard than findLiveRegisteredPtyForRendererTab — a shell without a registered pane key is still a real terminal the timeout must not kill (#7718).
  private hasLiveShellForRendererTab(worktreeId: string, tabId: string): boolean {
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId === worktreeId && pty.tabId === tabId && pty.connected) {
        return true
      }
    }
    return false
  }

  private isReadyMobileTerminalSurface(
    surface: RuntimeMobileSessionCreateTerminalResult | null
  ): boolean {
    return (
      surface?.tab.status === 'ready' &&
      typeof surface.tab.terminal === 'string' &&
      surface.tab.terminal.length > 0
    )
  }

  // Why: a create can settle over a renderer PTY that spawned without its
  // startup command (the create's renderer stalled, #7587), silently binding
  // the client to a plain shell under an agent tab forever — once the surface
  // is ready, the activation-time materialize recovery (#7837) never runs
  // (STA-3214). Spawn commands are recorded per PTY at spawn time, so a
  // missing record on the locally registered live PTY proves the launch never
  // ran; type it into the shell like the create would have.
  private deliverPendingStartupCommandToBareRendererPty(worktreeId: string, tabId: string): void {
    const pending = this.pendingMobileTerminalCreatesByKey.get(`${worktreeId}::${tabId}`)
    const command = pending?.startupCommand
    if (!command) {
      return
    }
    const pty = this.findLiveRegisteredPtyForRendererTab(worktreeId, tabId)
    if (!pty || this.terminalSpawnCommandsByPtyId.has(pty.ptyId)) {
      return
    }
    if (this.ptyController?.write(pty.ptyId, command)) {
      // Why: Enter rides its own write so a long command cannot swallow it.
      this.ptyController.write(pty.ptyId, '\r')
      this.noteTerminalSpawnCommand(pty.ptyId, command)
    }
  }

  private waitForTerminalHandle(tabId: string, timeoutMs = 10_000): Promise<string> {
    const existing = this.resolveHandleForTab(tabId)
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        reject(new Error('Timed out waiting for terminal handle after creation'))
      }, timeoutMs)

      const check = (): void => {
        const handle = this.resolveHandleForTab(tabId)
        if (handle) {
          clearTimeout(timer)
          const idx = this.graphSyncCallbacks.indexOf(check)
          if (idx !== -1) {
            this.graphSyncCallbacks.splice(idx, 1)
          }
          resolve(handle)
        }
      }
      this.graphSyncCallbacks.push(check)
      // Why: graph sync may have fired between the initial check and registration; re-check to avoid a missed wake-up.
      check()
    })
  }

  // Why: mobile may subscribe before the PTY spawns; wait for it so subscribe proceeds with phone-fit instead of a bare scrollback+end.
  waitForLeafPtyId(handle: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
    const leaf = this.resolveLeafForHandle(handle)
    if (leaf?.ptyId) {
      return Promise.resolve(leaf.ptyId)
    }

    // Why: ptyId null→real invalidates the old handle; capture tabId+leafId now for direct leaf lookup afterward.
    const record = this.handles.get(handle)
    const savedTabId = record?.tabId ?? null
    const savedLeafId = record?.leafId ?? null

    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let check: () => void = () => {}
      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (ptyId: string): void => {
        cleanup()
        resolve(ptyId)
      }
      const fail = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onAbort = (): void => {
        fail(new Error('request_aborted'))
      }
      if (signal?.aborted) {
        reject(new Error('request_aborted'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        fail(new Error('Timed out waiting for PTY to spawn'))
      }, timeoutMs)

      check = (): void => {
        // Try the handle first (works if handle wasn't invalidated yet)
        let ptyId = this.resolveLeafForHandle(handle)?.ptyId
        // Why: ptyId null→real invalidates the old handle; fall back to direct leaf lookup by saved coordinates.
        if (!ptyId && savedTabId && savedLeafId) {
          const directLeaf = this.leaves.get(this.getLeafKey(savedTabId, savedLeafId))
          ptyId = directLeaf?.ptyId ?? null
        }
        if (ptyId) {
          finish(ptyId)
        }
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }

  // Why: never-mounted tabs have no PTY or snapshot; synthetic handles need the ptyId to mount the exact owning tab.
  requestRendererTerminalTabMount(handle: string): boolean {
    const record = this.handles.get(handle)
    if (!record?.worktreeId) {
      return false
    }
    const tabId = record.tabId.startsWith('pty:') ? undefined : record.tabId
    const ptyId = record.ptyId ?? undefined
    if (!tabId && !ptyId) {
      return false
    }
    try {
      this.getAuthoritativeWindow().webContents.send('terminal:requestTabMount', {
        worktreeId: record.worktreeId,
        ...(tabId ? { tabId } : {}),
        ...(ptyId ? { ptyId } : {})
      })
      return true
    } catch {
      // No authoritative window (shutdown/headless): subscribe keeps its empty-snapshot fallback.
      return false
    }
  }

  getRendererTerminalSerializerGeneration(ptyId: string): number {
    return this.ptyController?.getRendererSerializerGeneration?.(ptyId) ?? 0
  }

  getRendererTerminalSerializerGenerationForHandle(handle: string): number {
    const ptyId = this.handles.get(handle)?.ptyId
    return ptyId ? this.getRendererTerminalSerializerGeneration(ptyId) : 0
  }

  replaceHeadlessTerminalFromRendererSnapshotForRecovery(
    ptyId: string,
    snapshot: {
      data: string
      cols: number
      rows: number
      cwd?: string | null
      oscLinks?: TerminalOscLinkRange[]
    },
    trailingOutput: { data: string; seq: number }[] = []
  ): void {
    if (!snapshot.data) {
      return
    }
    // Why: a redraw byte can create a suffix-only model before the renderer settles; replace it with the exact snapshot already sent mobile.
    this.providerSnapshotPreferredPtys.add(ptyId)
    this.disposeHeadlessTerminal(ptyId)
    this.seedHeadlessTerminal(
      ptyId,
      snapshot.data,
      { cols: snapshot.cols, rows: snapshot.rows },
      { cwd: snapshot.cwd, oscLinks: snapshot.oscLinks }
    )
    for (const chunk of trailingOutput) {
      this.trackHeadlessTerminalData(ptyId, chunk.data, chunk.seq)
    }
    // The seed's write chain owns subsequent live bytes; suppress on-data hydration from replacing this known-good seed.
    this.headlessHydrationState.set(ptyId, 'done')
  }

  waitForRendererTerminalSerializer(
    ptyId: string,
    afterGeneration: number,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    return (
      this.ptyController?.waitForRendererSerializer?.(ptyId, afterGeneration, timeoutMs, signal) ??
      Promise.resolve(false)
    )
  }

  // Why: a leaf exists before its PTY spawns; a handle issued while ptyId is null gets invalidated on the next sync, so wait for a connected PTY.
  private countLeavesInTab(tabId: string): number {
    let count = 0
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === tabId) {
        count++
      }
    }
    return count
  }

  private resolveHandleForTab(tabId: string): string | null {
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === tabId && leaf.ptyId !== null) {
        return this.issueHandle(leaf)
      }
    }
    return null
  }

  async focusTerminal(
    handle: string,
    options: { navigateHost?: boolean } = {}
  ): Promise<RuntimeTerminalFocus> {
    const navigateHost = options.navigateHost !== false
    const livePtyIdentity = (): RuntimeTerminalFocus => {
      const live = this.getLivePtyForHandle(handle)
      if (!live?.pty.connected) {
        throw new Error('terminal_exited')
      }
      return {
        handle,
        tabId: live.pty.tabId ?? live.record.tabId,
        worktreeId: live.pty.worktreeId,
        navigated: false
      }
    }
    const liveLeafIdentity = (): RuntimeTerminalFocus => {
      this.assertGraphReady()
      const { leaf: current } = this.getLiveLeafForHandle(handle)
      return {
        handle,
        tabId: current.tabId,
        worktreeId: current.worktreeId,
        navigated: false
      }
    }

    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_exited')
      }
      if (!navigateHost || !this.notifier?.revealTerminalSession) {
        return {
          handle,
          tabId: pty.pty.tabId ?? pty.record.tabId,
          worktreeId: pty.pty.worktreeId,
          navigated: false
        }
      }
      // Coalesce concurrent host navigations: only the latest full reveal claims navigated.
      return this.terminalFocusNavigationCoalescer.run({
        key: handle,
        resolveSuperseded: (completed) =>
          completed ? { ...completed, navigated: false } : livePtyIdentity(),
        run: async (ctx) => {
          const live = this.getLivePtyForHandle(handle)
          if (!live?.pty.connected) {
            throw new Error('terminal_exited')
          }
          if (!ctx.isCurrent()) {
            return {
              handle,
              tabId: live.pty.tabId ?? live.record.tabId,
              worktreeId: live.pty.worktreeId,
              navigated: false
            }
          }
          const notifier = this.notifier
          if (!notifier?.revealTerminalSession) {
            return {
              handle,
              tabId: live.pty.tabId ?? live.record.tabId,
              worktreeId: live.pty.worktreeId,
              navigated: false
            }
          }
          const parsedPaneKey = parsePaneKey(live.pty.paneKey ?? '')
          const revealed = await notifier.revealTerminalSession(live.pty.worktreeId, {
            ptyId: live.pty.ptyId,
            title: getLatestPtyTitle(live.pty),
            ...(live.pty.launchConfig
              ? { launchConfig: copySleepingAgentLaunchConfig(live.pty.launchConfig) }
              : {}),
            ...(live.pty.launchToken ? { launchToken: live.pty.launchToken } : {}),
            ...(live.pty.launchAgent ? { launchAgent: live.pty.launchAgent } : {}),
            ...(live.pty.tabId !== null ? { tabId: live.pty.tabId } : {}),
            ...(parsedPaneKey ? { leafId: parsedPaneKey.leafId } : {})
          })
          if (!ctx.isCurrent() || this.notifier !== notifier) {
            return {
              handle,
              tabId: revealed?.tabId ?? live.pty.tabId ?? live.record.tabId,
              worktreeId: live.pty.worktreeId,
              navigated: false
            }
          }
          return {
            handle,
            tabId: revealed?.tabId ?? live.pty.tabId ?? live.record.tabId,
            worktreeId: live.pty.worktreeId,
            navigated: true
          }
        }
      })
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!navigateHost) {
      return {
        handle,
        tabId: leaf.tabId,
        worktreeId: leaf.worktreeId,
        navigated: false
      }
    }
    if (!this.notifier?.focusTerminal) {
      return {
        handle,
        tabId: leaf.tabId,
        worktreeId: leaf.worktreeId,
        navigated: false
      }
    }
    return this.terminalFocusNavigationCoalescer.run({
      key: handle,
      resolveSuperseded: (completed) =>
        completed ? { ...completed, navigated: false } : liveLeafIdentity(),
      run: async (ctx) => {
        this.assertGraphReady()
        const { leaf: liveLeaf } = this.getLiveLeafForHandle(handle)
        if (!ctx.isCurrent()) {
          return {
            handle,
            tabId: liveLeaf.tabId,
            worktreeId: liveLeaf.worktreeId,
            navigated: false
          }
        }
        const notifier = this.notifier
        if (!notifier?.focusTerminal) {
          return {
            handle,
            tabId: liveLeaf.tabId,
            worktreeId: liveLeaf.worktreeId,
            navigated: false
          }
        }
        notifier.focusTerminal(liveLeaf.tabId, liveLeaf.worktreeId, liveLeaf.leafId)
        if (!ctx.isCurrent() || this.notifier !== notifier) {
          return {
            handle,
            tabId: liveLeaf.tabId,
            worktreeId: liveLeaf.worktreeId,
            navigated: false
          }
        }
        return {
          handle,
          tabId: liveLeaf.tabId,
          worktreeId: liveLeaf.worktreeId,
          navigated: true
        }
      }
    })
  }

  async closeTerminal(handle: string): Promise<RuntimeTerminalClose> {
    const pty = this.getLivePtyForHandle(handle)
    this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
    if (pty) {
      // Why: PTY exit can immediately replace a ready SSH publication with a pending one, so capture its durable HUB surface before killing it.
      const surface =
        (pty.pty.tabId
          ? this.findMobileTerminalSurface(pty.pty.worktreeId, pty.pty.tabId)
          : null) ?? this.findMobileTerminalSurfaceForPty(pty.pty.worktreeId, pty.pty.ptyId)
      const tabId = surface?.tab.parentTabId ?? pty.pty.tabId ?? pty.record.tabId
      // Why: relay recovery can leave stale renderer leaves; the persisted HUB layout defines whether closing this PTY closes the whole surface.
      const siblingCount = surface?.tab.parentLayout
        ? countTerminalLayoutLeaves(surface.tab.parentLayout.root)
        : this.countLeavesInTab(tabId)
      const ptyKilled = this.ptyController?.kill(pty.pty.ptyId) ?? false
      if (!ptyKilled || siblingCount <= 1) {
        if (surface) {
          // Why: paired viewers keep ended streams mounted until the HUB publishes removal, so explicit close uses the durable host-tab transaction instead of viewer-local exit handling.
          try {
            await this.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId)
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'workspace_session_unavailable') {
              throw error
            }
            this.notifier?.closeTerminal(tabId)
          }
        } else {
          this.notifier?.closeTerminal(tabId)
        }
      }
      return { handle, tabId, ptyKilled }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    let ptyKilled = false
    if (leaf.ptyId) {
      ptyKilled = this.ptyController?.kill(leaf.ptyId) ?? false
    }
    // Why: in a multi-pane tab, killing the PTY is enough (renderer's exit handler closes the pane); an extra IPC close would race it and close the whole tab.
    const siblingCount = this.countLeavesInTab(leaf.tabId)
    if (!ptyKilled || siblingCount <= 1) {
      this.notifier?.closeTerminal(leaf.tabId, leaf.paneRuntimeId)
    }
    return { handle, tabId: leaf.tabId, ptyKilled }
  }

  async closeTerminalTab(handle: string): Promise<RuntimeTerminalClose> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const tabId = pty.pty.tabId
      if (!tabId) {
        return this.closeTerminal(handle)
      }
      // Why: a handle-addressed CLI/automation close is an explicit intent, so
      // it must stay destructive under the non-user close adjudication gate.
      await this.closeMobileSessionTab(`id:${pty.pty.worktreeId}`, tabId, { reason: 'user' })
      this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
      return { handle, tabId, closeMode: 'tab', ptyKilled: false }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    await this.closeMobileSessionTab(`id:${leaf.worktreeId}`, leaf.tabId, { reason: 'user' })
    this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
    return { handle, tabId: leaf.tabId, closeMode: 'tab', ptyKilled: false }
  }

  async splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {}
  ): Promise<RuntimeTerminalSplit> {
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty) {
      return await this.splitPtyBackedTerminal(livePty.pty, opts)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const direction = opts.direction ?? 'horizontal'

    // Snapshot current leaf keys so the post-split graph-sync delta reveals the new pane.
    const leafKeysBefore = new Set<string>()
    for (const [key, l] of this.leaves) {
      if (l.tabId === leaf.tabId) {
        leafKeysBefore.add(key)
      }
    }

    this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
      direction,
      command: opts.command,
      telemetrySource: opts.telemetrySource
    })

    const newHandle = await this.waitForNewLeafInTab(leaf.tabId, leafKeysBefore)
    return { handle: newHandle, tabId: leaf.tabId, paneRuntimeId: leaf.paneRuntimeId }
  }

  private async splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {}
  ): Promise<RuntimeTerminalSplit> {
    if (!this.ptyController?.spawn) {
      throw new Error('runtime_unavailable')
    }
    if (!pty.connected) {
      throw new Error('terminal_exited')
    }
    const parsedPaneKey = parsePaneKey(pty.paneKey ?? '')
    const parentTabId = pty.tabId?.trim()
    if (!parentTabId || !parsedPaneKey) {
      throw new Error('terminal_handle_stale')
    }
    const direction = opts.direction ?? 'horizontal'
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${pty.worktreeId}`)
    const sourceAuthority = this.resolveTerminalSplitSourceAuthority(
      workspace.id,
      parentTabId,
      parsedPaneKey.leafId,
      pty.ptyId
    )
    if (!sourceAuthority) {
      throw new Error('terminal_split_source_not_found')
    }
    const sourceIncarnationId =
      sourceAuthority.liveIncarnationId ?? sourceAuthority.persistedIncarnationId
    const leafId = randomUUID()
    const preAllocatedHandle = this.createPreAllocatedTerminalHandle()
    const paneKey = makePaneKey(parentTabId, leafId)
    const result = await this.ptyController.spawn({
      cols: 120,
      rows: 40,
      cwd: workspace.path,
      command: opts.command,
      commandDelivery: 'provider',
      env: this.buildTerminalWorkspaceEnv(workspace, opts.env ?? {}, paneKey, parentTabId),
      envToDelete: opts.envToDelete,
      connectionId: workspace.connectionId,
      worktreeId: workspace.id,
      preAllocatedHandle,
      tabId: parentTabId,
      leafId,
      persistHostSessionBinding: true,
      ...(sourceAuthority.persisted
        ? {
            expectedSourceBinding: {
              ...(sourceAuthority.persistedWorktreeId
                ? { worktreeId: sourceAuthority.persistedWorktreeId }
                : {}),
              tabId: parentTabId,
              leafId: parsedPaneKey.leafId,
              ptyId: pty.ptyId,
              // Why: the store can only match its own persisted map, so a live-only id it never
              // recorded would reject every split from a session restored without incarnations.
              // The live id is fenced by revalidateSourceAuthority below instead.
              ...(sourceAuthority.persistedIncarnationId
                ? { incarnationId: sourceAuthority.persistedIncarnationId }
                : {})
            }
          }
        : {})
    })
    this.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
    if (result.wslDistro) {
      this.preparePtyExecutionContext(result.id, result.wslDistro)
    }
    this.registerPty(result.id, workspace.id, workspace.connectionId)
    const createdPty = this.getOrCreatePtyWorktreeRecord(result.id)
    if (createdPty) {
      createdPty.tabId = parentTabId
      createdPty.paneKey = paneKey
      createdPty.runtimeSessionOwned = pty.runtimeSessionOwned
      this.setPairedRendererSessionOwnership(
        createdPty.ptyId,
        this.pairedRendererSessionOwnedPtyIds.has(pty.ptyId)
      )
    }

    const revealSplit = async (): Promise<void> => {
      await this.notifier?.revealTerminalSession?.(workspace.id, {
        ptyId: result.id,
        title: null,
        activate: opts.activate !== false,
        ...ownerSurfacing(opts.surfaceOwner !== false),
        tabId: parentTabId,
        leafId,
        splitFromLeafId: parsedPaneKey.leafId,
        splitDirection: direction,
        splitTelemetrySource: opts.telemetrySource
      })
    }

    try {
      const revalidateSourceAuthority = (): void => {
        const current = this.resolveTerminalSplitSourceAuthority(
          workspace.id,
          parentTabId,
          parsedPaneKey.leafId,
          pty.ptyId
        )
        if (
          !current ||
          (sourceAuthority.persisted && !current.persisted) ||
          (sourceIncarnationId !== null &&
            (current.liveIncarnationId ?? current.persistedIncarnationId) !== sourceIncarnationId)
        ) {
          throw new Error('terminal_split_source_not_found')
        }
      }
      revalidateSourceAuthority()
      if (!sourceAuthority.persisted) {
        await revealSplit()
        // Why: rejecting here unmounts the pane the reveal just added only because the retire
        // below always emits its exit and the tab still holds the source sibling — the renderer's
        // exit handler closes non-final panes. Never close it by tabId: that drops the whole tab.
        revalidateSourceAuthority()
      }
      if (createdPty) {
        const persisted = this.persistHeadlessTerminalSplit({
          worktreeId: workspace.id,
          tabId: parentTabId,
          leafId,
          ptyId: createdPty.ptyId,
          splitFromLeafId: parsedPaneKey.leafId,
          direction
        })
        if (sourceAuthority.persisted && !persisted) {
          throw new Error('workspace_session_unavailable')
        }
        this.publishPtyBackedMobileSessionTerminal(workspace.id, createdPty, {
          tabId: parentTabId,
          leafId,
          title: null,
          activate: opts.activate !== false,
          split: { splitFromLeafId: parsedPaneKey.leafId, direction }
        })
      }
    } catch (error) {
      this.setPairedRendererSessionOwnership(result.id, false)
      let stopped = false
      try {
        stopped =
          (await this.ptyController.stopAndWait?.(result.id, {
            deadlineMs: Date.now() + REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS
          })) ?? false
      } catch {
        // Best-effort fallback below preserves the original split authority error.
      }
      if (!stopped) {
        try {
          this.ptyController.kill(result.id)
        } catch {
          // Best-effort cleanup; retirement below still runs and the original error still throws.
        }
      }
      try {
        this.ptyController.retireRejectedPty?.(result.id)
      } catch {
        // Best-effort cleanup; preserve the original split authority error.
      }
      throw error
    }
    const committedSourceAuthority = sourceAuthority.persisted
      ? this.resolveTerminalSplitSourceAuthority(
          workspace.id,
          parentTabId,
          parsedPaneKey.leafId,
          pty.ptyId
        )
      : null
    if (sourceAuthority.persisted && committedSourceAuthority?.rendererMounted) {
      // Why: renderer adoption is a projection after the durable main commit; rejection cannot undo it.
      void revealSplit().catch(() => undefined)
    }

    return { handle: this.issuePtyHandle(createdPty ?? pty), tabId: parentTabId, paneRuntimeId: -1 }
  }

  private resolveTerminalSplitSourceAuthority(
    worktreeId: string,
    tabId: string,
    leafId: string,
    ptyId: string
  ): {
    persisted: boolean
    rendererMounted: boolean
    persistedWorktreeId: string | null
    persistedIncarnationId: string | null
    liveIncarnationId: string | null
  } | null {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const sessionWorktreeId = session ? resolveTerminalSessionWorktreeId(session, worktreeId) : null
    const persistedTab = sessionWorktreeId
      ? session?.tabsByWorktree[sessionWorktreeId]?.find(
          (tab) => tab.id === tabId && runtimeWorktreeIdsEqual(tab.worktreeId, worktreeId)
        )
      : undefined
    const persistedLayout = session?.terminalLayoutsByTabId?.[tabId]
    const persistedIncarnationId =
      session?.terminalPtyIncarnationsByPaneKey?.[makePaneKey(tabId, leafId)] ?? null
    const liveIncarnationId = this.ptysById.get(ptyId)?.incarnationId ?? null
    if (
      persistedIncarnationId &&
      liveIncarnationId &&
      persistedIncarnationId !== liveIncarnationId
    ) {
      return null
    }
    const persisted = Boolean(
      persistedTab &&
      persistedLayout?.ptyIdsByLeafId?.[leafId] === ptyId &&
      terminalLayoutContainsLeaf(persistedLayout.root, leafId)
    )
    const rendererTab = this.tabs.get(tabId)
    const rendererLeaf = this.leaves.get(this.getLeafKey(tabId, leafId))
    const rendererMounted = Boolean(
      rendererTab &&
      rendererLeaf &&
      runtimeWorktreeIdsEqual(rendererTab.worktreeId, worktreeId) &&
      runtimeWorktreeIdsEqual(rendererLeaf.worktreeId, worktreeId) &&
      rendererLeaf.ptyId === ptyId
    )
    if (persisted && persistedLayout) {
      return {
        persisted: true,
        rendererMounted,
        persistedWorktreeId: sessionWorktreeId,
        persistedIncarnationId,
        liveIncarnationId
      }
    }
    // Why: renderer adoption can precede graph sync; this path still requires reveal success before commit.
    const projected = [...this.mobileSessionTabsByWorktree.entries()].some(
      ([candidateWorktreeId, snapshot]) =>
        runtimeWorktreeIdsEqual(candidateWorktreeId, worktreeId) &&
        snapshot.tabs.some(
          (tab) =>
            tab.type === 'terminal' &&
            tab.parentTabId === tabId &&
            tab.leafId === leafId &&
            (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[leafId] === ptyId)
        )
    )
    if (!rendererMounted && !projected) {
      return null
    }
    return {
      persisted: false,
      rendererMounted,
      persistedWorktreeId: null,
      persistedIncarnationId: null,
      liveIncarnationId
    }
  }

  async handleAgentTeamsTmuxCompat(
    request: AgentTeamsTmuxCompatRequest
  ): Promise<AgentTeamsTmuxCompatResponse> {
    return await this.claudeAgentTeams.handleTmuxCompat(request, {
      splitTerminal: (handle, opts) => this.splitTerminal(handle, opts),
      readTerminal: (handle, opts) => this.readTerminal(handle, opts),
      sendTerminal: (handle, action) => this.sendTerminal(handle, action),
      focusTerminal: (handle) => this.focusTerminal(handle),
      closeTerminal: (handle) => this.closeTerminal(handle),
      showTerminal: (handle) => this.showTerminal(handle)
    })
  }

  async prepareClaudeAgentTeamsLeader(args: {
    paneKey: string
    baseEnv?: Record<string, string>
  }): Promise<{ env: Record<string, string> }> {
    const handle = this.getTerminalHandleForPaneKey(args.paneKey)
    if (!handle) {
      throw new Error('claude_agent_teams_requires_orca_terminal')
    }
    return await this.prepareClaudeAgentTeamsLeaderForHandle({
      handle,
      baseEnv: args.baseEnv
    })
  }

  async prepareClaudeAgentTeamsLeaderForHandle(args: {
    handle: string
    baseEnv?: Record<string, string>
  }): Promise<{ env: Record<string, string> }> {
    const baseEnv = {
      ...process.env,
      ...args.baseEnv
    }
    const shimDir = await ensureClaudeAgentTeamsShimDir()
    const shimBin = resolveClaudeAgentTeamsShimBin(baseEnv)
    return this.claudeAgentTeams.createLaunchEnv({
      leaderHandle: args.handle,
      baseEnv,
      shimDir,
      shimBin
    })
  }

  // Why: a leader handle that never binds to a PTY (lost pane race) has no exit
  // or close path to evict its team, so the abandoning caller must release it.
  releaseClaudeAgentTeamsLeaderForHandle(handle: string): void {
    this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
  }

  private waitForNewLeafInTab(
    tabId: string,
    existingLeafKeys: Set<string>,
    timeoutMs = 10_000
  ): Promise<string> {
    const tryResolve = (): string | null => {
      for (const [key, leaf] of this.leaves) {
        if (leaf.tabId === tabId && !existingLeafKeys.has(key) && leaf.ptyId !== null) {
          return this.issueHandle(leaf)
        }
      }
      return null
    }

    const existing = tryResolve()
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        reject(new Error('Timed out waiting for split pane handle'))
      }, timeoutMs)

      const check = (): void => {
        const handle = tryResolve()
        if (handle) {
          clearTimeout(timer)
          const idx = this.graphSyncCallbacks.indexOf(check)
          if (idx !== -1) {
            this.graphSyncCallbacks.splice(idx, 1)
          }
          resolve(handle)
        }
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }

  async stopTerminalsForWorktree(
    worktreeSelector: string,
    options: {
      deadline?: number
      stopPty?: (
        ptyId: string,
        stop: () => boolean | Promise<boolean>
      ) => Promise<{ stopped: boolean; owner: boolean }>
      /** Authoritative id for an orphan whose selector no longer resolves. */
      resolvedWorktreeId?: string
      resolvedConnectionId?: string
      resolvedRuntimeEnvironmentId?: string
    } = {}
  ): Promise<{ stopped: number }> {
    // Why: this mutates live PTYs, so reject while the graph is reloading rather than act on cached leaf ownership.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = options.resolvedWorktreeId
      ? { id: options.resolvedWorktreeId }
      : await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      return { stopped: 0 }
    }
    // Preserve folder-instance suffixes while normalizing cross-platform path spelling.
    const ownsWorktree = options.resolvedWorktreeId
      ? (candidate: string | undefined): boolean =>
          candidate ? runtimeWorktreeIdsEqual(candidate, worktree.id) : false
      : (candidate: string | undefined): boolean => candidate === worktree.id
    const ownsHost = (ptyId: string, connectionId?: string | null): boolean => {
      if (options.resolvedRuntimeEnvironmentId !== undefined) {
        return ptyId.startsWith(
          `remote:${encodeURIComponent(options.resolvedRuntimeEnvironmentId)}@@`
        )
      }
      return (
        options.resolvedConnectionId === undefined || connectionId === options.resolvedConnectionId
      )
    }
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (
        ownsWorktree(leaf.worktreeId) &&
        leaf.ptyId &&
        ownsHost(leaf.ptyId, this.ptysById.get(leaf.ptyId)?.connectionId)
      ) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.ptysById.values()) {
      if (ownsWorktree(pty.worktreeId) && pty.connected && ownsHost(pty.ptyId, pty.connectionId)) {
        ptyIds.add(pty.ptyId)
      }
    }

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        break
      }
      const stop = (): boolean | Promise<boolean> => {
        if (options.deadline !== undefined && Date.now() >= options.deadline) {
          return false
        }
        if (options.stopPty) {
          // Why: destructive worktree cleanup must not let its cross-surface
          // dedupe treat fire-and-forget controller.kill as physical exit.
          // Why: the RPC deadline makes shutdown/list RPCs settle before the sweep
          // deadline so a wedged daemon yields the accurate stop failure; no deadline
          // (non-destructive) keeps the provider default RPC timeout.
          if (options.deadline !== undefined) {
            return (
              this.ptyController?.stopAndWait?.(ptyId, {
                deadlineMs: teardownRpcDeadline(options.deadline)
              }) ?? false
            )
          }
          return this.ptyController?.stopAndWait?.(ptyId) ?? false
        }
        return Boolean(this.ptyController?.kill(ptyId))
      }
      const stopResult = options.stopPty
        ? await options.stopPty(ptyId, stop)
        : { stopped: stop(), owner: true }
      if (stopResult.owner && stopResult.stopped) {
        stopped += 1
      }
    }
    return { stopped }
  }

  async sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const existing = this.terminalSleepByWorktreeId.get(worktree.id)
    if (existing) {
      return await existing
    }

    const sleeping = this.sleepResolvedWorktreeTerminals(worktree)
    this.terminalSleepByWorktreeId.set(worktree.id, sleeping)
    try {
      return await sleeping
    } finally {
      if (this.terminalSleepByWorktreeId.get(worktree.id) === sleeping) {
        this.terminalSleepByWorktreeId.delete(worktree.id)
      }
    }
  }

  async acquireWorktreeTerminalSpawn(worktreeId?: string): Promise<() => void> {
    if (!worktreeId) {
      return () => {}
    }
    const release = await this.acquireWorktreeTerminalMutation(worktreeId)
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const sleepState = this.terminalSleepStateByWorktreeId.get(key)
    if (sleepState?.phase === 'sleeping' || sleepState?.phase === 'partial') {
      this.terminalSleepStateByWorktreeId.delete(key)
      this.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: sleepState.worktreeId,
        generation: sleepState.generation,
        phase: 'woken',
        ptyIds: sleepState.ptyIds,
        terminalHandles: sleepState.terminalHandles
      })
    }
    return release
  }

  private async acquireWorktreeTerminalMutation(
    worktreeId: string,
    deadline?: number
  ): Promise<() => void> {
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const previous = this.terminalMutationTailByWorktreeId.get(key) ?? Promise.resolve()
    let releaseCurrent = (): void => {}
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const tail = previous.catch(() => {}).then(() => current)
    this.terminalMutationTailByWorktreeId.set(key, tail)
    try {
      await waitForWorktreeTerminalMutation(
        previous.catch(() => {}),
        deadline
      )
    } catch (error) {
      // Why: resolve this abandoned queue node now so it can never acquire later and stop a terminal after the caller timed out.
      releaseCurrent()
      void tail.finally(() => {
        if (this.terminalMutationTailByWorktreeId.get(key) === tail) {
          this.terminalMutationTailByWorktreeId.delete(key)
        }
      })
      throw error
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      releaseCurrent()
      void tail.finally(() => {
        if (this.terminalMutationTailByWorktreeId.get(key) === tail) {
          this.terminalMutationTailByWorktreeId.delete(key)
        }
      })
    }
  }

  private async sleepResolvedWorktreeTerminals(
    worktree: ResolvedWorktree
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const sleepDeadline = Date.now() + WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS
    const releaseMutation = await this.acquireWorktreeTerminalMutation(worktree.id, sleepDeadline)
    const key = runtimeWorktreeIdentityKey(worktree.id)
    const existingSleepState = this.terminalSleepStateByWorktreeId.get(key)
    if (existingSleepState?.phase === 'sleeping') {
      try {
        const resolvedWorktrees = includeTargetResolvedWorktree(
          [...(await this.getResolvedWorktreeMap()).values()],
          worktree
        )
        const refreshedPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(
          resolvedWorktrees,
          worktree.id,
          sleepDeadline
        )
        if (!refreshedPtyLiveness) {
          throw new Error('terminal_liveness_unavailable')
        }
        if (this.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness).size === 0) {
          releaseMutation()
          return {
            stopped: 0,
            stoppedPtyIds: [],
            livePtyIds: [],
            postStopVerified: true
          }
        }
        this.emitClientEvent({
          type: 'worktreeTerminalSleepState',
          worktreeId: existingSleepState.worktreeId,
          generation: existingSleepState.generation,
          phase: 'woken',
          ptyIds: existingSleepState.ptyIds,
          terminalHandles: existingSleepState.terminalHandles
        })
        this.terminalSleepStateByWorktreeId.delete(key)
      } catch (error) {
        releaseMutation()
        throw error
      }
    }
    const priorPartialState = existingSleepState?.phase === 'partial' ? existingSleepState : null
    const committedPtyIds = new Set(priorPartialState?.ptyIds ?? [])
    const terminalHandlesByPtyId = { ...priorPartialState?.terminalHandlesByPtyId }
    const pendingPtyIds = new Set<string>()
    let generation = 0
    let fullyCommitted = false
    let releaseReversibleRendererStops = (): void => {}
    try {
      const resolvedWorktrees = includeTargetResolvedWorktree(
        [...(await this.getResolvedWorktreeMap()).values()],
        worktree
      )
      const refreshedPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(
        resolvedWorktrees,
        worktree.id,
        sleepDeadline
      )
      if (!refreshedPtyLiveness) {
        throw new Error('terminal_liveness_unavailable')
      }
      const livePtyIds = this.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness)
      generation = ++this.terminalSleepGeneration
      for (const ptyId of livePtyIds) {
        pendingPtyIds.add(ptyId)
        terminalHandlesByPtyId[ptyId] = this.getTerminalHandlesForPtyId(ptyId)
      }
      const liveTerminalHandles = this.getRecordedTerminalSleepHandles(
        livePtyIds,
        terminalHandlesByPtyId
      )
      this.terminalSleepStateByWorktreeId.set(key, {
        worktreeId: worktree.id,
        generation,
        phase: 'stopping',
        ptyIds: [...committedPtyIds].sort(),
        terminalHandles: this.getRecordedTerminalSleepHandles(
          committedPtyIds,
          terminalHandlesByPtyId
        ),
        terminalHandlesByPtyId
      })
      this.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: worktree.id,
        generation,
        phase: 'started',
        ptyIds: [...livePtyIds].sort(),
        terminalHandles: liveTerminalHandles
      })
      if (committedPtyIds.size > 0) {
        this.emitClientEvent({
          type: 'worktreeTerminalSleepState',
          worktreeId: worktree.id,
          generation,
          phase: 'committed',
          ptyIds: [...committedPtyIds].sort(),
          terminalHandles: this.getRecordedTerminalSleepHandles(
            committedPtyIds,
            terminalHandlesByPtyId
          )
        })
      }
      if (livePtyIds.size === 0) {
        const terminalHandles = this.getRecordedTerminalSleepHandles(
          committedPtyIds,
          terminalHandlesByPtyId
        )
        this.terminalSleepStateByWorktreeId.set(key, {
          worktreeId: worktree.id,
          generation,
          phase: 'sleeping',
          ptyIds: [...committedPtyIds].sort(),
          terminalHandles,
          terminalHandlesByPtyId
        })
        fullyCommitted = true
        return {
          stopped: 0,
          stoppedPtyIds: [],
          livePtyIds: [],
          postStopVerified: true
        }
      }
      const ptyController = this.ptyController
      if (!ptyController?.stopAndWait) {
        throw new Error('terminal_worktree_sleep_unavailable')
      }
      const stopAndWait = ptyController.stopAndWait.bind(ptyController)

      const orderedLivePtyIds = [...livePtyIds].sort()
      releaseReversibleRendererStops =
        ptyController.markReversibleStops?.(orderedLivePtyIds) ?? (() => {})
      const stopResults = await Promise.allSettled(
        orderedLivePtyIds.map(async (ptyId) => ({
          ptyId,
          stopped: await stopAndWait(ptyId, {
            keepHistory: true,
            deadlineMs: teardownRpcDeadline(sleepDeadline)
          })
        }))
      )
      const successfulStopPtyIds = orderedLivePtyIds.filter((_, index) => {
        const result = stopResults[index]
        return result?.status === 'fulfilled' && result.value.stopped
      })
      const failedStopIndex = stopResults.findIndex((result) =>
        result.status === 'rejected' ? true : !result.value.stopped
      )

      const postStopLiveness = await this.refreshPtyWorktreeRecordsFromController(
        resolvedWorktrees,
        worktree.id,
        sleepDeadline
      )
      if (!postStopLiveness) {
        this.commitWorktreeTerminalSleepPtys({
          worktreeId: worktree.id,
          generation,
          ptyIds: successfulStopPtyIds,
          pendingPtyIds,
          committedPtyIds,
          terminalHandlesByPtyId
        })
        if (failedStopIndex !== -1) {
          const failedStop = stopResults[failedStopIndex]
          throw Object.assign(new Error('terminal_worktree_sleep_failed'), {
            ptyId: orderedLivePtyIds[failedStopIndex],
            ...(failedStop.status === 'rejected' ? { cause: failedStop.reason } : {})
          })
        }
        return {
          stopped: successfulStopPtyIds.length,
          stoppedPtyIds: successfulStopPtyIds,
          livePtyIds: [...livePtyIds].sort(),
          postStopVerified: false,
          postStopFailure: 'terminal_liveness_unavailable'
        }
      }
      const remainingLivePtyIds = this.getLivePtyIdsForWorktree(worktree.id, postStopLiveness)
      const provenStoppedPtyIds = orderedLivePtyIds.filter(
        (ptyId) => !remainingLivePtyIds.has(ptyId)
      )
      this.commitWorktreeTerminalSleepPtys({
        worktreeId: worktree.id,
        generation,
        ptyIds: provenStoppedPtyIds,
        pendingPtyIds,
        committedPtyIds,
        terminalHandlesByPtyId
      })
      if (failedStopIndex !== -1 && remainingLivePtyIds.size > 0) {
        const failedStop = stopResults[failedStopIndex]
        console.error('[runtime] worktree terminal sleep physical stop failed', {
          worktreeId: worktree.id,
          ptyId: orderedLivePtyIds[failedStopIndex],
          cause: failedStop.status === 'rejected' ? failedStop.reason : 'stop_not_acknowledged'
        })
        throw Object.assign(new Error('terminal_worktree_sleep_failed'), {
          ptyId: orderedLivePtyIds[failedStopIndex],
          remainingLivePtyIds: [...remainingLivePtyIds].sort(),
          ...(failedStop.status === 'rejected' ? { cause: failedStop.reason } : {})
        })
      }
      if (remainingLivePtyIds.size > 0) {
        return {
          stopped: successfulStopPtyIds.length,
          stoppedPtyIds: successfulStopPtyIds,
          livePtyIds: [...livePtyIds].sort(),
          postStopVerified: false,
          postStopFailure: 'terminal_worktree_sleep_still_live',
          remainingLivePtyIds: [...remainingLivePtyIds].sort()
        }
      }
      const terminalHandles = this.getRecordedTerminalSleepHandles(
        committedPtyIds,
        terminalHandlesByPtyId
      )
      this.terminalSleepStateByWorktreeId.set(key, {
        worktreeId: worktree.id,
        generation,
        phase: 'sleeping',
        ptyIds: [...committedPtyIds].sort(),
        terminalHandles,
        terminalHandlesByPtyId
      })
      fullyCommitted = true
      return {
        stopped: provenStoppedPtyIds.length,
        stoppedPtyIds: provenStoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: true
      }
    } finally {
      releaseReversibleRendererStops()
      if (!fullyCommitted && generation > 0) {
        const cancelledPtyIds = [...pendingPtyIds].sort()
        if (cancelledPtyIds.length > 0) {
          this.emitClientEvent({
            type: 'worktreeTerminalSleepState',
            worktreeId: worktree.id,
            generation,
            phase: 'cancelled',
            ptyIds: cancelledPtyIds,
            terminalHandles: this.getRecordedTerminalSleepHandles(
              cancelledPtyIds,
              terminalHandlesByPtyId
            )
          })
        }
        if (committedPtyIds.size > 0) {
          const terminalHandles = this.getRecordedTerminalSleepHandles(
            committedPtyIds,
            terminalHandlesByPtyId
          )
          this.terminalSleepStateByWorktreeId.set(key, {
            worktreeId: worktree.id,
            generation,
            phase: 'partial',
            ptyIds: [...committedPtyIds].sort(),
            terminalHandles,
            terminalHandlesByPtyId
          })
        } else {
          this.terminalSleepStateByWorktreeId.delete(key)
        }
      }
      releaseMutation()
    }
  }

  async stopExactTerminalsForWorktree(
    worktreeSelector: string,
    expectedPtyIds: readonly string[],
    opts: { keepHistory?: boolean; targetOnly?: boolean } = {}
  ): Promise<{
    stopped: number
    stoppedPtyIds: string[]
    livePtyIds: string[]
    postStopVerified: boolean
    postStopFailure?: string
    remainingLivePtyIds?: string[]
  }> {
    // Why: exact stop hibernates one known pane; worktree sleep discovers its complete host-owned set separately.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    const expected = new Set(expectedPtyIds.filter((ptyId) => ptyId.length > 0))
    if (expected.size !== 1) {
      throw new Error('terminal_exact_stop_requires_single_pty')
    }
    const resolvedWorktrees = [...(await this.getResolvedWorktreeMap()).values()]
    const refreshedPtyLiveness =
      await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    if (!refreshedPtyLiveness) {
      throw new Error('terminal_liveness_unavailable')
    }
    const livePtyIds = this.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness)
    const targetOnly = opts.targetOnly === true
    const expectedIsLive = [...expected].every((ptyId) => livePtyIds.has(ptyId))
    if (targetOnly ? !expectedIsLive : !setsEqual(livePtyIds, expected)) {
      const error = Object.assign(new Error('terminal_stop_pty_set_mismatch'), {
        livePtyIds: [...livePtyIds].sort(),
        expectedPtyIds: [...expected].sort()
      })
      throw error
    }

    if (!this.ptyController?.stopAndWait) {
      throw new Error('terminal_exact_stop_unavailable')
    }

    const stoppedPtyIds: string[] = []
    for (const ptyId of [...expected].sort()) {
      if (opts.keepHistory) {
        this.intentionalHandlelessPtyStops.set(
          ptyId,
          this.ptysById.get(ptyId)?.incarnationId ?? null
        )
      }
      try {
        if (!(await this.ptyController.stopAndWait(ptyId, { keepHistory: opts.keepHistory }))) {
          throw Object.assign(new Error('terminal_exact_stop_failed'), { ptyId })
        }
      } finally {
        this.intentionalHandlelessPtyStops.delete(ptyId)
      }
      stoppedPtyIds.push(ptyId)
    }
    const postStopLiveness = await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    if (!postStopLiveness) {
      return {
        stopped: stoppedPtyIds.length,
        stoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: false,
        postStopFailure: 'terminal_liveness_unavailable'
      }
    }
    const remainingLivePtyIds = this.getLivePtyIdsForWorktree(worktree.id, postStopLiveness)
    const stoppedTargetsStillLive = [...expected].filter((ptyId) => remainingLivePtyIds.has(ptyId))
    if (targetOnly ? stoppedTargetsStillLive.length > 0 : remainingLivePtyIds.size > 0) {
      return {
        stopped: stoppedPtyIds.length,
        stoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: false,
        postStopFailure: 'terminal_exact_stop_still_live',
        remainingLivePtyIds: [...remainingLivePtyIds].sort()
      }
    }
    return {
      stopped: stoppedPtyIds.length,
      stoppedPtyIds,
      livePtyIds: [...livePtyIds].sort(),
      postStopVerified: true,
      ...(targetOnly && remainingLivePtyIds.size > 0
        ? { remainingLivePtyIds: [...remainingLivePtyIds].sort() }
        : {})
    }
  }

  private getLivePtyIdsForWorktree(
    worktreeId: string,
    freshPtyIds?: ReadonlySet<string>
  ): Set<string> {
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (
        runtimeWorktreeIdsEqual(leaf.worktreeId, worktreeId) &&
        leaf.connected &&
        leaf.ptyId &&
        (!freshPtyIds || freshPtyIds.has(leaf.ptyId))
      ) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.ptysById.values()) {
      if (
        runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId) &&
        pty.connected &&
        (!freshPtyIds || freshPtyIds.has(pty.ptyId))
      ) {
        ptyIds.add(pty.ptyId)
      }
    }
    return ptyIds
  }

  private getTerminalHandlesForPtyId(ptyId: string): string[] {
    const handles = new Set(
      this.getLeavesForPty(ptyId)
        .filter((candidate) => candidate.connected)
        .map((leaf) => this.issueHandle(leaf))
    )
    const runtimeHandle = this.handleByPtyId.get(ptyId)
    if (runtimeHandle) {
      handles.add(runtimeHandle)
    }
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (!pty) {
      throw Object.assign(new Error('terminal_worktree_sleep_handle_unavailable'), { ptyId })
    }
    if (handles.size === 0) {
      handles.add(this.issuePtyHandle(pty))
    }
    return [...handles].sort()
  }

  private getRecordedTerminalSleepHandles(
    ptyIds: Iterable<string>,
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  ): string[] {
    return [...new Set([...ptyIds].flatMap((ptyId) => terminalHandlesByPtyId[ptyId] ?? []))].sort()
  }

  private commitWorktreeTerminalSleepPtys(args: {
    worktreeId: string
    generation: number
    ptyIds: readonly string[]
    pendingPtyIds: Set<string>
    committedPtyIds: Set<string>
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  }): void {
    const newlyCommittedPtyIds = [...new Set(args.ptyIds)]
      .filter((ptyId) => !args.committedPtyIds.has(ptyId))
      .sort()
    for (const ptyId of newlyCommittedPtyIds) {
      args.pendingPtyIds.delete(ptyId)
      args.committedPtyIds.add(ptyId)
    }
    if (newlyCommittedPtyIds.length === 0) {
      return
    }
    this.emitClientEvent({
      type: 'worktreeTerminalSleepState',
      worktreeId: args.worktreeId,
      generation: args.generation,
      phase: 'committed',
      ptyIds: newlyCommittedPtyIds,
      terminalHandles: this.getRecordedTerminalSleepHandles(
        newlyCommittedPtyIds,
        args.terminalHandlesByPtyId
      )
    })
  }

  async hasTerminalsForWorktree(worktreeSelector: string): Promise<boolean> {
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === worktree.id && leaf.ptyId) {
        return true
      }
    }
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId === worktree.id && pty.connected) {
        return true
      }
    }
    return false
  }

  markRendererReloading(windowId: number): RuntimeRendererReloadFence | null {
    if (
      windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      this.headlessGraphFallbackAvailable
    ) {
      this.attachWindow(windowId)
      const revision = this.graphReloadLifecycle.getActiveRevision()
      return this.authoritativeWindowId === windowId && revision !== null
        ? { revision, recovery: 'headless' }
        : null
    }
    if (windowId !== this.authoritativeWindowId) {
      return null
    }
    if (this.graphStatus === 'reloading') {
      return {
        revision: this.graphReloadLifecycle.begin(windowId),
        recovery: this.shouldRestoreHeadlessGraph(windowId) ? 'headless' : 'reloading'
      }
    }
    if (this.graphStatus !== 'ready') {
      return null
    }
    return { revision: this.beginGraphReload(windowId), recovery: 'renderer' }
  }

  private beginGraphReload(windowId: number): number {
    // Why: a renderer reload tears down the live graph, so live handles must go stale immediately, not be reused against the rebuild.
    this.rendererGraphEpoch += 1
    this.graphStatus = 'reloading'
    const revision = this.graphReloadLifecycle.begin(windowId)
    this.setTerminalSideEffectConsumerAvailable(false)
    this.rememberDetachedPreAllocatedLeaves()
    this.handles.clear()
    this.handleByLeafKey.clear()
    // Why: handleByPtyId (pre-allocated CLI handles) survives reloads so CLI agents keep control; adoptPreAllocatedHandle re-links on the new graph.
    this.rejectAllWaiters('terminal_handle_stale')
    this.refreshWritableFlags()
    return revision
  }

  markRendererReloadCancelled(windowId: number, fence: RuntimeRendererReloadFence): boolean {
    if (
      windowId !== this.authoritativeWindowId ||
      this.graphStatus !== 'reloading' ||
      !this.graphReloadLifecycle.settle(fence.revision, 'cancelled')
    ) {
      return false
    }
    if (fence.recovery === 'headless' && this.shouldRestoreHeadlessGraph(windowId)) {
      this.restoreHeadlessGraphAuthority()
      return false
    }
    if (fence.recovery === 'renderer') {
      this.graphStatus = 'ready'
      this.setTerminalSideEffectConsumerAvailable(true)
      this.refreshWritableFlags()
      return true
    }
    this.graphReloadLifecycle.begin(windowId)
    return false
  }

  markGraphReady(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    this.graphReloadLifecycle.settleActive('success')
    if (windowId !== HEADLESS_RUNTIME_WINDOW_ID) {
      this.headlessGraphFallbackAvailable = false
      this.pendingHeadlessPromotionWindowId = null
    }
    this.graphStatus = 'ready'
    this.setTerminalSideEffectConsumerAvailable(windowId !== HEADLESS_RUNTIME_WINDOW_ID)
    this.refreshWritableFlags()
  }

  markGraphReloadFailed(
    windowId: number,
    _reason: 'renderer-frame-unavailable' | 'renderer-process-gone'
  ): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    if (this.graphStatus === 'ready') {
      this.beginGraphReload(windowId)
    }
    this.graphReloadLifecycle.settleActive('failure')
    this.transitionGraphReloadToTerminalState(windowId)
  }

  markGraphUnavailable(windowId: number): void {
    if (
      this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      windowId === this.pendingHeadlessPromotionWindowId
    ) {
      this.pendingHeadlessPromotionWindowId = null
      return
    }
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    this.graphReloadLifecycle.settleActive('cancelled')
    if (this.shouldRestoreHeadlessGraph(windowId)) {
      this.pendingHeadlessPromotionWindowId = null
      this.restoreHeadlessGraphAuthority()
      return
    }
    // Why: once the authoritative renderer graph disappears, fail closed for live-terminal ops instead of guessing from old state.
    if (this.graphStatus !== 'unavailable') {
      this.rendererGraphEpoch += 1
    }
    this.graphStatus = 'unavailable'
    this.setTerminalSideEffectConsumerAvailable(false)
    this.authoritativeWindowId = null
    this.rememberDetachedPreAllocatedLeaves()
    this.tabs.clear()
    this.leaves.clear()
    this.leavesByPtyId.clear()
    this.handles.clear()
    this.handleByLeafKey.clear()
    // Why: pre-allocated CLI handles must survive graph unavailability so they can be re-adopted on reconnect.
    this.rejectAllWaiters('terminal_handle_stale')
  }

  private handleGraphReloadTimeout(windowId: number): void {
    if (windowId !== this.authoritativeWindowId || this.graphStatus !== 'reloading') {
      return
    }
    this.transitionGraphReloadToTerminalState(windowId)
  }

  private transitionGraphReloadToTerminalState(windowId: number): void {
    if (this.shouldRestoreHeadlessGraph(windowId)) {
      this.restoreHeadlessGraphAuthority()
      return
    }
    this.graphStatus = 'unavailable'
    this.setTerminalSideEffectConsumerAvailable(false)
    this.rememberDetachedPreAllocatedLeaves()
    this.tabs.clear()
    this.leaves.clear()
    this.leavesByPtyId.clear()
    this.handles.clear()
    this.handleByLeafKey.clear()
    this.rejectAllWaiters('terminal_handle_stale')
    this.refreshWritableFlags()
  }

  private shouldRestoreHeadlessGraph(windowId: number): boolean {
    return windowId !== HEADLESS_RUNTIME_WINDOW_ID && this.headlessGraphFallbackAvailable
  }

  private restoreHeadlessGraphAuthority(): void {
    this.rendererGraphEpoch += 1
    this.authoritativeWindowId = HEADLESS_RUNTIME_WINDOW_ID
    this.graphStatus = 'ready'
    this.rendererGeneration = null
    this.setTerminalSideEffectConsumerAvailable(false)
    this.tabs.clear()
    this.leaves.clear()
    this.leavesByPtyId.clear()
    this.handles.clear()
    this.handleByLeafKey.clear()
    this.rejectAllWaiters('terminal_handle_stale')
    this.refreshWritableFlags()
  }

  private assertGraphReady(): void {
    if (this.graphStatus !== 'ready') {
      throw new Error('runtime_unavailable')
    }
  }

  private captureReadyGraphEpoch(): number {
    this.assertGraphReady()
    return this.rendererGraphEpoch
  }

  private assertStableReadyGraph(expectedGraphEpoch: number): void {
    if (this.graphStatus !== 'ready' || this.rendererGraphEpoch !== expectedGraphEpoch) {
      throw new Error('runtime_unavailable')
    }
  }

  private resolveFolderWorkspaceConnectionId(workspace: FolderWorkspace): string | null {
    const repos = this.store?.getRepos() ?? []
    const projectGroups = this.store?.getProjectGroups?.() ?? []
    const connection = inferFolderWorkspacePathConnection({
      folderPath: workspace.folderPath,
      projectGroupId: workspace.projectGroupId,
      connectionId: workspace.connectionId ?? null,
      projectGroups,
      repos
    })
    if (connection.kind === 'ambiguous') {
      // Why: a PTY spawns on one runtime target; mixed child-repo connections need an explicit V2 routing decision.
      throw new Error('folder_workspace_connection_ambiguous')
    }
    return connection.kind === 'ssh' ? connection.connectionId : null
  }

  private async resolveFolderWorkspaceLaunchScope(
    selector: string
  ): Promise<(TerminalWorkspaceLaunchScope & { folderWorkspace: FolderWorkspace }) | null> {
    const workspace = this.resolveFolderWorkspaceSelector(selector)
    if (!workspace) {
      return null
    }
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const status = await getFolderWorkspacePathStatus(
      this.store,
      { scope: 'folder-workspace', folderWorkspaceId: workspace.id },
      { getSshFilesystemProvider }
    )
    assertFolderWorkspacePathUsable(status)
    return {
      id: folderWorkspaceKey(workspace.id),
      path: workspace.folderPath,
      connectionId: this.resolveFolderWorkspaceConnectionId(workspace),
      repo: null,
      folderWorkspace: workspace
    }
  }

  private resolveFolderWorkspaceSelector(selector: string): FolderWorkspace | null {
    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    if (parsed?.type !== 'folder') {
      return null
    }
    const workspace = this.store
      ?.getFolderWorkspaces?.()
      .find((entry) => entry.id === parsed.folderWorkspaceId)
    if (!workspace) {
      throw new Error('selector_not_found')
    }
    return workspace
  }

  private async resolveEmulatorWorkspaceId(selector: string): Promise<string> {
    const folderWorkspace = this.resolveFolderWorkspaceSelector(selector)
    return folderWorkspace
      ? folderWorkspaceKey(folderWorkspace.id)
      : (await this.resolveWorktreeSelector(selector)).id
  }

  private async resolveBrowserWorkspace(selector: string): Promise<ResolvedWorktree> {
    const folderScope = await this.resolveFolderWorkspaceLaunchScope(selector)
    return folderScope?.folderWorkspace
      ? this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace)
      : this.resolveWorktreeSelector(selector)
  }

  /**
   * Closes the window in which snapshots warn that this client's client-hosted pages are still
   * unaccounted for. Keyed by paired device because one client attaching says nothing about another.
   */
  markClientHostedPagesReconciled(pairedDeviceId: string): void {
    this.clientHostedPageReconciliation.markReconciled(pairedDeviceId)
  }

  /**
   * The execution-host key a client-hosted page in this workspace would be created under now.
   *
   * Adoption cannot reuse the key an inventory entry reports: native and WSL keys name the runtime
   * that minted them, and an SSH key carries a per-process provider epoch, so a restart always
   * invalidates them.
   *
   * The two failure modes are not the same answer. A workspace that no longer resolves is gone and
   * its pages have nothing left to be restored into; an execution host that is merely not up yet --
   * an SSH provider mid-reconnect, a project runtime still repairing -- is a "not now", and must
   * never be read as permission to retire the page.
   */
  async resolveBrowserExecutionHostKeyForWorkspace(
    workspaceId: string
  ): Promise<BrowserExecutionHostKeyResolution> {
    let worktree: ResolvedWorktree
    try {
      worktree = await this.resolveBrowserWorkspace(`id:${workspaceId}`)
    } catch {
      return { status: 'workspace-gone' }
    }
    try {
      return {
        status: 'resolved',
        executionHostKey: browserNetworkExecutionHostKey(
          await this.resolveBrowserNetworkExecutionHostForWorktree(worktree)
        )
      }
    } catch {
      return { status: 'unavailable' }
    }
  }

  routeClientHostedBrowserRpc(
    method: string,
    params: unknown
  ): Promise<ClientHostedBrowserRpcRoute> {
    return routeRuntimeBrowserClientAutomation({
      method,
      params,
      pages: getRuntimeBrowserPageRegistry(this),
      leases: getBrowserHostLeaseRegistry(this),
      resolveWorkspace: (selector) => this.resolveBrowserWorkspace(selector)
    })
  }

  private resolveBrowserNetworkExecutionHostForWorktree(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost> {
    const repo = worktree?.repoId ? this.requireStore().getRepo(worktree.repoId) : undefined
    const executionHostId = worktree
      ? getWorktreeExecutionHostId(worktree, repo)
      : LOCAL_EXECUTION_HOST_ID
    const parsedHost = parseExecutionHostId(executionHostId)
    return resolveRuntimeBrowserNetworkExecutionHost({
      runtimeId: this.getRuntimeId(),
      runtimeRevision: this.getStartedAt(),
      executionHostId,
      ...(worktree
        ? {
            projectRuntime: resolveLocalProjectRuntimeForWorktreeId(
              this.requireStore(),
              worktree.id
            )
          }
        : {}),
      ...(parsedHost?.kind === 'ssh'
        ? { sshState: getRegisteredSshState(parsedHost.targetId) }
        : {})
    })
  }

  private async resolveEmulatorCleanupWorkspaceId(selector: string): Promise<string> {
    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    return parsed?.type === 'folder'
      ? folderWorkspaceKey(parsed.folderWorkspaceId)
      : this.resolveEmulatorWorkspaceId(selector)
  }

  private folderWorkspaceToResolvedWorktree(folderWorkspace: FolderWorkspace): ResolvedWorktree {
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    return {
      ...worktree,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: worktree.path,
        head: worktree.head,
        branch: worktree.branch,
        isBare: worktree.isBare,
        isMainWorktree: worktree.isMainWorktree
      }
    }
  }

  private resolveWorkspaceTerminalStartupCwd(
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ): string | undefined {
    return resolveTerminalStartupCwd(workspace.path, requestedCwd)
  }

  private async resolveTerminalWorkspaceLaunchScope(
    selector: string
  ): Promise<TerminalWorkspaceLaunchScope> {
    return (await this.resolveTerminalWorkspaceLaunchTarget(selector)).scope
  }

  private async resolveTerminalWorkspaceLaunchTarget(
    selector: string
  ): Promise<ResolvedTerminalWorkspaceLaunchTarget> {
    const floatingTerminalSelector =
      selector === FLOATING_TERMINAL_WORKTREE_ID ||
      selector === `id:${FLOATING_TERMINAL_WORKTREE_ID}`
    if (floatingTerminalSelector) {
      // Why: the floating sentinel is terminal-only — no backing repo/worktree record for other workspace APIs.
      return {
        scope: {
          id: FLOATING_TERMINAL_WORKTREE_ID,
          path: homedir(),
          connectionId: null,
          repo: null,
          folderWorkspace: null
        },
        managedWorktree: null
      }
    }

    const folderScope = await this.resolveFolderWorkspaceLaunchScope(selector)
    if (folderScope) {
      return {
        scope: folderScope,
        managedWorktree: this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace)
      }
    }

    const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
    const parsed = parseWorkspaceKey(workspaceSelector)
    const worktreeSelector = parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : selector
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const repo = this.store?.getRepo(worktree.repoId) ?? null
    return {
      scope: {
        id: worktree.id,
        path: worktree.path,
        connectionId: repo?.connectionId ?? null,
        repo,
        folderWorkspace: null
      },
      managedWorktree: worktree
    }
  }

  private buildTerminalWorkspaceEnv(
    scope: TerminalWorkspaceLaunchScope,
    baseEnv: Record<string, string>,
    paneKey: string,
    tabId: string,
    agentTeamsEnv?: Record<string, string>
  ): Record<string, string> {
    const cleanBaseEnv = { ...baseEnv }
    for (const key of AGENT_HOOK_RUNTIME_ENV_KEYS) {
      delete cleanBaseEnv[key]
    }
    const env = {
      ...cleanBaseEnv,
      ...agentTeamsEnv,
      ...this.buildAgentHookPtyEnv?.(),
      ORCA_PANE_KEY: paneKey,
      ORCA_TAB_ID: tabId,
      ORCA_WORKTREE_ID: scope.id
    }
    if (!scope.folderWorkspace) {
      return env
    }
    return {
      ...env,
      ORCA_WORKSPACE_ID: scope.id,
      ORCA_PROJECT_GROUP_ID: scope.folderWorkspace.projectGroupId,
      ORCA_WORKSPACE_ROOT: scope.folderWorkspace.folderPath
    }
  }

  private getValidatedExplicitWorktreeIdSelector(selector: string | undefined): string | null {
    const worktreeId = getExplicitWorktreeIdSelector(selector)
    if (
      worktreeId &&
      !worktreeId.includes(WORKTREE_ID_SEPARATOR) &&
      this.store?.getRepo(worktreeId)
    ) {
      // Why: a registered repo id is a known-invalid worktree id; reject early before fast paths or Git/SSH scans hide the mistake.
      throw new WorktreeIdRequiresFullPathError()
    }
    return worktreeId
  }

  private async resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(selector)
    // Why only `id:`: every other selector kind is matched across the whole fleet, and their
    // `selector_ambiguous` contract is defined over all repos. Scoping those would silently pick a
    // winner where today they correctly refuse. An `id:` selector already names its repo.
    if (explicitWorktreeId && !this.hasFreshResolvedWorktreeCache()) {
      const scoped = await this.resolveExplicitWorktreeIdScoped(explicitWorktreeId)
      if (scoped) {
        return scoped
      }
    }
    const worktrees = await this.listResolvedWorktrees()
    let candidates: ResolvedWorktree[]

    if (selector === 'active') {
      throw new Error('selector_not_found')
    }

    if (selector.startsWith('id:')) {
      const worktreeId = explicitWorktreeId ?? selector.slice(3)
      candidates = worktrees.filter((worktree) => worktree.id === worktreeId)
      if (candidates.length === 0) {
        const parsed = splitWorktreeIdForFilesystem(worktreeId)
        const repo = parsed ? this.store?.getRepo(parsed.repoId) : null
        const fallback =
          repo?.connectionId && this.store?.getWorktreeMeta(worktreeId)
            ? this.buildResolvedWorktreeFromId(worktreeId)
            : null
        if (fallback !== null) {
          candidates = [fallback]
        }
      }
    } else if (selector.startsWith('path:')) {
      candidates = worktrees.filter((worktree) =>
        runtimePathsEqual(worktree.path, selector.slice(5))
      )
      if (candidates.length > 1) {
        const hostIds = new Set(
          candidates.map((worktree) => {
            const repo = this.store?.getRepo(worktree.repoId)
            return getWorktreeExecutionHostId(worktree, repo)
          })
        )
        // Why: duplicate registrations on one host describe one path; identical paths on different hosts do not.
        if (hostIds.size === 1) {
          candidates = [candidates[0]]
        }
      }
    } else if (selector.startsWith('branch:')) {
      const branchSelector = selector.slice(7)
      candidates = worktrees.filter((worktree) =>
        branchSelectorMatches(worktree.branch, branchSelector)
      )
    } else if (selector.startsWith('name:')) {
      // Keep display-name matching exact so duplicate names hit the same ambiguity path as other selectors.
      candidates = worktrees.filter((worktree) => worktree.displayName === selector.slice(5))
    } else if (selector.startsWith('issue:')) {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.linkedIssue !== null && String(worktree.linkedIssue) === selector.slice(6)
      )
    } else {
      candidates = worktrees.filter(
        (worktree) =>
          worktree.id === selector ||
          runtimePathsEqual(worktree.path, selector) ||
          branchSelectorMatches(worktree.branch, selector)
      )
    }

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('selector_not_found')
  }

  private resolveLineageForWorktreeCreate(
    input?: WorktreeLineageInput
  ): Promise<WorktreeLineageResolution> {
    return this.worktreeLineage.resolveCreate(input)
  }
  private getOrchestrationDbIfAvailable(): OrchestrationDb | null {
    try {
      return this._orchestrationDb ?? this.getOrchestrationDb()
    } catch {
      return this._orchestrationDb
    }
  }

  hydrateInferredWorktreeLineage(): Promise<void> {
    return this.worktreeLineage.hydrate()
  }

  listWorktreeLineage(): Promise<Record<string, WorktreeLineage>> {
    return this.worktreeLineage.listWorktreeLineage()
  }

  listWorkspaceLineage(): Promise<Record<WorkspaceKey, WorkspaceLineage>> {
    return this.worktreeLineage.listWorkspaceLineage()
  }

  // Why: one selector grammar, so connection-scoped resolution can narrow the same
  // candidate set instead of reimplementing (and diverging from) the matching rules.
  private selectReposBySelector(selector: string): Repo[] {
    const repos = this.store?.getRepos() ?? []
    if (selector.startsWith('id:')) {
      return repos.filter((repo) => repo.id === selector.slice(3))
    }
    if (selector.startsWith('path:')) {
      return repos.filter((repo) => runtimePathsEqual(repo.path, selector.slice(5)))
    }
    if (selector.startsWith('name:')) {
      return repos.filter((repo) => repo.displayName === selector.slice(5))
    }
    return repos.filter(
      (repo) =>
        repo.id === selector ||
        runtimePathsEqual(repo.path, selector) ||
        repo.displayName === selector
    )
  }

  private async resolveRepoSelector(selector: string): Promise<Repo> {
    if (!this.store) {
      throw new Error('repo_not_found')
    }
    const candidates = this.selectReposBySelector(selector)

    if (candidates.length === 1) {
      return candidates[0]
    }
    if (candidates.length > 1) {
      throw new Error('selector_ambiguous')
    }
    throw new Error('repo_not_found')
  }

  private requireStore(): Store {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return this.store as unknown as Store
  }

  private buildResolvedWorktreeFromId(worktreeId: string): ResolvedWorktree | null {
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    if (!parsed?.repoId || !parsed.worktreePath) {
      return null
    }
    const repo = this.store?.getRepos().find((entry) => entry.id === parsed.repoId)
    const git = {
      path: parsed.worktreePath,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: repo ? areWorktreePathsEqual(parsed.worktreePath, repo.path) : false
    }
    const meta = this.store?.getWorktreeMeta(worktreeId)
    const merged = {
      ...mergeWorktree(parsed.repoId, git, meta, repo?.displayName),
      ...(repo ? { hostId: meta?.hostId ?? getRepoExecutionHostId(repo) } : {})
    }
    return {
      ...merged,
      id: worktreeId,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git,
      displayName: merged.displayName,
      comment: merged.comment
    }
  }

  private listKnownResolvedWorktreesForExplicitTarget(
    targetWorktreeId: string,
    targetWorktree: ResolvedWorktree | null
  ): ResolvedWorktree[] {
    if (!this.store || !targetWorktree) {
      return []
    }
    const target = splitWorktreeIdForFilesystem(targetWorktreeId)
    if (!target?.repoId || !target.worktreePath) {
      return []
    }
    const worktreeIds = new Set(
      Object.keys(this.store.getAllWorktreeMeta()).filter((worktreeId) => {
        const parsed = splitWorktreeIdForFilesystem(worktreeId)
        return (
          parsed?.repoId === target.repoId &&
          Boolean(parsed.worktreePath) &&
          (isPathInsideOrEqual(target.worktreePath, parsed.worktreePath) ||
            isPathInsideOrEqual(parsed.worktreePath, target.worktreePath))
        )
      })
    )
    worktreeIds.add(targetWorktreeId)

    const resolved: ResolvedWorktree[] = []
    for (const worktreeId of worktreeIds) {
      const worktree =
        worktreeId === targetWorktreeId
          ? targetWorktree
          : this.buildResolvedWorktreeFromId(worktreeId)
      if (worktree) {
        resolved.push(worktree)
      }
    }
    return resolved
  }

  /** A warm fleet snapshot already answers any selector for free, so scoped scanning must yield to it. */
  private hasFreshResolvedWorktreeCache(): boolean {
    return Boolean(this.resolvedWorktreeCache && this.resolvedWorktreeCache.expiresAt > Date.now())
  }

  private async listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    return (await this.listResolvedWorktreeSnapshot()).worktrees
  }

  private async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
    if (!this.store) {
      return { worktrees: [], platformByRepoId: new Map() }
    }
    return this.resolvedWorktrees.getSnapshot(
      () => this.computeResolvedWorktrees(),
      RESOLVED_WORKTREE_CACHE_TTL_MS
    )
  }

  private async computeResolvedWorktrees(): Promise<ResolvedWorktreeSnapshot> {
    if (!this.store) {
      return { worktrees: [], platformByRepoId: new Map() }
    }
    const metaById = this.store.getAllWorktreeMeta() ?? {}
    const repos = this.store.getRepos()
    const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(this.requireStore(), repos)
    const platformByRepoId = new Map(
      repos.map((repo) => [
        repo.id,
        getAgentLaunchPlatformForRepo(repo, projectRuntimeByRepoId.get(repo.id))
      ])
    )
    const deps = this.repoWorktreeRowDeps()
    const perRepoWorktrees = await Promise.all(
      repos.map(
        async (repo) => await resolveRepoWorktreeRows(deps, repo, metaById, projectRuntimeByRepoId)
      )
    )
    const worktrees = projectResolvedWorktreeLineage(
      perRepoWorktrees.flat(),
      this.store?.getAllWorktreeLineage?.() ?? {}
    )
    return { worktrees, platformByRepoId }
  }

  /** Bind the runtime-owned scan cache and folder-workspace stamping into the row resolver. */
  private repoWorktreeRowDeps(): RepoWorktreeRowDeps {
    const store = this.requireStore()
    return {
      store,
      scanRepo: (repo, projectRuntimeByRepoId) =>
        this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId),
      listFolderWorkspaces: (repo) => listRuntimeFolderWorkspaces(store, repo)
    }
  }

  private async resolveExplicitWorktreeIdScoped(
    worktreeId: string
  ): Promise<ResolvedWorktree | null> {
    if (!this.store) {
      return null
    }
    return await resolveScopedWorktreeIdRow(this.repoWorktreeRowDeps(), worktreeId)
  }

  private async listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    const projectRuntime = projectRuntimeByRepoId
      ? projectRuntimeByRepoId.get(repo.id)
      : !repo.connectionId
        ? resolveLocalProjectRuntimeForRepo(this.requireStore(), repo)
        : undefined
    const runtimeKey = projectRuntime
      ? projectRuntime.status === 'resolved'
        ? projectRuntime.runtime.cacheKey
        : projectRuntime.repair.cacheKey
      : repo.connectionId
        ? `ssh:${repo.connectionId}:${getSshGitProviderGeneration(repo.connectionId)}`
        : 'local:default'
    const now = Date.now()
    const generation = this.worktreeScanGenerations.get(repo.id) ?? 0
    const cached = this.worktreeScanCache.get(repo.id)
    if (
      cached?.generation === generation &&
      cached.runtimeKey === runtimeKey &&
      cached.expiresAt > now
    ) {
      return cached.result
    }
    const inFlight = this.worktreeScanInFlight.get(repo.id)
    if (inFlight?.generation === generation && inFlight.runtimeKey === runtimeKey) {
      const refresh = await inFlight.promise
      if (generation !== (this.worktreeScanGenerations.get(scanScopeKey) ?? 0)) {
        return this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
      }
      return refresh.result
    }
    const reusableCached =
      cached?.generation === generation && cached.runtimeKey === runtimeKey ? cached : null
    const promise = this.refreshRepoWorktreeScan(repo, projectRuntime, reusableCached)
    this.worktreeScanInFlight.set(repo.id, { generation, runtimeKey, promise })
    try {
      const refresh = await promise
      if (
        (refresh.result.ok || !repo.connectionId) &&
        generation === (this.worktreeScanGenerations.get(repo.id) ?? 0) &&
        this.worktreeScanInFlight.get(repo.id)?.promise === promise
      ) {
        const entry: RuntimeWorktreeScanCache = {
          generation,
          runtimeKey,
          result: refresh.result,
          expiresAt: Date.now() + resolveWorktreeScanCacheTtlMs(repo),
          adminFingerprint: refresh.adminFingerprint,
          scannedAt: refresh.scannedAt
        }
        this.worktreeScanCache.set(repo.id, entry)
        void refresh.adminFingerprintProbe?.then((fingerprint) => {
          if (this.worktreeScanCache.get(repo.id) === entry) {
            entry.adminFingerprint = fingerprint
          }
        })
      }
      return refresh.result
    } finally {
      if (this.worktreeScanInFlight.get(repo.id)?.promise === promise) {
        this.worktreeScanInFlight.delete(repo.id)
      }
    }
  }

  /**
   * Refresh one repo's worktree rows, skipping the `git worktree list` subprocess when a cheap
   * Git-admin fingerprint proves nothing changed since the cached scan.
   */
  private async refreshRepoWorktreeScan(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined,
    cached: RuntimeWorktreeScanCache | null
  ): Promise<RuntimeWorktreeScanRefresh> {
    const scannedAt = Date.now()
    // SSH and WSL-routed repos run Git off-host, so a local admin-dir read cannot describe them.
    const fingerprintCapable =
      !repo.connectionId &&
      // Why: a repo whose scan TTL already reaches the reconciliation interval can never reuse a
      // fingerprint, so reading one would be pure work. Agent-scratch roots are that case today.
      resolveWorktreeScanCacheTtlMs(repo) < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS &&
      !getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime).wslDistro
    // Why issue it before the scan: a change landing while the scan runs must not be stamped as
    // already-observed, or the next probe would mask it until the reconciliation deadline.
    const probe = fingerprintCapable ? this.startRepoWorktreeAdminFingerprintProbe(repo) : null
    const reusable =
      cached?.result.ok === true &&
      scannedAt - cached.scannedAt < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
        ? cached
        : null
    if (probe && reusable) {
      // Why await only here: this is the one branch whose decision needs the probe. A scan-bound
      // caller must never wait on it, or every cold read pays filesystem latency it cannot use.
      const probed = await withTimeoutResult(probe, WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS)
      if (!probed.ok) {
        // Why log: expiry and "fingerprint unavailable" both surface as `null`, so a wedged mount is
        // otherwise indistinguishable from a repo that simply cannot be fingerprinted.
        console.warn('[worktree-scan] admin fingerprint probe expired; running a full scan', {
          repoId: repo.id,
          timeoutMs: WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS
        })
      }
      const current = probed.ok ? probed.value : null
      if (current !== null && current === reusable.adminFingerprint) {
        return {
          result: reusable.result,
          adminFingerprint: current,
          adminFingerprintProbe: null,
          scannedAt: reusable.scannedAt
        }
      }
    }
    const result = await this.listRepoWorktreesForResolutionUncached(repo, projectRuntime)
    return { result, adminFingerprint: null, adminFingerprintProbe: probe, scannedAt }
  }

  /**
   * Read one repo's Git-admin fingerprint, unless that repo's previous read is still outstanding.
   * Why the gate: `withTimeout` abandons a probe without cancelling it, and readdir/stat take no
   * AbortSignal — on a wedged mount a fresh probe per refresh would pin every libuv fs thread.
   */
  private startRepoWorktreeAdminFingerprintProbe(repo: Repo): Promise<string | null> | null {
    if (this.worktreeAdminFingerprintProbes.has(repo.id)) {
      return null
    }
    this.worktreeAdminFingerprintProbes.add(repo.id)
    return readRepoWorktreeAdminFingerprint(repo.path)
      .catch(() => null)
      .finally(() => {
        this.worktreeAdminFingerprintProbes.delete(repo.id)
      })
  }

  private async listRepoWorktreesForResolutionUncached(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined
  ): Promise<RuntimeWorktreeScanResult> {
    if (!repo.connectionId) {
      return await scanLocalRepoWorktreesForResolution(
        repo.path,
        getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime)
      )
    }
    const provider = getSshGitProvider(repo.connectionId)
    if (!provider) {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
    try {
      return { ok: true, worktrees: await provider.listWorktrees(repo.path) }
    } catch {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
  }

  private listStoredWorktreesForResolution(repo: Repo): GitWorktreeInfo[] {
    return this.store ? listStoredWorktreeRowsForRepo(this.requireStore(), repo) : []
  }

  private async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return new Map((await this.listResolvedWorktrees()).map((worktree) => [worktree.id, worktree]))
  }

  private invalidateResolvedWorktreeCache(): void {
    this.resolvedWorktrees.invalidateResolved()
  }

  private invalidateWorktreeScanCacheForRepo(repoId: string): void {
    this.worktreeScanGenerations.set(repoId, (this.worktreeScanGenerations.get(repoId) ?? 0) + 1)
    this.worktreeScanCache.delete(repoId)
    this.worktreeScanInFlight.delete(repoId)
    this.resolvedWorktrees.invalidateScan(repoId)
  }

  private invalidateSshWorktreeScanCacheInternal(targetId: string): void {
    const repos = this.store?.getRepos() ?? []
    const affectedRepoIds = new Set(
      repos.filter((repo) => repo.connectionId === targetId).map((repo) => repo.id)
    )
    for (const repoId of affectedRepoIds) {
      this.resolvedWorktrees.invalidateScan(repoId)
    }
    if (affectedRepoIds.size > 0) {
      this.resolvedWorktrees.invalidateResolved()
    }
  }

  /** Invalidate the worktree cache and tell the renderer to re-list after an out-of-band branch change so the new name surfaces immediately. */
  notifyBranchRenamed(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
    this.notifyWorktreesChanged(repoId)
  }

  /** Like {@link notifyBranchRenamed} but carries old->new worktree id so the renderer re-keys instead of treating the id change as a deletion. */
  notifyWorktreeFolderRenamed(repoId: string, oldWorktreeId: string, newWorktreeId: string): void {
    this.clientSessionTabSelections.migrateWorktree(oldWorktreeId, newWorktreeId)
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
    this.notifier?.worktreesChanged(repoId, { oldWorktreeId, newWorktreeId })
    // Mirror notifyBranchRenamed so in-process onClientEvent listeners also see the rename.
    this.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  notifyFolderWorkspaceChanged(): void {
    this.invalidateResolvedWorktreeCache()
    this.notifyReposChanged()
  }

  private recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    state: Partial<
      Pick<
        RuntimePtyWorktreeRecord,
        | 'connected'
        | 'lastOutputAt'
        | 'preview'
        | 'tabId'
        | 'paneKey'
        | 'title'
        | 'connectionId'
        | 'runtimeSessionOwned'
        | 'isWsl'
        | 'wslDistro'
        | 'incarnationId'
      >
    > = {}
  ): RuntimePtyWorktreeRecord {
    let pty = this.ptysById.get(ptyId)
    if (!pty) {
      const titleObservedAt = state.title ? this.nextTitleObservationSequence() : null
      const connectionId = state.connectionId ?? parseAppSshPtyId(ptyId)?.connectionId ?? null
      const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
      const fallbackWslDistro =
        process.platform === 'win32' && connectionId === null && worktreePath
          ? parseWslUncPath(worktreePath)?.distro
          : undefined
      const wslDistro =
        connectionId === null
          ? (state.wslDistro ?? this.wslDistroByPtyId.get(ptyId) ?? fallbackWslDistro ?? null)
          : null
      pty = {
        ptyId,
        incarnationId: state.incarnationId ?? null,
        worktreeId,
        connectionId,
        runtimeSessionOwned: state.runtimeSessionOwned ?? false,
        isWsl: state.isWsl ?? null,
        wslDistro,
        tabId: state.tabId ?? null,
        paneKey: state.paneKey ?? null,
        launchConfig: null,
        launchToken: null,
        launchIncarnationId: null,
        launchAgent: null,
        foregroundAgent: null,
        connected: state.connected ?? true,
        disconnectedAt: state.connected === false ? Date.now() : null,
        lastExitCode: null,
        lastAgentStatus: null,
        lastAgentStatusObservedLive: false,
        lastAgentStatusStartedAtEpochMs: null,
        lastAgentStatusRichInvalidatedAtEpochMs: null,
        lastOscTitle: null,
        lastOscTitleAt: null,
        lastOscTitleEpochMs: null,
        managementTitle: null,
        managementTitleAt: null,
        controllerTitle: null,
        title: state.title ?? null,
        titleUpdatedAt: titleObservedAt,
        lastOutputAt: state.lastOutputAt ?? null,
        tailBuffer: [],
        tailTranscriptBuffer: [],
        tailTranscriptChars: 0,
        tailPartialLine: '',
        tailPendingAnsi: '',
        tailRedrawCursor: null,
        tailTruncated: false,
        tailLinesTotal: 0,
        preview: state.preview ?? '',
        waitBlockedAt: null
      }
      if (state.title) {
        this.setPtyManagementTitleFromObservedTitle(pty, state.title, titleObservedAt ?? 0)
      }
      this.ptysById.set(ptyId, pty)
      if (wslDistro) {
        this.wslDistroByPtyId.set(ptyId, wslDistro)
      } else if (connectionId !== null) {
        // Why: restored SSH IDs can collide with stale local parser state; connection ownership must win before their first output is parsed.
        this.wslDistroByPtyId.delete(ptyId)
      }
      // Why: restored/controller-discovered PTYs learn their worktree here without registerPty(), so URL enrichment must bind at this source.
      advertisedUrlWatcher.bindPty(ptyId, worktreeId)
      return pty
    }

    pty.worktreeId = worktreeId
    if (state.incarnationId !== undefined) {
      pty.incarnationId = state.incarnationId
    }
    if (state.connectionId !== undefined) {
      pty.connectionId = state.connectionId
      if (state.connectionId !== null) {
        pty.wslDistro = null
        this.wslDistroByPtyId.delete(ptyId)
      }
    }
    if (state.runtimeSessionOwned !== undefined) {
      pty.runtimeSessionOwned = state.runtimeSessionOwned
    }
    if (state.isWsl !== undefined) {
      pty.isWsl = state.isWsl
    }
    if (state.wslDistro !== undefined) {
      pty.wslDistro = state.wslDistro
      if (state.wslDistro) {
        this.wslDistroByPtyId.set(ptyId, state.wslDistro)
      } else {
        this.wslDistroByPtyId.delete(ptyId)
      }
    }
    if (state.tabId !== undefined) {
      pty.tabId = state.tabId
    }
    if (state.paneKey !== undefined) {
      pty.paneKey = state.paneKey
    }
    if (state.connected !== undefined) {
      pty.connected = state.connected
      pty.disconnectedAt = state.connected ? null : (pty.disconnectedAt ?? Date.now())
    }
    if (state.lastOutputAt !== undefined) {
      pty.lastOutputAt = maxTimestamp(pty.lastOutputAt, state.lastOutputAt)
    }
    if (state.preview !== undefined && state.preview.length > 0) {
      pty.preview = state.preview
    }
    if (state.title !== undefined && state.title !== null && state.title.length > 0) {
      const observedAt = this.nextTitleObservationSequence()
      pty.title = state.title
      pty.titleUpdatedAt = observedAt
      this.setPtyManagementTitleFromObservedTitle(pty, state.title, observedAt)
    }
    // Why: recordPtyWorktree is the common lifecycle point for every path that resolves a PTY's worktree (renderer restore, controller list).
    advertisedUrlWatcher.bindPty(ptyId, worktreeId)
    return pty
  }

  private makeRuntimePaneKey(
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ): string {
    return isTerminalLeafId(leaf.leafId)
      ? makePaneKey(leaf.tabId, leaf.leafId)
      : `${leaf.tabId}:${leaf.paneRuntimeId}`
  }

  private getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null {
    const existing = this.ptysById.get(ptyId)
    if (existing) {
      return existing
    }
    const inferredWorktreeId = inferWorktreeIdFromPtyId(ptyId)
    if (!inferredWorktreeId) {
      return null
    }
    // Why: daemon-backed PTY session IDs are prefixed with the worktree ID so mobile summaries survive renderer graph gaps and reloads.
    return this.recordPtyWorktree(ptyId, inferredWorktreeId)
  }

  /** Synchronizes PTY tracking records with running daemon sessions, querying their foreground agent states. */
  private async refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number
  ): Promise<Set<string> | null> {
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      targetWorktreeId,
      deadline
    )
    return inventory ? new Set(inventory.livePtyIds) : null
  }

  private async refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number,
    connectionId?: string | null
  ): Promise<PtyControllerInventory | null> {
    if (targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      const targetedLiveness = this.refreshFloatingWorkspacePtyLiveness()
      if (targetedLiveness !== null) {
        return {
          livePtyIds: targetedLiveness,
          allLivePtyIds: targetedLiveness,
          terminalIdentityByPtyId: new Map()
        }
      }
    }
    if (!this.ptyController?.listProcesses) {
      return null
    }
    const inventoryGeneration = this.ptyControllerInventorySequence + 1
    this.ptyControllerInventorySequence = inventoryGeneration
    const providerKey = typeof connectionId === 'string' ? `ssh:${connectionId}` : 'local'
    if (connectionId === undefined) {
      this.ptyControllerAggregateInventoryGeneration = inventoryGeneration
    } else {
      this.ptyControllerInventoryGenerationByProvider.set(providerKey, inventoryGeneration)
    }
    const sessionsResult = await withTimeoutResult(
      this.ptyController.listProcesses(connectionId),
      deadline === undefined
        ? PTY_CONTROLLER_LIST_TIMEOUT_MS
        : Math.max(1, Math.min(PTY_CONTROLLER_LIST_TIMEOUT_MS, deadline - Date.now()))
    )
    if (!sessionsResult.ok) {
      // Why: a transient controller failure is not evidence that retained PTYs exited.
      return null
    }
    const isCurrentInventory =
      connectionId === undefined
        ? this.ptyControllerAggregateInventoryGeneration === inventoryGeneration &&
          ![...this.ptyControllerInventoryGenerationByProvider.values()].some(
            (generation) => generation > inventoryGeneration
          )
        : this.ptyControllerInventoryGenerationByProvider.get(providerKey) ===
            inventoryGeneration &&
          this.ptyControllerAggregateInventoryGeneration <= inventoryGeneration
    if (!isCurrentInventory) {
      return null
    }
    const sessions = sessionsResult.value
    const controllerIdentityByPtyId = new Map<string, PtyControllerTerminalIdentity>()
    const ptyIdByControllerHandle = new Map<string, string>()
    const ambiguousControllerPtyIds = new Set<string>()
    for (const session of sessions) {
      const handle = session.terminalHandle?.trim()
      const incarnationId = session.incarnationId?.trim()
      if (!handle?.startsWith('term_') || !incarnationId) {
        continue
      }
      const priorPtyId = ptyIdByControllerHandle.get(handle)
      if (priorPtyId && priorPtyId !== session.id) {
        ambiguousControllerPtyIds.add(priorPtyId)
        ambiguousControllerPtyIds.add(session.id)
        controllerIdentityByPtyId.delete(priorPtyId)
        continue
      }
      if (controllerIdentityByPtyId.has(session.id)) {
        ambiguousControllerPtyIds.add(session.id)
        controllerIdentityByPtyId.delete(session.id)
        continue
      }
      ptyIdByControllerHandle.set(handle, session.id)
      controllerIdentityByPtyId.set(session.id, {
        handle,
        incarnationId,
        ...(session.wslDistro !== undefined ? { wslDistro: session.wslDistro } : {})
      })
    }
    for (const ptyId of ambiguousControllerPtyIds) {
      controllerIdentityByPtyId.delete(ptyId)
    }
    const findResolvedWorktree = createIncrementalResolvedWorktreeLookup(resolvedWorktrees)
    const persistedIndexesByHostId = new Map<
      ExecutionHostId,
      {
        worktreeIdByPtyId: ReadonlyMap<string, string>
        surfaceByPtyId: ReturnType<typeof indexPersistedPtySurfaceBindings>
      }
    >()
    const getPersistedIndexes = (hostId: ExecutionHostId) => {
      const existing = persistedIndexesByHostId.get(hostId)
      if (existing) {
        return existing
      }
      const persistedSession = this.store?.getWorkspaceSession?.(hostId)
      const indexes = {
        worktreeIdByPtyId: indexPersistedPtyWorktreeBindings(persistedSession),
        surfaceByPtyId: indexPersistedPtySurfaceBindings(persistedSession)
      }
      persistedIndexesByHostId.set(hostId, indexes)
      return indexes
    }
    const allLivePtyIds = new Set(sessions.map((session) => session.id))
    const selectedLivePtyIds = new Set<string>()
    for (const session of sessions) {
      const sessionConnectionId =
        parseAppSshPtyId(session.id)?.connectionId ??
        (typeof connectionId === 'string' ? connectionId : null)
      const persistedIndexes = getPersistedIndexes(
        sessionConnectionId ? toSshExecutionHostId(sessionConnectionId) : LOCAL_EXECUTION_HOST_ID
      )
      const controllerIdentity = controllerIdentityByPtyId.get(session.id)
      const persistedWorktreeId = persistedIndexes.worktreeIdByPtyId.get(session.id)
      const providerWorktree = session.worktreeId
        ? findResolvedWorktree(session.worktreeId)
        : undefined
      const inferredWorktreeId = inferWorktreeIdFromPtyId(session.id)
      const persistedWorktree = persistedWorktreeId
        ? findResolvedWorktree(persistedWorktreeId)
        : undefined
      const hasMigrationEvidence =
        Boolean(session.worktreeId) &&
        !providerWorktree &&
        Boolean(persistedWorktree) &&
        Boolean(inferredWorktreeId) &&
        runtimeWorktreeIdsEqual(session.worktreeId as string, inferredWorktreeId as string)
      // Why: an unresolved explicit provider owner remains authoritative unless the session id proves it was frozen before a persisted rename migration.
      const worktreeId = providerWorktree
        ? providerWorktree.id
        : hasMigrationEvidence
          ? (persistedWorktree?.id ?? null)
          : (session.worktreeId ??
            persistedWorktree?.id ??
            inferredWorktreeId ??
            findResolvedWorktreeIdForPath(resolvedWorktrees, session.cwd, targetWorktreeId))
      const persistedSurface = persistedIndexes.surfaceByPtyId.get(session.id)
      const restoresExactSurface =
        persistedSurface &&
        session.incarnationId &&
        persistedSurface.incarnationId === session.incarnationId &&
        Boolean(worktreeId) &&
        runtimeWorktreeIdsEqual(persistedSurface.worktreeId, worktreeId as string)
      this.adoptControllerTerminalHandle(
        session.id,
        controllerIdentity?.handle ?? session.terminalHandle,
        controllerIdentity?.incarnationId ?? session.incarnationId,
        { exactRestoredSurface: Boolean(restoresExactSurface && controllerIdentity) }
      )
      if (
        !targetWorktreeId ||
        (worktreeId && runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId))
      ) {
        selectedLivePtyIds.add(session.id)
      }
      if (
        targetWorktreeId &&
        (!worktreeId || !runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId))
      ) {
        const receipt = this.restoredOrchestrationAuthorityByPtyId.get(session.id)
        if (receipt && runtimeWorktreeIdsEqual(receipt.worktreeId, targetWorktreeId)) {
          this.restoredOrchestrationAuthorityByPtyId.delete(session.id)
        }
        continue
      }
      this.restoredOrchestrationAuthorityByPtyId.delete(session.id)
      if (worktreeId) {
        const pty = this.recordPtyWorktree(session.id, worktreeId, {
          connected: true,
          ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
          ...(session.wslDistro !== undefined
            ? { isWsl: Boolean(session.wslDistro), wslDistro: session.wslDistro }
            : {}),
          ...(restoresExactSurface
            ? { tabId: persistedSurface.tabId, paneKey: persistedSurface.paneKey }
            : {})
        })
        if (restoresExactSurface && controllerIdentity) {
          this.rememberRestoredOrchestrationAuthority(
            pty,
            controllerIdentity.handle,
            controllerIdentity.incarnationId
          )
        } else {
          this.restoredOrchestrationAuthorityByPtyId.delete(session.id)
        }
        pty.controllerTitle = session.title?.trim() || null
        this.reconcileSubscriberDrivenProviderAttach(session.id)
      }
      // Why: fire-and-forget so this listing hot path doesn't serialize a relay round-trip per session and a throw can't abort the sweep below.
      this.refreshPtyForegroundAgent(session.id)
    }
    for (const [ptyId, receipt] of this.restoredOrchestrationAuthorityByPtyId) {
      const inScope =
        connectionId === undefined ||
        (connectionId === null && receipt.hostScope.kind !== 'ssh') ||
        (typeof connectionId === 'string' &&
          receipt.hostScope.kind === 'ssh' &&
          receipt.hostScope.targetId === connectionId)
      if (inScope && !allLivePtyIds.has(ptyId)) {
        this.restoredOrchestrationAuthorityByPtyId.delete(ptyId)
      }
    }
    for (const pty of this.ptysById.values()) {
      if (connectionId !== undefined && pty.connectionId !== connectionId) {
        continue
      }
      if (!allLivePtyIds.has(pty.ptyId) && !this.leafExistsForPty(pty.ptyId)) {
        if (this.ptyController.hasPty?.(pty.ptyId) === true) {
          // Why: an SSH spawn can become addressable before an overlapping relay list includes it.
          allLivePtyIds.add(pty.ptyId)
          if (
            !targetWorktreeId ||
            (pty.worktreeId && runtimeWorktreeIdsEqual(pty.worktreeId, targetWorktreeId))
          ) {
            selectedLivePtyIds.add(pty.ptyId)
          }
          pty.connected = true
          pty.disconnectedAt = null
          continue
        }
        pty.connected = false
        pty.disconnectedAt ??= Date.now()
      }
    }
    this.pruneDisconnectedPtyRecords()
    return {
      livePtyIds: targetWorktreeId ? selectedLivePtyIds : allLivePtyIds,
      allLivePtyIds,
      terminalIdentityByPtyId: controllerIdentityByPtyId
    }
  }

  private refreshFloatingWorkspacePtyLiveness(): Set<string> | null {
    const controller = this.ptyController
    if (!controller?.hasPty) {
      return null
    }
    const knownPtyIds = new Set<string>()
    const persistedBindingByPtyId = new Map<string, { tabId: string; paneKey: string }>()
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
        knownPtyIds.add(pty.ptyId)
      }
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === FLOATING_TERMINAL_WORKTREE_ID && leaf.ptyId) {
        knownPtyIds.add(leaf.ptyId)
      }
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(FLOATING_TERMINAL_WORKTREE_ID)
    for (const tab of snapshot?.tabs ?? []) {
      if (tab.type !== 'terminal') {
        continue
      }
      if (tab.ptyId) {
        knownPtyIds.add(tab.ptyId)
        persistedBindingByPtyId.set(tab.ptyId, {
          tabId: tab.parentTabId,
          paneKey: this.getMobileTerminalPaneKey(tab)
        })
      }
      for (const [leafId, ptyId] of Object.entries(tab.parentLayout?.ptyIdsByLeafId ?? {})) {
        knownPtyIds.add(ptyId)
        persistedBindingByPtyId.set(ptyId, {
          tabId: tab.parentTabId,
          paneKey: isTerminalLeafId(leafId)
            ? makePaneKey(tab.parentTabId, leafId)
            : `${tab.parentTabId}:${/^pane:(\d+)$/.exec(leafId)?.[1] ?? leafId}`
        })
      }
    }

    const liveness = new Map<string, boolean>()
    try {
      for (const ptyId of knownPtyIds) {
        const live = controller.hasPty(ptyId)
        if (live === null) {
          return null
        }
        liveness.set(ptyId, live)
      }
    } catch {
      return null
    }

    const livePtyIds = new Set<string>()
    for (const [ptyId, live] of liveness) {
      let pty = this.ptysById.get(ptyId)
      if (live) {
        livePtyIds.add(ptyId)
        const binding = persistedBindingByPtyId.get(ptyId)
        if (!pty && binding) {
          // Why: a live daemon PTY restored from disk needs its pane identity before mobile can issue a safe handle.
          pty = this.recordPtyWorktree(ptyId, FLOATING_TERMINAL_WORKTREE_ID, {
            connected: true,
            tabId: binding.tabId,
            paneKey: binding.paneKey
          })
        }
        if (pty) {
          pty.connected = true
          pty.disconnectedAt = null
          this.refreshPtyForegroundAgent(ptyId)
        }
      } else if (pty && !this.leafExistsForPty(ptyId)) {
        pty.connected = false
        pty.disconnectedAt ??= Date.now()
      }
    }
    this.pruneDisconnectedPtyRecords()
    return livePtyIds
  }

  private pruneDisconnectedPtyTranscript(pty: RuntimePtyWorktreeRecord): void {
    if (pty.connected) {
      return
    }
    // Why: disconnected PTY records stay addressable for status/exit reads, but their transcripts must not accumulate after the process dies.
    pty.tailBuffer = []
    pty.tailTranscriptBuffer = []
    pty.tailTranscriptChars = 0
    pty.tailPartialLine = ''
    pty.tailPendingAnsi = ''
    pty.tailRedrawCursor = null
    pty.tailTruncated = false
    pty.tailLinesTotal = 0
    pty.waitBlockedAt = null
    // Why: tail is now empty, so clear the memoized wait scan; onPtyData must recompute from the reset tail if this record resumes output.
    pty.tailWaitState = undefined
  }

  private pruneDisconnectedPtyRecords(): void {
    const retained = [...this.ptysById.values()]
      .filter((pty) => !pty.connected && !this.leafExistsForPty(pty.ptyId))
      .sort((a, b) => (a.disconnectedAt ?? 0) - (b.disconnectedAt ?? 0))
    const staleCount = Math.max(0, retained.length - DISCONNECTED_PTY_RECORD_MAX)
    for (const stale of retained.slice(0, staleCount)) {
      // Why: exited runtime-owned PTYs stay readable, but long-lived runtimes churn through many sessions; bound the archive.
      this.dropDisconnectedPtyRecord(stale.ptyId)
    }
  }

  private dropDisconnectedPtyRecord(ptyId: string): void {
    // Why: pruning can remove a PTY without the normal exit callback.
    this.advancePtyLifecycleGeneration(ptyId)
    this.pairedRendererSessionOwnedPtyIds.delete(ptyId)
    this.ptysById.delete(ptyId)
    this.recentPtyOutputById.delete(ptyId)
    this.setupCompletionTokenByPtyId.delete(ptyId)
    this.clearWaitBlockedCheckState(ptyId)
    this.recentPtyPathCandidatesById.delete(ptyId)
    this.ptyOutputSequenceById.delete(ptyId)
    this.providerSequenceInitializedPtys.delete(ptyId)
    this.providerSequenceOffsetByPtyId.delete(ptyId)
    this.providerSnapshotPreferredPtys.delete(ptyId)
    this.providerModeTrackersByPtyId.delete(ptyId)
    this.providerModeSnapshotScansByPtyId.delete(ptyId)
    this.providerBufferAcquisitionsByPtyId.delete(ptyId)
    this.providerVisibleStateByPtyId.delete(ptyId)
    this.providerVisibleRetryAtByPtyId.delete(ptyId)
    this.agentStatusOscProcessorsByPtyId.delete(ptyId)
    this.terminalSpawnCommandsByPtyId.delete(ptyId)
    this.disposePtyTitleTracker(ptyId)
    this.oscTitleScanTailByPtyId.delete(ptyId)
    this.osc7ScanTailByPtyId.delete(ptyId)
    this.terminalCwdByPtyId.delete(ptyId)
    this.terminalFileUriHostnameByPtyId.delete(ptyId)
    this.wslDistroByPtyId.delete(ptyId)
    this.clearAgentRowSnapshotsForPty(ptyId)
    const handle = this.handleByPtyId.get(ptyId)
    if (handle) {
      // Why: pruning can remove a PTY without onPtyExit firing; release this leader's agent team so it doesn't leak.
      this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
      this.handleByPtyId.delete(ptyId)
      this.syntheticTerminalHandles.delete(handle)
      const record = this.handles.get(handle)
      if (record?.tabId.startsWith('pty:')) {
        this.handles.delete(handle)
      }
    }
  }

  private leafExistsForPty(ptyId: string): boolean {
    return (this.leavesByPtyId.get(ptyId)?.length ?? 0) > 0
  }

  private rebuildLeafPtyIndex(): void {
    const next = new Map<string, RuntimeLeafRecord[]>()
    for (const leaf of this.leaves.values()) {
      if (!leaf.ptyId) {
        continue
      }
      const leaves = next.get(leaf.ptyId)
      if (leaves) {
        leaves.push(leaf)
      } else {
        next.set(leaf.ptyId, [leaf])
      }
    }
    this.leavesByPtyId = next
  }

  private getLeavesForPty(ptyId: string): RuntimeLeafRecord[] {
    return this.leavesByPtyId.get(ptyId) ?? []
  }

  private getPrimaryLeafForPty(ptyId: string): RuntimeLeafRecord | null {
    return this.getLeavesForPty(ptyId)[0] ?? null
  }

  private getSummaryForRuntimeWorktreeId(
    summaries: Map<string, RuntimeWorktreePsSummary>,
    runtimeWorktreeSummaryPathIndex: RuntimeWorktreeSummaryPathIndex,
    missingRuntimeWorktreeIds: Set<string>,
    runtimeWorktreeId: string
  ): RuntimeWorktreePsSummary | null {
    const exact = summaries.get(runtimeWorktreeId)
    if (exact) {
      return exact
    }
    if (missingRuntimeWorktreeIds.has(runtimeWorktreeId)) {
      return null
    }
    const parsed = parseRuntimeWorktreeId(runtimeWorktreeId)
    if (!parsed) {
      return null
    }
    const comparisonPlatform =
      runtimeWorktreeSummaryPathIndex.platformByRepoId.get(parsed.repoId) ?? process.platform
    const indexed = findRuntimeWorktreeSummaryByPath(
      runtimeWorktreeSummaryPathIndex,
      parsed.repoId,
      parsed.worktreePath,
      comparisonPlatform
    )
    if (indexed) {
      return indexed
    }
    missingRuntimeWorktreeIds.add(runtimeWorktreeId)
    return null
  }

  private buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>,
    provenLivePtyIds: ReadonlySet<string> | null = null
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(leaf.worktreeId)
    const tab = this.tabs.get(leaf.tabId) ?? null

    const pty = leaf.ptyId ? this.ptysById.get(leaf.ptyId) : undefined
    // Why: leaf.connected mirrors the renderer graph (`ptyId !== null`), so a
    // restored surface whose PTY died with a prior run still reads connected.
    // Demote only on a controller-proven absence, and only for locally-scoped
    // ids the aggregate inventory authoritatively covers — SSH/remote scopes may
    // be legitimately missing from it, and unknown liveness never demotes.
    // The sync hasPty rescue closes the spawn/list race: a just-spawned PTY can
    // register after the inventory snapshot, and federation reads one
    // connected:false as exited.
    const provenAbsent =
      provenLivePtyIds !== null &&
      leaf.ptyId !== null &&
      !provenLivePtyIds.has(leaf.ptyId) &&
      !leaf.ptyId.startsWith('remote:') &&
      parseAppSshPtyId(leaf.ptyId) === null &&
      this.ptyController?.hasPty?.(leaf.ptyId) !== true
    return {
      handle: this.issueHandle(leaf),
      ptyId: leaf.ptyId,
      incarnationId: pty?.incarnationId ?? null,
      orphaned: false,
      worktreeId: leaf.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      title: getLatestLeafTitle(leaf, tab?.title ?? null),
      connected: provenAbsent ? false : leaf.connected,
      writable: provenAbsent ? false : leaf.writable,
      lastOutputAt: leaf.lastOutputAt,
      preview: leaf.preview
    }
  }

  // Returns the worktrees whose stored snapshot object changed during this
  // sync, so the caller can fan out only actually-changed worktrees.
  private syncMobileSessionTabs(
    snapshots: RuntimeMobileSessionTabsSnapshot[] | undefined,
    unchangedWorktreeIds?: string[],
    resyncWorktreeIds = new Set<string>()
  ): Set<string> {
    const changedWorktreeIds = new Set<string>()
    if (snapshots === undefined) {
      return changedWorktreeIds
    }
    // Why: snapshots are immutable — every writer replaces the map entry with a
    // new object, and the accept gate below drops semantically-unchanged
    // renderer resends before they replace an entry — so reference identity
    // before/after detects exactly the entries that actually changed.
    const before = new Map(this.mobileSessionTabsByWorktree)
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(null, {
      missingSnapshotOnly: true,
      notify: false
    })
    // Why: graph sync must scan each persisted host session once, not once per workspace.
    const worktreeSessionsToHydrate = new Map<string, WorkspaceSessionState | null>(
      this.getWorkspaceSessionHydrationTargets(Boolean(this.offscreenBrowserBackend))
    )
    if (this.offscreenBrowserBackend) {
      for (const snapshot of snapshots) {
        if (!worktreeSessionsToHydrate.has(snapshot.worktree)) {
          worktreeSessionsToHydrate.set(snapshot.worktree, null)
        }
      }
    }
    // Why: an empty renderer publication after HUB restart must not hide SSH panes persisted in this HUB's host partition.
    for (const [worktreeId, workspaceSession] of worktreeSessionsToHydrate) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true,
        ...(workspaceSession ? { runtimeOwnedTerminalCandidateKnown: true, workspaceSession } : {})
      })
    }
    const nextWorktrees = new Set<string>()
    const incomingWorktreeIds = new Set(snapshots.map((snapshot) => snapshot.worktree))
    // Why: the renderer withholds unchanged snapshots to keep the graph payload
    // small, so these worktrees are still live and must not fall into the prune
    // below. Ask for a republish when main no longer holds that accepted renderer
    // publication or a formerly-preserved runtime tab has gone stale.
    for (const worktreeId of unchangedWorktreeIds ?? []) {
      const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
      const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)
      if (existing) {
        nextWorktrees.add(worktreeId)
      }
      if (
        existing &&
        accepted &&
        (existing.publicationEpoch === accepted.publicationEpoch ||
          existing.publicationEpoch.startsWith(`${accepted.publicationEpoch}:headless-merge:`)) &&
        existing.tabs.length >= accepted.rendererTabCount &&
        (existing.tabs.length === accepted.rendererTabCount ||
          !this.storedMobileSnapshotHasStalePreservedTab(
            existing,
            accepted.rendererTabIdentityKeys
          ))
      ) {
        continue
      }
      if (!incomingWorktreeIds.has(worktreeId)) {
        resyncWorktreeIds.add(worktreeId)
      }
      // Why: the accept gate compares against the renderer's last accepted pair,
      // which outlives the dropped snapshot and would reject the republish.
      this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
    }
    for (const snapshot of snapshots) {
      nextWorktrees.add(snapshot.worktree)
      const existing = this.mobileSessionTabsByWorktree.get(snapshot.worktree)
      // Why: judge renderer publication ordering against the renderer's own
      // last-accepted (epoch, version) — the renderer reuses one pair for
      // byte-identical content, so a same-epoch version <= the accepted one is
      // a no-op resend (or a stale frame) and must be skipped. Never compare
      // against the stored snapshot's version: main-local touches bump it
      // independently and would reject genuinely newer renderer revisions.
      const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(snapshot.worktree)
      if (
        accepted &&
        accepted.publicationEpoch === snapshot.publicationEpoch &&
        snapshot.snapshotVersion <= accepted.rendererVersion &&
        // Why: preservation is main-only state — a serve/SSH binding (or live
        // browser page) can disappear without the renderer bumping its version,
        // so a resend of the EXACT accepted revision (content-identical to the
        // accepted publication, safe to re-merge) must still fall through to
        // the merge, which prunes stale preserved tabs. Strictly-older frames
        // stay skipped: their content is outdated, and the next accepted-pair
        // resend performs the prune.
        !(
          existing &&
          snapshot.snapshotVersion === accepted.rendererVersion &&
          this.storedMobileSnapshotHasStalePreservedTab(existing, accepted.rendererTabIdentityKeys)
        )
      ) {
        continue
      }
      this.nativeChatDraftResolutions.reconcile(snapshot)
      const launchDraftFencedSnapshot = this.nativeChatDraftResolutions.applyFence(snapshot)
      const fencedSnapshot = this.applyMobileSessionRetirementFences(launchDraftFencedSnapshot)
      const nextSnapshot = this.mergePreservedHeadlessMobileSessionTabs(fencedSnapshot, existing)
      // Why: clients drop same-epoch frames whose version isn't strictly newer,
      // and main-local touches may already have emitted a higher version than
      // the renderer's counter — keep the stored version strictly monotonic so
      // the accepted content is never discarded as stale downstream.
      const storedVersion = existing
        ? Math.max(nextSnapshot.snapshotVersion, existing.snapshotVersion + 1)
        : nextSnapshot.snapshotVersion
      this.mobileSessionTabsByWorktree.set(
        snapshot.worktree,
        storedVersion === nextSnapshot.snapshotVersion
          ? nextSnapshot
          : { ...nextSnapshot, snapshotVersion: storedVersion }
      )
      this.acceptedRendererMobileSnapshotByWorktree.set(snapshot.worktree, {
        publicationEpoch: snapshot.publicationEpoch,
        rendererVersion: snapshot.snapshotVersion,
        rendererTabCount: fencedSnapshot.tabs.length,
        rendererTabIdentityKeys: new Set(
          fencedSnapshot.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab))
        )
      })
    }
    for (const [worktreeId, existing] of [...this.mobileSessionTabsByWorktree.entries()]) {
      if (!nextWorktrees.has(worktreeId)) {
        const preserved = this.buildPreservedHeadlessMobileSessionSnapshot(existing)
        if (preserved) {
          // Why: preservation filters existing.tabs in place (same objects) and
          // the merge epoch hashes the preserved identities idempotently, so an
          // equal epoch with every tab object retained means the recomputation
          // was a no-op — keep the entry so no-op syncs don't fan out.
          const preservedIsNoOp =
            preserved.publicationEpoch === existing.publicationEpoch &&
            preserved.tabs.length === existing.tabs.length &&
            preserved.tabs.every((tab, index) => tab === existing.tabs[index])
          if (!preservedIsNoOp) {
            this.mobileSessionTabsByWorktree.set(worktreeId, preserved)
          }
          // Why: the stored entry is no longer the renderer's publication, so a
          // future renderer frame must be re-merged even if it reuses the pair.
          this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
          nextWorktrees.add(worktreeId)
        } else {
          this.mobileSessionTabsByWorktree.delete(worktreeId)
          this.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId)
          this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
          // Why: drop any pending coalesced notify so a stale snapshot can't land after the removed frame.
          this.mobileSessionTabsNotifyCoalescer.cancel(worktreeId)
          this.notifyMobileSessionTabsRemoved(worktreeId)
        }
      }
    }
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      if (before.get(worktreeId) !== snapshot) {
        changedWorktreeIds.add(worktreeId)
      }
    }
    return changedWorktreeIds
  }

  private mergePreservedHeadlessMobileSessionTabs(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot | undefined
  ): RuntimeMobileSessionTabsSnapshot {
    if (!existing) {
      return snapshot
    }
    const preservedTabs = this.collectPreservedHeadlessMobileSessionTabs(existing, snapshot)
    if (preservedTabs.length === 0) {
      return snapshot
    }
    const hasIncomingActiveTab = snapshot.tabs.some((tab) => tab.isActive)
    const normalizedPreservedTabs = preservedTabs.map((tab) =>
      hasIncomingActiveTab ? { ...tab, isActive: false } : tab
    )
    const tabs = mergeMobileSessionSnapshotTabs(snapshot.tabs, normalizedPreservedTabs)
    if (tabs.length === snapshot.tabs.length) {
      return snapshot
    }
    const activeTab =
      snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId) ??
      tabs.find((tab) => tab.id === existing.activeTabId) ??
      tabs.find((tab) => tab.isActive) ??
      tabs[0] ??
      null
    const terminalTabs = tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    return {
      ...snapshot,
      publicationEpoch: this.getMergedMobileSessionPublicationEpoch(
        snapshot,
        normalizedPreservedTabs
      ),
      snapshotVersion: Math.max(snapshot.snapshotVersion, existing.snapshotVersion),
      activeGroupId: snapshot.activeGroupId ?? existing.activeGroupId,
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: mergeMobileSessionTabGroups(
        snapshot.worktree,
        snapshot.tabGroups ?? existing.tabGroups ?? [],
        terminalTabs,
        activeTab?.type === 'terminal' ? activeTab : null
      ),
      tabs
    }
  }

  private buildPreservedHeadlessMobileSessionSnapshot(
    existing: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot | null {
    const tabs = this.collectPreservedHeadlessMobileSessionTabs(existing)
    if (tabs.length === 0) {
      return null
    }
    const activeTab =
      tabs.find((tab) => tab.id === existing.activeTabId) ??
      tabs.find((tab) => tab.isActive) ??
      tabs[0] ??
      null
    const terminalTabs = tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    return {
      ...existing,
      publicationEpoch: this.getMergedMobileSessionPublicationEpoch(existing, tabs),
      // Why: mint a fresh version or clients' same-epoch gate drops the prune frame.
      snapshotVersion: existing.snapshotVersion + 1,
      activeGroupId: existing.activeGroupId ?? getHeadlessMobileSessionGroupId(existing.worktree),
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: mergeMobileSessionTabGroups(
        existing.worktree,
        existing.tabGroups ?? [],
        terminalTabs,
        activeTab?.type === 'terminal' ? activeTab : null
      ),
      tabs
    }
  }

  // Why: the accepted-revision no-op gate must not fossilize preserved runtime
  // tabs. A stored merged snapshot's tabs absent from the accepted renderer
  // publication exist only via preservation; if any such tab no longer
  // passes the preservation predicate (binding removed from the live PTY table
  // and persisted session, or browser page closed), the stored snapshot is stale.
  private storedMobileSnapshotHasStalePreservedTab(
    existing: RuntimeMobileSessionTabsSnapshot,
    rendererTabIdentityKeys: ReadonlySet<string>
  ): boolean {
    return existing.tabs.some(
      (tab) =>
        !getMobileSessionSnapshotTabIdentityKeys(tab).some((id) =>
          rendererTabIdentityKeys.has(id)
        ) && !this.shouldPreserveHeadlessMobileSessionTab(existing, tab)
    )
  }

  private collectPreservedHeadlessMobileSessionTabs(
    existing: RuntimeMobileSessionTabsSnapshot,
    incoming?: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionSnapshotTab[] {
    const incomingIds = new Set(
      incoming?.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab)) ?? []
    )
    return existing.tabs.filter((tab) => {
      if (getMobileSessionSnapshotTabIdentityKeys(tab).some((id) => incomingIds.has(id))) {
        return false
      }
      return this.shouldPreserveHeadlessMobileSessionTab(existing, tab)
    })
  }

  private shouldPreserveHeadlessMobileSessionTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionSnapshotTab
  ): boolean {
    if (tab.type === 'browser') {
      const liveClientPage =
        typeof tab.browserPageId === 'string'
          ? getRuntimeBrowserPageRegistry(this).getPage(tab.browserPageId)
          : undefined
      if (
        liveClientPage?.workspaceId === snapshot.worktree &&
        tab.placement?.kind === 'client' &&
        sameRuntimeBrowserPlacement(liveClientPage.placement, tab.placement)
      ) {
        return true
      }
      // Why: headless offscreen browser tabs exist only server-side, so a renderer-graph merge must keep them, not prune as "not in the graph".
      if (!this.offscreenBrowserBackend) {
        return false
      }
      // Why: in a renderer-based merged snapshot the browser entries can also
      // be renderer-owned, so only pages the offscreen bridge still lists are
      // runtime-owned and preservable; a pure renderer epoch preserves none.
      return (
        this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch) ||
        (snapshot.publicationEpoch.includes(':headless-merge:') &&
          typeof tab.browserPageId === 'string' &&
          this.getLiveBrowserTabsByPageId(snapshot.worktree).has(tab.browserPageId))
      )
    }
    if (tab.type !== 'terminal') {
      return false
    }
    // Why: a merged renderer snapshot carries BOTH renderer-owned and
    // runtime-owned tabs, so the epoch alone must not preserve every terminal —
    // that resurrects renderer tabs the renderer already closed. Broad
    // preservation applies only to genuinely headless-built snapshots; in a
    // renderer-based one, only tabs with a live-or-persisted serve/SSH binding
    // are runtime-owned and preservable.
    return (
      this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch) ||
      this.hasLiveRuntimeSessionOwnedPtyBinding(snapshot.worktree, tab) ||
      this.hasLiveOrPersistedServeOrSshOwnedPtyBinding(snapshot.worktree, tab)
    )
  }

  private isHeadlessMobileSessionPublication(publicationEpoch: string): boolean {
    return (
      publicationEpoch.startsWith('headless:') ||
      publicationEpoch.startsWith('headless-hydrated:') ||
      publicationEpoch.includes(':headless-merge:')
    )
  }

  // Why: `:headless-merge:` only marks that runtime tabs were merged in — the
  // BASE epoch still says who published the snapshot. A renderer-based merged
  // snapshot must not be classified as headless-built, or its renderer tabs
  // read as runtime-owned.
  private isHeadlessBuiltMobileSessionPublicationBase(publicationEpoch: string): boolean {
    const base = publicationEpoch.split(':headless-merge:')[0]
    return base.startsWith('headless:') || base.startsWith('headless-hydrated:')
  }

  private getMergedMobileSessionPublicationEpoch(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    preservedTabs: readonly RuntimeMobileSessionSnapshotTab[]
  ): string {
    // Why: preserved snapshots can merge repeatedly; strip the prior merge suffix first so the publication epoch stays idempotent.
    const normalizedPublicationEpoch = snapshot.publicationEpoch.split(':headless-merge:')[0]
    const signature = createHash('sha1')
      .update(
        preservedTabs
          .map((tab) =>
            tab.type === 'terminal'
              ? `${tab.id}:${tab.parentTabId}:${tab.ptyId ?? ''}:${tab.leafId}`
              : tab.id
          )
          .join('|')
      )
      .digest('hex')
      .slice(0, 12)
    return `${normalizedPublicationEpoch}:headless-merge:${signature}`
  }

  private readonly clientHostedBrowserRows = new ClientHostedBrowserRowPublisher({
    listClientPages: (worktreeId) => getRuntimeBrowserPageRegistry(this).listPages(worktreeId),
    hasLivePlacement: (browserPageId) =>
      getBrowserHostLeaseRegistry(this).getPlacement(browserPageId) !== undefined,
    resolveDeviceName: (pairedDeviceId) => this.getPairedDeviceNameFn(pairedDeviceId),
    getEmitter: () => {
      const notifier = this.notifier
      const send = notifier?.clientHostedBrowserRowsChanged
      return send ? (event) => send.call(notifier, event) : null
    }
  })

  /** Worktrees whose persisted client-hosted rows this runtime is responsible for rewriting. */
  private readonly persistedClientHostedBrowserWorktreeIds = new Set<string>()

  /** Serves a hydrating host renderer; the publisher counts this as a delivery, not a read. */
  listClientHostedBrowserRows(): ClientHostedBrowserRowsEvent[] {
    return this.clientHostedBrowserRows.deliverHydrationSnapshot()
  }

  private notifyMobileSessionTabsRemoved(worktreeId: string): void {
    const removed: RuntimeMobileSessionTabsRemovedResult = {
      worktree: worktreeId,
      publicationEpoch: `removed:${Date.now().toString(36)}`,
      snapshotVersion: 0,
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.clientSessionTabSelections.project(removed, subscription.clientNavigationId)
      )
    }
    this.clientSessionTabSelections.forgetWorktree(worktreeId)
  }

  notifyMobileSessionTabsChanged(worktreeId?: string): void {
    if (!worktreeId) {
      this.clientHostedBrowserRows.publishAll()
      for (const id of new Set([
        ...this.persistedClientHostedBrowserWorktreeIds,
        ...getRuntimeBrowserPageRegistry(this)
          .listPages()
          .map((page) => page.workspaceId)
      ])) {
        this.persistClientHostedBrowserPagesForWorktree(id)
      }
      this.notifyMobileSessionTabSnapshots()
      return
    }
    // Why: every client-page mutation — create, navigate, metadata, host quit, recovery — reaches
    // this announcement, so the host's own rows derive from it rather than from a second seam.
    this.clientHostedBrowserRows.publish(worktreeId)
    this.persistClientHostedBrowserPagesForWorktree(worktreeId)
    const hasClientBrowserPages =
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId).length > 0
    if (this.offscreenBrowserBackend || hasClientBrowserPages) {
      const reconciled = this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
        worktreeId,
        hasClientBrowserPages
          ? { allowAttachedWindow: true, onlyRuntimeOwnedTerminals: true }
          : undefined
      )
      // Why: hydrate already reconciles an existing snapshot in place; only reconcile here when it didn't (fresh build or early-returned hydrate).
      if (!reconciled.has(worktreeId)) {
        const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
        if (existing) {
          this.reconcileHeadlessMobileSessionBrowserTabs(worktreeId, existing)
        }
      }
    }
    // Why: structural changes must propagate promptly; cancel any pending coalesced notify since this immediate emit supersedes it.
    this.mobileSessionTabsNotifyCoalescer.cancel(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId)
  }

  private notifyMobileSessionTabsChangedNow(worktreeId: string): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    // Why: browser bridge events are already worktree-scoped; don't fan out every workspace snapshot during navigation/tab churn.
    const result = this.toMobileSessionTabsResult(snapshot)
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId)
      )
    }
  }

  private notifyMobileSessionTabSnapshots(): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    for (const snapshot of this.mobileSessionTabsByWorktree.values()) {
      const result = this.toMobileSessionTabsResult(snapshot)
      for (const subscription of this.mobileSessionTabListeners) {
        subscription.listener(
          this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId)
        )
      }
    }
  }

  private getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return this.projectMobileSessionTabsForClient(
        {
          worktree: worktreeId,
          publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
          snapshotVersion: 0,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        },
        clientNavigationId
      )
    }
    return this.projectMobileSessionTabsForClient(
      this.toMobileSessionTabsResult(snapshot),
      clientNavigationId
    )
  }

  private emitMobileSessionTabsSnapshotToClient(
    projected: RuntimeMobileSessionTabsResult,
    clientNavigationId: string,
    follow = false
  ): void {
    for (const subscription of this.mobileSessionTabListeners) {
      if (subscription.clientNavigationId === clientNavigationId) {
        subscription.listener(follow ? { ...projected, navigationIntent: 'follow' } : projected)
      }
    }
  }

  private async resolveMobileMarkdownWorktreeId(
    worktreeSelector: string,
    tabId: string
  ): Promise<string> {
    const worktreeId =
      this.getValidatedExplicitWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorktreeSelector(worktreeSelector)).id
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionMarkdownTab =>
        candidate.type === 'markdown' && candidate.id === tabId
    )
    if (!tab) {
      throw new Error('tab_not_found')
    }
    return worktreeId
  }

  private getLiveBrowserTabsByPageId(worktreeId: string): Map<string, BrowserTabInfo> {
    const liveTabs = this.agentBrowserBridge?.tabList?.(worktreeId).tabs ?? []
    const byPageId = new Map(liveTabs.map((tab) => [tab.browserPageId, tab]))
    for (const [index, page] of getRuntimeBrowserPageRegistry(this)
      .listPages(worktreeId)
      .entries()) {
      byPageId.set(page.browserPageId, {
        browserPageId: page.browserPageId,
        index: liveTabs.length + index,
        url: page.url,
        title: page.title,
        active: page.active,
        worktreeId,
        profileId: page.browserProfileId
      })
    }
    return byPageId
  }

  private collectReturnedSessionTabIds(
    tabs: readonly RuntimeMobileSessionClientTab[]
  ): Set<string> {
    const ids = new Set<string>()
    for (const tab of tabs) {
      ids.add(tab.id)
      if (tab.type === 'terminal') {
        ids.add(tab.parentTabId)
      } else if (tab.type === 'browser') {
        ids.add(tab.browserWorkspaceId)
      }
    }
    return ids
  }

  private sanitizeMobileSessionTabGroups(
    groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
    returnedTabs: readonly RuntimeMobileSessionClientTab[]
  ): RuntimeMobileSessionTabGroup[] | undefined {
    if (!groups || groups.length === 0) {
      return undefined
    }
    const returnedIds = this.collectReturnedSessionTabIds(returnedTabs)
    const sanitized = groups
      .map((group): RuntimeMobileSessionTabGroup | null => {
        const tabOrder = group.tabOrder.filter((tabId) => returnedIds.has(tabId))
        if (tabOrder.length === 0) {
          return null
        }
        const activeTabId =
          group.activeTabId && tabOrder.includes(group.activeTabId)
            ? group.activeTabId
            : (tabOrder[0] ?? null)
        const recentTabIds = group.recentTabIds?.filter((tabId) => tabOrder.includes(tabId))
        return {
          id: group.id,
          activeTabId,
          tabOrder,
          ...(recentTabIds && recentTabIds.length > 0 ? { recentTabIds } : {})
        }
      })
      .filter((group): group is RuntimeMobileSessionTabGroup => group !== null)
    return sanitized.length > 0 ? sanitized : undefined
  }

  private pruneMobileSessionTabGroupLayout(
    layout: TabGroupLayoutNode | null | undefined,
    validGroupIds: ReadonlySet<string>
  ): TabGroupLayoutNode | null {
    if (!layout) {
      return null
    }
    if (layout.type === 'leaf') {
      return validGroupIds.has(layout.groupId) ? layout : null
    }
    const first = this.pruneMobileSessionTabGroupLayout(layout.first, validGroupIds)
    const second = this.pruneMobileSessionTabGroupLayout(layout.second, validGroupIds)
    if (first && second) {
      return { ...layout, first, second }
    }
    return first ?? second
  }

  /** Transforms an internal mobile session tab snapshot into a sanitized client payload, resolving launch-agent ownership and normalizing titles. */
  private toMobileSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsResult {
    return projectRuntimeMobileSessionTabs(snapshot, this.getMobileSessionProjectionHost())
  }

  private getMobileSessionProjectionHost(): RuntimeMobileSessionProjectionHost {
    return {
      tabs: this.tabs,
      leaves: this.leaves,
      ptysById: this.ptysById,
      getLiveBrowserTabs: (worktreeId) => this.getLiveBrowserTabsByPageId(worktreeId),
      getProviderSessionRows: (paneKey) => this.getAgentProviderSessionRowsForPaneFn?.(paneKey),
      getProviderSessionSnapshot: () => this.getAgentProviderSessionSnapshotFn?.() ?? [],
      getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
      findPty: (worktreeId, tab, options) =>
        this.findPtyForMobileTerminalTab(worktreeId, tab, options),
      getRetainedStatus: (paneKey, pty, tab) =>
        this.getFreshRetainedAgentStatusForMobileTab(paneKey, pty, tab),
      getTrackedTitle: (ptyId) => this.getUnpersistedTrackedTitleForPty(ptyId),
      issuePtyHandle: (pty) => this.issuePtyHandle(pty),
      recordPty: (ptyId, worktreeId, state) => this.recordPtyWorktree(ptyId, worktreeId, state),
      buildPtyStatus: (pty, tab, terminalHandle, retained, getRows) =>
        this.buildPtyMobileAgentStatus(pty, tab, terminalHandle, retained, getRows),
      sanitizeGroups: (groups, tabs) => this.sanitizeMobileSessionTabGroups(groups, tabs),
      pruneGroupLayout: (layout, validGroupIds) =>
        this.pruneMobileSessionTabGroupLayout(layout, validGroupIds),
      collectTabIds: (tabs) => this.collectReturnedSessionTabIds(tabs)
    }
  }

  private buildPtyMobileAgentStatus(
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab,
    terminalHandle: string | null,
    retained: RuntimeAgentRowSnapshot | null,
    getHookRowsForPane: (paneKey: string) => AgentStatusIpcPayload[]
  ): { agentStatus: AgentStatusEntry } | Record<string, never> {
    return buildRuntimeMobileAgentStatus(pty, tab, terminalHandle, retained, getHookRowsForPane, {
      getPaneKey: (candidate) => this.getMobileTerminalPaneKey(candidate),
      getLeaf: (candidate) =>
        this.leaves.get(this.getLeafKey(candidate.parentTabId, candidate.leafId)) ?? null,
      getTrackedTitle: (ptyId) => this.getUnpersistedTrackedTitleForPty(ptyId)
    })
  }

  private getFreshRetainedAgentStatusForMobileTab(
    paneKey: string,
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab
  ): RuntimeAgentRowSnapshot | null {
    return this.agentRows.getFreshForMobile(paneKey, pty, tab)
  }

  private findPtyForMobileTerminalTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowWorktreeOnlyMatch?: boolean } = {}
  ): RuntimePtyWorktreeRecord | null {
    const snapshotPtyId = tab.ptyId ?? tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? null
    const paneKey = this.getMobileTerminalPaneKey(tab)
    if (snapshotPtyId) {
      const pty = this.ptysById.get(snapshotPtyId)
      if (!pty) {
        return null
      }
      // Why: persisted PTY ids can collide with unrelated provider ids after restart; only a matching spawn-time pane identity is safe to expose.
      if (this.mobileTerminalTabMatchesPty(worktreeId, tab, pty, paneKey)) {
        return pty
      }
      if (
        options.allowWorktreeOnlyMatch === true &&
        pty.worktreeId === worktreeId &&
        pty.tabId === null &&
        pty.paneKey === null
      ) {
        return pty
      }
      return null
    }
    const paneKeys = new Set([`${tab.parentTabId}:${tab.leafId}`])
    if (tab.leafId === `pane:${FIRST_PANE_ID}`) {
      paneKeys.add(`${tab.parentTabId}:${FIRST_PANE_ID}`)
    }
    for (const pty of this.ptysById.values()) {
      if (pty.tabId === tab.parentTabId && pty.paneKey && paneKeys.has(pty.paneKey)) {
        return pty
      }
    }
    return null
  }

  private getMobileTerminalPaneKey(tab: RuntimeMobileSessionTerminalTab): string {
    if (isTerminalLeafId(tab.leafId)) {
      return makePaneKey(tab.parentTabId, tab.leafId)
    }
    const legacyPaneId = /^pane:(\d+)$/.exec(tab.leafId)?.[1] ?? null
    return `${tab.parentTabId}:${legacyPaneId ?? tab.leafId}`
  }

  private mobileTerminalTabMatchesPty(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    pty: RuntimePtyWorktreeRecord,
    paneKey = this.getMobileTerminalPaneKey(tab)
  ): boolean {
    return pty.worktreeId === worktreeId && pty.tabId === tab.parentTabId && pty.paneKey === paneKey
  }

  // Why: group address resolution (Section 4.5) queries per-handle status and must not throw on stale handles; return null on any error.
  getAgentStatusForHandle(handle: string): string | null {
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      return this.getTerminalAgentStatusSnapshot(handle, ptyId).titleStatus
    } catch {
      return null
    }
  }

  getAgentStatusOrchestrationContextForPaneKey(
    paneKey: string
  ): AgentStatusOrchestrationContext | undefined {
    const handle = this.getTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      return undefined
    }
    return this.agentOrchestrationProjection.getForHandle(handle)
  }

  getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined {
    return this.getTerminalHandleForPaneKey(paneKey) ?? undefined
  }

  getAgentStatusLaunchConfigForPaneKey(
    paneKey: string,
    args?: { launchToken?: string }
  ): SleepingAgentLaunchConfig | undefined {
    const pty = this.getPtyRecordForPaneKey(paneKey)
    if (!pty?.launchConfig) {
      return undefined
    }
    if (pty.launchToken === null || pty.launchToken !== args?.launchToken) {
      return undefined
    }
    return copySleepingAgentLaunchConfig(pty.launchConfig)
  }

  private getTerminalHandleForPaneKey(paneKey: string): string | null {
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed ? this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId)) : undefined
    if (leaf?.ptyId && leaf.connected) {
      return this.issueHandle(leaf)
    }
    const panePty = this.getPtyRecordForPaneKey(paneKey)
    if (panePty?.connected) {
      return this.issuePtyHandle(panePty)
    }
    if (leaf?.ptyId) {
      return this.issueHandle(leaf)
    }
    return panePty ? this.issuePtyHandle(panePty) : null
  }

  private getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null {
    const parsed = parsePaneKey(paneKey)
    let leafPty: RuntimePtyWorktreeRecord | null = null
    if (parsed) {
      const leaf = this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId))
      const pty = leaf?.ptyId ? this.ptysById.get(leaf.ptyId) : undefined
      if (pty?.connected) {
        return pty
      }
      leafPty = pty ?? null
      for (const candidate of this.leaves.values()) {
        if (candidate.leafId !== parsed.leafId || !candidate.ptyId) {
          continue
        }
        const remintedPty = this.ptysById.get(candidate.ptyId)
        if (remintedPty?.connected) {
          return remintedPty
        }
        leafPty ??= remintedPty ?? null
      }
    }
    let newestMatch: RuntimePtyWorktreeRecord | null = null
    for (const pty of this.ptysById.values()) {
      const ptyPane = parsePaneKey(pty.paneKey ?? '')
      if (pty.paneKey === paneKey || (parsed && ptyPane && parsed.leafId === ptyPane.leafId)) {
        if (pty.connected) {
          return pty
        }
        newestMatch = pty
      }
    }
    return leafPty ?? newestMatch
  }

  private getPaneKeyForTerminalHandle(handle: string): string | null {
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty?.pty.paneKey) {
      return livePty.pty.paneKey
    }
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      return null
    }
    if (!isTerminalLeafId(record.leafId)) {
      return null
    }
    return makePaneKey(record.tabId, record.leafId)
  }

  private getWorktreeIdForTerminalHandle(handle: string): string | null {
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty?.pty.worktreeId) {
      return livePty.pty.worktreeId
    }
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      return null
    }
    return record.worktreeId
  }

  private setPtyManagementTitleFromObservedTitle(
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ): void {
    const trimmed = title?.trim()
    if (!trimmed) {
      return
    }
    if (isClaudeManagementTitle(trimmed)) {
      pty.managementTitle = trimmed
      pty.managementTitleAt = observedAt
      return
    }
    if (
      detectAgentStatusFromTitle(trimmed) !== null &&
      observedAt >= (pty.managementTitleAt ?? -1)
    ) {
      pty.managementTitle = null
      pty.managementTitleAt = null
    }
  }

  private nextTitleObservationSequence(): number {
    this.titleObservationSequence += 1
    return this.titleObservationSequence
  }

  // Why: title is the tightest agent-presence signal, but a Claude management title is negative evidence for task activity.
  async isTerminalRunningAgent(handle: string): Promise<boolean> {
    return this.terminalAgentPresence.isRunning(handle)
  }

  deliverPendingMessagesForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    let terminalHandle = handle
    if (!this.handles.has(terminalHandle)) {
      const runId = handle.startsWith('run:') ? handle.slice('run:'.length) : ''
      const coordinatorHandle = runId
        ? this._orchestrationDb?.getRun(runId)?.coordinator_handle
        : null
      if (!coordinatorHandle || !this.handles.has(coordinatorHandle)) {
        return
      }
      terminalHandle = coordinatorHandle
    }
    try {
      const { leaf } = this.getLiveLeafForHandle(terminalHandle)
      // Why lastAgentStatusObservedLive: a cold restore seeds `idle` from the
      // title persisted at snapshot time, so an agent that went busy across the
      // relaunch still reads idle until its first live frame. Pushing on that
      // would type a message plus Enter into a working agent. Seeded state waits
      // for a live observation to authorize it.
      if (leaf.lastAgentStatus === 'idle' && leaf.lastAgentStatusObservedLive) {
        this.deliverPendingMessages(leaf, { mailboxHandle: handle, reservedTypes })
      }
    } catch {
      // Unknown/stale handles can't be pointed now; the persisted message stays available via explicit check or future idle delivery.
    }
  }

  private scheduleRestoredMessageRepoints(): void {
    const handles = this._orchestrationDb?.getUndeliveredUnreadMailboxHandles?.() ?? []
    for (const handle of handles) {
      if (!handle.startsWith('dispatch:')) {
        this.mailPointerRepointScheduler.schedule(handle)
      }
    }
  }

  private repointPendingMessagesForHandle(handle: string): void {
    try {
      this.deliverPendingMessagesForHandle(handle)
    } catch {
      // The unref'd repair can outlive a test/runtime-owned database during shutdown.
    }
  }

  private deliverPendingMessagesForLeaf(leaf: RuntimeLeafRecord): void {
    this.deliverPendingMessages(leaf)
    if (!this._orchestrationDb) {
      return
    }
    const run = this._orchestrationDb.getCurrentRunForPane?.(`${leaf.tabId}:${leaf.leafId}`)
    if (run) {
      this.deliverPendingMessages(leaf, { mailboxHandle: `run:${run.id}` })
    }
  }

  private buildPtyTerminalSummary(
    pty: RuntimePtyWorktreeRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(pty.worktreeId)

    const pane = parsePaneKey(pty.paneKey ?? '')
    const orphaned = !pty.tabId || !pane || pane.tabId !== pty.tabId
    return {
      handle: this.issuePtyHandle(pty),
      ptyId: pty.ptyId,
      incarnationId: pty.incarnationId,
      orphaned,
      worktreeId: pty.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: orphaned ? `pty:${pty.ptyId}` : pty.tabId!,
      leafId: orphaned ? `pty:${pty.ptyId}` : pane.leafId,
      title: getLatestPtyTitle(pty),
      connected: pty.connected,
      writable: pty.connected,
      lastOutputAt: pty.lastOutputAt,
      preview: pty.preview
    }
  }

  private getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  } {
    this.assertGraphReady()
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      throw new Error('terminal_handle_stale')
    }
    if (record.rendererGraphEpoch !== this.rendererGraphEpoch) {
      throw new Error('terminal_handle_stale')
    }

    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf || leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration) {
      throw new Error('terminal_handle_stale')
    }
    return { record, leaf }
  }

  private getLivePtyForHandle(handle: string): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null {
    let record = this.handles.get(handle)
    if (!record) {
      const ptyId = [...this.handleByPtyId.entries()].find(
        ([, mappedHandle]) => mappedHandle === handle
      )?.[0]
      const pty = ptyId ? this.ptysById.get(ptyId) : null
      if (pty) {
        // Why: graph reload clears renderer handle records, but runtime-owned PTY handles remain the caller's control identity.
        this.issuePtyHandle(pty)
        record = this.handles.get(handle)
      }
    }
    if (!record || record.runtimeId !== this.runtimeId || !record.tabId.startsWith('pty:')) {
      return null
    }
    if (!record.ptyId) {
      return null
    }
    const pty = this.ptysById.get(record.ptyId)
    if (!pty || pty.ptyId !== record.ptyId) {
      return null
    }
    // Why: renderer adoption can race with CLI reads; keep ptyId → handle populated so summaries don't mint a second handle for the same terminal.
    this.handleByPtyId.set(record.ptyId, handle)
    return { record, pty }
  }

  private assertLiveTerminalHandleTargetsPty(handle: string, expectedPtyId: string): void {
    const runtimePty = this.getLivePtyForHandle(handle)
    if (runtimePty) {
      if (runtimePty.pty.ptyId !== expectedPtyId) {
        throw new Error('terminal_handle_stale')
      }
      return
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (leaf.ptyId !== expectedPtyId) {
      throw new Error('terminal_handle_stale')
    }
  }

  private readPtyTerminal(
    handle: string,
    pty: RuntimePtyWorktreeRecord,
    opts: { cursor?: number; limit?: number } = {}
  ): RuntimeTerminalRead {
    return readTerminalTail({
      handle,
      status: pty.connected ? 'running' : pty.lastExitCode !== null ? 'exited' : 'unknown',
      previewLines: pty.tailBuffer,
      completedLines: pty.tailTranscriptBuffer,
      partialLine: pty.tailPartialLine,
      completedLineCount: pty.tailLinesTotal,
      bufferTruncated: pty.tailTruncated,
      cursor: opts.cursor,
      limit: opts.limit
    })
  }

  private issueHandle(leaf: RuntimeLeafRecord): string {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const existingHandle = this.handleByLeafKey.get(leafKey)
    if (existingHandle) {
      const existingRecord = this.handles.get(existingHandle)
      if (
        existingRecord &&
        existingRecord.rendererGraphEpoch === this.rendererGraphEpoch &&
        existingRecord.ptyId === leaf.ptyId &&
        existingRecord.ptyGeneration === leaf.ptyGeneration
      ) {
        return existingHandle
      }
    }

    const preAllocatedHandle = this.adoptPreAllocatedHandle(leaf)
    const handle = preAllocatedHandle ?? `term_${randomUUID()}`
    if (!preAllocatedHandle) {
      this.syntheticTerminalHandles.add(handle)
    }
    if (this.handles.has(handle)) {
      return handle
    }
    this.handles.set(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.handleByLeafKey.set(leafKey, handle)
    return handle
  }

  private adoptPreAllocatedHandle(leaf: RuntimeLeafRecord): string | null {
    if (!leaf.ptyId) {
      return null
    }
    const preAllocated = this.handleByPtyId.get(leaf.ptyId)
    if (!preAllocated) {
      return null
    }
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    this.handles.set(preAllocated, {
      handle: preAllocated,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.handleByLeafKey.set(leafKey, preAllocated)
    return preAllocated
  }

  private issuePtyHandle(pty: RuntimePtyWorktreeRecord): string {
    const existingHandle =
      this.handleByPtyId.get(pty.ptyId) ?? this.findHandleForPtyRecord(pty.ptyId)
    if (existingHandle) {
      const existingRecord = this.handles.get(existingHandle)
      if (
        existingRecord &&
        existingRecord.runtimeId === this.runtimeId &&
        existingRecord.ptyId === pty.ptyId
      ) {
        this.handleByPtyId.set(pty.ptyId, existingHandle)
        return existingHandle
      }
    }

    const handle = existingHandle ?? `term_${randomUUID()}`
    if (!existingHandle) {
      this.syntheticTerminalHandles.add(handle)
    }
    const syntheticId = `pty:${pty.ptyId}`
    this.handles.set(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: pty.worktreeId,
      tabId: syntheticId,
      leafId: syntheticId,
      ptyId: pty.ptyId,
      ptyGeneration: 0
    })
    this.handleByPtyId.set(pty.ptyId, handle)
    return handle
  }

  private findHandleForPtyRecord(ptyId: string): string | null {
    for (const [handle, record] of this.handles) {
      if (
        record.runtimeId === this.runtimeId &&
        record.ptyId === ptyId &&
        record.tabId.startsWith('pty:')
      ) {
        return handle
      }
    }
    return null
  }

  private refreshWritableFlags(): void {
    for (const leaf of this.leaves.values()) {
      leaf.writable = this.graphStatus === 'ready' && leaf.connected && leaf.ptyId !== null
    }
  }

  private invalidateLeafHandle(leafKey: string): void {
    const handle = this.handleByLeafKey.get(leafKey)
    if (!handle) {
      return
    }
    this.handleByLeafKey.delete(leafKey)
    this.handles.delete(handle)
    this.syntheticTerminalHandles.delete(handle)
    this.rejectWaitersForHandle(handle, 'terminal_handle_stale')
  }

  private adoptFirstPtyForLeafHandle(
    leafKey: string,
    ptyId: string | null,
    ptyGeneration: number
  ): boolean {
    const handle = this.handleByLeafKey.get(leafKey)
    const record = handle ? this.handles.get(handle) : null
    if (!handle || !record || record.ptyId !== null || ptyId === null) {
      return false
    }
    this.handles.set(handle, { ...record, ptyId, ptyGeneration })
    return true
  }

  private rememberDetachedPreAllocatedLeaves(): void {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId && this.handleByPtyId.has(leaf.ptyId)) {
        // Why: ORCA_TERMINAL_HANDLE is an agent identity, so CLI control survives renderer graph loss while the PTY is alive.
        this.detachedPreAllocatedLeaves.set(leaf.ptyId, leaf)
      }
    }
  }

  private resolveExitWaiters(leaf: RuntimeLeafRecord): void {
    const handle = this.issueHandle(leaf)
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'exit') {
        this.resolveWaiter(waiter, buildTerminalWaitResult(handle, 'exit', leaf))
      } else {
        // Why: after exit, conditions like tui-idle can never be satisfied — reject now instead of spinning the poll until timeout on a dead process.
        this.removeWaiter(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  private resolveTuiIdleWaiters(leaf: RuntimeLeafRecord): void {
    const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'tui-idle') {
        this.resolveWaiter(waiter, buildTerminalWaitResult(handle, 'tui-idle', leaf))
      }
    }
  }

  private resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const handle = this.handleByPtyId.get(ptyId)
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'exit') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, 'exit', pty))
      } else {
        this.removeWaiter(waiter)
        waiter.reject(new Error('terminal_exited'))
      }
    }
  }

  private resolvePtyTuiIdleWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const handle = this.handleByPtyId.get(ptyId)
    if (!handle) {
      return
    }
    const waiters = this.terminalWaiters.get(handle)
    if (!waiters || waiters.size === 0) {
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.condition === 'tui-idle') {
        this.resolveWaiter(waiter, buildPtyTerminalWaitResult(handle, 'tui-idle', pty))
      }
    }
  }

  // Why: the primary OSC-title signal can't fire for daemon-hosted terminals (no PTY data through the runtime), so this fallback polls the renderer-synced tab title + foreground-process quiescence; self-cancels when the OSC path fires.
  private getAdoptedPtyExplicitIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== pty.ptyId) {
        continue
      }
      const title = leaf.paneTitle ?? this.tabs.get(leaf.tabId)?.title
      if (!title) {
        continue
      }
      const status = detectExplicitIdleStatusFromTitle(title)
      if (status !== null) {
        return status
      }
    }
    return null
  }

  // Why: the whole pointer→Enter span must be single-flight per pty. Triggers
  // landing mid-flight park their mailbox and re-run once on settle. The
  // flight object is the settle identity: a stale settle surviving an exit
  // retire must not clear a newer same-id flight or flush its parked trigger.
  private readonly messageDeliveryFlightsByPtyId = new Map<
    string,
    { enterTimer: ReturnType<typeof setTimeout> | null }
  >()

  private readonly parkedMessageRedeliveriesByPtyId = new Map<
    string,
    Map<string, { leaf: RuntimeLeafRecord; reservedTypes?: ReadonlySet<string> }>
  >()

  private settlePendingMessageDelivery(
    ptyId: string,
    flight: { enterTimer: ReturnType<typeof setTimeout> | null }
  ): void {
    if (this.messageDeliveryFlightsByPtyId.get(ptyId) !== flight) {
      return
    }
    this.messageDeliveryFlightsByPtyId.delete(ptyId)
    const parked = this.parkedMessageRedeliveriesByPtyId.get(ptyId)
    if (!parked) {
      return
    }
    this.parkedMessageRedeliveriesByPtyId.delete(ptyId)
    for (const [mailboxHandle, delivery] of parked) {
      this.deliverPendingMessages(delivery.leaf, {
        mailboxHandle,
        reservedTypes: delivery.reservedTypes
      })
    }
  }

  // Why: a dead session's Enter or watermark must not affect a same-id cold restore.
  private retirePendingMessageDeliveryForPty(ptyId: string): void {
    const flight = this.messageDeliveryFlightsByPtyId.get(ptyId)
    if (flight?.enterTimer != null) {
      clearTimeout(flight.enterTimer)
    }
    this.messageDeliveryFlightsByPtyId.delete(ptyId)
    this.parkedMessageRedeliveriesByPtyId.delete(ptyId)
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (handle) {
        this.lastPointedMessageSequenceByHandle.delete(handle)
        this.pointedMessageIdsByHandle.delete(handle)
        this.mailPointerRepointScheduler.schedule(handle)
      }
      const run = this._orchestrationDb?.getCurrentRunForPane?.(`${leaf.tabId}:${leaf.leafId}`)
      if (run) {
        this.lastPointedMessageSequenceByHandle.delete(`run:${run.id}`)
        this.pointedMessageIdsByHandle.delete(`run:${run.id}`)
        this.mailPointerRepointScheduler.schedule(`run:${run.id}`)
      }
    }
  }

  // Why: normal delivery stays event-driven; the bounded mailbox retry only repairs missed liveness edges.
  private deliverPendingMessages(
    leaf: RuntimeLeafRecord,
    options: {
      mailboxHandle?: string
      reservedTypes?: ReadonlySet<string>
      skipAbsenceProbe?: boolean
    } = {}
  ): void {
    if (!this._orchestrationDb) {
      return
    }

    const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
    if (!handle) {
      return
    }
    const mailboxHandle = options.mailboxHandle ?? handle

    if (leaf.ptyId && this.messageDeliveryFlightsByPtyId.has(leaf.ptyId)) {
      let parked = this.parkedMessageRedeliveriesByPtyId.get(leaf.ptyId)
      if (!parked) {
        parked = new Map()
        this.parkedMessageRedeliveriesByPtyId.set(leaf.ptyId, parked)
      }
      const priorReservedTypes = parked.get(mailboxHandle)?.reservedTypes
      const reservedTypes =
        priorReservedTypes || options.reservedTypes
          ? new Set([...(priorReservedTypes ?? []), ...(options.reservedTypes ?? [])])
          : undefined
      parked.set(mailboxHandle, { leaf, reservedTypes })
      return
    }

    // Why filter here and not at the trigger: the push reads every pending row,
    // not just the one that woke it, so a row a pull has claimed would be typed
    // into the pane AND returned by that pull's check. Live waiters cover the
    // still-blocked case; reservedTypes carries the notify-time snapshot for a
    // waiter resolved later in the same drain, which is already gone from the map.
    const unread = this._orchestrationDb
      .getUndeliveredUnreadMessages(mailboxHandle)
      .filter(
        (message) =>
          !options.reservedTypes?.has(message.type) &&
          !this.messageWaiters.typeHasLiveWaiter(mailboxHandle, message.type)
      )
    if (unread.length === 0) {
      return
    }

    const watermark = this.lastPointedMessageSequenceByHandle.get(mailboxHandle) ?? -1
    const priorPointedIds = this.pointedMessageIdsByHandle.get(mailboxHandle)
    if (
      !unread.some(
        (message) => message.sequence > watermark || priorPointedIds?.has(message.id) !== true
      )
    ) {
      return
    }

    if (!leaf.writable || !leaf.ptyId) {
      return
    }
    const newestSequence = unread.at(-1)?.sequence
    if (newestSequence === undefined) {
      return
    }

    if (
      !options.skipAbsenceProbe &&
      this.ptyController?.probePtyLiveness &&
      !this.controllerKnowsPtyIsLive(leaf.ptyId)
    ) {
      // Why: a fire-and-forget write to a prior process's ptyId reports success
      // and would mark these delivered while losing them. Proven absence keeps
      // them queued for a future surface; unknown liveness still delivers.
      const probedPtyId = leaf.ptyId
      // Why: triggers arriving mid-probe must not each arm a continuation — the
      // Every continuation would re-read the same unread rows. The single armed
      // continuation re-reads fresh rows when it fires, so nothing is lost.
      if (this.probeDeferredDeliveryPtyIds.has(probedPtyId)) {
        return
      }
      this.probeDeferredDeliveryPtyIds.add(probedPtyId)
      void this.isLeafPtyProvenAbsent(probedPtyId)
        .then((absent) => {
          this.probeDeferredDeliveryPtyIds.delete(probedPtyId)
          if (!absent && leaf.ptyId === probedPtyId) {
            // Why a macrotask and not the stale reservation snapshot: a `remote:`
            // pty answers the probe null before its first await, so this chain can
            // settle in microtasks and overtake the resumption of a check resolved
            // meanwhile — that check's waiter is already out of the map and its
            // rows are not yet read, so the push would inject what it returns.
            // Yielding the turn lets every queued check mark its rows read first;
            // re-reading then (rather than replaying a reservation this probe may
            // have outlived) is what keeps an orphaned row from stranding.
            setTimeout(() => {
              // Why current state, not the closure: the gate that authorized this
              // push ran before the probe. A same-id cold restore inside the probe
              // window keeps ptyId identical and makes the leaf writable again, so
              // an id-only check would type the pointer plus Enter into a process
              // whose idle was never observed. Re-read the live-idle gate.
              const currentLeaf = this.leaves.get(this.getLeafKey(leaf.tabId, leaf.leafId))
              if (
                currentLeaf?.ptyId === probedPtyId &&
                currentLeaf.lastAgentStatus === 'idle' &&
                currentLeaf.lastAgentStatusObservedLive
              ) {
                this.deliverPendingMessages(currentLeaf, {
                  mailboxHandle,
                  skipAbsenceProbe: true
                })
              }
            }, 0)
          }
        })
        .catch(() => {
          this.probeDeferredDeliveryPtyIds.delete(probedPtyId)
        })
      return
    }

    const deliveryPtyId = leaf.ptyId
    const flight: { enterTimer: ReturnType<typeof setTimeout> | null } = { enterTimer: null }
    this.messageDeliveryFlightsByPtyId.set(deliveryPtyId, flight)
    // Why: every sync outcome — failed write, Cursor branch, or a throw —
    // must end the flight here, or a leaked flag parks this pty's deliveries
    // forever. Only an armed Enter hands settling to its own callback.
    let settlesInEnterCallback = false
    try {
      const payload = formatMessagePointer(unread.length)
      const wrote = this.ptyController?.write(deliveryPtyId, payload) ?? false
      if (!wrote) {
        return
      }
      this.lastPointedMessageSequenceByHandle.set(
        mailboxHandle,
        Math.max(watermark, newestSequence)
      )
      const pointedIdsAfterWrite =
        this.pointedMessageIdsByHandle.get(mailboxHandle) ?? new Set<string>()
      for (const message of unread) {
        pointedIdsAfterWrite.add(message.id)
      }
      this.pointedMessageIdsByHandle.set(mailboxHandle, pointedIdsAfterWrite)

      const tabTitle = this.tabs.get(leaf.tabId)?.title
      if (isCursorAgentOrchestrationTarget(leaf, tabTitle)) {
        // Why: Cursor Agent treats injected PTY text as editable prompt input, so submitting must stay under user control.
        return
      }

      // Why: agent TUIs can swallow a \r in the same PTY write; submit separately after a delay.
      flight.enterTimer = setTimeout(() => {
        try {
          // Why current state, not the closure: graph resync replaces leaf
          // objects, so the captured record can read writable=true after the
          // pty died, and an exit retire may have superseded this flight.
          if (this.messageDeliveryFlightsByPtyId.get(deliveryPtyId) !== flight) {
            return
          }
          const currentLeaf = this.leaves.get(this.getLeafKey(leaf.tabId, leaf.leafId))
          if (!currentLeaf || currentLeaf.ptyId !== deliveryPtyId || !currentLeaf.writable) {
            return
          }
          this.ptyController?.write(deliveryPtyId, '\r')
        } catch {
          // Terminal may have closed during the delay; mail remains queued for check.
        } finally {
          // Why finally: every outcome — submit, refusal, throw — ends the flight,
          // and settle re-runs any trigger parked during it so nothing strands.
          this.settlePendingMessageDelivery(deliveryPtyId, flight)
        }
      }, 500)
      settlesInEnterCallback = true
    } finally {
      if (!settlesInEnterCallback) {
        this.settlePendingMessageDelivery(deliveryPtyId, flight)
      }
    }
  }

  private resolveWaiter(waiter: TerminalWaiter, result: RuntimeTerminalWait): void {
    this.terminalWaiters.resolve(waiter, result)
  }

  private rejectWaitersForHandle(handle: string, code: string): void {
    this.terminalWaiters.rejectHandle(handle, code)
  }

  private rejectAllWaiters(code: string): void {
    this.terminalWaiters.rejectAll(code)
  }

  private removeWaiter(waiter: TerminalWaiter): void {
    this.terminalWaiters.remove(waiter)
  }

  private getLeafKey(tabId: string, leafId: string): string {
    return `${tabId}::${leafId}`
  }

  // ── Linear integration ──

  readonly linearCommands = new RuntimeLinearCommands({
    runtimeAvailable: () => this.store !== null,
    showTerminal: (handle) => this.showTerminal(handle),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    listResolvedWorktrees: () => this.listResolvedWorktrees(),
    setWorktreeMeta: (worktreeId, meta) => this.store!.setWorktreeMeta(worktreeId, meta),
    emitClientEvent: (event) => this.emitClientEvent(event)
  })
  readonly linearBrowseCommands = new RuntimeLinearBrowseCommands()

  private getAuthoritativeWindow(): BrowserWindow {
    const win = this.getAvailableAuthoritativeWindow()
    if (!win || win.isDestroyed()) {
      throw new Error('No renderer window available')
    }
    return win
  }

  private getAvailableAuthoritativeWindow(): BrowserWindow | null {
    if (this.authoritativeWindowId === null) {
      return null
    }
    if (!BrowserWindow?.fromId) {
      return null
    }
    const win = BrowserWindow.fromId(this.authoritativeWindowId)
    return win && !win.isDestroyed() ? win : null
  }
}

type OrcaRuntimeServiceExport = RuntimeCommandSurfaceHost<OrcaRuntimeService>

const OrcaRuntimeServiceExport = OrcaRuntimeService as unknown as {
  new (...args: ConstructorParameters<typeof OrcaRuntimeService>): OrcaRuntimeServiceExport
  readonly prototype: OrcaRuntimeServiceExport
}

export { OrcaRuntimeServiceExport as OrcaRuntimeService }

installRuntimeLinearCommandSurface(OrcaRuntimeServiceExport.prototype)

const WAIT_BLOCKED_CHECK_MIN_INTERVAL_MS = 50
// Why: chunks that could complete an actionable prompt bypass the throttle so blocked stamps stay immediate; scanned over the new chunk + short carry, never the whole window.
const WAIT_BLOCKED_KEYWORD_PATTERN =
  /press enter|press t to trust|do you trust|trust this|trusted workspace|update available|choose working directory|codex just got an upgrade|hooks need review/
const WAIT_BLOCKED_KEYWORD_CARRY_CHARS = 31
export const AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS = 8_000
const VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS = 750
const VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS = 1_000
const DEFAULT_REPO_SEARCH_REFS_LIMIT = 25
const DEFAULT_TERMINAL_LIST_LIMIT = 200
const DEFAULT_WORKTREE_LIST_LIMIT = 200
const DEFAULT_WORKTREE_PS_LIMIT = 200
const DISCONNECTED_PTY_RECORD_MAX = 128
const RESOLVED_WORKTREE_CACHE_TTL_MS = 1000
const WORKTREE_SCAN_CACHE_TTL_MS = 30_000
// Why: agent-scratch repos don't need 30s freshness — the steady-state scan
// fan-out was measured at ~128 git execs/min on real installs, mostly against
// these (crash-cluster diagnostics, 2026-07).
const WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS = 5 * 60_000
// Why: the Git-admin fingerprint reads HEAD and its ref tip exactly, but sparse-checkout pattern
// edits are invisible to it and a tip living in packed-refs or reftable only gets an mtime + size
// stamp, so a real scan still runs on this interval even while the probe reports "unchanged".
export const WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS = 5 * 60_000
// Why reserved rather than spent on the probe: when the probe expires the caller still has to run
// `git worktree list` and answer inside the same budget, so the fallback needs its own room. Sized
// for a healthy Git on a busy host, well above the tens of milliseconds a warm list costs.
const WORKTREE_SCAN_FALLBACK_ALLOWANCE_MS = 1500
// Why derived from the caller's budget instead of a generous absolute: this wait runs *inside*
// RESOLVED_WORKTREE_REPO_TIMEOUT_MS, so outlasting it buys nothing — the caller has already given up
// and restored persisted rows — while turning a reusable scan into a full-budget stall that repeats
// on every TTL expiry. Subtracting keeps that invariant true by construction if either side moves.
// Why not smaller: the probe reads a subset of what the fallback scan reads, so a probe too slow to
// fit is a scan that will not fit either — waiting is strictly better right up to the budget.
// Expiring yields `null`, the existing "cannot prove unchanged" sentinel, so a real scan runs.
export const WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS =
  RESOLVED_WORKTREE_REPO_TIMEOUT_MS - WORKTREE_SCAN_FALLBACK_ALLOWANCE_MS

export function resolveWorktreeScanCacheTtlMs(repo: Pick<Repo, 'path' | 'connectionId'>): number {
  return !repo.connectionId && isAgentScratchRepoRootPath(repo.path)
    ? WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS
    : WORKTREE_SCAN_CACHE_TTL_MS
}
const PTY_CONTROLLER_LIST_TIMEOUT_MS = 3000
// Why: the renderer waits 15s; leave room for the verified failure response and release the spawn fence before its caller times out.
const WORKTREE_TERMINAL_SLEEP_TIMEOUT_MS = 12_000

async function waitForWorktreeTerminalMutation(
  previous: Promise<void>,
  deadline?: number
): Promise<void> {
  if (deadline === undefined) {
    await previous
    return
  }
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error('terminal_worktree_sleep_timeout')
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('terminal_worktree_sleep_timeout')),
          remainingMs
        )
      })
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

// Why: tui-idle needs OSC title transitions; an unsupported CLI/plain shell never fires one, so cap at 5min to avoid indefinite hangs.
const TUI_IDLE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const TUI_IDLE_POLL_INTERVAL_MS = 2000
const TUI_IDLE_QUIESCENCE_MS = 3000
// Clamp for mobileAutoRestoreFitMs: floor above the legacy 300ms debounce, 1h ceiling (a held PTY beyond that is "I forgot", not intentional).
const MOBILE_AUTO_RESTORE_FIT_MIN_MS = 5_000
const MOBILE_AUTO_RESTORE_FIT_MAX_MS = 60 * 60 * 1000
