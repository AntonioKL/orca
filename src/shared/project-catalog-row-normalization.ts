import { LOCAL_EXECUTION_HOST_ID } from './execution-host'
import type { Project, ProjectHostSetup } from './project-types'

/**
 * Repairs untrusted `Project` / `ProjectHostSetup` rows so their declared field types are true.
 *
 * These rows reach typed code from persisted JSON and from remote Orca hosts running a different
 * version, where a field the type promises is a `string` can arrive `null`, missing, or another
 * type entirely — while consumers call `.trim()` on it unconditionally (crash 3bcc5be3). Call
 * these at every boundary such a row enters the app, so nothing downstream has to re-guard.
 *
 * Coercion only. A normalizer never drops a row, never adds or removes an optional key, and
 * returns its input reference untouched when it already conforms — callers keep row and array
 * identity, which selectors and `useMemo` deps depend on.
 *
 * The string-literal unions (`setupState`, `setupMethod`) are deliberately left alone: they are
 * only ever compared, so an unknown value degrades instead of crashing, and inventing a fallback
 * would silently change what a corrupt row claims about itself.
 */

function isString(value: unknown): boolean {
  return typeof value === 'string'
}

// Why 0 and not now(): the catalog merge already reads 0 as "timestamp unknown", not as the epoch.
function isTimestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

export function normalizeProjectHostSetupRow(setup: ProjectHostSetup): ProjectHostSetup {
  const needsRepair =
    !isString(setup.id) ||
    !isString(setup.projectId) ||
    !isString(setup.hostId) ||
    !isString(setup.repoId) ||
    !isString(setup.path) ||
    !isString(setup.displayName) ||
    !isTimestamp(setup.createdAt) ||
    !isTimestamp(setup.updatedAt)
  if (!needsRepair) {
    return setup
  }
  return {
    ...setup,
    id: isString(setup.id) ? setup.id : '',
    projectId: isString(setup.projectId) ? setup.projectId : '',
    hostId: isString(setup.hostId) ? setup.hostId : LOCAL_EXECUTION_HOST_ID,
    repoId: isString(setup.repoId) ? setup.repoId : '',
    path: isString(setup.path) ? setup.path : '',
    displayName: isString(setup.displayName) ? setup.displayName : '',
    createdAt: isTimestamp(setup.createdAt) ? setup.createdAt : 0,
    updatedAt: isTimestamp(setup.updatedAt) ? setup.updatedAt : 0
  }
}

export function normalizeProjectRow(project: Project): Project {
  const sourceRepoIdsConform =
    Array.isArray(project.sourceRepoIds) && project.sourceRepoIds.every(isString)
  const needsRepair =
    !isString(project.id) ||
    !isString(project.displayName) ||
    !isString(project.badgeColor) ||
    !sourceRepoIdsConform ||
    !isTimestamp(project.createdAt) ||
    !isTimestamp(project.updatedAt)
  if (!needsRepair) {
    return project
  }
  return {
    ...project,
    id: isString(project.id) ? project.id : '',
    displayName: isString(project.displayName) ? project.displayName : '',
    badgeColor: isString(project.badgeColor) ? project.badgeColor : '',
    sourceRepoIds: Array.isArray(project.sourceRepoIds)
      ? project.sourceRepoIds.filter((repoId): repoId is string => isString(repoId))
      : [],
    createdAt: isTimestamp(project.createdAt) ? project.createdAt : 0,
    updatedAt: isTimestamp(project.updatedAt) ? project.updatedAt : 0
  }
}

function normalizeRows<T>(rows: readonly T[], normalize: (row: T) => T): readonly T[] {
  if (!Array.isArray(rows)) {
    return []
  }
  let repaired: T[] | null = null
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const normalized = normalize(row)
    if (normalized !== row && !repaired) {
      repaired = rows.slice(0, index)
    }
    repaired?.push(normalized)
  }
  return repaired ?? rows
}

export function normalizeProjectHostSetupRows(
  setups: readonly ProjectHostSetup[]
): readonly ProjectHostSetup[] {
  return normalizeRows(setups, normalizeProjectHostSetupRow)
}

export function normalizeProjectRows(projects: readonly Project[]): readonly Project[] {
  return normalizeRows(projects, normalizeProjectRow)
}
