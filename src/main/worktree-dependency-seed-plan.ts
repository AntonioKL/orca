import type { OrcaHooks } from '../shared/orca-yaml-hook-types'
import {
  normalizeWorktreeDependencySeedInputPaths,
  normalizeWorktreeDependencySeedPaths
} from './worktree-dependency-seed-fingerprint'

/** The paths copied into a new worktree and the files used to identify them. */
export type WorktreeDependencySeedPlan = {
  paths: readonly string[]
  /** `undefined` means use the built-in lockfile list. An empty list disables inputs. */
  fingerprintPaths?: readonly string[]
}

const DEFAULT_DEPENDENCY_SEED_PATHS = ['node_modules'] as const

/**
 * Resolve the dependency-seed portion of a parsed `orca.yaml` document.
 *
 * Presence is intentional: the parser preserves an explicitly supplied empty
 * array, allowing a project to opt out without changing older files that omit
 * the setting.
 */
export function resolveWorktreeDependencySeedPlan(
  hooks: OrcaHooks | null | undefined
): WorktreeDependencySeedPlan {
  const worktree = hooks?.worktree
  const hasPaths = Array.isArray(worktree?.dependencySeedPaths)
  const hasInputs = Array.isArray(worktree?.dependencySeedInputs)
  const paths = hasPaths
    ? normalizeWorktreeDependencySeedPaths(worktree?.dependencySeedPaths ?? [])
    : [...DEFAULT_DEPENDENCY_SEED_PATHS]
  const fingerprintPaths = hasInputs
    ? normalizeWorktreeDependencySeedInputPaths(worktree?.dependencySeedInputs ?? [])
    : undefined
  return {
    paths,
    ...(fingerprintPaths !== undefined ? { fingerprintPaths } : {})
  }
}
