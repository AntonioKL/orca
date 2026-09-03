import { dirname } from 'node:path'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { logStartupMilestone } from './startup-diagnostics'
import { clearGpuFallbackMarker, readGpuFallbackMarker } from './gpu-fallback-marker'
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
/** A positive clean DACL reading; outranks any repair verdict about a tree with nothing to fix. */
let installDirReadClean = false
let blockingRepairInFlight = false
const verdictWaiters = new Set<() => void>()

function settleVerdictWaiters(): void {
  // `wake` deletes only itself, which is safe to do on the entry being visited.
  for (const wake of verdictWaiters) {
    wake()
  }
  verdictWaiters.clear()
}

export function resetWindowsInstallDirAclRecoveryForTest(): void {
  poison = null
  probePendingSince = null
  installDirReadClean = false
  blockingRepairInFlight = false
  settleVerdictWaiters()
}

/** Call when the install-DACL probe is dispatched: its verdict is not in yet. */
export function noteWindowsInstallDirAclProbePending(): void {
  probePendingSince = Date.now()
}

/**
 * Resolves when the probe's verdict lands, or when its grace window runs out.
 * For callers that must not act on a suspicion the probe is about to withdraw.
 */
export function waitForInstallDirAclVerdict(now: number = Date.now()): Promise<void> {
  const remainingMs =
    probePendingSince === null ? 0 : PROBE_VERDICT_GRACE_MS - (now - probePendingSince)
  if (remainingMs <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer)
      verdictWaiters.delete(wake)
      resolve()
    }
    const timer = setTimeout(wake, remainingMs)
    timer.unref?.()
    verdictWaiters.add(wake)
  })
}

/**
 * True while a sandboxed-child death could be the install DACL rather than the
 * graphics driver. Safe graphics does not rescue a poisoned tree — it still kills
 * the renderer — and it removes the GPU child, erasing the sibling-death evidence
 * that is the only way to recognise the shape in a crash report.
 */
export function isInstallDirAclSuspect(now: number = Date.now()): boolean {
  if (installDirReadClean) {
    return false
  }
  if (poison) {
    return poison.stage !== 'repaired'
  }
  return probePendingSince !== null && now - probePendingSince < PROBE_VERDICT_GRACE_MS
}

/**
 * True while a repair for this tree is dispatched and has not reported yet.
 *
 * Why it is not the same question as `isInstallDirAclSuspect`: a suspect tree we are
 * actively repairing is one a *future* launch can still be rescued on, so the safe-graphics
 * marker earns its keep there — a launch Chromium FATALs mid-repair comes back software
 * rendered, stops spawning the GPU children that trigger the FATAL, and lets the next gate
 * run to completion. A terminal verdict has no such next step.
 */
export function isInstallDirAclRepairPending(): boolean {
  return poison?.stage === 'pending'
}

/** True while the pre-window gate is rewriting the very files a new renderer would load. */
export function isBlockingInstallDirAclRepairInFlight(): boolean {
  return blockingRepairInFlight
}

/** False when the once-per-process repair had already been dispatched, so no `onDone` is coming. */
function startRepair(
  installDir: string,
  options: WindowsInstallDirAclRecoveryOptions,
  onDone?: (result: WindowsInstallDirAclRepairResult) => void
): boolean {
  writeInstallDirAclPoisonMarker(options.userDataPath, installDir, options.appVersion)
  const started = repairWindowsInstallDirPackageAcl({
    ...options,
    installDir,
    onDone: (result) => {
      // A marker recording a completed repair is not a failure to repair: this tree is done.
      const stage: RepairStage =
        result.mode === 'marker-hit' && result.alreadyRepaired ? 'repaired' : result.mode
      // A clean reading of the tree outranks this: there was nothing left to repair.
      if (!installDirReadClean) {
        poison = { installDir, stage }
      }
      logStartupMilestone('install-dir-acl-repair-done', { mode: result.mode })
      if (stage === 'repaired') {
        clearInstallDirAclPoisonMarker(options.userDataPath)
        // The GPU child deaths were never a driver fault, so safe graphics — and the
        // --in-process-gpu launch that hides the next crash's evidence — must not outlive the repair.
        // Never a user-confirmed marker: "keep safe graphics" is a choice, not Orca's latch.
        if (readGpuFallbackMarker(options.userDataPath)?.userConfirmed === false) {
          clearGpuFallbackMarker(options.userDataPath)
        }
      }
      if (result.mode === 'failed') {
        console.warn('[win32-acl] install dir package ACL repair failed:', result.reason)
      }
      onDone?.(result)
    }
  })
  if (started) {
    poison = { installDir, stage: 'pending' }
  }
  return started
}

/** The probe's `onDone`: no-op unless the machine is in the reproduced state. */
export function startWindowsInstallDirAclRepairIfPoisoned(
  data: CrashReportBreadcrumbData,
  options: WindowsInstallDirAclRecoveryOptions
): void {
  probePendingSince = null
  try {
    applyInstallDirAclProbeVerdict(data, options)
  } finally {
    // Only after the verdict is applied: a waiter wakes to re-read `isInstallDirAclSuspect()`.
    settleVerdictWaiters()
  }
}

function applyInstallDirAclProbeVerdict(
  data: CrashReportBreadcrumbData,
  options: WindowsInstallDirAclRecoveryOptions
): void {
  if (!isInstallDirAclPoisonVerdict(data)) {
    // Only a positive clean reading retires the verdict; an unreadable DACL proves nothing.
    if (data.matchesPoisonSignature === false) {
      clearInstallDirAclPoisonMarker(options.userDataPath)
      installDirReadClean = true
      // Keeping 'repaired' costs nothing and is what tells the user to reload; anything
      // else would go on suppressing the driver fallback and accusing a healthy folder.
      if (poison?.stage !== 'repaired') {
        poison = null
      }
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
  blockingRepairInFlight = true
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve('timeout'),
        options.timeoutMs ?? BLOCKING_REPAIR_BUDGET_MS
      )
      timer.unref?.()
      const started = startRepair(installDir, options, (result) => {
        clearTimeout(timer)
        resolve(result.mode)
      })
      // No dispatch means no `onDone`, so waiting out the whole budget would buy nothing.
      if (!started) {
        clearTimeout(timer)
        resolve('skipped')
      }
    })
  } catch (error) {
    // This sits in the critical path ahead of window creation; it must never throw into it.
    console.warn('[win32-acl] blocking install dir ACL repair faulted:', error)
    return 'skipped'
  } finally {
    blockingRepairInFlight = false
  }
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
