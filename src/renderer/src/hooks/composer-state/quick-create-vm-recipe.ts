import type { ComposerModel } from './composer-model'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { useAppStore } from '@/store'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'

type RecipeInput = Pick<
  ComposerModel,
  'ephemeralVmRecipes' | 'selectedWorkspaceTarget' | 'selectedRepoExecutionHostId'
>

export async function prepareQuickCreateVmRecipe(
  input: RecipeInput,
  repoId: string,
  recipeId: string | null,
  isCancelled: () => boolean
): Promise<WorktreeCreationRequest['ephemeralVmRecipe'] | null> {
  if (!recipeId || input.selectedWorkspaceTarget.status !== 'ready') {
    return undefined
  }
  const trust = await settleComposerSubmit(
    ensureHooksConfirmed(
      useAppStore.getState(),
      repoId,
      'vmRecipe',
      input.selectedRepoExecutionHostId ?? undefined,
      undefined,
      isCancelled
    ),
    isCancelled
  )
  if (trust.status === 'cancelled' || trust.value === 'skip') {
    return null
  }
  const recipe = input.ephemeralVmRecipes.find((entry) => entry.id === recipeId)
  return {
    sourceRepoId: repoId,
    recipeId,
    projectId: input.selectedWorkspaceTarget.target.projectId,
    ...(recipe?.checkoutMode ? { checkoutMode: recipe.checkoutMode } : {})
  }
}
