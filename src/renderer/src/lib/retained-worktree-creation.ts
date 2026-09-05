import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { WorktreeCreationRequest } from './pending-worktree-creation'

export function canRetainComposerWorktree(request: WorktreeCreationRequest): boolean {
  return (
    request.agent === null &&
    request.startup?.command === '' &&
    !request.startup.launchAgent &&
    !request.startup.launchConfig &&
    !request.startupPlan &&
    !request.launchDraftPrompt &&
    !request.issueCommand &&
    !request.ephemeralVmRecipe &&
    !request.ephemeralVmRuntimeId &&
    !request.ephemeralVmRuntimeEnvironmentId &&
    !request.ephemeralVmCheckoutMode &&
    !request.ephemeralVmExpectedRefHead &&
    request.agentLaunchRoute !== 'structured-native-chat'
  )
}

function serializeRequest(request: WorktreeCreationRequest): string {
  return JSON.stringify(request, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      )
    }
    return value
  })
}

function freezeRequest(value: unknown): void {
  if (!value || typeof value !== 'object') {
    return
  }
  for (const child of Object.values(value)) {
    freezeRequest(child)
  }
  Object.freeze(value)
}

export function createRetainedWorktreeCreation(
  create: (request: WorktreeCreationRequest) => Promise<CreateWorktreeResult>
) {
  let started = false
  let retired = false
  let taken = false
  let requestKey: string | null = null
  let ownerKey: string | null = null
  let creation: Promise<CreateWorktreeResult> | null = null
  let completed: CreateWorktreeResult | null = null

  return {
    start(request: WorktreeCreationRequest, executionIdentity: string): boolean {
      if (started || retired || !executionIdentity || !canRetainComposerWorktree(request)) {
        return false
      }
      requestKey = serializeRequest(request)
      const snapshot = JSON.parse(requestKey) as WorktreeCreationRequest
      freezeRequest(snapshot)
      ownerKey = executionIdentity
      started = true
      creation = Promise.resolve()
        .then(() => create(snapshot))
        .then((result) => {
          completed = result
          return result
        })
      // An abandoned composer has no submit awaiting a failed ordinary creation.
      void creation.catch(() => undefined)
      return true
    },
    take(
      request: WorktreeCreationRequest,
      executionIdentity: string
    ): CreateWorktreeResult | Promise<CreateWorktreeResult> | null {
      if (retired || taken || !creation) {
        return null
      }
      if (ownerKey !== executionIdentity || requestKey !== serializeRequest(request)) {
        retired = true
        return null
      }
      taken = true
      return completed ?? creation
    },
    retire(): void {
      // Ordinary workspace persistence owns all work once creation starts.
      retired = true
    }
  }
}
