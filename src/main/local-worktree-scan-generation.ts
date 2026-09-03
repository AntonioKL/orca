const generationByRepoId = new Map<string, number>()
let generationSequence = 0

export function getLocalWorktreeScanGeneration(repoId: string): number {
  const existing = generationByRepoId.get(repoId)
  if (existing !== undefined) {
    return existing
  }
  const generation = ++generationSequence
  generationByRepoId.set(repoId, generation)
  return generation
}

export function bumpLocalWorktreeScanGeneration(repoId: string): void {
  generationByRepoId.set(repoId, ++generationSequence)
}

/**
 * The shared counter behind every per-repo generation above. It advances on each repo add, removal
 * and update, and on the first key handed out for a repo id nothing has scanned yet — so a cache
 * that must not answer for a repo it never saw can compare it in O(1) instead of walking the repo
 * list. Ordering-only: the value itself means nothing outside a same-process comparison.
 */
export function getWorktreeScanGenerationSequence(): number {
  return generationSequence
}

export function isLocalWorktreeScanGenerationCurrent(repoId: string, generation: number): boolean {
  return getLocalWorktreeScanGeneration(repoId) === generation
}

export function resetLocalWorktreeScanGenerationsForTests(): void {
  generationSequence += 1
  generationByRepoId.clear()
}
