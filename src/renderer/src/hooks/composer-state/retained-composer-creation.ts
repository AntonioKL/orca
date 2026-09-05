import type { Repo } from '../../../../shared/repo-types'
import { useEffect, useMemo, useState } from 'react'
import { createRetainedWorktreeCreation } from '@/lib/retained-worktree-creation'
import { createRequestedWorktree } from '@/lib/create-requested-worktree'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type {
  WorktreeCreationPhase,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

export type ComposerPreparation = { isCancelled: () => boolean }

function createComposerReservation() {
  const creationId = createBrowserUuid()
  return {
    creationId,
    phase: undefined as WorktreeCreationPhase | undefined,
    ...createRetainedWorktreeCreation((request) =>
      createRequestedWorktree(creationId, request, true)
    )
  }
}

export function useRetainedComposerCreation(
  isSubmissionCancelled: () => boolean,
  executionIdentity: string
) {
  const [state] = useState(() => ({
    generation: 0,
    started: false,
    creation: createComposerReservation()
  }))
  useEffect(
    () =>
      window.api?.worktrees?.onCreateProgress?.((event) => {
        if (event.creationId === state.creation.creationId) {
          state.creation.phase = event.phase
        }
      }),
    [state]
  )
  return useMemo(
    () => ({
      begin(preparation?: ComposerPreparation): (() => boolean) | null {
        if (preparation && state.started) {
          return null
        }
        const generation = preparation ? state.generation : ++state.generation
        return () =>
          isSubmissionCancelled() ||
          Boolean(preparation && (preparation.isCancelled() || generation !== state.generation))
      },
      prepare(request: WorktreeCreationRequest, repo: Repo): void {
        state.started = state.creation.start(request, JSON.stringify({ executionIdentity, repo }))
      },
      resetForNextCreate(): void {
        state.generation++
        state.started = false
        state.creation = createComposerReservation()
      },
      take(request: WorktreeCreationRequest, repo: Repo) {
        const creation = state.creation.take(request, JSON.stringify({ executionIdentity, repo }))
        return creation
          ? { creation, creationId: state.creation.creationId, phase: state.creation.phase }
          : undefined
      }
    }),
    [executionIdentity, isSubmissionCancelled, state]
  )
}
