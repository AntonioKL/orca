import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/run-process'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { readActiveGpuFallbackMarker, writeGpuFallbackMarker } from './gpu-fallback-marker'
import {
  probeWindowsInstallDirAcl,
  resetWindowsInstallDirAclProbeForTest
} from './windows-install-dir-acl-probe'
import {
  hasInstallDirAclPoisonMarker,
  writeInstallDirAclPoisonMarker
} from './windows-install-dir-acl-poison-marker'
import {
  describeInstallDirAclPoison,
  isBlockingInstallDirAclRepairInFlight,
  isInstallDirAclSuspect,
  noteWindowsInstallDirAclProbePending,
  repairKnownPoisonedInstallDirBeforeWindow,
  resetWindowsInstallDirAclRecoveryForTest,
  startWindowsInstallDirAclRepairIfPoisoned,
  type WindowsInstallDirAclRecoveryOptions
} from './windows-install-dir-acl-recovery'
import {
  resetWindowsInstallDirAclRepairForTest,
  WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE,
  WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION
} from './windows-install-dir-package-acl-repair'
import {
  ALL_PACKAGES_ACE,
  fakeIcaclsSpawn,
  FRENCH_BASELINE_ACES,
  FRENCH_RESTRICTED_PACKAGES_ACE,
  icaclsDacl,
  ORPHAN_PACKAGE_ACE,
  RESTRICTED_PACKAGES_ACE
} from './windows-install-dir-acl.test-fixture'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'
const APP_VERSION = '1.4.184'

type Runner = (spec: ProcessSpec) => Promise<ProcessResult>

/**
 * Drives the production path: the real probe hands its verdict to the real gate,
 * which decides whether icacls ever runs. Only the two process seams are faked.
 */
function probeThenRecover(
  dacl: (target: string) => string,
  options: { failRepair?: boolean } = {}
): Promise<ProcessSpec[]> {
  const specs: ProcessSpec[] = []
  const runProcessFn = async (spec: ProcessSpec): Promise<ProcessResult> => {
    specs.push(spec)
    return {
      code: options.failRepair === true ? 5 : 0,
      signal: null,
      stdout: 'Successfully processed 81 files; Failed processing 0 files',
      stderr: '',
      timedOut: false
    }
  }
  return new Promise((resolve) => {
    probeWindowsInstallDirAcl({
      platform: 'win32',
      installDir: INSTALL_DIR,
      fileExists: (path) => path.endsWith('ffmpeg.dll'),
      spawnFn: fakeIcaclsSpawn(dacl).spawnFn,
      recordBreadcrumb: () => undefined,
      onDone: (data) => {
        startWindowsInstallDirAclRepairIfPoisoned(data, {
          platform: 'win32',
          installDir: INSTALL_DIR,
          appVersion: APP_VERSION,
          userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-recovery-')),
          runProcessFn: runProcessFn as never,
          recordBreadcrumb: () => undefined
        })
        // Longer than the repair's own setImmediate hop, so a repair that was
        // started has always spawned by the time this resolves.
        setTimeout(() => resolve(specs), 25)
      }
    })
  })
}

describe('startWindowsInstallDirAclRepairIfPoisoned', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('repairs when the probe sees an orphan package ACE and no well-known grant', async () => {
    const specs = await probeThenRecover((target) => icaclsDacl(target, [ORPHAN_PACKAGE_ACE]))
    expect(specs.map((spec) => spec.args?.[2])).toEqual([
      '*S-1-15-2-2:(OI)(CI)(RX)',
      '*S-1-15-2-2:(RX)'
    ])
  })

  // Orphan + the Program Files ALL APPLICATION PACKAGES default launched clean on
  // win32 10.0.26200 / Electron 43.4.1, so it earns neither an ACL write nor the
  // accusing dialog copy.
  it('leaves an install whose package grant is ALL APPLICATION PACKAGES alone', async () => {
    const specs = await probeThenRecover((target) =>
      icaclsDacl(target, [ORPHAN_PACKAGE_ACE, ALL_PACKAGES_ACE])
    )
    expect(specs).toHaveLength(0)
    expect(describeInstallDirAclPoison()).toBeNull()
  })

  it('does not touch an install that already carries the restricted grant', async () => {
    const specs = await probeThenRecover((target) =>
      icaclsDacl(target, [ORPHAN_PACKAGE_ACE, RESTRICTED_PACKAGES_ACE])
    )
    expect(specs).toHaveLength(0)
    expect(describeInstallDirAclPoison()).toBeNull()
  })

  // A localized icacls prints the grant under a name the probe cannot match, so
  // the signature is unproven: neither icacls nor the accusing dialog copy.
  it('does not act on a signature from a non-English icacls', async () => {
    const specs = await probeThenRecover((target) =>
      icaclsDacl(target, [ORPHAN_PACKAGE_ACE, FRENCH_RESTRICTED_PACKAGES_ACE], FRENCH_BASELINE_ACES)
    )
    expect(specs).toHaveLength(0)
    expect(describeInstallDirAclPoison()).toBeNull()
  })

  it('does not act when the probe could not read the DACL', async () => {
    const specs = await new Promise<ProcessSpec[]>((resolve) => {
      const collected: ProcessSpec[] = []
      probeWindowsInstallDirAcl({
        platform: 'win32',
        installDir: INSTALL_DIR,
        fileExists: () => false,
        spawnFn: fakeIcaclsSpawn(() => null).spawnFn,
        recordBreadcrumb: () => undefined,
        onDone: (data) => {
          startWindowsInstallDirAclRepairIfPoisoned(data, {
            platform: 'win32',
            installDir: INSTALL_DIR,
            appVersion: APP_VERSION,
            userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-recovery-')),
            runProcessFn: (async (spec: ProcessSpec) => {
              collected.push(spec)
              throw new Error('unreachable')
            }) as never,
            recordBreadcrumb: () => undefined
          })
          setTimeout(() => resolve(collected), 25)
        }
      })
    })
    expect(specs).toHaveLength(0)
    expect(describeInstallDirAclPoison()).toBeNull()
  })
})

describe('describeInstallDirAclPoison', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('offers the copyable commands, and drops them once the repair lands', async () => {
    await probeThenRecover((target) => icaclsDacl(target, [ORPHAN_PACKAGE_ACE]))
    const repaired = describeInstallDirAclPoison()
    expect(repaired?.detail).toContain('Orca repaired the permissions')
    expect(repaired?.detail).not.toContain('Administrator Command Prompt')
    expect(repaired?.commands).toEqual([
      `icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(OI)(CI)(RX)"`,
      `icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(RX)" /T /C`
    ])
  })

  it('walks a standard user through icacls when the repair could not write', async () => {
    await probeThenRecover((target) => icaclsDacl(target, [ORPHAN_PACKAGE_ACE]), {
      failRepair: true
    })
    const failed = describeInstallDirAclPoison()
    expect(failed?.detail).toContain('needs an administrator')
    expect(failed?.detail).toContain(`icacls "${INSTALL_DIR}" /grant "*S-1-15-2-2:(RX)" /T /C`)
  })

  it('reports the repair as in flight before icacls has answered', () => {
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: true, wellKnownNameCheckReliable: true },
      {
        platform: 'win32',
        installDir: INSTALL_DIR,
        appVersion: APP_VERSION,
        userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-recovery-')),
        runProcessFn: (() => new Promise<never>(() => undefined)) as never,
        recordBreadcrumb: () => undefined
      }
    )
    expect(describeInstallDirAclPoison()?.detail).toContain('repairing the permissions now')
  })
})

const POISON_VERDICT: CrashReportBreadcrumbData = {
  status: 'ok',
  matchesPoisonSignature: true,
  wellKnownNameCheckReliable: true
}
const GPU_ENV = { appVersion: APP_VERSION, electronVersion: '43.4.1', platform: 'win32' } as const

function recoveryOptions(userDataPath: string, run: Runner): WindowsInstallDirAclRecoveryOptions {
  return {
    platform: 'win32',
    installDir: INSTALL_DIR,
    appVersion: APP_VERSION,
    userDataPath,
    runProcessFn: run as never,
    recordBreadcrumb: () => undefined
  }
}

/** icacls' real success summary, as the repair's parser expects it. */
const okRun: Runner = async () => ({
  code: 0,
  signal: null,
  stdout: 'Successfully processed 3200 files; Failed processing 0 files',
  stderr: '',
  timedOut: false
})

describe('install-dir ACL repair vs the GPU safe-graphics marker', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('clears the sticky safe-graphics marker once the real cause is repaired', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gpu-'))
    // The machine is in the reproduced state: the poisoned install DACL killed the
    // GPU child three times, so Orca latched safe graphics for this build.
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: Date.now(), crashesInWindow: 3, userConfirmed: false },
      GPU_ENV
    )
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)).not.toBeNull()

    await new Promise<void>((resolve) => {
      startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, {
        ...recoveryOptions(userDataPath, okRun),
        // Settles after the repair's own setImmediate hop and its two icacls passes.
        recordBreadcrumb: () => {
          setTimeout(resolve, 0)
          return undefined
        }
      })
    })

    expect(describeInstallDirAclPoison()?.detail).toContain('repaired the permissions')
    // The GPU child deaths were never a driver fault, so safe graphics — and the
    // --in-process-gpu launch that hides the next crash's evidence — must not outlive the repair.
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)).toBeNull()
  })

  // "Keep safe graphics" is a durable user choice with its own reasons; the repair
  // only retires the latch Orca engaged on its own.
  it('leaves a user-confirmed safe-graphics marker alone', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gpu-'))
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: Date.now(), crashesInWindow: 3, userConfirmed: true },
      GPU_ENV
    )

    await new Promise<void>((resolve) => {
      startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, {
        ...recoveryOptions(userDataPath, okRun),
        recordBreadcrumb: () => {
          setTimeout(resolve, 0)
          return undefined
        }
      })
    })

    expect(describeInstallDirAclPoison()?.detail).toContain('repaired the permissions')
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)?.userConfirmed).toBe(true)
  })
})

describe('isInstallDirAclSuspect', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('is false when nothing has suggested the install DACL is involved', () => {
    expect(isInstallDirAclSuspect()).toBe(false)
  })

  // The GPU child dies ~74ms in and the probe answers 0.9-3.0s later, so "no verdict
  // yet" is the entire window in which the misdiagnosis happens.
  it('holds while the probe verdict is outstanding, and releases on a clean verdict', () => {
    noteWindowsInstallDirAclProbePending()
    expect(isInstallDirAclSuspect()).toBe(true)

    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: false },
      recoveryOptions(mkdtempSync(join(tmpdir(), 'orca-acl-suspect-')), okRun)
    )
    expect(isInstallDirAclSuspect()).toBe(false)
  })

  it('releases once the wait exceeds the grace window, so a silent probe cannot pin it', () => {
    noteWindowsInstallDirAclProbePending()
    expect(isInstallDirAclSuspect(Date.now() + 14_000)).toBe(true)
    expect(isInstallDirAclSuspect(Date.now() + 16_000)).toBe(false)
  })

  it('holds through a repair that failed, and releases once one succeeds', async () => {
    const failing: Runner = async () => ({
      code: 5,
      signal: null,
      stdout: '',
      stderr: 'Access is denied.',
      timedOut: false
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-suspect-'))
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, failing)
    )
    expect(isInstallDirAclSuspect()).toBe(true)
    await vi.waitFor(() => expect(describeInstallDirAclPoison()?.detail).toContain('could not'))
    // Still suspect: the tree is proven poisoned, and safe graphics does not rescue it.
    expect(isInstallDirAclSuspect()).toBe(true)

    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(mkdtempSync(join(tmpdir(), 'orca-acl-suspect-')), okRun)
    )
    await vi.waitFor(() => expect(isInstallDirAclSuspect()).toBe(false))
  })
})

describe('repairKnownPoisonedInstallDirBeforeWindow', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('costs a healthy machine one absent-file read and no icacls', async () => {
    const specs: ProcessSpec[] = []
    const run: Runner = async (spec) => {
      specs.push(spec)
      return okRun(spec)
    }
    const mode = await repairKnownPoisonedInstallDirBeforeWindow(
      recoveryOptions(mkdtempSync(join(tmpdir(), 'orca-acl-gate-')), run)
    )
    expect(mode).toBe('not-marked')
    expect(specs).toHaveLength(0)
  })

  // The crash this fixes: launch 1 detects the poison but createMainWindow already
  // ran, so the renderer is dead before icacls is spawned. Launch 2 must not repeat it.
  it('repairs a launch that a previous one recorded as poisoned, before returning', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-'))
    // Launch 1: the probe reports poison and the app dies mid-repair.
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, (() => new Promise<never>(() => undefined)) as Runner)
    )
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)

    // Launch 2.
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: Date.now(), crashesInWindow: 3, userConfirmed: false },
      GPU_ENV
    )
    const specs: ProcessSpec[] = []
    const run: Runner = async (spec) => {
      specs.push(spec)
      return okRun(spec)
    }
    const mode = await repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, run))
    expect(mode).toBe('repaired')
    // Both passes have already run by the time the window may be created.
    expect(specs.map((spec) => spec.args?.[2])).toEqual([
      '*S-1-15-2-2:(OI)(CI)(RX)',
      '*S-1-15-2-2:(RX)'
    ])
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(false)
    expect(readActiveGpuFallbackMarker(userDataPath, GPU_ENV)).toBeNull()
  })

  it('gives up on its budget rather than holding the window open forever', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-'))
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, (() => new Promise<never>(() => undefined)) as Runner)
    )
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()

    const mode = await repairKnownPoisonedInstallDirBeforeWindow({
      ...recoveryOptions(userDataPath, (() => new Promise<never>(() => undefined)) as Runner),
      timeoutMs: 20
    })
    expect(mode).toBe('timeout')
  })

  it('is a no-op off win32 and in serve mode', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-'))
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, (() => new Promise<never>(() => undefined)) as Runner)
    )
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()

    expect(
      await repairKnownPoisonedInstallDirBeforeWindow({
        ...recoveryOptions(userDataPath, okRun),
        platform: 'darwin'
      })
    ).toBe('skipped')
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow({
        ...recoveryOptions(userDataPath, okRun),
        isServeMode: true
      })
    ).toBe('skipped')
  })

  it('retires the marker when a later probe reports the install clean', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-'))
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, (() => new Promise<never>(() => undefined)) as Runner)
    )
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)

    resetWindowsInstallDirAclRecoveryForTest()
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: false },
      recoveryOptions(userDataPath, okRun)
    )
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(false)
  })

  // An unreadable DACL is not evidence of health; forgetting the verdict there would
  // hand the next launch straight back to the crash it already recorded.
  it('keeps the marker when the probe could not read the DACL', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-gate-'))
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, (() => new Promise<never>(() => undefined)) as Runner)
    )
    resetWindowsInstallDirAclRecoveryForTest()
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'failed', reason: 'all-targets-unreadable' },
      recoveryOptions(userDataPath, okRun)
    )
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
  })
})

// hasMarkerFor also matches a marker written by a SUCCESSFUL repair, so 'marker-hit'
// on its own cannot tell a finished tree from one Orca gave up on.
describe('a marker-hit on a tree a previous launch already repaired', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('reads as repaired, not as a repair Orca could not do', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-repaired-hit-'))
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, okRun))
    ).toBe('repaired')

    // The state a launch killed between the repair and the marker clear leaves behind.
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    const spent: ProcessSpec[] = []
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow(
        recoveryOptions(userDataPath, async (spec) => {
          spent.push(spec)
          return okRun(spec)
        })
      )
    ).toBe('marker-hit')
    expect(spent).toHaveLength(0)
    expect(isInstallDirAclSuspect()).toBe(false)
    expect(describeInstallDirAclPoison()?.detail).toContain('Orca repaired the permissions')
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(false)
  })

  // The opposite evidence: the probe has just READ this tree and found it poisoned, so a
  // marker claiming success describes a tree that was re-poisoned, or an icacls run that
  // silently no-opped. Reporting 'repaired' there runs no icacls, deletes the poison marker
  // that arms the next launch's gate, un-suspects the tree so --in-process-gpu can engage,
  // and tells the user their permissions are fixed.
  it('re-runs icacls when a fresh probe verdict contradicts the repaired marker', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-repoisoned-'))
    writeInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, okRun))
    ).toBe('repaired')

    // Next launch: the gate is disarmed, and the probe reads the same tree as poisoned.
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    const spent: ProcessSpec[] = []
    const failing: Runner = async (spec) => {
      spent.push(spec)
      return { code: 5, signal: null, stdout: '', stderr: 'Access is denied.', timedOut: false }
    }
    await new Promise<void>((resolve) => {
      startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, {
        ...recoveryOptions(userDataPath, failing),
        recordBreadcrumb: () => {
          setTimeout(resolve, 0)
          return undefined
        }
      })
    })

    expect(spent.map((spec) => spec.args?.[2])).toEqual([
      '*S-1-15-2-2:(OI)(CI)(RX)',
      '*S-1-15-2-2:(RX)'
    ])
    expect(isInstallDirAclSuspect()).toBe(true)
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
    expect(describeInstallDirAclPoison()?.detail).toContain('could not repair them')
  })

  // The contradiction re-opens the budget, it does not remove it: a tree that has spent
  // every attempt must not re-spawn icacls on every launch forever.
  it('still stops at the attempt budget when the probe keeps reporting poison', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-repoisoned-budget-'))
    writeFileSync(
      join(userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE),
      JSON.stringify({
        schemeVersion: WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION,
        installDir: INSTALL_DIR,
        appVersion: APP_VERSION,
        attemptedAt: Date.now(),
        outcome: 'repaired',
        attempts: 3
      })
    )
    const spent: ProcessSpec[] = []
    const run: Runner = async (spec) => {
      spent.push(spec)
      return okRun(spec)
    }
    await new Promise<void>((resolve) => {
      startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, {
        ...recoveryOptions(userDataPath, run),
        recordBreadcrumb: () => {
          setTimeout(resolve, 0)
          return undefined
        }
      })
    })

    expect(spent).toHaveLength(0)
    // Nothing was repaired, so the user still gets the commands and the gate stays armed.
    expect(isInstallDirAclSuspect()).toBe(true)
    expect(describeInstallDirAclPoison()?.detail).toContain('could not repair them')
    expect(hasInstallDirAclPoisonMarker(userDataPath, INSTALL_DIR, APP_VERSION)).toBe(true)
  })
})

describe('a clean probe verdict', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  // The launch this covers: the repair budget is spent, so the gate can only report
  // 'marker-hit' — and then the probe reads the tree and finds it healthy.
  it('retires a verdict the gate could no longer act on', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-clean-'))
    writeFileSync(
      join(userDataPath, WINDOWS_INSTALL_DIR_ACL_REPAIR_MARKER_FILE),
      JSON.stringify({
        schemeVersion: WINDOWS_INSTALL_DIR_ACL_REPAIR_SCHEME_VERSION,
        installDir: INSTALL_DIR,
        appVersion: APP_VERSION,
        attemptedAt: Date.now(),
        outcome: 'failed',
        attempts: 3
      })
    )
    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, (() => new Promise<never>(() => undefined)) as Runner)
    )
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()
    expect(
      await repairKnownPoisonedInstallDirBeforeWindow(recoveryOptions(userDataPath, okRun))
    ).toBe('marker-hit')
    expect(isInstallDirAclSuspect()).toBe(true)

    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: false },
      recoveryOptions(userDataPath, okRun)
    )
    // Neither the driver fallback stays suppressed nor does the dialog accuse a healthy folder.
    expect(isInstallDirAclSuspect()).toBe(false)
    expect(describeInstallDirAclPoison()).toBeNull()
  })

  // The probe answers while the repair is still walking the tree: 'failed' from a
  // repair with nothing left to fix must not re-accuse an install just read clean.
  it('outranks a repair verdict that lands after it', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-clean-'))
    const failing: Runner = async () => ({
      code: 5,
      signal: null,
      stdout: '',
      stderr: 'Access is denied.',
      timedOut: false
    })
    let repairSettled = false
    startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, {
      ...recoveryOptions(userDataPath, failing),
      recordBreadcrumb: () => {
        repairSettled = true
        return undefined
      }
    })
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: false },
      recoveryOptions(userDataPath, okRun)
    )
    await vi.waitFor(() => expect(repairSettled).toBe(true))
    expect(isInstallDirAclSuspect()).toBe(false)
    expect(describeInstallDirAclPoison()).toBeNull()
  })
})

describe('the probe-pending grace window', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  // openMainWindow re-runs on every tray/second-instance reopen while the probe is
  // once-per-process, so a re-arm would wait 15s on a verdict that already landed
  // and drop every GPU child crash in between.
  it('is armed by a dispatched probe only, so a reopen cannot re-arm it', async () => {
    const probeArgs = {
      platform: 'win32' as const,
      installDir: INSTALL_DIR,
      fileExists: () => false,
      spawnFn: fakeIcaclsSpawn((target) => icaclsDacl(target, [RESTRICTED_PACKAGES_ACE])).spawnFn,
      recordBreadcrumb: () => undefined
    }
    let settleVerdict: () => void = () => undefined
    const verdict = new Promise<void>((resolve) => (settleVerdict = resolve))
    // Launch, wired exactly as main-window-controller wires it.
    const dispatched = probeWindowsInstallDirAcl({
      ...probeArgs,
      onDone: (data) => {
        startWindowsInstallDirAclRepairIfPoisoned(
          data,
          recoveryOptions(mkdtempSync(join(tmpdir(), 'orca-acl-rearm-')), okRun)
        )
        settleVerdict()
      }
    })
    if (dispatched) {
      noteWindowsInstallDirAclProbePending()
    }
    expect(dispatched).toBe(true)
    expect(isInstallDirAclSuspect()).toBe(true)
    await verdict
    expect(isInstallDirAclSuspect()).toBe(false)

    // Reopen: the probe declines, so nothing arms the grace window again.
    const reopened = probeWindowsInstallDirAcl({ ...probeArgs, onDone: () => undefined })
    if (reopened) {
      noteWindowsInstallDirAclProbePending()
    }
    expect(reopened).toBe(false)
    expect(isInstallDirAclSuspect()).toBe(false)
    expect(isInstallDirAclSuspect(Date.now() + 14_000)).toBe(false)
  })
})

describe('isBlockingInstallDirAclRepairInFlight', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclProbeForTest()
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
  })

  it('is false on a healthy machine and clears once the gate returns', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-inflight-'))
    expect(isBlockingInstallDirAclRepairInFlight()).toBe(false)

    startWindowsInstallDirAclRepairIfPoisoned(
      POISON_VERDICT,
      recoveryOptions(userDataPath, (() => new Promise<never>(() => undefined)) as Runner)
    )
    resetWindowsInstallDirAclRecoveryForTest()
    resetWindowsInstallDirAclRepairForTest()

    let inFlightDuringRepair = false
    const gate = repairKnownPoisonedInstallDirBeforeWindow({
      ...recoveryOptions(userDataPath, async (spec) => {
        inFlightDuringRepair = isBlockingInstallDirAclRepairInFlight()
        return okRun(spec)
      }),
      timeoutMs: 5_000
    })
    expect(await gate).toBe('repaired')
    expect(inFlightDuringRepair).toBe(true)
    expect(isBlockingInstallDirAclRepairInFlight()).toBe(false)
  })

  // A second entry has no `onDone` coming, so waiting out the 20s budget for it
  // would hold the window closed for nothing.
  it('returns immediately when the once-per-process repair already ran', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-acl-inflight-'))
    startWindowsInstallDirAclRepairIfPoisoned(POISON_VERDICT, recoveryOptions(userDataPath, okRun))
    resetWindowsInstallDirAclRecoveryForTest()

    const mode = await repairKnownPoisonedInstallDirBeforeWindow({
      ...recoveryOptions(userDataPath, okRun),
      timeoutMs: 30_000
    })
    expect(mode).toBe('skipped')
    expect(isBlockingInstallDirAclRepairInFlight()).toBe(false)
  })
})
