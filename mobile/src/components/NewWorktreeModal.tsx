import { useState, useEffect, useMemo, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  Switch,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Keyboard
} from 'react-native'
import { ChevronDown, ChevronUp, Monitor } from 'lucide-react-native'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { BottomDrawerModalHost } from './bottom-drawer-modal-host'
import { useNewWorktreeDrawerNavigation } from './use-new-worktree-drawer-navigation'
import { PickerListDrawer } from './PickerListDrawer'
import { MobileAgentIcon } from './MobileAgentIcon'
import { getSuggestedCreatureName } from './worktree-name-suggestion'
import { useRetiredWorktreeNames } from '../worktree/use-retired-worktree-names'
import { repoColor } from '../worktree/repo-color'
import { deriveWorkspaceSshGate, workspaceSshStatusLabel } from '../tasks/workspace-ssh-gate'
import {
  isSetupHookTrusted,
  normalizeSetupHookTrust,
  wasSetupHookPreviouslyApproved,
  type SetupHookTrust
} from '../tasks/setup-hook-trust'
import { isMobileTuiAgentEnabled } from '../tasks/mobile-tui-agents'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import { getProjectIdentityKey } from '../../../src/shared/project-host-setup-projection'
import {
  NEW_WORKTREE_AGENT_OPTIONS as AGENT_OPTIONS,
  NEW_WORKTREE_BLANK_AGENT as BLANK_TERMINAL,
  pickPreferredNewWorktreeAgent,
  resolveNewWorktreeAgentSelection,
  type NewWorktreeAgentOption as AgentOption
} from './new-worktree-agent-selection'
import { getCachedRepos, setCachedRepos } from '../cache/repo-cache'
import { useLastVisitedWorktreeRepoId } from '../worktree/use-last-visited-worktree-repo'
import {
  getMobileNewWorkspaceDialogEligibleRepos,
  refreshMobileNewWorkspaceDialogSelectedRepo,
  resolveMobileNewWorkspaceDialogRepoId
} from '../worktree/new-workspace-dialog-repo-selection'
import { useNewWorktreeRuntimeCapabilities } from '../tasks/worktree-create-capability'
import { normalizeWorkspaceAgent } from '../tasks/workspace-agent-selection'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  type TaskProvider
} from '../tasks/mobile-task-providers'
import { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import type { SmartModeAvailabilityInput } from '../tasks/mobile-smart-source-modes'
import { deriveRepoSlug, type PasteRepoCandidate } from '../tasks/smart-source-paste-intent'
import { shouldPreserveWorkspaceSourceOnRepoChange } from '../../../src/shared/new-workspace/workspace-source'
import { getComposerRepoWorktreeBranches } from '../../../src/shared/composer-branch-selection'
import { SmartWorkspaceSourceField } from './SmartWorkspaceSourceField'
import { SmartWorkspaceSourceDrawer } from './SmartWorkspaceSourceDrawer'
import { SmartWorkspaceAdvancedFields } from './SmartWorkspaceAdvancedFields'
import { SetupHookTrustDrawer, type SetupTrustPrompt } from './SetupHookTrustDrawer'
import type {
  HostWorkspaceCreationOperations,
  NewWorkspaceRepository,
  NewWorkspaceRuntimeSettings
} from '../worktree/host-workspace-creation-operations'
import type { HostScreenShellOperations } from '../worktree/host-screen-shell-operations'
import { NewWorktreeProjectTargetFields } from './NewWorktreeProjectTargetFields'
import {
  buildNewWorkspaceProjectOptions,
  buildNewWorkspaceRunTargetOptions,
  getNewWorkspaceRunTarget
} from './new-workspace-project-targets'

type Repo = NewWorkspaceRepository

type SetupDecision = 'inherit' | 'run' | 'skip'
type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
type RuntimeSettings = NewWorkspaceRuntimeSettings

type SetupHookDetails = {
  repoId: string
  command: string | null
  source: string | null
  trust: SetupHookTrust | null
  runPolicy: SetupRunPolicy
}

type DetectedAgentIdsState = {
  connectionId: string | null
  ids: Set<string>
}

type CreateOptions = {
  setupOverride?: Exclude<SetupDecision, 'inherit'>
  approvedSetupContentHash?: string
}

function repoBadgeColor(repo: Repo | null): string {
  return repo?.badgeColor || repoColor(repo?.displayName ?? 'repository')
}

// ── Main modal ──────────────────────────────────────────────────────

type Props = {
  visible: boolean
  operations: HostWorkspaceCreationOperations | null
  hostId?: string
  // Why: existing worktree paths from the host so we can pick a unique
  // marine-creature default when the user leaves the name blank, matching
  // the desktop UI's behavior. The "already exists locally" collision is
  // on the on-disk directory basename, so paths (not displayNames) are
  // what the suggestion logic must dedupe against.
  existingWorktreePaths?: readonly string[]
  existingWorktrees?: readonly { repoId: string; branch: string }[]
  openExternalUrl: HostScreenShellOperations['openExternalUrl']
  onCreated: (worktreeId: string, name: string) => void
  onClose: () => void
}

export function NewWorktreeModal({
  visible,
  operations,
  hostId,
  existingWorktreePaths,
  existingWorktrees,
  openExternalUrl,
  onCreated,
  onClose
}: Props) {
  // Why: each drawer opening is a fresh form session; remounting resets local
  // form state before paint instead of clearing it in a visible-prop Effect.
  const [session, setSession] = useState({ openEpoch: 0, visible })
  if (session.visible !== visible) {
    setSession({
      openEpoch: visible ? session.openEpoch + 1 : session.openEpoch,
      visible
    })
  }

  return (
    <NewWorktreeModalContent
      key={`${session.openEpoch}:${hostId}`}
      visible={visible}
      operations={operations}
      hostId={hostId}
      existingWorktreePaths={existingWorktreePaths}
      existingWorktrees={existingWorktrees}
      openExternalUrl={openExternalUrl}
      onCreated={onCreated}
      onClose={onClose}
    />
  )
}

function NewWorktreeModalContent({
  visible,
  operations,
  hostId,
  existingWorktreePaths,
  existingWorktrees,
  openExternalUrl,
  onCreated,
  onClose
}: Props) {
  const [initialRepos] = useState(() => (hostId ? (getCachedRepos(hostId) as Repo[] | null) : null))
  const [repos, setRepos] = useState<Repo[]>(initialRepos ?? [])
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  // Why: a deleted workspace's directory can still hold agent conversation state keyed by cwd, so
  // its name must never be suggested again. Fetched per selected repo while the sheet is open.
  // Keyed on the path set rather than the array so a poll that changes nothing does not refetch.
  const retiredNamesRefreshKey = useMemo(
    () => [...(existingWorktreePaths ?? [])].sort().join('\0'),
    [existingWorktreePaths]
  )
  const readRetiredWorktreeNames = useMemo(
    () => (operations ? (repoId: string) => operations.readRetiredWorktreeNames(repoId) : null),
    [operations]
  )
  const retiredWorktreeNames = useRetiredWorktreeNames(
    readRetiredWorktreeNames,
    selectedRepo?.id,
    retiredNamesRefreshKey
  )
  const { drawerView, formSheetVisible, formSheetInteractive, transitionDrawer, openSourceDrawer } =
    useNewWorktreeDrawerNavigation(visible)
  const createInFlightRef = useRef(false)
  const setupTrustActionInFlightRef = useRef(false)
  const [selectedAgentState, setSelectedAgent] = useState<AgentOption>(AGENT_OPTIONS[0]!)
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null)
  const [detectedAgentIdsState, setDetectedAgentIdsState] = useState<DetectedAgentIdsState | null>(
    null
  )
  const [agentOverriddenState, setAgentOverridden] = useState(false)
  const [sshState, setSshState] = useState<SshConnectionState | null>(null)
  const [sshConnectingTargetId, setSshConnectingTargetId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [availableProviders, setAvailableProviders] = useState<TaskProvider[]>([])
  const { tasksSupported, hostPlatform, getWorktreeCreateCutoverSupport } =
    useNewWorktreeRuntimeCapabilities(operations, visible)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [setupHookDetails, setSetupHookDetails] = useState<SetupHookDetails | null>(null)
  const [trustedOrcaHooks, setTrustedOrcaHooks] = useState<PersistedTrustedOrcaHooks>({})
  const [setupTrustPrompt, setSetupTrustPrompt] = useState<SetupTrustPrompt | null>(null)
  const [setupDecisionChoice, setSetupDecisionChoice] = useState<Exclude<
    SetupDecision,
    'inherit'
  > | null>(null)
  const [runSetup, setRunSetup] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(initialRepos == null)
  const lastVisitedRepo = useLastVisitedWorktreeRepoId(hostId, visible)
  const selectedRepoWorktreeBranches = useMemo(
    () => getComposerRepoWorktreeBranches(existingWorktrees ?? [], selectedRepo?.id ?? null),
    [existingWorktrees, selectedRepo]
  )

  const composer = useMobileComposerSource({
    operations,
    selectedRepoId: selectedRepo?.id ?? null,
    worktreeBranches: selectedRepoWorktreeBranches,
    onError: setError
  })

  const selectedRepoConnectionId = selectedRepo?.connectionId ?? null
  const sshGate = deriveWorkspaceSshGate({
    connectionId: selectedRepoConnectionId,
    state: sshState,
    connecting: sshConnectingTargetId === selectedRepoConnectionId
  })
  const detectedAgentIds =
    detectedAgentIdsState?.connectionId === selectedRepoConnectionId &&
    (selectedRepoConnectionId === null || sshGate.status === 'connected')
      ? detectedAgentIdsState.ids
      : null
  const activeSetupHookDetails =
    selectedRepo && setupHookDetails?.repoId === selectedRepo.id ? setupHookDetails : null
  const setupCommand = activeSetupHookDetails?.command ?? null
  const setupSource = activeSetupHookDetails?.source ?? null
  const setupTrust = activeSetupHookDetails?.trust ?? null
  const setupRunPolicy = activeSetupHookDetails?.runPolicy ?? 'run-by-default'
  const selectedAgentResolution = resolveNewWorktreeAgentSelection({
    visible,
    selectedAgent: selectedAgentState,
    agentOverridden: agentOverriddenState,
    runtimeSettings,
    detectedAgentIds
  })
  // Why: agent preference repair is pure render dataflow; doing it here
  // avoids a stale selected-agent commit while preserving user overrides.
  if (
    selectedAgentState.id !== selectedAgentResolution.selectedAgent.id ||
    agentOverriddenState !== selectedAgentResolution.agentOverridden
  ) {
    setSelectedAgent(selectedAgentResolution.selectedAgent)
    setAgentOverridden(selectedAgentResolution.agentOverridden)
  }
  const selectedAgent = selectedAgentResolution.selectedAgent

  const selectedRepoIsGit = selectedRepo ? selectedRepo.kind !== 'folder' : true
  const sourceAvailability: SmartModeAvailabilityInput = {
    textOnly: selectedRepo != null && !selectedRepoIsGit,
    tasksSupported,
    hasRepo: selectedRepo != null,
    githubAvailable: availableProviders.includes('github'),
    gitlabAvailable: availableProviders.includes('gitlab'),
    linearAvailable: availableProviders.includes('linear')
  }
  const pasteRepos = useMemo<PasteRepoCandidate[]>(
    () =>
      repos.map((repo) => ({
        id: repo.id,
        displayName: repo.displayName,
        slug: deriveRepoSlug(repo)
      })),
    [repos]
  )

  useEffect(() => {
    if (!visible || !lastVisitedRepo.loaded || selectedRepo || repos.length === 0) {
      return
    }
    const eligibleRepos = getMobileNewWorkspaceDialogEligibleRepos(repos)
    const preferredRepoId = resolveMobileNewWorkspaceDialogRepoId({
      eligibleRepos,
      activeRepoId: lastVisitedRepo.repoId
    })
    const preferredRepo = repos.find((repo) => repo.id === preferredRepoId) ?? null
    if (preferredRepo) {
      setSelectedRepo(preferredRepo)
    }
  }, [lastVisitedRepo.loaded, lastVisitedRepo.repoId, repos, selectedRepo, visible])

  useEffect(() => {
    if (!visible || !operations) {
      return
    }
    let stale = false

    if (repos.length === 0) {
      setLoading(true)
    }

    void operations
      .listRepositories()
      .then((nextRepos) => {
        if (stale) {
          return
        }
        setRepos(nextRepos)
        if (hostId) {
          setCachedRepos(hostId, nextRepos)
        }
        setSelectedRepo((current) => {
          // Why: the optimistic cache can include repos removed before the
          // fresh repo.list returns; never create against a stale repo id.
          return refreshMobileNewWorkspaceDialogSelectedRepo(nextRepos, current)
        })
      })
      // Why (F10): a dropped connection rejects this call — keep the last-good list (the content
      // remounts with the new host's cache when the client changes) instead of emptying the picker.
      .catch(() => undefined)
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })

    void (async () => {
      // Why: settle each RPC independently so a flaky availability probe (e.g. a
      // linear.status timeout, which rejects rather than resolving {ok:false})
      // can't discard the already-resolved critical settings/ui results.
      const probes = Promise.allSettled([
        operations.isGitLabCliInstalled(),
        operations.isLinearConnected()
      ])
      // Why: hydrate settings/trust the moment their own RPCs settle — gating them
      // on the probes (a first-open preflight.check can take seconds) widens the
      // window where an already-trusted setup hook spuriously re-prompts on create.
      const [settingsRes, uiRes] = await Promise.allSettled([
        operations.readRuntimeSettings(),
        operations.readTrustedHooks()
      ])
      if (stale) {
        return
      }

      const settingsValue = settingsRes.status === 'fulfilled' ? settingsRes.value : null
      if (settingsValue) {
        setRuntimeSettings(settingsValue)
      }
      if (uiRes.status === 'fulfilled') {
        setTrustedOrcaHooks(uiRes.value)
      }

      const [preflightRes, linearRes] = await probes
      if (stale) {
        return
      }
      const glabInstalled = preflightRes.status === 'fulfilled' && preflightRes.value
      const linearConnected = linearRes.status === 'fulfilled' && linearRes.value
      const visibleProviders = normalizeVisibleTaskProviders(settingsValue?.visibleTaskProviders)
      setAvailableProviders(
        // Drop filterAvailableTaskProviders' forced 'github' fallback when the user
        // hid GitHub; the Branch tab always guarantees at least one tab remains.
        filterAvailableTaskProviders(visibleProviders, {
          gitlabInstalled: glabInstalled,
          linearConnected
        }).filter((provider) => visibleProviders.includes(provider))
      )
    })()
    return () => {
      stale = true
    }
  }, [visible, operations, hostId])

  useEffect(() => {
    if (!visible || !operations || !selectedRepoConnectionId) {
      return
    }
    let stale = false
    void operations
      .readSshState(selectedRepoConnectionId)
      .then((state) => {
        if (stale) {
          return
        }
        setSshState(state)
      })
      .catch((err) => {
        if (!stale) {
          setSshState({
            targetId: selectedRepoConnectionId,
            status: 'error',
            error: err instanceof Error ? err.message : 'Failed to read SSH connection state.',
            reconnectAttempt: 0
          })
        }
      })
    return () => {
      stale = true
    }
  }, [operations, selectedRepoConnectionId, visible])

  useEffect(() => {
    if (!visible || !operations) {
      return
    }
    if (selectedRepoConnectionId && sshGate.status !== 'connected') {
      return
    }
    let stale = false
    void (async () => {
      try {
        const agentIds = await operations.detectAgents(selectedRepoConnectionId)
        if (stale) {
          return
        }
        setDetectedAgentIdsState({
          connectionId: selectedRepoConnectionId,
          ids: new Set(agentIds)
        })
      } catch {
        if (!stale) {
          setDetectedAgentIdsState({ connectionId: selectedRepoConnectionId, ids: new Set() })
        }
      }
    })()
    return () => {
      stale = true
    }
  }, [operations, selectedRepoConnectionId, sshGate.status, visible])

  useEffect(() => {
    if (!operations || !selectedRepo) {
      return
    }
    let stale = false
    void (async () => {
      try {
        const result = await operations.readRepoHooks(selectedRepo.id)
        if (stale) {
          return
        }
        const cmd = result.hooks?.scripts?.setup?.trim() || null
        const policy = result.setupRunPolicy ?? 'run-by-default'
        setSetupHookDetails({
          repoId: selectedRepo.id,
          command: cmd,
          source: result.source,
          trust: normalizeSetupHookTrust(result.setupTrust),
          runPolicy: policy
        })
        setSetupDecisionChoice(null)
        setRunSetup(policy !== 'skip-by-default')
        if (cmd && policy === 'ask') {
          setShowAdvanced(true)
        }
      } catch {
        if (!stale) {
          setSetupHookDetails({
            repoId: selectedRepo.id,
            command: null,
            source: null,
            trust: null,
            runPolicy: 'run-by-default'
          })
          setSetupDecisionChoice(null)
        }
      }
    })()
    return () => {
      stale = true
    }
  }, [operations, selectedRepo])

  async function connectSelectedSshRepo(): Promise<void> {
    if (!operations || !selectedRepoConnectionId) {
      return
    }
    setSshConnectingTargetId(selectedRepoConnectionId)
    setSshState({
      targetId: selectedRepoConnectionId,
      status: 'connecting',
      error: null,
      reconnectAttempt: 0
    })
    try {
      setSshState(await operations.connectSsh(selectedRepoConnectionId))
    } catch (err) {
      setSshState({
        targetId: selectedRepoConnectionId,
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to connect to SSH repository.',
        reconnectAttempt: 0
      })
    } finally {
      setSshConnectingTargetId((current) => (current === selectedRepoConnectionId ? null : current))
    }
  }

  async function handleCreate(options: CreateOptions = {}) {
    if (!operations || !selectedRepo || createInFlightRef.current) {
      return
    }
    createInFlightRef.current = true
    setCreating(true)
    setError('')

    try {
      if (sshGate.requiresConnection) {
        setError(`Connect ${selectedRepo.displayName} before creating a workspace.`)
        return
      }
      let latestRuntimeSettings = runtimeSettings
      try {
        const settings = await operations.readRuntimeSettings()
        latestRuntimeSettings = settings
        setRuntimeSettings(settings)
      } catch {
        // Best-effort refresh; the runtime validates the same setting before spawning.
      }
      if (
        selectedAgent.id !== '__blank__' &&
        !isMobileTuiAgentEnabled(selectedAgent.id, latestRuntimeSettings?.disabledTuiAgents)
      ) {
        setSelectedAgent(pickPreferredNewWorktreeAgent(latestRuntimeSettings, detectedAgentIds))
        setAgentOverridden(false)
        setError('Selected agent is disabled. Choose an enabled agent before creating.')
        return
      }

      // Why: blank name field — match desktop behavior by computing the
      // next available marine-creature name at submit time and passing it
      // to the server. The server's worktree.create rejects empty/invalid
      // names, so we must generate one client-side rather than letting the
      // server invent one. The pre-flight basename dedupe is only a hint;
      // the authoritative collision is checked server-side against git
      // branches/remotes/PRs, so we also retry-with-suffix on conflict.
      const trimmedName = composer.name.trim()
      const baseName =
        trimmedName ||
        getSuggestedCreatureName(existingWorktreePaths ?? [], undefined, retiredWorktreeNames)

      let setupDecision: SetupDecision = 'inherit'
      if (setupCommand) {
        if (options.setupOverride) {
          setupDecision = options.setupOverride
        } else if (setupRunPolicy === 'ask') {
          if (!setupDecisionChoice) {
            setError('Choose whether to run the setup script.')
            return
          }
          setupDecision = setupDecisionChoice
        } else {
          setupDecision = runSetup ? 'run' : 'skip'
        }
      }
      if (
        setupDecision === 'run' &&
        setupTrust &&
        setupTrust.contentHash !== options.approvedSetupContentHash &&
        !isSetupHookTrusted(trustedOrcaHooks, selectedRepo.id, setupTrust.contentHash)
      ) {
        // Why: desktop prompts before running repo-owned orca.yaml setup hooks.
        // Mobile stores the same trust hash so approvals carry across surfaces.
        setSetupTrustPrompt({
          repoId: selectedRepo.id,
          repoName: selectedRepo.displayName,
          scriptContent: setupTrust.scriptContent,
          contentHash: setupTrust.contentHash,
          previouslyApproved: wasSetupHookPreviouslyApproved(trustedOrcaHooks, selectedRepo.id)
        })
        transitionDrawer('trust')
        return
      }

      const agentChoice = normalizeWorkspaceAgent(selectedAgent.id) ?? 'blank'
      const trimmedNote = note.trim() || undefined
      const createSelection = composer.createSelection
      const result = createSelection
        ? await operations.createWorkspaceFromSource({
            selection: createSelection,
            targetRepoId: selectedRepo.id,
            setupDecision,
            agentChoice,
            workspaceName: trimmedName || undefined,
            note: trimmedNote,
            nameIsAutoManaged: composer.isNameAutoManaged,
            worktreeCreateIdempotency: getWorktreeCreateCutoverSupport()
          })
        : await operations.createBlankWorkspace({
            repoId: selectedRepo.id,
            baseName,
            agentChoice,
            // `baseName` is the suggestion exactly when the user typed nothing, so no identity check
            // is needed — desktop's seeded composer needs one (useComposerState `nameWasGenerated`).
            nameWasGenerated: !trimmedName,
            comment: trimmedNote,
            setupDecision,
            worktreeCreateIdempotency: getWorktreeCreateCutoverSupport()
          })
      if ('error' in result) {
        setError(result.error)
        return
      }
      onClose()
      onCreated(result.worktreeId, result.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create workspace')
    } finally {
      createInFlightRef.current = false
      setCreating(false)
    }
  }

  const needsSetupChoice = Boolean(setupCommand) && setupRunPolicy === 'ask'
  const canCreate =
    selectedRepo != null &&
    !creating &&
    !sshGate.requiresConnection &&
    (!needsSetupChoice || setupDecisionChoice != null)
  const visibleAgentOptions =
    detectedAgentIds === null
      ? AGENT_OPTIONS.filter(
          (agent) =>
            agent.id !== '__blank__' &&
            isMobileTuiAgentEnabled(agent.id, runtimeSettings?.disabledTuiAgents)
        )
      : AGENT_OPTIONS.filter(
          (agent) =>
            agent.id !== '__blank__' &&
            detectedAgentIds.has(agent.id) &&
            isMobileTuiAgentEnabled(agent.id, runtimeSettings?.disabledTuiAgents)
        )
  const pickerAgentOptions = [...visibleAgentOptions, BLANK_TERMINAL]
  const projectPickerItems = useMemo(() => buildNewWorkspaceProjectOptions(repos), [repos])
  const selectedProjectId = selectedRepo
    ? (selectedRepo.projectId ?? getProjectIdentityKey(selectedRepo))
    : null
  const selectedProject =
    projectPickerItems.find((project) => project.id === selectedProjectId) ?? null
  const runTargetPickerItems = useMemo(
    () => buildNewWorkspaceRunTargetOptions(repos, selectedProjectId, hostPlatform),
    [hostPlatform, repos, selectedProjectId]
  )
  const selectedRunTarget = selectedRepo
    ? getNewWorkspaceRunTarget(selectedRepo, hostPlatform)
    : null

  function prepareSelectionPickerOpen(): void {
    // Why: picker taps can beat an open soft keyboard; dismissing it prevents the
    // keyboard from reopening under the picker drawer.
    Keyboard.dismiss()
  }

  function handleRepoSelected(repo: Repo): void {
    const repoChanged = repo.id !== selectedRepo?.id
    setSelectedRepo(repo)
    // Branch and provider-backed sources are repo-scoped; Linear/Jira are global
    // work context and survive choosing a different implementation repo.
    if (repoChanged && !shouldPreserveWorkspaceSourceOnRepoChange(composer.linkedWorkItem)) {
      composer.handleClearSmartNameSelection()
    }
  }

  async function approveSetupTrust(alwaysTrust: boolean): Promise<void> {
    if (
      !operations ||
      !setupTrustPrompt ||
      setupTrustActionInFlightRef.current ||
      createInFlightRef.current
    ) {
      return
    }
    setupTrustActionInFlightRef.current = true
    setCreating(true)
    try {
      const nextTrust = await operations.persistSetupTrust({
        trust: trustedOrcaHooks,
        repoId: setupTrustPrompt.repoId,
        contentHash: setupTrustPrompt.contentHash,
        alwaysTrust
      })
      setTrustedOrcaHooks(nextTrust)
      const approvedHash = setupTrustPrompt.contentHash
      setSetupTrustPrompt(null)
      transitionDrawer('form')
      await handleCreate({ setupOverride: 'run', approvedSetupContentHash: approvedHash })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trust setup script.')
    } finally {
      setupTrustActionInFlightRef.current = false
      if (!createInFlightRef.current) {
        setCreating(false)
      }
    }
  }

  function closeSetupTrust(): void {
    if (setupTrustActionInFlightRef.current || createInFlightRef.current) {
      return
    }
    setSetupTrustPrompt(null)
    transitionDrawer('form')
  }

  function skipSetupTrust(): void {
    if (setupTrustActionInFlightRef.current || createInFlightRef.current) {
      return
    }
    closeSetupTrust()
    void handleCreate({ setupOverride: 'skip' })
  }

  return (
    // Why: hosting the form and every picker in one persistent native Modal makes
    // form → repo/agent transitions in-window view swaps, avoiding the iOS
    // dismiss-then-present race that left the dropdowns unresponsive. Native back
    // closes the flow from the form, routes the trust prompt through its in-flight
    // guard, and otherwise returns to the form from a picker.
    <BottomDrawerModalHost
      visible={visible}
      onRequestClose={() => {
        if (drawerView === 'form') {
          onClose()
        } else if (drawerView === 'trust') {
          closeSetupTrust()
        } else {
          transitionDrawer('form')
        }
      }}
    >
      <BottomDrawer visible={formSheetVisible} interactive={formSheetInteractive} onClose={onClose}>
        <View style={styles.header}>
          <Text style={styles.title}>Create worktree</Text>
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : repos.length === 0 ? (
          <View style={styles.loadingContainer}>
            <Text style={styles.emptyText}>No projects found</Text>
          </View>
        ) : (
          <>
            <NewWorktreeProjectTargetFields
              project={selectedProject}
              runTarget={selectedRunTarget}
              projectBadgeColor={selectedRepo ? repoBadgeColor(selectedRepo) : null}
              onOpenProject={() => {
                prepareSelectionPickerOpen()
                transitionDrawer('project')
              }}
              onOpenRunTarget={() => {
                prepareSelectionPickerOpen()
                transitionDrawer('runTarget')
              }}
            />

            <SmartWorkspaceSourceField
              composer={composer}
              label={selectedRepoIsGit ? "Name or 'Create From'" : 'Workspace name'}
              disabled={sshGate.requiresConnection}
              interactive={formSheetInteractive}
              onOpenExternalUrl={openExternalUrl}
              onBeforeOpen={() => setError('')}
              onOpenDrawer={openSourceDrawer}
            />

            {composer.forkPushWarning ? (
              <Text style={styles.sourceWarning}>{composer.forkPushWarning}</Text>
            ) : null}

            {selectedRepoConnectionId ? (
              <View style={styles.field}>
                <Text style={styles.label}>SSH Connection</Text>
                <View style={styles.sshBox}>
                  <View style={styles.sshRow}>
                    <View
                      style={[
                        styles.sshDot,
                        sshGate.status === 'connected'
                          ? styles.sshDotConnected
                          : sshGate.connectInProgress
                            ? styles.sshDotProgress
                            : styles.sshDotDisconnected
                      ]}
                    />
                    <View style={styles.sshCopy}>
                      <Text style={styles.sshTitle} numberOfLines={1}>
                        {selectedRepo?.displayName ?? 'Remote repository'}
                      </Text>
                      <Text style={styles.sshSubtitle}>
                        {workspaceSshStatusLabel(sshGate.status)}
                      </Text>
                    </View>
                    {sshGate.status === 'connected' ? null : (
                      <Pressable
                        style={[
                          styles.sshConnectButton,
                          sshGate.connectInProgress && styles.disabled
                        ]}
                        disabled={sshGate.connectInProgress}
                        onPress={() => void connectSelectedSshRepo()}
                      >
                        <Text style={styles.sshConnectText}>
                          {sshGate.connectInProgress ? 'Connecting...' : 'Connect'}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  {sshGate.error ? <Text style={styles.errorInline}>{sshGate.error}</Text> : null}
                </View>
              </View>
            ) : null}

            <View style={styles.field}>
              <Text style={styles.label}>Agent</Text>
              <Pressable
                style={[styles.fieldButton, sshGate.requiresConnection && styles.disabled]}
                disabled={sshGate.requiresConnection}
                onPress={() => {
                  prepareSelectionPickerOpen()
                  transitionDrawer('agent')
                }}
              >
                <MobileAgentIcon agentId={selectedAgent.id} size={16} />
                <Text style={styles.fieldButtonText} numberOfLines={1}>
                  {sshGate.requiresConnection ? 'Connect target first' : selectedAgent.label}
                </Text>
                <ChevronDown size={14} color={colors.textMuted} />
              </Pressable>
            </View>

            <Pressable style={styles.advancedToggle} onPress={() => setShowAdvanced(!showAdvanced)}>
              <Text style={styles.advancedText}>Advanced</Text>
              {showAdvanced ? (
                <ChevronUp size={14} color={colors.textSecondary} />
              ) : (
                <ChevronDown size={14} color={colors.textSecondary} />
              )}
            </Pressable>

            {showAdvanced && (
              <>
                <SmartWorkspaceAdvancedFields
                  composer={composer}
                  selectedRepoIsGit={selectedRepoIsGit}
                />

                <View style={styles.field}>
                  <Text style={styles.label}>Note</Text>
                  <TextInput
                    style={styles.input}
                    value={note}
                    onChangeText={setNote}
                    placeholder="Write a note"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                {setupCommand ? (
                  <View style={styles.field}>
                    <View style={styles.setupHeader}>
                      <Text style={styles.label}>Setup script</Text>
                      {setupSource && (
                        <View style={styles.sourceBadge}>
                          <Text style={styles.sourceBadgeText}>
                            {setupSource === 'orca.yaml' ? 'ORCA.YAML' : 'HOOKS'}
                          </Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.setupBox}>
                      {setupRunPolicy === 'ask' ? (
                        <View style={styles.setupChoiceRow}>
                          <Pressable
                            style={[
                              styles.setupChoiceButton,
                              setupDecisionChoice === 'run' && styles.setupChoiceButtonSelected
                            ]}
                            onPress={() => setSetupDecisionChoice('run')}
                          >
                            <Text style={styles.setupChoiceText}>Run</Text>
                          </Pressable>
                          <Pressable
                            style={[
                              styles.setupChoiceButton,
                              setupDecisionChoice === 'skip' && styles.setupChoiceButtonSelected
                            ]}
                            onPress={() => setSetupDecisionChoice('skip')}
                          >
                            <Text style={styles.setupChoiceText}>Skip</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <View style={styles.setupToggleRow}>
                          <Text style={styles.setupToggleLabel}>Run setup command</Text>
                          <Switch
                            value={runSetup}
                            onValueChange={setRunSetup}
                            trackColor={{ false: colors.borderSubtle, true: colors.textSecondary }}
                            thumbColor={colors.textPrimary}
                            style={styles.setupSwitch}
                          />
                        </View>
                      )}
                      <View style={styles.setupCommandBlock}>
                        <Text style={styles.setupCommand}>{setupCommand}</Text>
                      </View>
                    </View>
                  </View>
                ) : null}
              </>
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.actions}>
              <Pressable
                style={[styles.createButton, !canCreate && styles.createButtonDisabled]}
                disabled={!canCreate}
                onPress={() => void handleCreate()}
              >
                {creating ? (
                  <ActivityIndicator size="small" color={colors.bgBase} />
                ) : (
                  <Text style={styles.createText}>
                    {sshGate.requiresConnection ? 'Connect target' : 'Create worktree'}
                  </Text>
                )}
              </Pressable>
            </View>
          </>
        )}
      </BottomDrawer>

      {/* Why: list drawers stay outside the form's ScrollView, and the transition
          state lets each hosted overlay finish hiding before the next appears. */}
      <SmartWorkspaceSourceDrawer
        visible={visible && drawerView === 'source'}
        operations={operations}
        composer={composer}
        availability={sourceAvailability}
        repoId={selectedRepo?.id ?? null}
        repos={pasteRepos}
        sshReady={!sshGate.requiresConnection}
        onRepoChange={(repoId) => {
          const nextRepo = repos.find((repo) => repo.id === repoId)
          if (nextRepo) {
            setSelectedRepo(nextRepo)
          }
        }}
        onClose={() => transitionDrawer('form')}
      />

      <PickerListDrawer
        visible={visible && drawerView === 'project'}
        title="Project"
        items={projectPickerItems}
        selectedId={selectedProjectId ?? ''}
        onSelect={(item) => handleRepoSelected(item.repo)}
        onClose={() => transitionDrawer('form')}
        renderIcon={(item) => {
          return <View style={[styles.repoDot, { backgroundColor: repoBadgeColor(item.repo) }]} />
        }}
      />

      <PickerListDrawer
        visible={visible && drawerView === 'runTarget'}
        title="Run on"
        items={runTargetPickerItems}
        selectedId={selectedRepo?.id ?? ''}
        onSelect={(item) => handleRepoSelected(item.repo)}
        onClose={() => transitionDrawer('form')}
        renderIcon={() => <Monitor size={16} color={colors.textMuted} />}
      />

      <PickerListDrawer
        visible={visible && drawerView === 'agent'}
        title="Agent"
        items={pickerAgentOptions}
        selectedId={selectedAgent.id}
        onSelect={(agent) => {
          setAgentOverridden(true)
          setSelectedAgent(agent)
        }}
        onClose={() => transitionDrawer('form')}
        renderIcon={(agent) => <MobileAgentIcon agentId={agent.id} size={18} />}
      />

      <SetupHookTrustDrawer
        visible={visible && drawerView === 'trust' && setupTrustPrompt != null}
        prompt={setupTrustPrompt}
        busy={creating}
        onRunOnce={() => void approveSetupTrust(false)}
        onAlwaysTrust={() => void approveSetupTrust(true)}
        onDontRun={skipSetupTrust}
        onClose={closeSetupTrust}
      />
    </BottomDrawerModalHost>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  loadingContainer: {
    paddingVertical: spacing.xl,
    alignItems: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  field: {
    marginBottom: spacing.md
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs
  },
  labelHint: {
    fontWeight: '400',
    color: colors.textMuted
  },
  fieldButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  fieldButtonText: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  fieldButtonPlaceholder: {
    color: colors.textMuted
  },
  repoDot: {
    width: 8,
    height: 8,
    borderRadius: 999
  },
  disabled: {
    opacity: 0.55
  },
  sshBox: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs
  },
  sshRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sshDot: {
    width: 8,
    height: 8,
    borderRadius: 999
  },
  sshDotConnected: {
    backgroundColor: colors.statusGreen
  },
  sshDotProgress: {
    backgroundColor: colors.statusAmber
  },
  sshDotDisconnected: {
    backgroundColor: colors.statusRed
  },
  sshCopy: {
    flex: 1,
    minWidth: 0
  },
  sshTitle: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  sshSubtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 1
  },
  sshConnectButton: {
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  sshConnectText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  errorInline: {
    color: colors.statusRed,
    fontSize: 12
  },
  input: {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm,
    fontSize: typography.bodySize,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  error: {
    color: colors.statusRed,
    fontSize: 13,
    marginBottom: spacing.md
  },
  sourceWarning: {
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
    fontSize: 12,
    color: colors.statusAmber
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs
  },
  advancedText: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textSecondary
  },
  setupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs
  },
  sourceBadge: {
    backgroundColor: colors.bgRaised,
    borderRadius: 4,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2
  },
  sourceBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5
  },
  setupBox: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.md
  },
  setupToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm
  },
  setupToggleLabel: {
    fontSize: 13,
    color: colors.textSecondary
  },
  setupChoiceRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  setupChoiceButton: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingVertical: spacing.sm
  },
  setupChoiceButtonSelected: {
    backgroundColor: colors.bgPanel,
    borderColor: colors.textSecondary
  },
  setupChoiceText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  },
  setupSwitch: {
    transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }]
  },
  setupCommandBlock: {
    backgroundColor: colors.bgBase,
    borderRadius: 6,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm
  },
  setupCommand: {
    fontSize: 13,
    fontFamily: typography.monoFamily,
    color: colors.textPrimary
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.sm
  },
  createButton: {
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    minWidth: 160,
    alignItems: 'center'
  },
  createButtonDisabled: {
    opacity: 0.4
  },
  createText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
