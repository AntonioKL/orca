import { app } from 'electron'
import { gitAdmissionCountsSnapshot } from '../git/command-runner/git-admission-census'
import { collectProcessMetricBuckets } from './process-gone-diagnostics'

export type FreezeCensus = {
  census_window_count?: number
  census_pane_count_local?: number
  census_agent_count?: number
  census_git_inflight?: number
  census_git_queued?: number
  metrics_browser_mb?: number
  metrics_renderer_mb?: number
  metrics_gpu_mb?: number
  metrics_other_mb?: number
  metrics_renderer_private_mb?: number
  metrics_commit_total_mb?: number
  sysmem_total_mb?: number
  sysmem_free_mb?: number
}

function mb(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0, value) / 1024)
    : undefined
}

export function captureFreezeCensus(
  options: {
    windowCount?: number
    paneCountLocal?: number
    agentCount?: number
  } = {}
): FreezeCensus {
  const result: FreezeCensus = {
    ...(Number.isFinite(options.windowCount)
      ? { census_window_count: Math.max(0, Math.round(options.windowCount!)) }
      : {}),
    ...(Number.isFinite(options.paneCountLocal)
      ? { census_pane_count_local: Math.max(0, Math.round(options.paneCountLocal!)) }
      : {}),
    ...(Number.isFinite(options.agentCount)
      ? { census_agent_count: Math.max(0, Math.round(options.agentCount!)) }
      : {})
  }
  try {
    const git = gitAdmissionCountsSnapshot()
    result.census_git_inflight = git.inflight
    result.census_git_queued = git.queued
  } catch {
    // Best effort only.
  }
  try {
    const metrics = app.getAppMetrics() as {
      type?: unknown
      memory?: { workingSetSize?: unknown; privateBytes?: unknown }
    }[]
    const buckets = collectProcessMetricBuckets(metrics)
    result.metrics_browser_mb = buckets.browserMB
    result.metrics_renderer_mb = buckets.rendererMB
    result.metrics_gpu_mb = buckets.gpuMB
    result.metrics_other_mb = buckets.otherMB
    if (buckets.rendererPrivateMB !== undefined) {
      result.metrics_renderer_private_mb = buckets.rendererPrivateMB
    }
    if (process.platform === 'win32' && buckets.commitTotalMB !== undefined) {
      result.metrics_commit_total_mb = buckets.commitTotalMB
    }
  } catch {
    // Electron may reject metrics during shutdown.
  }
  try {
    const memory = process.getSystemMemoryInfo()
    result.sysmem_total_mb = mb(memory.total)
    result.sysmem_free_mb = mb(memory.free)
  } catch {
    // Unsupported on some platforms.
  }
  return result
}
