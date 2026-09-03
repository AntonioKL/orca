import { mkdtempSync, readFileSync } from 'node:fs'
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
import { hasInstallDirAclPoisonMarker } from './windows-install-dir-acl-poison-marker'
import {
  describeInstallDirAclPoison,
  isInstallDirAclSuspect,
  noteWindowsInstallDirAclProbePending,
  repairKnownPoisonedInstallDirBeforeWindow,
  resetWindowsInstallDirAclRecoveryForTest,
  startWindowsInstallDirAclRepairIfPoisoned,
  type WindowsInstallDirAclRecoveryOptions
} from './windows-install-dir-acl-recovery'
import { resetWindowsInstallDirAclRepairForTest } from './windows-install-dir-package-acl-repair'
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

/**
 * Why a source assertion: gpu-lifecycle's transitive import graph reaches the real
 * `electron` binding, so the guard cannot be driven in-process. This pins the one
 * thing that matters — the ACL verdict is consulted before the crash is counted
 * towards the burst that latches safe graphics.
 */
describe('handleGpuChildCrash call site', () => {
  it('consults the install-dir ACL verdict before counting the crash', () => {
    const source = readFileSync(join(__dirname, 'gpu-lifecycle.ts'), 'utf8')
    const start = source.indexOf('export async function handleGpuChildCrash')
    const countIndex = source.indexOf('recordGpuCrash(', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(countIndex).toBeGreaterThan(start)
    expect(source.slice(start, countIndex)).toContain('isInstallDirAclSuspect()')
  })
})
