/** `user` = asked for in Settings and standing until revoked; `automatic` = derived from crashes. */
export type GpuFallbackSource = 'automatic' | 'user'

/** Whether this launch booted in Safe Graphics Mode (hardware acceleration disabled). */
export type GpuFallbackStatus = {
  active: boolean
  /** Identity of the engagement: a dismissed notice returns when a *new* one starts. */
  engagedAt: number | null
  /** The persisted decision. Diverges from `active` between a Settings change and its relaunch. */
  enabledForNextLaunch: boolean
  /**
   * Who decided. The renderer must not tell a user who pinned this that a crash caused it —
   * that contradicts the dialog they accepted and teaches them to distrust a true notice.
   */
  source: GpuFallbackSource | null
}

/** Hardware acceleration on, nothing pending — the answer wherever the fallback cannot apply. */
export const GPU_FALLBACK_INACTIVE_STATUS: GpuFallbackStatus = {
  active: false,
  engagedAt: null,
  enabledForNextLaunch: false,
  source: null
}
