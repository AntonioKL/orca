/**
 * The renderer's periodic memory sample doubles as a liveness heartbeat: the
 * gap between the last one and a crash report measures how long the renderer
 * had been silent before it died. Shared so main measures against the cadence
 * the renderer actually runs instead of a hardcoded copy of it.
 */
export const RENDERER_MEMORY_HEARTBEAT_BREADCRUMB = 'renderer_memory'
export const RENDERER_MEMORY_HEARTBEAT_INTERVAL_MS = 60_000
