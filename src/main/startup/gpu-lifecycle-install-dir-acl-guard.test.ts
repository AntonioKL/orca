import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Why the mocks: gpu-lifecycle's import graph reaches electron and the toolkit's
// electron re-export. Everything below this is the real module under test.
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getVersion: () => '1.4.184',
    getGPUFeatureStatus: () => ({}),
    setAboutPanelOptions: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    isReady: () => true,
    exit: vi.fn(),
    on: vi.fn(),
    name: 'Orca'
  }
}))
vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
  optimizer: { watchWindowShortcuts: vi.fn() },
  electronApp: { setAppUserModelId: vi.fn() }
}))

import type { ProcessResult, ProcessSpec } from '../../shared/child-process/run-process'
import { handleGpuChildCrash } from './gpu-lifecycle'
import { mainProcessState as state } from './main-process-state'
import {
  noteWindowsInstallDirAclProbePending,
  resetWindowsInstallDirAclRecoveryForTest,
  startWindowsInstallDirAclRepairIfPoisoned
} from './windows-install-dir-acl-recovery'
import { resetWindowsInstallDirAclRepairForTest } from './windows-install-dir-package-acl-repair'

const INSTALL_DIR = 'C:\\Users\\neil\\AppData\\Local\\Programs\\orca'

function stubTracker(): { recordGpuCrash: ReturnType<typeof vi.fn> } {
  const tracker = {
    recordGpuCrash: vi.fn(() => ({ shouldEngageFallback: false, crashesInWindow: 1 }))
  }
  state.gpuCrashFallbackTracker = tracker as never
  return tracker
}

function markPoisoned(): void {
  startWindowsInstallDirAclRepairIfPoisoned(
    { status: 'ok', matchesPoisonSignature: true, wellKnownNameCheckReliable: true },
    {
      platform: 'win32',
      installDir: INSTALL_DIR,
      appVersion: '1.4.184',
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-gpu-guard-')),
      // Never settles: the repair is still in flight, which is when the GPU children die.
      runProcessFn: (() => new Promise<ProcessResult>(() => undefined)) as unknown as (
        spec: ProcessSpec
      ) => Promise<ProcessResult>,
      recordBreadcrumb: () => undefined
    }
  )
}

/**
 * The guard suppresses Orca's shipped safe-graphics fallback on every platform, so
 * it is driven here rather than asserted against the source: a source match is
 * equally happy with the polarity inverted.
 */
describe('handleGpuChildCrash vs the install-dir ACL verdict', () => {
  beforeEach(() => {
    resetWindowsInstallDirAclRepairForTest()
    resetWindowsInstallDirAclRecoveryForTest()
    state.isQuitting = false
    state.isServeMode = false
    state.gpuFallbackActiveThisLaunch = false
  })

  it('counts the crash towards safe graphics when nothing implicates the install DACL', async () => {
    const tracker = stubTracker()
    await handleGpuChildCrash('crashed', null, 1_000)
    expect(tracker.recordGpuCrash).toHaveBeenCalledWith(1_000)
  })

  it('drops the crash while the install DACL is the suspect', async () => {
    const tracker = stubTracker()
    markPoisoned()
    await handleGpuChildCrash('crashed', null, 1_000)
    expect(tracker.recordGpuCrash).not.toHaveBeenCalled()
  })

  it('drops the crash while the probe verdict is still outstanding', async () => {
    const tracker = stubTracker()
    noteWindowsInstallDirAclProbePending()
    await handleGpuChildCrash('crashed', null, 1_000)
    expect(tracker.recordGpuCrash).not.toHaveBeenCalled()
  })

  // The suppression is the dangerous half: a machine the probe cleared must go
  // straight back to counting driver crashes.
  it('resumes counting once the probe reports the install clean', async () => {
    const tracker = stubTracker()
    noteWindowsInstallDirAclProbePending()
    startWindowsInstallDirAclRepairIfPoisoned(
      { status: 'ok', matchesPoisonSignature: false },
      {
        platform: 'win32',
        installDir: INSTALL_DIR,
        appVersion: '1.4.184',
        userDataPath: mkdtempSync(join(tmpdir(), 'orca-acl-gpu-guard-')),
        recordBreadcrumb: () => undefined
      }
    )
    await handleGpuChildCrash('crashed', null, 1_000)
    expect(tracker.recordGpuCrash).toHaveBeenCalledWith(1_000)
  })
})
