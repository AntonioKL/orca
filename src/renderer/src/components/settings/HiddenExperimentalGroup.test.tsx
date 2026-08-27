// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { HiddenExperimentalGroup } from './HiddenExperimentalGroup'

const isArmed = vi.fn()
const setArmed = vi.fn()
vi.mock('../terminal-pane/terminal-render-desync-trigger', () => ({
  isTerminalRenderDesyncSentinelArmed: (...args: unknown[]) => isArmed(...args),
  setTerminalRenderDesyncSentinelArmed: (...args: unknown[]) => setArmed(...args)
}))

describe('HiddenExperimentalGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isArmed.mockReturnValue(false)
  })
  afterEach(() => {
    cleanup()
  })

  function renderDiagnosticsSwitch(): HTMLElement {
    return screen.getByRole('switch', { name: 'Terminal render diagnostics' })
  }

  it('initializes the render-diagnostics switch from the armed state', () => {
    isArmed.mockReturnValue(true)
    render(<HiddenExperimentalGroup />)

    expect(renderDiagnosticsSwitch().getAttribute('data-state')).toBe('checked')
  })

  it('arms and disarms the capture sentinel through the switch', () => {
    render(<HiddenExperimentalGroup />)
    expect(renderDiagnosticsSwitch().getAttribute('data-state')).toBe('unchecked')

    fireEvent.click(renderDiagnosticsSwitch())
    expect(setArmed).toHaveBeenCalledWith(true)
    expect(renderDiagnosticsSwitch().getAttribute('data-state')).toBe('checked')

    fireEvent.click(renderDiagnosticsSwitch())
    expect(setArmed).toHaveBeenCalledWith(false)
    expect(renderDiagnosticsSwitch().getAttribute('data-state')).toBe('unchecked')
  })
})
