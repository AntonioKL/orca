// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedSettingsTextDraft } from './use-debounced-settings-text-draft'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useDebouncedSettingsTextDraft', () => {
  it('shows every keystroke immediately but commits once', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useDebouncedSettingsTextDraft({ value: '', commit }))

    for (const next of ['w', 'wr', 'wrk']) {
      act(() => result.current.onChange(next))
    }

    expect(result.current.value).toBe('wrk')
    expect(commit).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(700)
    })

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('wrk')
  })

  it('commits immediately on blur without waiting for the debounce', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useDebouncedSettingsTextDraft({ value: '', commit }))

    act(() => result.current.onChange('abc'))
    act(() => result.current.onBlur())

    expect(commit).toHaveBeenCalledExactlyOnceWith('abc')

    act(() => {
      vi.advanceTimersByTime(700)
    })

    // The pending timer must not fire a second, duplicate commit.
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('commits a pending edit when the field unmounts', () => {
    const commit = vi.fn()
    const { result, unmount } = renderHook(() =>
      useDebouncedSettingsTextDraft({ value: '', commit })
    )

    act(() => result.current.onChange('half-typed'))
    unmount()

    expect(commit).toHaveBeenCalledExactlyOnceWith('half-typed')
  })

  it('adopts an external value while the field is untouched', () => {
    const commit = vi.fn()
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedSettingsTextDraft({ value, commit }),
      { initialProps: { value: 'first' } }
    )

    rerender({ value: 'from-another-window' })

    expect(result.current.value).toBe('from-another-window')
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not let an external value overwrite an in-progress edit', () => {
    const commit = vi.fn()
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedSettingsTextDraft({ value, commit }),
      { initialProps: { value: 'first' } }
    )

    act(() => result.current.onChange('typing'))
    rerender({ value: 'from-another-window' })

    expect(result.current.value).toBe('typing')
  })

  it('does not commit when nothing was edited', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useDebouncedSettingsTextDraft({ value: 'x', commit }))

    act(() => result.current.onBlur())

    expect(commit).not.toHaveBeenCalled()
  })
})
