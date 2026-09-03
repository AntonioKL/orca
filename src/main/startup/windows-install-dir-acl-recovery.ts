import { dirname } from 'node:path'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { logStartupMilestone } from './startup-diagnostics'
import { clearGpuFallbackMarker } from './gpu-fallback-marker'
import {
  clearInstallDirAclPoisonMarker,
  hasInstallDirAclPoisonMarker,
  writeInstallDirAclPoisonMarker
} from './windows-install-dir-acl-poison-marker'
import {
  buildInstallDirAclRepairCommands,
  isInstallDirAclPoisonVerdict,
  repairWindowsInstallDirPackageAcl,
  type WindowsInstallDirAclRepairArgs,
  type WindowsInstallDirAclRepairResult
} from './windows-install-dir-package-acl-repair'

/**
 * Joins the read-only install-DACL probe to the repair, and keeps the verdict so
 * the renderer-recovery dialog can say what is actually wrong instead of blaming
 * the graphics driver. See `windows-install-dir-package-acl-repair.ts`.
 */

export type InstallDirAclPoisonDiagnosis = {
  /** Dialog copy; ends with the commands when the user has to run them. */
  detail: string
  commands: string[]
}

export type WindowsInstallDirAclRecoveryOptions = Omit<WindowsInstallDirAclRepairArgs, 'onDone'>

type RepairStage = WindowsInstallDirAclRepairResult['mode'] | 'pending'

/** Long enough for the ~4-13s repair measured on real hosts, short enough to still be a launch. */
const BLOCKING_REPAIR_BUDGET_MS = 20_000
/** A probe that never answers must not suppress the driver fallback for the session. */
const PROBE_VERDICT_GRACE_MS = 15_000

let poison: { installDir: string; stage: RepairStage } | null = null
let probePendingSince: number | null = null

export function resetWindowsInstallDirAclRecoveryForTest(): void {
  poison = null
  probePendingSince = null
}

/** Call when the install-DACL probe is dispatched: its verdict is not in yet. */
export function noteWindowsInstallDirAclProbePending(): void {
  probePendingSince = Date.now()
}

/**
 * True while a sandboxed-child death could be the install DACL rather than the
 * graphics driver. Safe graphics does not rescue a poisoned tree — it still kills
 * the renderer — and it removes the GPU child, erasing the sibling-death evidence
 * that is the only way to recognise the shape in a crash report.
 */
export function isInstallDirAclSuspect(now: number = Date.now()): boolean {
  if (poison) {
    return poison.stage !== 'repaired'
  }
  return probePendingSince !== null && now - probePendingSince < PROBE_VERDICT_GRACE_MS
}

function startRepair(
  installDir: string,
  options: WindowsInstallDirAclRecoveryOptions,
  onDone?: (result: WindowsInstallDirAclRepairResult) => void
): void {
  poison = { installDir, stage: 'pending' }
  writeInstallDirAclPoisonMarker(options.userDataPath, installDir, options.appVersion)
  repairWindowsInstallDirPackageAcl({
    ...options,
    installDir,
    onDone: (result) => {
      poison = { installDir, stage: result.mode }
      logStartupMilestone('install-dir-acl-repair-done', { mode: result.mode })
      if (result.mode === 'repaired') {
        clearInstallDirAclPoisonMarker(options.userDataPath)
        // The GPU child deaths were never a driver fault, so safe graphics — and the
        // --in-process-gpu launch that hides the next crash's evidence — must not outlive the repair.
        clearGpuFallbackMarker(options.userDataPath)
      }
      if (result.mode === 'failed') {
        console.warn('[win32-acl] install dir package ACL repair failed:', result.reason)
      }
      onDone?.(result)
    }
  })
}

/** The probe's `onDone`: no-op unless the machine is in the reproduced state. */
export function startWindowsInstallDirAclRepairIfPoisoned(
  data: CrashReportBreadcrumbData,
  options: WindowsInstallDirAclRecoveryOptions
): void {
  probePendingSince = null
  if (!isInstallDirAclPoisonVerdict(data)) {
    // Only a positive clean reading retires the marker; an unreadable DACL proves nothing.
    if (data.matchesPoisonSignature === false) {
      clearInstallDirAclPoisonMarker(options.userDataPath)
    }
    return
  }
  // The blocking pre-window gate may already own this launch's repair; restarting it
  // would reset the verdict to 'pending' against a repair that can no longer report.
  if (poison) {
    return
  }
  startRepair(options.installDir ?? dirname(process.execPath), options)
}

/**
 * Pre-window gate for a machine a previous launch already found poisoned.
 *
 * Why blocking, and why only here: the probe is `setImmediate`-deferred and takes
 * 0.9-3.0s on the affected hosts, while the renderer it has to save is spawned
 * synchronously by `createMainWindow` and dies at init 48-1373ms in. The
 * persisted verdict is what buys that knowledge for free — a healthy machine
 * reads one absent file and pays nothing.
 */
export async function repairKnownPoisonedInstallDirBeforeWindow(
  options: WindowsInstallDirAclRecoveryOptions & { timeoutMs?: number }
): Promise<'not-marked' | 'skipped' | WindowsInstallDirAclRepairResult['mode'] | 'timeout'> {
  if ((options.platform ?? process.platform) !== 'win32' || options.isServeMode === true) {
    return 'skipped'
  }
  const installDir = options.installDir ?? dirname(process.execPath)
  if (!hasInstallDirAclPoisonMarker(options.userDataPath, installDir, options.appVersion)) {
    return 'not-marked'
  }
  logStartupMilestone('install-dir-acl-repair-blocking-start')
  return await new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve('timeout'),
      options.timeoutMs ?? BLOCKING_REPAIR_BUDGET_MS
    )
    timer.unref?.()
    startRepair(installDir, options, (result) => {
      clearTimeout(timer)
      resolve(result.mode)
    })
  })
}

const CAUSE =
  "Windows permissions on Orca's install folder are blocking its own sandboxed processes from reading the files it shipped with."

// Why the exact commands: the window is blank, so the dialog is the only place a user can be told what to run.
export function describeInstallDirAclPoison(): InstallDirAclPoisonDiagnosis | null {
  if (!poison) {
    return null
  }
  const commands = buildInstallDirAclRepairCommands(poison.installDir)
  if (poison.stage === 'repaired') {
    return { detail: `${CAUSE}\n\nOrca repaired the permissions. Reload to use them.`, commands }
  }
  const status =
    poison.stage === 'pending'
      ? 'Orca is repairing the permissions now.'
      : 'Orca could not repair them, which usually means the folder needs an administrator.'
  return {
    detail: `${CAUSE} ${status}\n\nRun these in an Administrator Command Prompt, then relaunch Orca:\n\n${commands.join('\n')}`,
    commands
  }
}
