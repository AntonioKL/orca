import { getAppEnvironment, hasAppEnvironment } from '../shared/app-environment'

/**
 * PIDs of Orca's own Chromium processes — browser, renderers, GPU, utilities.
 *
 * Why: `taskkill /T /F` aimed at one of these kills a renderer we depend on, and
 * the `render-process-gone` it produces is indistinguishable from an external
 * kill in every field Orca records (#10680). A pid in this set is proof the
 * target is ours to keep, not ours to tear down.
 *
 * Empty on a Node host and empty on failure: that is "no refusal proven", never
 * "safe to kill" — callers must keep every other guard they already have.
 */
export function readOrcaChromiumProcessPids(): ReadonlySet<number> {
  if (!hasAppEnvironment()) {
    return new Set()
  }
  try {
    const pids = getAppEnvironment()
      .getAppMetrics()
      .map((metric) => metric.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    return new Set(pids)
  } catch {
    return new Set()
  }
}
