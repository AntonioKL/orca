// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { useAppStore } from '@/store'
import { useNativeChatMonitoringStatus } from './use-native-chat-hook-status'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function monitoringEntry(updatedAt: number): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    workingMode: 'monitoring',
    prompt: 'Monitor background tasks',
    updatedAt,
    stateStartedAt: updatedAt,
    stateHistory: []
  }
}

describe('useNativeChatMonitoringStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T12:00:00.000Z'))
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: monitoringEntry(Date.now()) },
      agentStatusEpoch: 0
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState({ agentStatusByPaneKey: {}, agentStatusEpoch: 0 })
    vi.useRealTimers()
  })

  it('rerenders at expiry without rerendering for an unrelated epoch', () => {
    let renders = 0
    function Probe(): React.JSX.Element {
      renders += 1
      const monitoring = useNativeChatMonitoringStatus(PANE_KEY)
      return <span>{monitoring ? 'monitoring' : 'idle'}</span>
    }

    render(<Probe />)
    expect(screen.getByText('monitoring')).toBeInTheDocument()
    expect(renders).toBe(1)

    act(() => {
      useAppStore.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
    })
    expect(renders).toBe(1)

    vi.setSystemTime(Date.now() + AGENT_STATUS_STALE_AFTER_MS + 1)
    act(() => {
      useAppStore.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
    })
    expect(screen.getByText('idle')).toBeInTheDocument()
    expect(renders).toBe(2)
  })
})
