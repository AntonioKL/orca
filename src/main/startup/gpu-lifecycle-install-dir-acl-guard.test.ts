import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted with the vi.mock factory below. 'Keep Running' — the prompt firing at all is the signal.
const { showMessageBox, userData } = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  userData: { path: '' }
}))

// Why the mocks: gpu-lifecycle's import graph reaches electron and the toolkit's
// electron re-export. Everything below this is the real module under test.
vi.mock('electron', () => ({
  app: {
    getPath: () => userData.path,
    getVersion: () => '1.4.184',
    getGPUFeatureStatus: () => ({}),
    setAboutPanelOptions: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    isReady: () => true,
    exit: vi.fn(),
    on: vi.fn(),
    name: 'Orca'
  },
  dialog: { showMessageBox }
}))
vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
  optimizer: { watchWindowShortcuts: vi.fn() },
  electronApp: { setAppUserModelId: vi.fn() }
}))

import type { ProcessResult, ProcessSpec } from '../../shared/child-process/run-process'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker
} from '../crash-reporting/gpu-crash-fallback-decision'
import { readGpuFallbackMarker } from './gpu-fallback-marker'
import { handleGpuChildCrash } from './gpu-lifecycle'
import { mainProcessState as state } from './main-process-state'
import {
  noteWindowsInstallDirAclProbePending,
  resetWindowsInstallDirAclRecoveryForTest,
  startWindowsInstallDirAclRepairIfPoisoned
} from './windows-install-dir-acl-recovery'
import { resetWindowsInstallDirAclRepairForTest } from './windows-install-dir-package-acl-repair'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'

function recoveryOptions(): {
  platform: 'win32'
  installDir: string
  appVersion: string
  userDataPath: string
  recordBreadcrumb: () => void
} {
  return {
    platform: 'win32',
    installDir: INSTALL_DIR,
    appVersion: '1.4.184',
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-gpu-guard-')),
    recordBreadcrumb: () => undefined
  }
}

function reportProbePoisoned(): void {
  startWindowsInstallDirAclRepairIfPoisoned(
    { status: 'ok', matchesPoisonSignature: true, wellKnownNameCheckReliable: true },
    {
      ...recoveryOptions(),
      // Never settles: the repair is still in flight, which is when the GPU children die.
      runProcessFn: (() => new Promise<ProcessResult>(() => undefined)) as unknown as (
        spec: ProcessSpec
      ) => Promise<ProcessResult>
    }
  )
}

function reportProbeClean(): void {
  startWindowsInstallDirAclRepairIfPoisoned(
    { status: 'ok', matchesPoisonSignature: false },
    recoveryOptions()
  )
}

/** One short of the fallback threshold, so the caller's next crash is the decisive one. */
async function crashUpToThreshold(): Promise<void> {
  for (let i = 1; i < DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD; i += 1) {
    await handleGpuChildCrash('crashed', null, i * 200)
  }
}

/**
 * Driven end-to-end against the real tracker rather than asserted against the source:
 * a source match is equally happy with the polarity inverted, and the property that
 * matters is that a driver burst survives the ACL verdict either way.
 */
describe('handleGpuChildCrash vs the install-dir ACL verdict', () => {
  let tracker: GpuCrashFallbackTracker
  const realPlatform = process.platform

  beforeAll(() => {
    // The whole guard is win32-only, and so is the safe-graphics marker it writes.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  beforeEach(() => {
    userData.path = mkdtempSync(join(tmpdir(), 'orca-acl-gpu-userdata-'))
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
    showMessageBox.mockClear()
    state.isQuitting = false
    state.isServeMode = false
    state.gpuFallbackActiveThisLaunch = false
    tracker = new GpuCrashFallbackTracker({
      windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
      threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
    })
    state.gpuCrashFallbackTracker = tracker
  })

  it('engages safe graphics on a driver burst when nothing implicates the install DACL', async () => {
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  // The regression this guard must never reintroduce: the probe is armed on every
  // win32 launch, so a burst landing inside its window is the common driver case.
  it('keeps counting crashes that land while the probe verdict is outstanding', async () => {
    noteWindowsInstallDirAclProbePending()
    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).not.toHaveBeenCalled()
    reportProbeClean()
    await decisive
    expect(tracker.windowSnapshot()).toHaveLength(DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('withholds safe graphics while the install DACL is the suspect, but keeps the evidence', async () => {
    reportProbePoisoned()
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(tracker.windowSnapshot()).toHaveLength(DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('withholds safe graphics when the outstanding verdict comes back poisoned', async () => {
    noteWindowsInstallDirAclProbePending()
    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    reportProbePoisoned()
    await decisive
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  // Chromium aborts the browser on the 6th GPU crash, sooner than the probe can answer,
  // so the wait must not be the reason a machine comes back hardware-accelerated.
  it('holds an unconfirmed safe-graphics marker on disk across the wait', async () => {
    noteWindowsInstallDirAclProbePending()
    await crashUpToThreshold()
    const decisive = handleGpuChildCrash('crashed', null, 600)
    expect(readGpuFallbackMarker(userData.path)?.userConfirmed).toBe(false)
    reportProbePoisoned()
    await decisive
    expect(readGpuFallbackMarker(userData.path)).toBeNull()
  })

  it('engages immediately once the probe has already reported the install clean', async () => {
    noteWindowsInstallDirAclProbePending()
    reportProbeClean()
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  // recordGpuCrash reports the threshold crossing once and latches. Withholding consumes
  // that one report, so without a re-arm the same process could never engage again — a
  // machine whose tree is repaired and whose driver is genuinely broken would be stuck
  // hardware-accelerated through an unbounded crash loop.
  it('can still engage a later burst after a withheld one, once the tree is repaired', async () => {
    reportProbePoisoned()
    await crashUpToThreshold()
    await handleGpuChildCrash('crashed', null, 600)
    expect(showMessageBox).not.toHaveBeenCalled()

    // The repair lands: the tree is no longer the suspect.
    reportProbeClean()

    for (let i = 1; i <= DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD; i += 1) {
      await handleGpuChildCrash('crashed', null, 10_000 + i * 200)
    }
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })
})
