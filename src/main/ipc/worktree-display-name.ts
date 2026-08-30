import type { CreateWorktreeArgs } from '../../shared/worktree/create-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

export function sanitizeWorktreeDisplayName(input: string): string | undefined {
  const withoutControls = Array.from(input, (char) => {
    const code = char.charCodeAt(0)
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : char
  }).join('')
  const sanitized = withoutControls
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim()

  return sanitized || undefined
}

export function resolveWorktreeCreateDisplayName(
  input: string | undefined,
  kind: CreateWorktreeArgs['displayNameKind']
): string | undefined {
  if (!input) {
    return undefined
  }
  if (kind !== 'user') {
    return sanitizeWorktreeDisplayName(input)
  }
  const safe = Array.from(input, (char) => {
    const code = char.charCodeAt(0)
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : char
  })
    .join('')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
  return safe || undefined
}

export function resolveWorktreeCreateDisplayNameMeta(
  requestedDisplayName: string | undefined,
  branchName: string,
  kind: CreateWorktreeArgs['displayNameKind'],
  fallback: { requestedName: string; sanitizedName: string }
): Partial<Pick<WorktreeMeta, 'displayName' | 'displayNameIsPinned'>> {
  if (requestedDisplayName !== undefined) {
    if (kind !== 'user' && requestedDisplayName === branchName) {
      return {}
    }
    return { displayName: requestedDisplayName, displayNameIsPinned: true }
  }
  if (kind !== 'user' && fallback.requestedName === branchName) {
    return { displayName: fallback.requestedName, displayNameIsPinned: false }
  }
  return shouldSetDisplayName(fallback.requestedName, branchName, fallback.sanitizedName)
    ? { displayName: fallback.requestedName, displayNameIsPinned: true }
    : {}
}

export function shouldSetDisplayName(
  requestedName: string,
  branchName: string,
  sanitizedName: string
): boolean {
  return !(branchName === requestedName && sanitizedName === requestedName)
}
