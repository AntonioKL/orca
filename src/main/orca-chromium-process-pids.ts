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
 *
 * The other direction is real too, and bounded by design: `getAppMetrics()` can
 * still list a renderer Electron has not finished reaping, so on Windows a pid
 * already recycled onto an unrelated child of ours reads as `own` and its tree
 * walk is refused. That is why a refusal only blocks the pid-addressed walk and
 * every gated site still kills its own root through the child handle.
 *
 * Host coverage: only Electron main installs a Chromium-backed AppEnvironment
 * (main-process-preflight). The standalone daemon installs none and `orcad`
 * installs a Node one whose `getAppMetrics()` is `[]`, so this set is empty in
 * both — and that is sound, not a hole: the pid-addressed kills those hosts
 * issue go through `classifyWindowsTreeKillTarget`, which walks ancestry back to
 * the *killing* process's own pid. Orca's Chromium processes are children of
 * Electron main, so they never classify `own` from a daemon or orcad host, and
 * on an SSH/serve host there is no Chromium on the machine at all.
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
