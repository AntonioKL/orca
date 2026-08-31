import { normalizeExecutionHostId, type ParsedExecutionHost } from '../shared/execution-host'
import type { ProjectHostSetup } from '../shared/project-types'
import { hostFilterMatchesHostId, resolveHostFlagTarget } from './execution-host-flag'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'

export type ProjectCreateTarget = {
  repoSelector: string
  setup: ProjectHostSetup
}

function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}

export function hasWorkspaceProjectTarget(flags: Map<string, string | boolean>): boolean {
  return flags.has('project') || flags.has('host') || flags.has('project-host-setup')
}

export function assertWorkspaceTargetFlagsCompatible(flags: Map<string, string | boolean>): void {
  const hasProjectTarget = hasWorkspaceProjectTarget(flags)
  if (flags.has('repo') && hasProjectTarget) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --repo or project target flags, not both.'
    )
  }
  if (flags.has('host') && !flags.has('project') && !flags.has('project-host-setup')) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--host requires --project unless --project-host-setup is provided.'
    )
  }
}

export async function resolveProjectCreateRepoSelector(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<string | undefined> {
  return (await resolveProjectCreateTarget(flags, client))?.repoSelector
}

// Why: the routed runtime can hold both an exact `runtime:<id>` row and a `local` row for the
// same project; the exact stamp is the one the caller named, so it wins the selection.
function findReadySetupOnHost(
  setups: readonly ProjectHostSetup[],
  projectId: string | undefined,
  host: ParsedExecutionHost | undefined
): ProjectHostSetup | undefined {
  const candidates = setups.filter((candidate) => candidate.projectId === projectId)
  if (!host) {
    // Why: ordering here is persistence order, not a user choice, so "first" is arbitrary — the
    // same silent pick that aimed creation at an unrelated checkout, just without a --host to blame.
    return candidates.length > 0 ? pickSingleSetup(candidates, projectId, undefined) : undefined
  }
  const exact = candidates.filter(
    (candidate) => normalizeExecutionHostId(candidate.hostId) === host.id
  )
  if (exact.length > 0) {
    return pickSingleSetup(exact, projectId, host)
  }
  // Why: `local` means "the box that answered", which is the same machine as `runtime:<id>` only
  // when the command already runs there. Picking one of several silently aimed repo creation at an
  // unrelated checkout (STA-6080), so an ambiguous fallback must be refused, not guessed.
  const fallback = candidates.filter((candidate) => hostFilterMatchesHostId(host, candidate.hostId))
  if (fallback.length > 0) {
    return pickSingleSetup(fallback, projectId, host)
  }
  return undefined
}

function pickSingleSetup(
  matches: readonly ProjectHostSetup[],
  projectId: string | undefined,
  host: ParsedExecutionHost | undefined
): ProjectHostSetup {
  if (matches.length === 1) {
    return matches[0]
  }
  // Why: list the id alongside the path — the remedy we name is `--project-host-setup <id>`, so an
  // error that prints only paths asks for something it never showed.
  const listed = matches
    .map((candidate) => `  ${terminalSafe(candidate.id)}  ${terminalSafe(candidate.path)}`)
    .join('\n')
  const where = host ? ` on ${host.id}` : ''
  throw new RuntimeClientError(
    'invalid_argument',
    `"${projectId}" has ${matches.length} ready setups${where}; pass --project-host-setup <id> to choose one:\n${listed}`
  )
}

export async function resolveProjectCreateTarget(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<ProjectCreateTarget | undefined> {
  const projectHostSetupId = getPresentStringFlag(flags, 'project-host-setup')
  const projectId = getPresentStringFlag(flags, 'project')
  const host = await resolveHostFlagTarget(flags, client)
  if (!projectHostSetupId && !projectId && !host) {
    return undefined
  }
  let result: Awaited<ReturnType<typeof client.call<{ setups: ProjectHostSetup[] }>>>
  try {
    result = await client.call<{ setups: ProjectHostSetup[] }>('projectHostSetup.list')
  } catch (error) {
    // Why: --host runtime:<id> routes here, so an older server is reachable without the caller
    // meaning to; name the version gap rather than surfacing a raw method_not_found.
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca server does not support project host setup yet. Update Orca on the server and try again.'
      )
    }
    throw error
  }
  const ready = result.result.setups.filter((candidate) => candidate.setupState === 'ready')
  const setup = projectHostSetupId
    ? ready.find((candidate) => candidate.id === projectHostSetupId)
    : findReadySetupOnHost(ready, projectId, host)
  if (!setup) {
    throw new RuntimeClientError(
      'invalid_argument',
      projectHostSetupId
        ? `Project host setup is not ready or was not found: ${projectHostSetupId}`
        : `Project is not set up on the selected host: ${projectId}${host ? ` on ${host.id}` : ''}`
    )
  }
  return {
    repoSelector: `id:${setup.repoId}`,
    setup
  }
}

// Why: setup paths and ids come from persisted metadata and may legally contain newlines or
// control characters. This message is printed straight to a terminal, so an unescaped value could
// forge a line or emit ANSI. Keep it readable rather than fully quoting.
function terminalSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '?')
}
