/**
 * Extract the original branch from a git rebase `head-name` state file, or null when it
 * isn't a clean branch ref.
 * Why: a rebase started from a detached HEAD records the literal `detached HEAD`, and a
 * corrupt/multi-line value must not slice into a garbage branch that poisons PR lookups —
 * only a single-line `refs/heads/<branch>` (no ASCII control/space) is recoverable.
 */
export function parseRebaseHeadName(headName: string): string | null {
  const trimmed = headName.trim()
  if (!trimmed.startsWith('refs/heads/')) {
    return null
  }
  // Reject ASCII control chars and space (git check-ref-format forbids exactly these): blocks
  // corrupt multi-line values while still allowing the non-ASCII whitespace git permits.
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) <= 0x20) {
      return null
    }
  }
  return trimmed.slice('refs/heads/'.length)
}
