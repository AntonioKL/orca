// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationRunPageFrame } from './AutomationRunPageFrame'
import { AutomationRunNoticeBand } from './AutomationRunNoticeBand'

afterEach(cleanup)

describe('AutomationRunPageFrame notice', () => {
  it('renders the run reason above the output body', () => {
    render(
      <AutomationRunPageFrame
        title="Linear triage (daily 5pm PT)"
        breadcrumbs={['Aug 25, 5:00 PM', 'Orca', 'linear-triage']}
        statusLabel="Unverifiable"
        statusVariant="outline"
        notice={
          <AutomationRunNoticeBand
            notice={{
              text: 'Orca stopped watching this run before it reported completion.',
              tone: 'neutral'
            }}
          />
        }
        onBack={() => {}}
      >
        <pre>{'{"id":"local-status","ok":true}'}</pre>
      </AutomationRunPageFrame>
    )

    const reason = screen.getByText('Orca stopped watching this run before it reported completion.')
    const body = screen.getByText('{"id":"local-status","ok":true}')
    expect(reason.closest('[role="status"]')).toBe(screen.getByRole('status'))
    expect(reason).toBeTruthy()
    // Why: the reason must precede the body in the DOM, not scroll with it.
    expect(reason.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('adds no empty band when a run ended with no reason', () => {
    const { container } = render(
      <AutomationRunPageFrame
        title="Linear triage (daily 5pm PT)"
        breadcrumbs={[]}
        statusLabel="Done"
        statusVariant="secondary"
        onBack={() => {}}
      >
        <pre>report</pre>
      </AutomationRunPageFrame>
    )

    // Why count children: an always-rendered band would add a stray bordered strip
    // between the header and the body on every healthy run.
    expect(container.firstElementChild?.children).toHaveLength(2)
    expect(screen.getByText('report')).toBeTruthy()
  })

  it('announces observed failures as alerts', () => {
    render(
      <AutomationRunNoticeBand
        notice={{ text: 'Automation process exited with code 1.', tone: 'error' }}
      />
    )

    expect(screen.getByRole('alert').textContent).toContain(
      'Automation process exited with code 1.'
    )
  })
})
