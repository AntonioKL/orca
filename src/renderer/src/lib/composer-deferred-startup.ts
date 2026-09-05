import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { resolveBackendDraftStartup } from './worktree-draft-startup-view-mode'
import { isWebClientLocation } from './web-client-location'

export async function prepareComposerStartup(
  creationId: string,
  request: WorktreeCreationRequest
): Promise<WorktreeCreationRequest['startup']> {
  const plan = request.startupPlan
  if (!request.agent || !plan || typeof window === 'undefined' || isWebClientLocation()) {
    return undefined
  }
  try {
    if (!(await window.api?.worktrees?.supportsDeferredStartup?.(request.repoId))) {
      return undefined
    }
  } catch {
    return undefined
  }
  const startup = request.startup ?? {
    command: plan.launchCommand,
    env: plan.env,
    launchConfig: plan.launchConfig,
    launchAgent: request.agent,
    startupCommandDelivery: plan.startupCommandDelivery,
    ...(request.quickTelemetry ? { telemetry: request.quickTelemetry } : {})
  }
  return resolveBackendDraftStartup({
    ...request,
    startup: {
      ...startup,
      activate: false,
      launchToken: creationId,
      deferredStartupOperationId: creationId
    }
  })
}
