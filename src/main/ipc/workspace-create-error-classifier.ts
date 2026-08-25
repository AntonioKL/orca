// Bucket errors thrown by `createLocalWorktree` / `createRemoteWorktree` into
// the `workspace_create_failed` event's `error_class` enum.
//
// Why: the throw sites are bare `throw new Error('...')` calls in
// worktree-remote.ts, some of which interpolate user-controlled content
// (branch names, paths). The classifier reads `error.message` to bucket, but
// the matched strings never cross the wire — only the enum value does. The
// schema discipline at telemetry-events.ts §"Properties to keep off these
// events" is what makes that safe.
//
// Substring set is intentionally narrow: per the schema-evolution doctrine,
// widening this match set later requires explicit review, not silent regex
// expansion. Anything we cannot confidently bucket falls through to `unknown`.

import { GIT_OBJECT_STORE_FAILURE_ANCHOR } from '../../shared/git-object-store-failure'
import type { WorkspaceCreateErrorClass } from '../../shared/telemetry-events'

// Why the cause chain and not just `message`: object-store failures reach here redacted
// (worktree-add-object-store-error.ts rebuilds the message and keeps the raw git text on
// `cause`), and that raw text is the only place `Permission denied`/`EACCES` survives. Reading
// it back is a widening of the INPUT, not of the match set below, and the matched strings still
// never leave this process — only the enum does.
const MAX_CAUSE_DEPTH = 4

function readErrorChainText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    // Why `stderr` too: a buffer-capped runner can leave the fatal line off `message` entirely.
    const stderr = (current as { stderr?: unknown }).stderr
    parts.push(current.message, typeof stderr === 'string' ? stderr : '')
    current = current.cause
  }
  return parts.join('\n')
}

export function classifyWorkspaceCreateError(error: unknown): WorkspaceCreateErrorClass {
  // Why: throw sites mix capitalization ('Worktree created...' vs lowercased
  // git messages); normalize once so all anchors below can be lowercase literals.
  const text = readErrorChainText(error).toLowerCase()

  if (text.includes('could not resolve a default base ref')) {
    return 'base_ref_missing'
  }
  if (
    text.includes('already exists locally') ||
    text.includes('already exists on a remote') ||
    text.includes('already exists. pick') ||
    text.includes('already has pr') ||
    text.includes('could not find an available worktree name')
  ) {
    return 'path_collision'
  }
  if (text.includes('eacces') || text.includes('eperm') || text.includes('permission denied')) {
    return 'permission_denied'
  }
  // Why: anchors are intentionally specific to true git failures from
  // worktree-remote.ts. Bare 'git ' / 'worktree' would mis-bucket SSH-relay
  // and sparse-checkout validation errors (which the design doc routes to
  // 'unknown'); 'created but not found in listing' covers the formerly
  // miscased 'Worktree created but not found in listing' throw.
  // SSH-precondition failures (e.g. 'no git provider', 'SSH connection is
  // not available') deliberately fall through to 'unknown' — they're not
  // git failures and bucketing them here would mask connectivity issues.
  if (
    text.includes('fatal:') ||
    text.includes('git worktree') ||
    text.includes('created but not found in listing') ||
    // Redaction strips 'fatal:' and the argv from object-store failures; keep them bucketed.
    text.includes(GIT_OBJECT_STORE_FAILURE_ANCHOR)
  ) {
    return 'git_failed'
  }
  return 'unknown'
}
