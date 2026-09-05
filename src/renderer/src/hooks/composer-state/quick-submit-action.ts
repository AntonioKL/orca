import { useCallback } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { findPendingLinkedWorkItemCreationId } from '@/lib/pending-worktree-creation'
import { useAppStore } from '@/store'
import { getWorkspaceSeedName } from '@/lib/new-workspace'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'
import { toast } from 'sonner'

import type { ComposerModel } from './composer-model'

type QuickSubmitActionInput = Pick<
  ComposerModel,
  | 'effectiveLinkedPR'
  | 'executeQuickCreation'
  | 'fallbackCreatureName'
  | 'isProjectGroupTarget'
  | 'isSubmissionCancelled'
  | 'linkedPR'
  | 'name'
  | 'onCreated'
  | 'parsedLinkedIssueNumber'
  | 'repoId'
  | 'requiresExplicitSetupChoice'
  | 'resolvePendingSmartGitHubSubmit'
  | 'selectedRepo'
  | 'selectedRepoRequiresConnection'
  | 'selectedWorkspaceTarget'
  | 'setCreateError'
  | 'setCreating'
  | 'setupDecision'
  | 'showProjectRequiredError'
  | 'sourceIntentBlocksCreate'
  | 'sparseError'
  | 'submitFolderTarget'
>

export function useQuickSubmitAction(input: QuickSubmitActionInput) {
  const {
    effectiveLinkedPR,
    executeQuickCreation,
    fallbackCreatureName,
    isProjectGroupTarget,
    isSubmissionCancelled,
    linkedPR,
    name,
    onCreated,
    parsedLinkedIssueNumber,
    repoId,
    requiresExplicitSetupChoice,
    resolvePendingSmartGitHubSubmit,
    selectedRepo,
    selectedRepoRequiresConnection,
    selectedWorkspaceTarget,
    setCreateError,
    setCreating,
    setupDecision,
    showProjectRequiredError,
    sourceIntentBlocksCreate,
    sparseError,
    submitFolderTarget
  } = input

  const submitQuick = useCallback(
    async (
      requestedAgent: TuiAgent | null,
      preparation?: { isCancelled: () => boolean }
    ): Promise<void> => {
      const isCancelled = () => isSubmissionCancelled() || Boolean(preparation?.isCancelled())
      if (
        preparation &&
        (isProjectGroupTarget || linkedPR !== null || parsedLinkedIssueNumber !== null)
      ) {
        return
      }
      if (isProjectGroupTarget) {
        await submitFolderTarget(requestedAgent)
        return
      }

      const workspaceNameSeed = getWorkspaceSeedName({
        explicitName: name,
        prompt: '',
        linkedIssueNumber: parsedLinkedIssueNumber,
        linkedPR,
        fallbackName: fallbackCreatureName
      })

      if (!repoId || !selectedRepo) {
        if (!preparation) {
          showProjectRequiredError()
        }
        return
      }

      if (
        !workspaceNameSeed ||
        sourceIntentBlocksCreate ||
        selectedRepoRequiresConnection ||
        (requiresExplicitSetupChoice && !setupDecision) ||
        sparseError !== null
      ) {
        return
      }

      const workspaceRunContext: WorktreeCreationRequest['workspaceRunContext'] =
        selectedWorkspaceTarget.status === 'ready'
          ? {
              kind: 'workspace-run',
              projectId: selectedWorkspaceTarget.target.projectId,
              hostId: selectedWorkspaceTarget.target.hostId,
              projectHostSetupId: selectedWorkspaceTarget.target.projectHostSetupId,
              repoId: selectedWorkspaceTarget.target.repoId,
              path: selectedWorkspaceTarget.target.repo.path
            }
          : null

      const liveStore = useAppStore.getState()

      const pendingCreationId = findPendingLinkedWorkItemCreationId(
        liveStore.pendingWorktreeCreations,
        {
          repoId,
          ...(parsedLinkedIssueNumber != null ? { linkedIssue: parsedLinkedIssueNumber } : {}),
          ...(effectiveLinkedPR != null ? { linkedPR: effectiveLinkedPR } : {}),
          workspaceRunContext
        }
      )

      if (preparation && pendingCreationId) {
        return
      }
      if (pendingCreationId) {
        liveStore.setActivePendingWorktreeCreation(pendingCreationId)
        liveStore.setActiveView('terminal')
        liveStore.setSidebarOpen(true)
        onCreated?.()
        return
      }

      if (!preparation) {
        setCreateError(null)
        setCreating(true)
      }
      try {
        const smartGitHubSettlement = await settleComposerSubmit(
          preparation
            ? Promise.resolve({ kind: 'none' } as const)
            : resolvePendingSmartGitHubSubmit(),
          isCancelled
        )
        if (smartGitHubSettlement.status === 'cancelled') {
          return
        }
        await executeQuickCreation(
          smartGitHubSettlement.value,
          requestedAgent,
          workspaceNameSeed,
          workspaceRunContext,
          repoId,
          selectedRepo,
          preparation ? { isCancelled } : undefined
        )
      } catch (error) {
        if (preparation || isCancelled()) {
          return
        }
        const formattedError = formatWorkspaceCreateError(error)
        setCreateError(formattedError)
        toast.error(getWorkspaceCreateErrorToastMessage(formattedError))
      } finally {
        if (!preparation) {
          setCreating(false)
        }
      }
    },
    [
      effectiveLinkedPR,
      executeQuickCreation,
      fallbackCreatureName,
      isProjectGroupTarget,
      isSubmissionCancelled,
      linkedPR,
      name,
      onCreated,
      parsedLinkedIssueNumber,
      repoId,
      requiresExplicitSetupChoice,
      resolvePendingSmartGitHubSubmit,
      selectedRepo,
      selectedRepoRequiresConnection,
      selectedWorkspaceTarget,
      setCreateError,
      setCreating,
      setupDecision,
      showProjectRequiredError,
      sourceIntentBlocksCreate,
      sparseError,
      submitFolderTarget
    ]
  )

  const prepareQuickWorkspace = useCallback(
    (agent: TuiAgent | null, isCancelled: () => boolean) => submitQuick(agent, { isCancelled }),
    [submitQuick]
  )
  return { submitQuick, prepareQuickWorkspace }
}
