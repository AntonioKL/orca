// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GpuFallbackStatus as Status } from '../../../../shared/gpu-fallback-status'
import { SafeGraphicsModeSetting } from './SafeGraphicsModeSetting'

const OFF: Status = { active: false, engagedAt: null, enabledForNextLaunch: false, source: null }
const ON: Status = {
  active: true,
  engagedAt: 1_760_000_000_000,
  enabledForNextLaunch: true,
  source: 'automatic'
}
const PINNED: Status = { ...ON, source: 'user' }
const KEEP_ON = 'Keep on after updates'

const getGpuFallbackStatus = vi.hoisted(() => vi.fn(async (): Promise<Status> => OFF))
const setGpuFallbackEnabled = vi.hoisted(() => vi.fn(async (_enabled: boolean) => {}))
const relaunch = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

describe('SafeGraphicsModeSetting', () => {
  beforeEach(() => {
    getGpuFallbackStatus.mockReset()
    getGpuFallbackStatus.mockResolvedValue(OFF)
    setGpuFallbackEnabled.mockReset()
    relaunch.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { app: { getGpuFallbackStatus, setGpuFallbackEnabled, relaunch } }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('reports hardware acceleration with the mode switched off', async () => {
    render(<SafeGraphicsModeSetting />)

    await waitFor(() => {
      expect(getGpuFallbackStatus).toHaveBeenCalled()
    })
    expect(screen.getByRole('switch').getAttribute('data-state')).toBe('unchecked')
  })

  // Why: fallback engages with no consent and lasts for the whole build, so this is the
  // persistent surface that reports it and the only exit once a driver is fixed.
  it('confirms before relaunching out of Safe Graphics Mode', async () => {
    getGpuFallbackStatus.mockResolvedValue(ON)
    render(<SafeGraphicsModeSetting />)

    await waitFor(() => {
      expect(screen.getByRole('switch').getAttribute('data-state')).toBe('checked')
    })
    await userEvent.click(screen.getByRole('switch'))

    expect(setGpuFallbackEnabled).not.toHaveBeenCalled()
    expect(screen.getByText('Restart with hardware acceleration?')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))

    await waitFor(() => {
      expect(setGpuFallbackEnabled).toHaveBeenCalledWith(false)
    })
    await waitFor(() => {
      expect(relaunch).toHaveBeenCalledTimes(1)
    })
  })

  // Why: with no way in, a user whose driver is known bad cannot pin the workaround they
  // already need — the automatic path makes them re-earn it with crashing launches.
  it('turns Safe Graphics Mode on explicitly', async () => {
    render(<SafeGraphicsModeSetting />)

    await waitFor(() => {
      expect(getGpuFallbackStatus).toHaveBeenCalled()
    })
    await userEvent.click(screen.getByRole('switch'))

    expect(screen.getByText('Restart in Safe Graphics Mode?')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))

    await waitFor(() => {
      expect(setGpuFallbackEnabled).toHaveBeenCalledWith(true)
    })
    await waitFor(() => {
      expect(relaunch).toHaveBeenCalledTimes(1)
    })
  })

  // Why: the automatic copy blames repeated crashes, which contradicts the dialog a pinning
  // user just accepted; and a pin has nothing to convert, so the row must not offer it.
  it('reports a user-pinned mode as the choice the user made', async () => {
    getGpuFallbackStatus.mockResolvedValue(PINNED)
    render(<SafeGraphicsModeSetting />)

    await waitFor(() => {
      expect(screen.getByRole('switch').getAttribute('data-state')).toBe('checked')
    })
    expect(screen.getByText(/On because you turned it on/)).toBeTruthy()
    expect(screen.queryByText(/graphics process crashed/)).toBeNull()
    expect(screen.queryByRole('button', { name: KEEP_ON })).toBeNull()
  })

  // Why: with only the switch, a user already in automatic fallback can reach a pin solely by
  // turning the workaround off and taking a hardware launch on the driver that kills startup —
  // once per update, forever. Pinning is a marker rewrite; software rendering is already on.
  it('pins an automatic engagement without an intervening hardware launch', async () => {
    getGpuFallbackStatus.mockResolvedValue(ON)
    render(<SafeGraphicsModeSetting />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: KEEP_ON })).toBeTruthy()
    })
    await userEvent.click(screen.getByRole('button', { name: KEEP_ON }))

    await waitFor(() => {
      expect(setGpuFallbackEnabled).toHaveBeenCalledWith(true)
    })
    expect(relaunch).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByText(/On because you turned it on/)).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: KEEP_ON })).toBeNull()
    expect(screen.getByRole('switch').getAttribute('data-state')).toBe('checked')
  })

  it('offers no pin while hardware acceleration is on', async () => {
    render(<SafeGraphicsModeSetting />)

    await waitFor(() => {
      expect(getGpuFallbackStatus).toHaveBeenCalled()
    })
    expect(screen.queryByRole('button', { name: KEEP_ON })).toBeNull()
  })

  it('backs out of the confirmation without touching the durable artifacts', async () => {
    getGpuFallbackStatus.mockResolvedValue(ON)
    render(<SafeGraphicsModeSetting />)

    await waitFor(() => {
      expect(screen.getByRole('switch').getAttribute('data-state')).toBe('checked')
    })
    await userEvent.click(screen.getByRole('switch'))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('switch').getAttribute('data-state')).toBe('checked')
    expect(setGpuFallbackEnabled).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
  })
})
