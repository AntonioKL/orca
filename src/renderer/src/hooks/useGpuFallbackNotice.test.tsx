// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import {
  GPU_FALLBACK_INACTIVE_STATUS,
  type GpuFallbackStatus as Status
} from '../../../shared/gpu-fallback-status'
import { GpuFallbackNoticeHost } from './useGpuFallbackNotice'

const ENGAGED_AT = 1_760_000_000_000
const OFF = GPU_FALLBACK_INACTIVE_STATUS
const AUTOMATIC: Status = {
  active: true,
  engagedAt: ENGAGED_AT,
  enabledForNextLaunch: true,
  source: 'automatic'
}
const PINNED: Status = { ...AUTOMATIC, source: 'user' }

const getGpuFallbackStatus = vi.hoisted(() =>
  vi.fn(async (): Promise<Status> => GPU_FALLBACK_INACTIVE_STATUS)
)
const setGpuFallbackEnabled = vi.hoisted(() => vi.fn(async () => {}))
const relaunch = vi.hoisted(() => vi.fn(async () => {}))
const openSettingsPage = vi.hoisted(() => vi.fn())
const openSettingsTarget = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en', hasResourceBundle: () => true } })
}))

vi.mock('@/store', () => {
  const state = { settings: { uiLanguage: 'en' }, openSettingsPage, openSettingsTarget }
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown): unknown =>
    selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

vi.mock('@/store/plugin-language-packs', () => ({
  usePluginLanguagePackStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ packs: [], loaded: true })
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

describe('useGpuFallbackNotice', () => {
  beforeEach(() => {
    getGpuFallbackStatus.mockReset()
    getGpuFallbackStatus.mockResolvedValue(OFF)
    window.localStorage.clear()
    setGpuFallbackEnabled.mockReset()
    relaunch.mockReset()
    openSettingsPage.mockReset()
    openSettingsTarget.mockReset()
    vi.mocked(toast.warning).mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { app: { getGpuFallbackStatus, setGpuFallbackEnabled, relaunch } }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('stays silent when hardware acceleration is on', async () => {
    render(<GpuFallbackNoticeHost />)

    await waitFor(() => {
      expect(getGpuFallbackStatus).toHaveBeenCalled()
    })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  // Why: engagement happens before any window exists, so this notice is the only place the user learns of it.
  it('explains the silent fallback once the window is up', async () => {
    getGpuFallbackStatus.mockResolvedValue(AUTOMATIC)
    render(<GpuFallbackNoticeHost />)

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toBe('Orca started in Safe Graphics Mode')
  })

  // Why: the copy blames repeated graphics crashes. Saying that to a user who just accepted a
  // dialog turning Safe Graphics Mode on is false, and it trains them to distrust the warning
  // on the machines where it is true. Settings still reports the state and owns the exit.
  it('does not warn about a mode the user pinned themselves', async () => {
    getGpuFallbackStatus.mockResolvedValue(PINNED)
    render(<GpuFallbackNoticeHost />)

    await waitFor(() => {
      expect(getGpuFallbackStatus).toHaveBeenCalled()
    })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  // Why: the downgrade lasts for the whole build, so the toast points at the persistent
  // Settings surface instead of being the sole (and dismissible, one-shot) exit.
  it('deep-links to the Safe Graphics Mode setting rather than relaunching directly', async () => {
    getGpuFallbackStatus.mockResolvedValue(AUTOMATIC)
    render(<GpuFallbackNoticeHost />)

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled()
    })
    const action = vi.mocked(toast.warning).mock.calls[0]?.[1]?.action
    if (typeof action !== 'object' || action === null || !('onClick' in action)) {
      throw new Error('notice is missing its action')
    }
    action.onClick(new MouseEvent('click') as never)

    expect(openSettingsPage).toHaveBeenCalledTimes(1)
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'advanced',
      repoId: null,
      sectionId: 'advanced-safe-graphics-mode'
    })
    expect(relaunch).not.toHaveBeenCalled()
    expect(setGpuFallbackEnabled).not.toHaveBeenCalled()
  })

  // Why: the downgrade is sticky for the whole build, so a session-only dismissal would
  // re-warn a user who already accepted software rendering on every launch for weeks.
  it('stops warning about an engagement the user dismissed', async () => {
    getGpuFallbackStatus.mockResolvedValue(AUTOMATIC)
    render(<GpuFallbackNoticeHost />)

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled()
    })
    const cancel = vi.mocked(toast.warning).mock.calls[0]?.[1]?.cancel
    if (typeof cancel !== 'object' || cancel === null || !('onClick' in cancel)) {
      throw new Error('notice is missing its dismiss button')
    }
    expect(cancel.label).toBe("Don't show again")
    cancel.onClick(new MouseEvent('click') as never)

    cleanup()
    vi.mocked(toast.warning).mockReset()
    render(<GpuFallbackNoticeHost />)
    await waitFor(() => {
      expect(getGpuFallbackStatus).toHaveBeenCalledTimes(2)
    })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  // Why: the Toaster renders a close button, so the X is the natural way to get rid of a
  // never-expiring toast; without this it would re-warn on every launch for weeks.
  it('stops warning after the toast close button dismisses it', async () => {
    getGpuFallbackStatus.mockResolvedValue(AUTOMATIC)
    render(<GpuFallbackNoticeHost />)

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled()
    })
    const onDismiss = vi.mocked(toast.warning).mock.calls[0]?.[1]?.onDismiss
    if (typeof onDismiss !== 'function') {
      throw new Error('notice does not persist a close-button dismissal')
    }
    onDismiss({ id: 'gpu-fallback-active' } as never)

    cleanup()
    vi.mocked(toast.warning).mockReset()
    render(<GpuFallbackNoticeHost />)
    await waitFor(() => {
      expect(getGpuFallbackStatus).toHaveBeenCalledTimes(2)
    })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  // Why: dismissal is scoped to one engagement — a fresh downgrade after the user asked for
  // hardware acceleration back is news again.
  it('announces a later engagement even after a dismissal', async () => {
    getGpuFallbackStatus.mockResolvedValue(AUTOMATIC)
    render(<GpuFallbackNoticeHost />)
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled()
    })
    const cancel = vi.mocked(toast.warning).mock.calls[0]?.[1]?.cancel
    if (typeof cancel !== 'object' || cancel === null || !('onClick' in cancel)) {
      throw new Error('notice is missing its dismiss button')
    }
    cancel.onClick(new MouseEvent('click') as never)

    cleanup()
    vi.mocked(toast.warning).mockReset()
    getGpuFallbackStatus.mockResolvedValue({ ...AUTOMATIC, engagedAt: ENGAGED_AT + 60_000 })
    render(<GpuFallbackNoticeHost />)

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1)
    })
  })
})
