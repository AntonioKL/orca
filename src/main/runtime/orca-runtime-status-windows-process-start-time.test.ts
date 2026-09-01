import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const { isWindowsProcessStartTimeAvailable } = vi.hoisted(() => ({
  isWindowsProcessStartTimeAvailable: vi.fn(() => true)
}))

vi.mock('../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isWindowsProcessStartTimeAvailable
}))

const hostPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

afterEach(() => {
  setPlatform(hostPlatform)
  isWindowsProcessStartTimeAvailable.mockReturnValue(true)
})

// Why this is load-bearing: the renderer's structured native-chat gate fails closed on
// win32 unless the host publishes this field, so dropping the producer silently disables
// structured chat for every Windows client with no red test anywhere else.
describe('runtime status windows process start-time proof', () => {
  it('publishes the proof when a Windows host can read process start times', () => {
    setPlatform('win32')
    expect(new OrcaRuntimeService().getStatus().windowsProcessStartTimeAvailable).toBe(true)
  })

  it('omits the proof when a Windows host cannot read process start times', () => {
    setPlatform('win32')
    isWindowsProcessStartTimeAvailable.mockReturnValue(false)
    expect(new OrcaRuntimeService().getStatus()).not.toHaveProperty(
      'windowsProcessStartTimeAvailable'
    )
  })

  it('omits the proof off Windows', () => {
    setPlatform('darwin')
    expect(new OrcaRuntimeService().getStatus()).not.toHaveProperty(
      'windowsProcessStartTimeAvailable'
    )
  })
})
