// @vitest-environment happy-dom

/**
 * A record Orca switched off used to be indistinguishable from one the user
 * switched off — same "Paused", no reason, no next step. These pin the one new
 * state to the migration's own stamp, and pin the other two to reading exactly
 * as they did before it existed.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Automation } from '../../../../shared/automations-types'
import { AutomationDetail } from './AutomationDetail'
import { makeAutomation } from './automations-page-fixtures'

const roots: Root[] = []

async function render(overrides: Partial<Automation>): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <AutomationDetail
          automation={makeAutomation(overrides)}
          runs={[]}
          projectName="orca"
          workspaceName="main"
          projectDefaultBaseRef="main"
          runNowAvailability={null}
          now={0}
          onRunNow={vi.fn()}
          onEdit={vi.fn()}
          onToggle={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>
    )
  })
  return container
}

function notice(container: HTMLDivElement): HTMLElement | null {
  return container.querySelector('[data-testid="automation-enablement-notice"]')
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
  document.body.innerHTML = ''
})

describe('AutomationDetail enablement', () => {
  it('says Orca paused it, why, and what to do about it', async () => {
    const container = await render({ enabled: false, enabledDecidedBy: 'owner_migration' })

    expect(container.textContent).toContain('Paused by Orca')
    expect(notice(container)?.textContent).toContain('You did not pause it.')
    // The affordance is the point: without it the user is told it stopped and
    // left with no move. Re-adding the host and resuming are different fixes.
    expect(notice(container)?.textContent).toContain('Re-add that host')
    expect(notice(container)?.textContent).toContain('resume the automation')
  })

  it('leaves a user-paused record reading as a plain pause', async () => {
    const container = await render({ enabled: false, enabledDecidedBy: 'user' })

    expect(container.textContent).toContain('Paused')
    expect(container.textContent).not.toContain('Paused by Orca')
    expect(notice(container)).toBeNull()
  })

  it('adds no new state to a pre-stamp record, which is every record until one is disabled', async () => {
    const container = await render({ enabled: false })

    expect(container.textContent).toContain('Paused')
    expect(container.textContent).not.toContain('Paused by Orca')
    expect(notice(container)).toBeNull()
  })

  it('never explains a running automation', async () => {
    // The authority restamps to `user` on resume, but the renderer holds the
    // old record until the list comes back — so `enabled` has to win the race.
    const container = await render({ enabled: true, enabledDecidedBy: 'owner_migration' })

    expect(container.textContent).toContain('Enabled')
    expect(notice(container)).toBeNull()
  })
})
