import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('runtime extraction regressions', () => {
  it('wires the managed Claude config directory into skill discovery', async () => {
    const runtime = new OrcaRuntimeService()
    const getRuntimeConfigDir = vi.fn(() => '/accounts/claude/managed')
    runtime.setAccountServices({
      claudeAccounts: { getRuntimeConfigDir },
      codexAccounts: {},
      rateLimits: {}
    } as never)

    await expect(
      runtime.resolveSkillDiscoveryProviderRoots({ kind: 'native-host' })
    ).resolves.toMatchObject({ claude: join('/accounts/claude/managed', 'skills') })
    expect(getRuntimeConfigDir).toHaveBeenCalledWith({ runtime: 'host' })
  })

  it('does not create orchestration state for optional lineage lookups', () => {
    const runtime = new OrcaRuntimeService()
    const createDb = vi.spyOn(runtime, 'getOrchestrationDb')
    const internal = runtime as unknown as {
      getOrchestrationDbIfAvailable(): unknown
    }

    expect(internal.getOrchestrationDbIfAvailable()).toBeNull()
    expect(createDb).not.toHaveBeenCalled()
  })
})
