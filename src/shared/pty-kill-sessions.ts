export type PtyKillIntent = 'orphan-cleanup' | 'owner-close'

export type DescendantSweepOutcome =
  | 'tree_terminated'
  | `tree_refused:${string}`
  | 'tree_unavailable'

export type PtyKillSessionRef = {
  id: string
  incarnationId?: string
}

export type PtyKillSessionResult = PtyKillSessionRef & {
  verdict: 'exited' | 'live' | 'unverifiable' | 'refused'
  reason?: string
  survivorPids?: number[]
  treeUnverified?: true
  fenceUnavailable?: true
}
