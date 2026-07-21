/**
 * Extract the original branch from a git rebase `head-name` state file, or null when it
 * isn't a clean branch ref.
 * Why: a rebase started from a detached HEAD records the literal `detached HEAD`, and a
 * corrupt/multi-line value must not slice into a garbage branch that poisons PR lookups —
 * only a single-line `refs/heads/<branch>` (no interior whitespace) is recoverable.
 */
export function parseRebaseHeadName(headName: string): string | null {
  const trimmed = headName.trim()
  if (!trimmed.startsWith('refs/heads/') || /\s/.test(trimmed)) {
    return null
  }
  return trimmed.slice('refs/heads/'.length)
}
