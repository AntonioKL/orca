/**
 * Stamped on resume with the span the machine was suspended for. Named here so
 * heartbeat-silence math can subtract OS sleep without importing the Electron
 * powerMonitor wiring that emits it.
 */
export const SYSTEM_SLEPT_BREADCRUMB = 'system_slept'
