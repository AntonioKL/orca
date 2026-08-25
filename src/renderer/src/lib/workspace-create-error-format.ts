import { translate } from '@/i18n/i18n'
import {
  classifyGitObjectStoreFailure,
  formatGitObjectStoreFailureMessage,
  isGitObjectStoreFailureMessage,
  splitGitObjectStoreRepairGuidance,
  unwrapGitObjectStoreFailureMessage
} from '../../../shared/git-object-store-failure'

export type WorkspaceCreateErrorDisplay = {
  title: string
  message: string
  help?: string
}

const MISSING_BASE_REF_ANCHOR = 'could not resolve a default base ref'

export function formatWorkspaceCreateError(error: unknown): WorkspaceCreateErrorDisplay {
  const message = error instanceof Error ? error.message : 'Failed to create worktree.'

  if (message.toLowerCase().includes(MISSING_BASE_REF_ANCHOR)) {
    return {
      title: translate('auto.lib.workspace.create.error.format.64555d0014', 'No base branch found'),
      message: translate(
        'auto.lib.workspace.create.error.format.37cf0bc991',
        'Orca could not resolve a usable base ref for this workspace.'
      ),
      help: 'Create an initial commit (for example on main), or select an existing branch in Create From, then try again.'
    }
  }

  const objectStore = formatGitObjectStoreError(message)
  if (objectStore) {
    return objectStore
  }

  return {
    title: message,
    message
  }
}

const OBJECT_STORE_TITLE = 'Repository objects are missing'

/**
 * Why classify here and not only on the host: the raw text also reaches this client from
 * older hosts and relays that rethrow git's stderr verbatim, and that text carries the
 * user's absolute worktree path and the whole argv. Redacting client-side fixes the leak
 * for every host version without a wire change.
 */
function formatGitObjectStoreError(message: string): WorkspaceCreateErrorDisplay | null {
  // An already-diagnosed host message passes through; raw git stderr gets composed here instead.
  const failure = isGitObjectStoreFailureMessage(message)
    ? null
    : classifyGitObjectStoreFailure(message)
  const composed = failure
    ? // Nothing was probed on this side, so claim neither a missing tree nor a partial clone.
      formatGitObjectStoreFailureMessage({
        failure,
        branch: extractQuotedBranch(message) ?? 'this branch',
        commit: 'unverifiable',
        rootTree: 'unverifiable',
        partialClone: 'unverifiable'
      })
    : isGitObjectStoreFailureMessage(message)
      ? unwrapGitObjectStoreFailureMessage(message)
      : null
  if (composed === null) {
    return null
  }
  const { summary, repair } = splitGitObjectStoreRepairGuidance(composed)
  return { title: OBJECT_STORE_TITLE, message: summary, help: repair }
}

// Git echoes the checked-out branch as `(checking out 'name')`; the surrounding argv is discarded.
function extractQuotedBranch(message: string): string | null {
  return message.match(/checking out '([^']+)'/)?.[1] ?? null
}

export function getWorkspaceCreateErrorToastMessage(error: WorkspaceCreateErrorDisplay): string {
  return error.help ? error.title : error.message
}

/**
 * Full text for surfaces that render one string (the creation panel). The background create
 * path never rethrows, so the composer footer that shows title+message+help never runs and
 * this is the only place the user can read what to repair.
 */
export function getWorkspaceCreateErrorDetail(error: WorkspaceCreateErrorDisplay): string {
  return error.help ? `${error.message} ${error.help}` : error.message
}
