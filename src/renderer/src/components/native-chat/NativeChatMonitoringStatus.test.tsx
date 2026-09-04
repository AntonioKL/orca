// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatMonitoringStatus } from './NativeChatMonitoringStatus'

describe('NativeChatMonitoringStatus', () => {
  afterEach(cleanup)

  it('stays hidden outside monitoring', () => {
    render(<NativeChatMonitoringStatus monitoring={false} />)

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the shared monitoring glyph with visible copy', () => {
    render(<NativeChatMonitoringStatus monitoring />)

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Monitoring background tasks')
    expect(status.querySelector('svg')).toBeInTheDocument()
  })
})
